'use strict';

const { Pool } = require('pg');

// SSL config: production Postgres (Render) requires SSL; the test
// Postgres on CI doesn't support it. Disable for NODE_ENV=test and let
// the rest fall back to relaxed-cert SSL.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'test' ? false : { rejectUnauthorized: false },
});

// Run any additive migrations on startup
pool.query(`
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS payout_methods TEXT;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS payout_contact TEXT;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS subscription_id TEXT;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS subscription_status TEXT;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS subscription_next_billing DATE;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS delivery_type TEXT;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS instant_fee_paid BOOLEAN DEFAULT FALSE;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS ssn_last4 TEXT;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS stripe_fc_account_id TEXT;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS stripe_card_pm_id TEXT;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS ssn TEXT;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS pay_frequency TEXT;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS state TEXT;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS dob DATE;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS offer_expires_at TIMESTAMPTZ;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS repayment_count INTEGER DEFAULT 0;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS referred_by TEXT;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS limit_freeze_until DATE;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS due_date_reminder_sent_at TIMESTAMPTZ;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS stripe_connect_account_id TEXT;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS stripe_connect_status TEXT;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS transfer_id TEXT;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS stripe_fc_session_id TEXT;
  ALTER TABLE applications ADD COLUMN IF NOT EXISTS stripe_fc_subscribed_at TIMESTAMPTZ;
`).catch(() => {});

pool.query(`
  CREATE TABLE IF NOT EXISTS income_sources (
    id SERIAL PRIMARY KEY,
    application_id TEXT NOT NULL,
    employer TEXT NOT NULL,
    payday DATE NOT NULL,
    pay_frequency TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  ALTER TABLE income_sources ALTER COLUMN pay_frequency DROP NOT NULL;
`).catch(() => {});

pool.query(`
  ALTER TABLE income_sources ALTER COLUMN application_id TYPE TEXT USING application_id::TEXT;
`).catch(() => {});

const fmtDate = (v) => {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return new Date(v).toISOString().slice(0, 10);
};

