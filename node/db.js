'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
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
  },
  requested_amount: parseFloat(row.requested_amount),
  payday: fmtDate(row.payday),
  status: row.status,
  plaid_connected: Boolean(row.access_token),
  stripe_card_saved: Boolean(row.stripe_payment_method_id),
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
  delivery_type: row.delivery_type || null,
  instant_fee_paid: row.instant_fee_paid || false,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

async function createApplication({ name, email, phone, employer, payday, requested_amount, password_hash }) {
  const { rows } = await pool.query(
    `INSERT INTO applications (name, email, phone, employer, payday, requested_amount, password_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [name, email, phone, employer, payday, requested_amount || 25, password_hash],
  );
  return rows[0];
}

async function getApplicationById(id) {
  const { rows } = await pool.query('SELECT * FROM applications WHERE id = $1', [id]);
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
         repayment_status='pending', status='repayment_scheduled', updated_at=NOW()
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
  const { rows } = await pool.query(
    `SELECT * FROM applications
     WHERE repayment_due_date <= CURRENT_DATE
       AND repayment_status = 'pending'
       AND stripe_payment_method_id IS NOT NULL
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

async function saveStripeCustomer(id, stripe_customer_id) {
  const { rows } = await pool.query(
    'UPDATE applications SET stripe_customer_id=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
    [stripe_customer_id, id],
  );
  return rows[0] || null;
}

async function saveStripePaymentMethod(id, stripe_payment_method_id) {
  const { rows } = await pool.query(
    'UPDATE applications SET stripe_payment_method_id=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
    [stripe_payment_method_id, id],
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

module.exports = {
  publicApp,
  createApplication,
  saveSubscription,
  saveDeliveryType,
  savePayoutPreference,
  getApplicationById,
  getApplicationByEmail,
  getAllApplications,
  updateApplicationStatus,
  setAccessToken,
  setRepayment,
  markRepaymentPaid,
  addMessage,
  getMessages,
  saveStripeCustomer,
  saveStripePaymentMethod,
  saveStripeCharge,
  getDueMemberships,
  getDueApplications,
};