const publicApp = (row) => ({
  id: row.id,
  customer: {
    name: row.name,
    email: row.email,
    phone: row.phone,
    employer: row.employer,
    ssn_last4: row.ssn ? row.ssn.slice(-4) : (row.ssn_last4 || null),
    pay_frequency: row.pay_frequency || null,
    state: row.state || null,
    dob: fmtDate(row.dob) || null,
  },
  requested_amount: parseFloat(row.requested_amount),
  payday: fmtDate(row.payday),
  status: row.status,
  plaid_connected: Boolean(row.stripe_fc_account_id || row.access_token),
  // stripe_card_saved: new flow uses stripe_card_pm_id; old card-only users have no fc_account_id
  stripe_card_saved: Boolean(row.stripe_card_pm_id || (row.stripe_payment_method_id && !row.stripe_fc_account_id)),
  stripe_charge_status: row.stripe_charge_status || null,
  repayment: row.repayment_amount != null ? {
    amount: parseFloat(row.repayment_amount),
    due_date: fmtDate(row.repayment_due_date),
    status: row.repayment_status || 'pending',
    note: row.repayment_note || '',
    created_at: row.updated_at,
  } : null,
  payout_methods: row.payout_methods || null,
  payout_contact: row.payout_contact || null,
  subscription_status: row.subscription_status || null,
  subscription_id: row.subscription_id || null,
  subscription_next_billing: fmtDate(row.subscription_next_billing) || null,
  delivery_type: row.delivery_type || null,
  instant_fee_paid: row.instant_fee_paid || false,
  repayment_count: row.repayment_count || 0,
  offer_expires_at: row.offer_expires_at ? new Date(row.offer_expires_at).toISOString() : null,
  referral_code: row.referral_code || null,
  referred_by: row.referred_by || null,
  limit_freeze_until: fmtDate(row.limit_freeze_until) || null,
  // Stripe Connect Express (ACH payouts). connect_status mirrors the
  // hosted-onboarding lifecycle: null → pending → ready → restricted.
  stripe_connect_account_id: row.stripe_connect_account_id || null,
  stripe_connect_status: row.stripe_connect_status || null,
  transfer_id: row.transfer_id || null,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

async function createIncomeSources(application_id, sources) {
  for (const s of sources) {
    await pool.query(
      'INSERT INTO income_sources (application_id, employer, payday, pay_frequency) VALUES ($1,$2,$3,$4)',
      // pay_frequency no longer collected at signup; default to null and let
      // downstream code derive it from bank transactions.
      [application_id, s.employer, s.payday, s.pay_frequency || null],
    );
  }
}

async function getIncomeSources(application_id) {
  const { rows } = await pool.query(
    'SELECT * FROM income_sources WHERE application_id=$1 ORDER BY id ASC',
    [application_id],
  );
  return rows.map(r => ({
    id: r.id,
    employer: r.employer,
    payday: fmtDate(r.payday),
    pay_frequency: r.pay_frequency,
  }));
}

async function createApplication({ name, email, phone, employer, payday, requested_amount, password_hash, ssn, pay_frequency, state, dob, referral_code, referred_by }) {
  const ssn_last4 = ssn ? ssn.replace(/-/g, '').slice(-4) : null;
  const ssn_clean = ssn ? ssn.replace(/-/g, '') : null;
  const { rows } = await pool.query(
    `INSERT INTO applications (name, email, phone, employer, payday, requested_amount, password_hash, ssn_last4, ssn, pay_frequency, state, dob, referral_code, referred_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [name, email, phone, employer, payday, requested_amount || 25, password_hash, ssn_last4, ssn_clean, pay_frequency || null, state || null, dob || null, referral_code || null, referred_by || null],
  );
  return rows[0];
}

async function getApplicationById(id) {
  const { rows } = await pool.query('SELECT * FROM applications WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getApplicationBySSN(ssn) {
  const { rows } = await pool.query(
    'SELECT * FROM applications WHERE ssn = $1 ORDER BY created_at DESC LIMIT 1', [ssn],
  );
  return rows[0] || null;
}

async function getApplicationByEmail(email) {
  const { rows } = await pool.query(
    'SELECT * FROM applications WHERE LOWER(email) = LOWER($1)', [email],
  );
  return rows[0] || null;
}

async function getAllApplications() {
  const { rows } = await pool.query('SELECT * FROM applications ORDER BY created_at DESC');
  return rows;
}

async function updateApplicationStatus(id, status) {
  const { rows } = await pool.query(
    'UPDATE applications SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
    [status, id],
  );
  return rows[0] || null;
}

async function setAccessToken(id, access_token, item_id) {
  const { rows } = await pool.query(
    `UPDATE applications SET access_token=$1, item_id=$2, status='bank_connected', updated_at=NOW()
     WHERE id=$3 RETURNING *`,
    [access_token, item_id, id],
  );
  return rows[0] || null;
}

async function setRepayment(id, amount, due_date, note) {
  const { rows } = await pool.query(
    `UPDATE applications
     SET repayment_amount=$1, repayment_due_date=$2, repayment_note=$3,
         repayment_status='pending', status='repayment_scheduled',
         due_date_reminder_sent_at=NULL, updated_at=NOW()
     WHERE id=$4 RETURNING *`,
    [amount, due_date, note || '', id],
  );
  return rows[0] || null;
}

async function markRepaymentPaid(id) {
  const { rows } = await pool.query(
    `UPDATE applications SET repayment_status='paid', status='repaid', updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [id],
  );
  return rows[0] || null;
}

async function addMessage(application_id, sender, text) {
  const { rows } = await pool.query(
    'INSERT INTO messages (application_id, sender, text) VALUES ($1,$2,$3) RETURNING *',
    [application_id, sender, text],
  );
  return rows[0];
}

async function getMessages(application_id) {
  const { rows } = await pool.query(
    'SELECT * FROM messages WHERE application_id=$1 ORDER BY created_at ASC',
    [application_id],
  );
  return rows;
}

async function getDueMemberships() {
  const { rows } = await pool.query(
    `SELECT * FROM applications
     WHERE subscription_status = 'active'
       AND subscription_next_billing <= CURRENT_DATE
       AND stripe_customer_id IS NOT NULL`
  );
  return rows;
}

async function getDueApplications() {
  // Match any application with at least one chargeable payment method.
  // Order of preference is handled in the charge endpoint
  // (bank PM via FC > card PM > legacy bank PM). This filter only
  // ensures the application has something we can charge.
  const { rows } = await pool.query(
    `SELECT * FROM applications
     WHERE repayment_due_date <= CURRENT_DATE
       AND repayment_status = 'pending'
       AND (stripe_payment_method_id IS NOT NULL OR stripe_card_pm_id IS NOT NULL)
       AND stripe_customer_id IS NOT NULL`
  );
  return rows;
}

async function saveSubscription(id, subscription_id, subscription_status, subscription_next_billing) {
  const { rows } = await pool.query(
    `UPDATE applications SET subscription_id=$1, subscription_status=$2,
     subscription_next_billing=$3, updated_at=NOW() WHERE id=$4 RETURNING *`,
    [subscription_id, subscription_status, subscription_next_billing || null, id],
  );
  return rows[0] || null;
}

async function saveDeliveryType(id, delivery_type, instant_fee_paid) {
  const { rows } = await pool.query(
    'UPDATE applications SET delivery_type=$1, instant_fee_paid=$2, updated_at=NOW() WHERE id=$3 RETURNING *',
    [delivery_type, instant_fee_paid, id],
  );
  return rows[0] || null;
}

async function savePayoutPreference(id, methods, contact) {
  const { rows } = await pool.query(
    'UPDATE applications SET payout_methods=$1, payout_contact=$2, updated_at=NOW() WHERE id=$3 RETURNING *',
    [methods, contact, id],
  );
  return rows[0] || null;
}

async function saveBankAccount(id, payment_method_id, fc_account_id) {
  const { rows } = await pool.query(
    `UPDATE applications
     SET stripe_payment_method_id=$1, stripe_fc_account_id=$2, status='bank_connected', updated_at=NOW()
     WHERE id=$3 RETURNING *`,
    [payment_method_id, fc_account_id || null, id],
  );
  return rows[0] || null;
}

async function saveStripeCustomer(id, stripe_customer_id) {
  const { rows } = await pool.query(
    'UPDATE applications SET stripe_customer_id=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
    [stripe_customer_id, id],
  );
  return rows[0] || null;
}

async function saveStripePaymentMethod(id, stripe_card_pm_id) {
  const { rows } = await pool.query(
    'UPDATE applications SET stripe_card_pm_id=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
    [stripe_card_pm_id, id],
  );
  return rows[0] || null;
}

async function saveStripeCharge(id, charge_id, charge_status) {
  const { rows } = await pool.query(
    'UPDATE applications SET stripe_charge_id=$1, stripe_charge_status=$2, updated_at=NOW() WHERE id=$3 RETURNING *',
    [charge_id, charge_status, id],
  );
  return rows[0] || null;
}

async function incrementRepaymentCount(id) {
  await pool.query(
    'UPDATE applications SET repayment_count = COALESCE(repayment_count, 0) + 1, updated_at=NOW() WHERE id=$1',
    [id],
  );
}

async function resetForReapply(id, requested_amount) {
  const { rows } = await pool.query(
    `UPDATE applications
     SET status='reviewing', delivery_type=NULL, instant_fee_paid=FALSE,
         offer_expires_at=NULL, repayment_amount=NULL, repayment_due_date=NULL,
         repayment_status=NULL, repayment_note=NULL,
         stripe_charge_id=NULL, stripe_charge_status=NULL,
         due_date_reminder_sent_at=NULL,
         requested_amount=$2, updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [id, requested_amount],
  );
  return rows[0] || null;
}

// Find applications whose repayment is due exactly 2 days from today and
// who haven't yet received the reminder tag for this advance cycle.
async function getApplicationsNeedingDueReminder() {
  const { rows } = await pool.query(`
    SELECT * FROM applications
    WHERE status IN ('funded', 'repayment_scheduled')
      AND repayment_due_date IS NOT NULL
      AND repayment_due_date::date = CURRENT_DATE + INTERVAL '2 days'
      AND due_date_reminder_sent_at IS NULL
      AND email IS NOT NULL
  `);
  return rows;
}

async function markDueDateReminderSent(id) {
  await pool.query(
    `UPDATE applications SET due_date_reminder_sent_at = NOW() WHERE id = $1`,
    [id],
  );
}

async function getApplicationByReferralCode(code) {
  const { rows } = await pool.query(
    'SELECT * FROM applications WHERE referral_code = $1 LIMIT 1', [code],
  );
  return rows[0] || null;
}

async function getReferredUsers(referral_code) {
  if (!referral_code) return [];
  const { rows } = await pool.query(
    `SELECT id, name, email, status, repayment_count, delivery_type, created_at
     FROM applications WHERE referred_by = $1 ORDER BY created_at DESC`,
    [referral_code],
  );
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    email: r.email,
    status: r.status,
    repayment_count: r.repayment_count || 0,
    got_advance: !!r.delivery_type,
    created_at: r.created_at,
  }));
}

async function saveLimitFreeze(id, freeze_until) {
  await pool.query(
    'UPDATE applications SET limit_freeze_until=$1, updated_at=NOW() WHERE id=$2',
    [freeze_until, id],
  );
}

async function saveOfferExpiry(id, offer_expires_at) {
  const { rows } = await pool.query(
    'UPDATE applications SET offer_expires_at=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
    [offer_expires_at, id],
  );
  return rows[0] || null;
}

// Stripe Connect Express helpers (ACH payout flow).
// stripe_connect_account_id is set when we first create the account; status
// flips to 'ready' once charges_enabled && payouts_enabled both true.
async function saveStripeConnectAccount(id, accountId, status) {
  const { rows } = await pool.query(
    `UPDATE applications
     SET stripe_connect_account_id=$1, stripe_connect_status=$2, updated_at=NOW()
     WHERE id=$3 RETURNING *`,
    [accountId, status, id],
  );
  return rows[0] || null;
}

async function setStripeConnectStatusByAccountId(accountId, status) {
  // Used by the webhook handler — we don't know the application id, only
  // the Stripe account id that fired the event.
  const { rows } = await pool.query(
    `UPDATE applications
     SET stripe_connect_status=$1, updated_at=NOW()
     WHERE stripe_connect_account_id=$2 RETURNING *`,
    [status, accountId],
  );
  return rows[0] || null;
}

async function saveTransferId(id, transferId) {
  const { rows } = await pool.query(
    `UPDATE applications SET transfer_id=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
    [transferId, id],
  );
  return rows[0] || null;
}

// Stripe Financial Connections helpers.
// Replaces Plaid for bank linking. One FC session can give us:
//   - a chargeable us_bank_account PaymentMethod (saved as
//     stripe_payment_method_id for the existing repayment cron)
//   - transaction reads for income classification (stripe_fc_account_id)
//   - a bank_account token attachable to a Connect external_account
async function saveStripeFcSession(id, sessionId) {
  const { rows } = await pool.query(
    `UPDATE applications SET stripe_fc_session_id=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
    [sessionId, id],
  );
  return rows[0] || null;
}

async function saveStripeFcLinkedAccount(id, fcAccountId, bankPmId) {
  // We deliberately write the FC-derived bank PM to the existing
  // stripe_payment_method_id column so the repayment cron picks it up
  // without any additional refactoring. Also flips the application to
  // 'bank_connected' since FC linking IS the bank step now.
  const { rows } = await pool.query(
    `UPDATE applications
     SET stripe_fc_account_id=$1, stripe_payment_method_id=$2, status='bank_connected', updated_at=NOW()
     WHERE id=$3 RETURNING *`,
    [fcAccountId, bankPmId, id],
  );
  return rows[0] || null;
}

async function markStripeFcSubscribed(id) {
  const { rows } = await pool.query(
    `UPDATE applications SET stripe_fc_subscribed_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`,
    [id],
  );
  return rows[0] || null;
}

module.exports = {
  // Export the pool so test teardown can close all connections cleanly.
  pool,
  publicApp,
  createApplication,
  getApplicationByReferralCode,
  getReferredUsers,
  saveLimitFreeze,
  createIncomeSources,
  getIncomeSources,
  saveSubscription,
  saveDeliveryType,
  savePayoutPreference,
  getApplicationById,
  getApplicationBySSN,
  getApplicationByEmail,
  getAllApplications,
  updateApplicationStatus,
  setAccessToken,
  setRepayment,
  markRepaymentPaid,
  addMessage,
  getMessages,
  saveBankAccount,
  saveStripeCustomer,
  saveStripePaymentMethod,
  saveStripeCharge,
  incrementRepaymentCount,
  resetForReapply,
  saveOfferExpiry,
  getDueMemberships,
  getDueApplications,
  getApplicationsNeedingDueReminder,
  markDueDateReminderSent,
  saveStripeConnectAccount,
  setStripeConnectStatusByAccountId,
  saveTransferId,
  saveStripeFcSession,
  saveStripeFcLinkedAccount,
  markStripeFcSubscribed,
};
