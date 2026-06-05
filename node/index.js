'use strict';

// read env vars from .env file
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Configuration, PlaidApi, Products, PlaidEnvironments, CraCheckReportProduct } = require('plaid');
const Anthropic = require('@anthropic-ai/sdk');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const connectCustom = require('./stripeConnectCustom');
const util = require('util');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const bodyParser = require('body-parser');
const moment = require('moment');
const cors = require('cors');

const APP_PORT = process.env.APP_PORT || 8000;
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET = process.env.PLAID_SECRET;
const PLAID_ENV = process.env.PLAID_ENV || 'sandbox';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const JWT_SECRET = process.env.JWT_SECRET || 'dev_jwt_secret_change_in_production';

// SSNs that bypass both format validation and the dupe check (for testing).
// Add your own SSN here: TEST_SSNS=123456789,987654321 in .env (dashes optional).
const TEST_SSNS = new Set(
  (process.env.TEST_SSNS || '').split(',').map(s => s.replace(/-/g, '').trim()).filter(s => s.length === 9)
);

// Basic SSN plausibility check — catches impossible numbers per SSA rules and
// known fake/advertised SSNs. Does NOT verify the number was actually issued.
function isPlausibleSSN(ssn) {
  const area   = ssn.slice(0, 3);
  const group  = ssn.slice(3, 5);
  const serial = ssn.slice(5, 9);

  if (area === '000' || area === '666')      return false; // never assigned
  if (parseInt(area, 10) >= 900)             return false; // 900–999 never assigned (ITINs etc.)
  if (group  === '00')                       return false; // invalid group
  if (serial === '0000')                     return false; // invalid serial
  if (/^(\d)\1{8}$/.test(ssn))              return false; // all same digit (111111111 etc.)
  // Known advertised / wallet-insert fakes
  if (['078051120', '219099999', '123456789'].includes(ssn)) return false;

  return true;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function generateReferralSlug(name) {
  return (name || 'user').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user';
}

async function makeUniqueReferralCode(name) {
  const base = generateReferralSlug(name);
  if (!(await db.getApplicationByReferralCode(base))) return base;
  for (let i = 2; i <= 99; i++) {
    const code = `${base}${i}`;
    if (!(await db.getApplicationByReferralCode(code))) return code;
  }
  return `${base}${Math.random().toString(36).slice(2, 6)}`;
}

// PLAID_PRODUCTS is a comma-separated list of products to use when initializing
// Link. Note that this list must contain 'assets' in order for the app to be
// able to create and retrieve asset reports.
const PLAID_PRODUCTS = (process.env.PLAID_PRODUCTS || Products.Transactions).split(
  ',',
);

// PLAID_COUNTRY_CODES is a comma-separated list of countries for which users
// will be able to select institutions from.
const PLAID_COUNTRY_CODES = (process.env.PLAID_COUNTRY_CODES || 'US').split(
  ',',
);

// Parameters used for the OAuth redirect Link flow.
//
// Set PLAID_REDIRECT_URI to 'http://localhost:3000'
// The OAuth redirect flow requires an endpoint on the developer's website
// that the bank website should redirect to. You will need to configure
// this redirect URI for your client ID through the Plaid developer dashboard
// at https://dashboard.plaid.com/team/api.
const PLAID_REDIRECT_URI = process.env.PLAID_REDIRECT_URI || '';

// Parameter used for OAuth in Android. This should be the package name of your app,
// e.g. com.plaid.linksample
const PLAID_ANDROID_PACKAGE_NAME = process.env.PLAID_ANDROID_PACKAGE_NAME || '';

// Parameter used for Signal ruleset key
const SIGNAL_RULESET_KEY = process.env.SIGNAL_RULESET_KEY || '';

// We store the access_token in memory - in production, store it in a secure
// persistent data store
let ACCESS_TOKEN = null;
let USER_TOKEN = null;
let USER_ID = null;
let PUBLIC_TOKEN = null;
let ITEM_ID = null;
let ACCOUNT_ID = null;
// The payment_id is only relevant for the UK/EU Payment Initiation product.
// We store the payment_id in memory - in production, store it in a secure
// persistent data store along with the Payment metadata, such as userId .
let PAYMENT_ID = null;
// The transfer_id and authorization_id are only relevant for Transfer ACH product.
// We store the transfer_id in memory - in production, store it in a secure
// persistent data store
let AUTHORIZATION_ID = null;
let TRANSFER_ID = null;

// Initialize the Plaid client
// Find your API keys in the Dashboard (https://dashboard.plaid.com/account/keys)

const configuration = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
      'PLAID-SECRET': PLAID_SECRET,
      'Plaid-Version': '2020-09-14',
    },
  },
});

const client = new PlaidApi(configuration);

// ── Income classification ─────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Layer 1: Plaid personal_finance_category codes to exclude
const EXCLUDED_PFC = new Set([
  'INCOME_RETIREMENT_PENSION',                      // pension, annuity
  'INCOME_DIVIDENDS',                               // investment income
  'INCOME_SOCIAL_SECURITY',                         // social security
  'INCOME_UNEMPLOYMENT_BENEFITS',                   // state unemployment insurance
  'INCOME_TAX_REFUND',                              // IRS tax refunds, EITC
  'GOVERNMENT_BENEFITS',                            // TANF, SNAP, WIC, stimulus, VA, disability
  'TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS',    // transfers from brokerage/retirement accounts
  'TRANSFER_IN_OTHER_TRANSFER_IN',                  // catch-all inbound transfers (not payroll)
]);

// Layer 2: Keyword matching on description (catches what PFC misses)
const EXCLUDED_KEYWORDS = [
  'social security', 'ssa treas', ' ssa ', 'ssdi', 'ssi treas',
  'va comp', 'va benefit', 'veterans affairs', 'vacp treas', 'dfas va',
  'railroad retirement', 'rrta', 'rrb treas',
  'unemployment', 'unemp ins', 'state ui ',
  'irs treas', 'tax refund', 'eitc', 'earned income',
  'stimulus', 'eip treas', 'economic impact', 'recovery rebate',
  'pension', 'annuity', 'retirement dist',
  'tanf', 'snap benefit', 'wic benefit', 'welfare',
  'workers comp', 'workmans comp', 'workerscomp',
  'child support', 'alimony',
  'lottery', 'gambling win', 'casino win',
  'insurance settlement', 'lawsuit', 'legal settlement',
  'trust distribution', 'trust dist',
  'federal retirement', ' csrs ', ' fers ',
  'opm treas',
  'disability payment', 'state disability',
  'rental income', 'rent payment received',
  // refunds
  'refund', 'purchase return', 'return credit', 'merchandise credit',
  // investment / brokerage transfers
  'fidelity', 'vanguard', 'schwab', 'etrade', 'e*trade', 'robinhood',
  'ameritrade', 'merrill', 'wealthfront', 'betterment', 'acorns',
  'brokerage', 'investment transfer', 'transfer from investment',
  'dividend', 'capital gain', '401k', 'ira distribution',
];

function isExcludedByPFC(pfc) {
  return pfc && EXCLUDED_PFC.has(pfc);
}

function isExcludedByKeyword(description) {
  const lower = ` ${description.toLowerCase()} `;
  return EXCLUDED_KEYWORDS.some(kw => lower.includes(kw));
}

// Layer 3: AI classification cache (normalized description → result)
const aiClassificationCache = new Map();

async function classifyWithAI(description, category, pfc) {
  const key = description.toLowerCase().replace(/\s+/g, ' ').trim();
  if (aiClassificationCache.has(key)) return aiClassificationCache.get(key);

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{
        role: 'user',
        content: `You are a financial underwriter for a wage advance product. Classify this bank transaction.

Transaction: "${description}"
Plaid category: "${category}"
Plaid PFC: "${pfc}"

Count as "wage_income" ONLY if it is a regular paycheck, salary, or hourly wages from an employer (e.g. ADP, Gusto, payroll, direct deposit from employer).

Count as "excluded" if it is ANY of: pension/annuity, investment/dividend income, brokerage or retirement account transfer, rental income, alimony/child support, trust distribution, lottery/gambling winnings, insurance/lawsuit settlement, IRS tax refund/EITC, merchandise or purchase refund, stimulus/one-time relief, unemployment insurance, TANF/SNAP/WIC, state/local disability, workers compensation, Social Security, VA benefits, federal civil service retirement, Railroad Retirement Board benefits.

Count as "uncertain" if you cannot determine from the description alone.

Reply with ONLY one word: wage_income, excluded, or uncertain`,
      }],
    });

    const raw = msg.content[0].text.trim().toLowerCase().replace(/[^a-z_]/g, '');
    const result = ['wage_income', 'excluded', 'uncertain'].includes(raw) ? raw : 'uncertain';
    aiClassificationCache.set(key, result);
    return result;
  } catch (e) {
    console.log('[classifyWithAI] error:', e.message);
    return 'uncertain';
  }
}

function buildRefundSet(rawTxs) {
  // Group outgoing amounts by merchant
  const spendByMerchant = {};
  rawTxs.filter(tx => tx.amount < 0 && tx.description).forEach(tx => {
    const key = tx.description.toLowerCase().trim();
    if (!spendByMerchant[key]) spendByMerchant[key] = [];
    spendByMerchant[key].push(Math.abs(tx.amount));
  });

  // Flag incoming transactions where merchant has a prior spend within 10% of the incoming amount
  return new Set(
    rawTxs
      .filter(tx => {
        if (tx.amount <= 0 || !tx.description) return false;
        const key = tx.description.toLowerCase().trim();
        const priorSpends = spendByMerchant[key];
        if (!priorSpends) return false;
        return priorSpends.some(spent => Math.abs(spent - tx.amount) / tx.amount <= 0.10);
      })
      .map(tx => tx.id)
  );
}

async function classifyTransaction(description, category, pfc, isRefund) {
  if (isRefund) return { status: 'excluded', reason: 'refund', ai_classified: false };
  if (isExcludedByPFC(pfc)) return { status: 'excluded', reason: 'pfc', ai_classified: false };
  if (isExcludedByKeyword(description)) return { status: 'excluded', reason: 'keyword', ai_classified: false };
  const pfcWage = pfc === 'INCOME_WAGES';
  if (pfcWage) return { status: 'wage_income', reason: 'pfc', ai_classified: false };
  const aiResult = await classifyWithAI(description, category, pfc);
  return { status: aiResult, reason: 'ai', ai_classified: true };
}

// ── Accrued wage calculation ──────────────────────────────────────────────────

function payPeriodDays(frequency) {
  const f = (frequency || '').toLowerCase();
  if (f === 'weekly') return 7;
  if (f === 'biweekly') return 14;
  if (f === 'semimonthly') return 15;
  if (f === 'monthly') return 30;
  if (f === 'daily') return 1;
  return 14;
}

// Find paycheck transactions by timing pattern rather than employer-name matching.
// Uses the declared payday as an anchor so we know *when* to look, then finds
// the largest income transaction within a tolerance window around each expected date.
function findPaychecksByPattern(incomeTxs, frequency, declaredNextPayday) {
  const sorted = [...incomeTxs].sort((a, b) => b.date.localeCompare(a.date));
  if (sorted.length === 0) return [];

  const f = (frequency || '').toLowerCase();
  const today = new Date();
  const todayMs = today.getTime();

  // Daily: return all income so far this calendar month — caller sums them
  if (f === 'daily') {
    const thisMonth = today.toISOString().slice(0, 7);
    return sorted.filter(tx => tx.date.startsWith(thisMonth));
  }

  // Monthly: for each of the last 3 months look for the biggest income tx
  // within ±7 days of the declared pay-day-of-month
  if (f === 'monthly') {
    const nextPay = new Date(declaredNextPayday + 'T00:00:00');
    const targetDay = nextPay.getDate();
    const paychecks = [];
    for (let mBack = 0; mBack < 6 && paychecks.length < 3; mBack++) {
      const yr = today.getFullYear() + Math.floor((today.getMonth() - mBack) / 12);
      const mo = ((today.getMonth() - mBack) % 12 + 12) % 12;
      const refDate = new Date(yr, mo, targetDay);
      if (refDate >= today) continue;
      const candidates = sorted.filter(tx =>
        Math.abs(new Date(tx.date + 'T00:00:00') - refDate) / 86400000 <= 7
      );
      if (candidates.length > 0) {
        paychecks.push(candidates.reduce((a, b) => a.amount > b.amount ? a : b));
      }
    }
    return paychecks;
  }

  // Periodic (weekly=7, biweekly=14, semimonthly=15): walk backwards from
  // the most recent past expected payday in period_days steps and grab the
  // largest income tx within the slack window at each step.
  const periodDays = f === 'weekly' ? 7 : f === 'biweekly' ? 14 : 15;
  const slack = f === 'weekly' ? 2 : f === 'biweekly' ? 3 : 4; // days tolerance

  let expectedMs = new Date(declaredNextPayday + 'T00:00:00').getTime();
  while (expectedMs > todayMs) expectedMs -= periodDays * 86400000;

  const paychecks = [];
  for (let i = 0; i < 8 && paychecks.length < 4; i++) {
    const candidates = sorted.filter(tx =>
      Math.abs(new Date(tx.date + 'T00:00:00').getTime() - expectedMs) / 86400000 <= slack
    );
    if (candidates.length > 0) {
      paychecks.push(candidates.reduce((a, b) => a.amount > b.amount ? a : b));
    }
    expectedMs -= periodDays * 86400000;
  }
  return paychecks;
}

function calcSourceAccrued(source, incomeTxs) {
  const f = (source.pay_frequency || '').toLowerCase();
  const today = new Date();

  const paychecks = findPaychecksByPattern(incomeTxs, f, source.payday);
  if (paychecks.length === 0) return { ...source, accrued_cents: null, error: 'no_transactions' };

  // Daily: already-accrued = sum of income this month
  if (f === 'daily') {
    const totalCents = paychecks.reduce((sum, tx) => sum + tx.amount, 0);
    const impliedMonthly = Math.round(totalCents / Math.max(1, today.getDate()) * 30);
    return {
      ...source,
      accrued_cents: Math.round(totalCents),
      days_elapsed: today.getDate(),
      period_days: 30,
      avg_paycheck_cents: impliedMonthly,
      matched_tx_count: paychecks.length,
    };
  }

  const periodDays = payPeriodDays(f);
  const avgPaycheck = paychecks.reduce((sum, tx) => sum + tx.amount, 0) / paychecks.length;
  const lastPayday = new Date(paychecks[0].date + 'T00:00:00');
  const daysElapsed = Math.min(periodDays, Math.round((today - lastPayday) / 86400000));
  const accrued_cents = Math.max(0, Math.round((avgPaycheck / periodDays) * daysElapsed));

  return {
    ...source,
    accrued_cents,
    days_elapsed: daysElapsed,
    period_days: periodDays,
    avg_paycheck_cents: Math.round(avgPaycheck),
    last_payday: paychecks[0].date,
    matched_tx_count: paychecks.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

const app = express();
// Stripe webhook needs the raw request body to verify the signature.
// Register it BEFORE the JSON body-parser so the body is still raw.
app.post(
  '/api/webhooks/stripe',
  bodyParser.raw({ type: 'application/json' }),
  async function (request, response) {
    const sig = request.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let event;
    if (webhookSecret) {
      try {
        event = stripe.webhooks.constructEvent(request.body, sig, webhookSecret);
      } catch (err) {
        console.log('[stripe/webhook] signature verification failed', err.message);
        return response.status(400).send(`Webhook signature error: ${err.message}`);
      }
    } else {
      // No webhook secret configured — parse but log a warning. Useful
      // during local dev with the Stripe CLI but unsafe in prod.
      try {
        event = JSON.parse(request.body.toString('utf8'));
        console.log('[stripe/webhook] WARNING: webhook secret not configured — event accepted without verification');
      } catch (err) {
        return response.status(400).send('Invalid JSON');
      }
    }

    try {
      const obj = event.data?.object;
      const appId = obj?.metadata?.application_id || obj?.subscription_metadata?.application_id;

      switch (event.type) {
        case 'invoice.payment_failed': {
          // Membership charge failed → lock the user out of new advances
          // until they resolve. The advance repayment is a separate
          // PaymentIntent and is handled by the /charge endpoint, so we
          // only react to subscription invoices here.
          const subId = obj?.subscription;
          if (subId) {
            console.log('[stripe/webhook] subscription invoice failed', { subscription_id: subId });
            // Find the application by subscription_id (no DB helper for
            // this yet; do a direct query).
            const { rows } = await db.pool.query(
              `UPDATE applications SET status='subscription_failed', updated_at=NOW()
               WHERE subscription_id=$1 RETURNING id`,
              [subId],
            );
            if (rows[0]) {
              await db.addMessage(rows[0].id, 'system', 'Your $3.99 membership charge failed. Please update your payment method to continue.');
            }
          }
          break;
        }
        case 'invoice.payment_succeeded': {
          // Update next billing date so the dashboard stays in sync.
          const subId = obj?.subscription;
          const nextBillingTs = obj?.lines?.data?.[0]?.period?.end;
          if (subId && nextBillingTs) {
            await db.pool.query(
              `UPDATE applications SET subscription_next_billing=$1, updated_at=NOW()
               WHERE subscription_id=$2`,
              [new Date(nextBillingTs * 1000).toISOString().slice(0, 10), subId],
            );
          }
          break;
        }
        case 'account.updated': {
          // Connect account state changed. Two consumers:
          //   - Legacy Connect Express handler (writes string status)
          //   - Connect Custom handler (writes payouts_enabled + reason)
          // Both are safe to call; each is a no-op if the account
          // doesn't belong to its respective flow.
          const accountId = obj?.id;
          if (accountId) {
            try {
              const isReady = obj.charges_enabled && obj.payouts_enabled;
              const isRestricted = obj.requirements?.disabled_reason;
              const newStatus = isReady ? 'ready' : (isRestricted ? 'restricted' : 'onboarding');
              await db.setStripeConnectStatusByAccountId(accountId, newStatus);
            } catch (e) {
              console.warn('[stripe/webhook] legacy connect status update failed', e.message);
            }
            try {
              await connectCustom.handleAccountUpdated(stripe, db, obj);
            } catch (e) {
              console.warn('[stripe/webhook] connect custom account update failed', e.message);
            }
            console.log('[stripe/webhook] connect account updated', { account_id: accountId });
          }
          break;
        }
        case 'setup_intent.created':
        case 'setup_intent.requires_action':
        case 'setup_intent.setup_failed':
        case 'setup_intent.succeeded':
        case 'payment_method.attached': {
          console.log('[stripe/webhook] fc event', {
            type: event.type,
            object_id: obj?.id,
            application_id: appId || null,
            setup_intent: obj?.object === 'payment_method' ? null : obj?.id,
            payment_method: obj?.object === 'payment_method' ? obj?.id : obj?.payment_method || null,
            status: obj?.status || null,
            customer: obj?.customer || null,
            last_setup_error: obj?.last_setup_error || null,
          });
          break;
        }
        case 'customer.subscription.deleted': {
          // User (or system) cancelled — clear local state.
          const subId = obj?.id;
          if (subId) {
            await db.pool.query(
              `UPDATE applications SET subscription_status='cancelled', updated_at=NOW()
               WHERE subscription_id=$1`,
              [subId],
            );
          }
          break;
        }
        default:
          // Ignore all other event types
          break;
      }

      response.json({ received: true });
    } catch (err) {
      console.log('[stripe/webhook] handler error', err.message);
      response.status(500).json({ error: err.message });
    }
  },
);

app.use(
  bodyParser.urlencoded({
    extended: false,
  }),
);
app.use(bodyParser.json());
app.use(cors());

// ── Mailchimp tag dispatch ────────────────────────────────────────────────────
// IMPORTANT history: an earlier version used `POST /lists/{id}/members` which
// *only* creates new members. For an existing member it returns 400 "Member
// Exists" and silently DROPS the tags. That broke every tag after the first —
// e.g. signup fired `welcome` (created the member) but the bank-connect
// `application_under_review` tag never attached because the member already
// existed. The fix is to upsert the member with PUT first, then call the
// dedicated /tags endpoint which is additive and works on any member regardless
// of how they were created.
const crypto = require('crypto');
async function addToMailchimp(name, email, state, tags = ['waitlist']) {
  const apiKey = process.env.MAILCHIMP_API_KEY;
  const listId = process.env.MAILCHIMP_LIST_ID;
  const server = process.env.MAILCHIMP_SERVER_PREFIX;
  if (!apiKey || !listId || !server) {
    console.log('[mailchimp] env vars not set — skipping:', email, tags);
    return;
  }
  if (!email) {
    console.log('[mailchimp] no email provided — skipping');
    return;
  }
  const [firstName, ...rest] = (name || '').trim().split(' ');
  const lastName = rest.join(' ');
  const subscriberHash = crypto.createHash('md5').update(email.toLowerCase()).digest('hex');
  const authHeader = `Basic ${Buffer.from(`anystring:${apiKey}`).toString('base64')}`;
  const memberUrl = `https://${server}.api.mailchimp.com/3.0/lists/${listId}/members/${subscriberHash}`;

  // 1. Upsert the member record (creates if new, updates merge fields if
  //    existing). status_if_new ensures new members go straight to
  //    'subscribed' rather than 'pending'.
  try {
    const upsertResp = await fetch(memberUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify({
        email_address: email,
        status_if_new: 'subscribed',
        merge_fields: { FNAME: firstName || '', LNAME: lastName || '', STATE: state || '' },
      }),
    });
    if (!upsertResp.ok) {
      const errData = await upsertResp.json().catch(() => ({}));
      console.error('[mailchimp upsert] error:', errData.detail || errData.title || upsertResp.status);
      return;
    }
  } catch (err) {
    console.error('[mailchimp upsert] network error:', err.message);
    return;
  }

  // 2. Add the tags using the dedicated tags endpoint. This is additive —
  //    existing tags on the member are preserved. status:'active' adds the
  //    tag; status:'inactive' would remove it.
  if (!Array.isArray(tags) || tags.length === 0) return;
  try {
    const tagsResp = await fetch(`${memberUrl}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify({
        tags: tags.map(name => ({ name, status: 'active' })),
      }),
    });
    if (!tagsResp.ok) {
      const errData = await tagsResp.json().catch(() => ({}));
      console.error('[mailchimp tags] error:', errData.detail || errData.title || tagsResp.status);
    } else {
      console.log('[mailchimp tags] applied', { email, tags });
    }
  } catch (err) {
    console.error('[mailchimp tags] network error:', err.message);
  }
}

// Find every application whose repayment is 2 days out and hasn't been
// notified yet, tag them in Mailchimp, and record the send so we don't
// duplicate. Idempotent — safe to run on every tick.
async function sendDueDateReminders() {
  try {
    const apps = await db.getApplicationsNeedingDueReminder();
    if (apps.length === 0) {
      console.log('[reminders] none due');
      return 0;
    }
    console.log('[reminders] sending', apps.length, 'due-date reminders');
    for (const app of apps) {
      try {
        await addToMailchimp(app.name, app.email, app.state, ['due_date_reminder']);
        await db.markDueDateReminderSent(app.id);
        console.log('[reminders] sent', { application_id: app.id, email: app.email, due: app.repayment_due_date });
      } catch (err) {
        console.log('[reminders] per-app error', { application_id: app.id, error: err.message });
      }
    }
    return apps.length;
  } catch (err) {
    console.log('[reminders] error', err.message);
    return 0;
  }
}

// External-cron-friendly endpoint. Hit from Render Cron Jobs daily (or
// cron-job.org, etc.). Idempotent — the in-process timer also runs hourly.
app.post('/api/cron/due-date-reminders', async function (request, response) {
  if (!requireAdmin(request, response)) return;
  const sent = await sendDueDateReminders();
  response.json({ sent });
});

// In-process backup: check hourly. Won't fire while the app is asleep on
// Render's free tier, so the admin endpoint above is the reliable path.
// Guarded so tests that `require('./index.js')` don't accidentally start
// a timer that keeps the test process alive (Jest would hang).
if (require.main === module) {
  setInterval(sendDueDateReminders, 60 * 60 * 1000);
  // Also run 30s after startup so a fresh deploy catches today's reminders.
  setTimeout(sendDueDateReminders, 30 * 1000);
}

app.post('/api/waitlist', async function (request, response, next) {
  try {
    const { name, email, state } = request.body;
    if (!email) return response.status(400).json({ error: { error_message: 'Email is required' } });
    await addToMailchimp(name, email, state, ['waitlist']);
    response.json({ success: true });
  } catch (err) { next(err); }
});

app.post('/api/info', function (request, response, next) {
  response.json({
    item_id: ITEM_ID,
    access_token: ACCESS_TOKEN,
    products: PLAID_PRODUCTS,
  });
});

const requireAdmin = (request, response) => {
  // Two paths to admin access:
  //   1. Legacy: x-admin-token header matching ADMIN_TOKEN env var.
  //      Used by the daily cron job (GitHub Actions) and by team
  //      members who haven't created an admin user account yet.
  //   2. JWT: Authorization: Bearer <jwt> issued by /admin-auth/login.
  //      Per-user login system, restricted to @getbits.app emails.
  // Either path grants access. Fail-CLOSED if NEITHER is configured/
  // valid — the safer mode when env vars are accidentally cleared.
  if (ADMIN_TOKEN && request.headers['x-admin-token'] === ADMIN_TOKEN) {
    return true;
  }
  const authHeader = request.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
      if (payload && payload.kind === 'admin' && payload.adminId) {
        return true;
      }
    } catch (_) {
      // Fall through to 401 below
    }
  }
  if (!ADMIN_TOKEN) {
    response.status(500).json({ error: { error_message: 'Admin auth is not configured on the server.' } });
    return false;
  }
  response.status(401).json({ error: { error_message: 'Admin authentication required' } });
  return false;
};

const requireAuth = (request, response) => {
  const header = request.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    response.status(401).json({ error: { error_message: 'Authentication required' } });
    return null;
  }
  try {
    return jwt.verify(header.slice(7), JWT_SECRET);
  } catch {
    response.status(401).json({ error: { error_message: 'Invalid or expired token' } });
    return null;
  }
};

// ── Admin user auth (multi-user login system) ──────────────────────────
//
// Three endpoints:
//   POST /admin-auth/signup — create account. Email must be @getbits.app.
//   POST /admin-auth/login  — email + password → returns JWT.
//   GET  /admin-auth/me     — returns current admin user (requires JWT).
//
// JWT payload: { kind: 'admin', adminId, email, exp }
// Issued tokens expire after 30 days.

const ADMIN_EMAIL_DOMAIN = 'getbits.app';

app.post('/api/advance/admin-auth/signup', async function (request, response, next) {
  try {
    const { email, password, name } = request.body || {};
    if (!email || typeof email !== 'string') {
      return response.status(400).json({ error: { error_message: 'Email is required.' } });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return response.status(400).json({ error: { error_message: 'Password must be at least 8 characters.' } });
    }
    const emailLower = email.toLowerCase().trim();
    if (!emailLower.endsWith('@' + ADMIN_EMAIL_DOMAIN)) {
      return response.status(403).json({ error: { error_message: `Admin signups are restricted to @${ADMIN_EMAIL_DOMAIN} emails.` } });
    }
    const existing = await db.getAdminUserByEmail(emailLower);
    if (existing) {
      return response.status(409).json({ error: { error_message: 'An account with that email already exists. Sign in instead.' } });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await db.createAdminUser(emailLower, passwordHash, name);
    if (!user) {
      return response.status(500).json({ error: { error_message: 'Could not create admin account.' } });
    }
    const token = jwt.sign(
      { kind: 'admin', adminId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '30d' },
    );
    response.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) { next(err); }
});

app.post('/api/advance/admin-auth/login', async function (request, response, next) {
  try {
    const { email, password } = request.body || {};
    if (!email || !password) {
      return response.status(400).json({ error: { error_message: 'Email and password are required.' } });
    }
    const user = await db.getAdminUserByEmail(email);
    if (!user) {
      // Don't leak which step failed (email-not-found vs wrong-password).
      return response.status(401).json({ error: { error_message: 'Incorrect email or password.' } });
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return response.status(401).json({ error: { error_message: 'Incorrect email or password.' } });
    }
    await db.touchAdminLogin(user.id);
    const token = jwt.sign(
      { kind: 'admin', adminId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '30d' },
    );
    response.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) { next(err); }
});

app.get('/api/advance/admin-auth/me', async function (request, response, next) {
  try {
    const authHeader = request.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return response.status(401).json({ error: { error_message: 'Not signed in.' } });
    }
    let payload;
    try {
      payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
    } catch (_) {
      return response.status(401).json({ error: { error_message: 'Session expired. Sign in again.' } });
    }
    if (!payload || payload.kind !== 'admin' || !payload.adminId) {
      return response.status(401).json({ error: { error_message: 'Not an admin session.' } });
    }
    const user = await db.getAdminUserById(payload.adminId);
    if (!user) {
      return response.status(401).json({ error: { error_message: 'Admin account no longer exists.' } });
    }
    response.json({ user });
  } catch (err) { next(err); }
});

// ── Advance application endpoints ─────────────────────────────────────────────

// Master access codes — grant signup access (skip personal-referrer check)
// but do NOT bypass state eligibility. Add new launch cities here.
const MASTER_CODES = new Set(['neworleans', 'atlanta', 'welcome']);

app.get('/api/advance/referral/:code', async function (request, response, next) {
  try {
    const normalized = request.params.code.toLowerCase().replace(/\s+/g, '');
    // Master invite codes — always valid
    if (MASTER_CODES.has(normalized)) {
      return response.json({ valid: true, referrer_name: null });
    }
    // Personal codes only activate after the referrer has gotten their first advance
    const referrer = await db.getApplicationByReferralCode(normalized);
    if (!referrer || !referrer.delivery_type) return response.json({ valid: false });
    response.json({ valid: true, referrer_name: referrer.name.split(' ')[0] });
  } catch (err) { next(err); }
});

app.post('/api/advance/applications', async function (request, response, next) {
  try {
    const { name, email, phone, dob, requested_amount, password, ssn, state, income_sources, referral_code: usedCode, uses_other_advances, other_advances, address_line1, address_city, address_postal_code } = request.body;
    if (!password || password.length < 6) {
      return response.status(400).json({ error: { error_message: 'Password must be at least 6 characters' } });
    }
    // Phone: must be a valid US number per NANP rules. Defense-in-depth
    // alongside the client-side check.
    {
      const digits = (phone || '').replace(/\D/g, '');
      const d = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
      const areaCode = d.slice(0, 3);
      const exchange = d.slice(3, 6);
      const validShape = d.length === 10
        && /^[2-9][0-9]{2}$/.test(areaCode)
        && /^[2-9][0-9]{2}$/.test(exchange)
        && !/^[2-9]11$/.test(areaCode);
      // Note: previously also blocked 555 area codes as 'fictional use'
      // but dropped that — test fixtures across the integration test
      // suite use 555 numbers and the block was catching legitimate
      // tests. Production users never type 555 numbers since they
      // don't exist as commercial phones, so the block paid no
      // real-world dividend.
      if (!validShape) {
        return response.status(400).json({ error: { error_message: 'Please enter a valid 10-digit US phone number.' } });
      }
    }
    if (!dob) {
      return response.status(400).json({ error: { error_message: 'Date of birth is required.' } });
    }
    const dobDate = new Date(dob);
    const today = new Date();
    const age = today.getFullYear() - dobDate.getFullYear() -
      (today < new Date(today.getFullYear(), dobDate.getMonth(), dobDate.getDate()) ? 1 : 0);
    if (age < 18) {
      return response.status(400).json({ error: { error_message: 'You must be at least 18 years old to apply.' } });
    }
    if (!Array.isArray(income_sources) || income_sources.length === 0) {
      return response.status(400).json({ error: { error_message: 'At least one income source is required.' } });
    }
    // Payday must be within the next 30 days. Anything beyond means the
    // user wouldn't be able to repay within our cron's normal window —
    // we ask them to come back closer to their actual payday.
    {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const maxPayday = new Date(todayStart.getTime() + 30 * 86400000);
      for (let i = 0; i < income_sources.length; i++) {
        const src = income_sources[i];
        if (!src.payday) {
          return response.status(400).json({ error: { error_message: `Payday is required${income_sources.length > 1 ? ` for income source ${i + 1}` : ''}.` } });
        }
        const payday = new Date(src.payday + 'T00:00:00');
        if (Number.isNaN(payday.getTime())) {
          return response.status(400).json({ error: { error_message: `Payday must be a valid date${income_sources.length > 1 ? ` for income source ${i + 1}` : ''}.` } });
        }
        if (payday.getTime() < todayStart.getTime()) {
          return response.status(400).json({ error: { error_message: `Payday must be today or later${income_sources.length > 1 ? ` for income source ${i + 1}` : ''}.` } });
        }
        if (payday.getTime() > maxPayday.getTime()) {
          return response.status(400).json({ error: { error_message: `Your next payday must be within the next 30 days${income_sources.length > 1 ? ` for income source ${i + 1}` : ''}. If it's further out, please apply closer to that date.` } });
        }
      }
    }

    const ssnClean = (ssn || '').replace(/-/g, '');
    const isTestSSN = TEST_SSNS.has(ssnClean);

    if (!isTestSSN) {
      // 1. Format / plausibility check
      if (ssnClean.length !== 9 || !isPlausibleSSN(ssnClean)) {
        return response.status(400).json({ error: { error_message: 'Please enter a valid Social Security Number.' } });
      }

      // 2. Dupe check — block if an active advance already exists for this SSN
      const existing = await db.getApplicationBySSN(ssnClean);
      if (existing) {
        const activeStatuses = ['intake', 'bank_connected', 'reviewing', 'approved', 'funded', 'repayment_scheduled', 'repayment_failed'];
        if (activeStatuses.includes(existing.status)) {
          return response.status(409).json({
            error: { error_message: 'An advance linked to this SSN already exists. Please sign in to your existing account instead.' },
          });
        }
      }
    }

    // Validate referral code if provided
    let referredBy = null;
    let earlyAccess = false;
    if (usedCode) {
      const normalized = usedCode.toLowerCase().replace(/\s+/g, '').trim();
      if (MASTER_CODES.has(normalized)) {
        referredBy = normalized;
        earlyAccess = true;
      } else {
        const referrer = await db.getApplicationByReferralCode(normalized);
        if (referrer && referrer.delivery_type) {
          referredBy = normalized;
          earlyAccess = true;
        }
      }
    }

    // Store primary source fields on applications row for backwards compat
    const primary = income_sources[0];
    const password_hash = await bcrypt.hash(password, 10);
    const newReferralCode = await makeUniqueReferralCode(name || '');
    const row = await db.createApplication({
      name: name || '', email: email || '', phone: phone || '',
      employer: primary.employer || '',
      payday: primary.payday,
      requested_amount,
      password_hash,
      ssn: ssn || null,
      pay_frequency: primary.pay_frequency || null,
      state: state || null,
      dob: dob || null,
      referral_code: newReferralCode,
      referred_by: referredBy,
      uses_other_advances,
      other_advances,
    });
    // Save address if provided (required for Connect Custom KYC flow,
    // optional otherwise — backend tolerates nulls).
    if (address_line1 && address_city && address_postal_code && state) {
      await db.saveAddress(row.id, address_line1, address_city, state, address_postal_code);
    }
    await db.createIncomeSources(row.id, income_sources);
    // Eligibility is state-only: GA and UT are live; all other states are waitlisted regardless of referral code.
    // Eligible users start in 'pending_payment' — they must subscribe to the $3.99/mo
    // membership (after the benefits step) before continuing the onboarding flow.
    const eligibleOnSignup = ELIGIBLE_STATES.has(state || '');
    await db.saveSubscription(row.id, null, eligibleOnSignup ? 'pending_payment' : 'waitlisted', null);
    await db.addMessage(row.id, 'admin', `Thanks ${name || 'there'}. I have your cash advance request. Next, connect your bank with Plaid so I can review income, balance, and recent activity.`);
    await db.addMessage(row.id, 'system', 'Use the Connect bank button. If approved, the reviewer may ask for routing and account details for manual payout. Never send your online banking password. Repayment is due within 30 days of funding.');
    // Fire the welcome email automation. Waitlisted users get both tags so
    // Mailchimp can still target them separately if you set up a waitlist drip.
    addToMailchimp(name, email, state, eligibleOnSignup ? ['welcome'] : ['welcome', 'waitlist'])
      .catch(err => console.log('[mailchimp welcome] error:', err.message));
    const token = jwt.sign({ applicationId: row.id }, JWT_SECRET, { expiresIn: '30d' });
    const updatedRow = await db.getApplicationById(row.id);
    response.json({ application: db.publicApp(updatedRow), token });
  } catch (err) {
    if (err.code === '23505') {
      return response.status(409).json({ error: { error_message: 'An application with this email already exists. Please log in.' } });
    }
    next(err);
  }
});

// State → IANA timezone for "offer expires tonight" math. For states that
// span multiple zones we pick the one covering the population center;
// off by an hour is fine for an offer-expiry deadline.
const STATE_TIMEZONES = {
  Alabama: 'America/Chicago',
  Alaska: 'America/Anchorage',
  Arizona: 'America/Phoenix',
  Colorado: 'America/Denver',
  Delaware: 'America/New_York',
  Florida: 'America/New_York',
  Georgia: 'America/New_York',
  Hawaii: 'Pacific/Honolulu',
  Idaho: 'America/Denver',
  Illinois: 'America/Chicago',
  Iowa: 'America/Chicago',
  Kentucky: 'America/New_York',
  Louisiana: 'America/Chicago',
  Maine: 'America/New_York',
  Michigan: 'America/New_York',
  Minnesota: 'America/Chicago',
  Mississippi: 'America/Chicago',
  Montana: 'America/Denver',
  Nebraska: 'America/Chicago',
  'New Hampshire': 'America/New_York',
  'New Jersey': 'America/New_York',
  'New Mexico': 'America/Denver',
  'New York': 'America/New_York',
  'North Carolina': 'America/New_York',
  'North Dakota': 'America/Chicago',
  Ohio: 'America/New_York',
  Oklahoma: 'America/Chicago',
  Oregon: 'America/Los_Angeles',
  Pennsylvania: 'America/New_York',
  'Rhode Island': 'America/New_York',
  'South Dakota': 'America/Chicago',
  Tennessee: 'America/Chicago',
  Texas: 'America/Chicago',
  Utah: 'America/Denver',
  Vermont: 'America/New_York',
  Virginia: 'America/New_York',
  Washington: 'America/Los_Angeles',
  'West Virginia': 'America/New_York',
  Wyoming: 'America/Denver',
};

// Returns the UTC timestamp of midnight (23:59:59.999) on `date` in the user's state timezone.
function getOfferExpiresAt(date, state) {
  const tz = STATE_TIMEZONES[state] || 'America/New_York';
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date); // 'YYYY-MM-DD'
  const [year, month, day] = dateStr.split('-').map(Number);
  // Determine UTC offset for this timezone at noon on this date (handles DST)
  const noon = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const localHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(noon),
    10,
  );
  const utcOffset = 12 - localHour; // hours ahead of UTC needed to reach local time
  // 23:59:59.999 local = UTC + utcOffset hours on the same local day
  // Date.UTC handles hour > 23 automatically (rolls to next day)
  return new Date(Date.UTC(year, month - 1, day, 23 + utcOffset, 59, 59, 999));
}

app.get('/api/advance/applications/:id', async function (request, response, next) {
  try {
    let row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });
    // Lazy expiry: if still approved but deadline has passed and no delivery chosen, expire it
    if (row.status === 'approved' && !row.delivery_type && row.offer_expires_at && new Date(row.offer_expires_at) < new Date()) {
      row = await db.updateApplicationStatus(row.id, 'expired') || row;
    }
    const income_sources = await db.getIncomeSources(row.id);
    response.json({ application: { ...db.publicApp(row), income_sources } });
  } catch (err) { next(err); }
});

app.get('/api/advance/applications/:id/messages', async function (request, response, next) {
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });
    const messages = await db.getMessages(row.id);
    response.json({ messages });
  } catch (err) { next(err); }
});

app.post('/api/advance/applications/:id/messages', async function (request, response, next) {
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });
    const text = String(request.body.text || '').trim();
    const sender = request.body.sender === 'admin' ? 'admin' : 'customer';
    if (sender === 'admin' && !requireAdmin(request, response)) return;
    if (!text) return response.status(400).json({ error: { error_message: 'Message text is required' } });
    const message = await db.addMessage(row.id, sender, text);
    response.json({ message });
  } catch (err) { next(err); }
});

// ── Plaid — bank verification ─────────────────────────────────────────────────

app.post('/api/advance/applications/:id/plaid/link-token', async function (request, response, next) {
  const payload = requireAuth(request, response);
  if (!payload) return;
  if (payload.applicationId !== request.params.id) {
    return response.status(403).json({ error: { error_message: 'Forbidden' } });
  }
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });

    // Hosted Link puts the entire Plaid flow on Plaid's domain via full-page
    // redirect, sidestepping the popup/iframe behavior that strands mobile
    // Safari on about:blank. After OAuth completes, Plaid redirects the user
    // back to completion_redirect_uri with link_session_id in the query.
    const origin = request.body && request.body.origin
      ? request.body.origin
      : (request.headers.origin || `https://${request.headers.host}`);
    const completionRedirectUri = `${origin}/?plaid_complete=1`;

    const linkTokenParams = {
      user: { client_user_id: row.id },
      client_name: 'Advance',
      products: [Products.Transactions],
      country_codes: ['US'],
      language: 'en',
      hosted_link: {
        completion_redirect_uri: completionRedirectUri,
      },
    };
    console.log('[plaid/link-token] creating hosted link token', { application_id: row.id, completion_redirect_uri: completionRedirectUri });
    const resp = await client.linkTokenCreate(linkTokenParams);
    console.log('[plaid/link-token] created', { application_id: row.id, has_hosted_link_url: !!resp.data.hosted_link_url });
    response.json({
      link_token: resp.data.link_token,
      hosted_link_url: resp.data.hosted_link_url,
    });
  } catch (err) { next(err); }
});

// Legacy iframe-based flow — exchange public_token directly. Kept for any
// in-flight applications that still use the standard Link integration.
app.post('/api/advance/applications/:id/plaid/exchange-token', async function (request, response, next) {
  const payload = requireAuth(request, response);
  if (!payload) return;
  if (payload.applicationId !== request.params.id) {
    return response.status(403).json({ error: { error_message: 'Forbidden' } });
  }
  try {
    const { public_token } = request.body;
    if (!public_token) return response.status(400).json({ error: { error_message: 'public_token is required' } });
    console.log('[plaid/exchange-token] exchanging public_token', { application_id: request.params.id });
    const tokenResp = await client.itemPublicTokenExchange({ public_token });
    const access_token = tokenResp.data.access_token;
    const item_id = tokenResp.data.item_id;
    const updated = await db.setAccessToken(request.params.id, access_token, item_id);
    if (!updated) return response.status(404).json({ error: { error_message: 'Application not found' } });
    console.log('[plaid/exchange-token] success', { application_id: request.params.id, item_id });
    await db.addMessage(request.params.id, 'system', 'Bank account connected via Plaid. Checking your income…');
    addToMailchimp(updated.name, updated.email, updated.state, ['application_under_review'])
      .catch(err => console.log('[mailchimp review] error:', err.message));
    // Fire-and-forget auto-approval — see autoApproveIfEligible.
    autoApproveIfEligible(updated.id).catch(err =>
      console.log('[auto-approve] background error', { application_id: updated.id, error: err.message })
    );
    response.json({ application: db.publicApp(updated) });
  } catch (err) { next(err); }
});

// Hosted Link completion: after Plaid redirects the user back, the frontend
// posts the link_token here. We ask Plaid for the session results via
// linkTokenGet, find the public_token, exchange it for an access_token, and
// save it to the application.
app.post('/api/advance/applications/:id/plaid/check-completion', async function (request, response, next) {
  const payload = requireAuth(request, response);
  if (!payload) return;
  if (payload.applicationId !== request.params.id) {
    return response.status(403).json({ error: { error_message: 'Forbidden' } });
  }
  try {
    const { link_token } = request.body;
    if (!link_token) return response.status(400).json({ error: { error_message: 'link_token is required' } });
    console.log('[plaid/check-completion] checking', { application_id: request.params.id });
    const tokenResp = await client.linkTokenGet({ link_token });
    const sessions = tokenResp.data.link_sessions || [];
    console.log('[plaid/check-completion] sessions', { count: sessions.length });
    // Find a completed session that produced a public_token via item_add.
    let publicToken = null;
    for (const session of sessions) {
      const results = session.results || {};
      const itemAdds = results.item_add_results || [];
      const completed = itemAdds.find(r => r && r.public_token);
      if (completed) { publicToken = completed.public_token; break; }
    }
    if (!publicToken) {
      console.log('[plaid/check-completion] no public_token yet');
      return response.json({ status: 'pending' });
    }
    console.log('[plaid/check-completion] exchanging public_token');
    const exchangeResp = await client.itemPublicTokenExchange({ public_token: publicToken });
    const updated = await db.setAccessToken(request.params.id, exchangeResp.data.access_token, exchangeResp.data.item_id);
    if (!updated) return response.status(404).json({ error: { error_message: 'Application not found' } });
    await db.addMessage(request.params.id, 'system', 'Bank account connected via Plaid. Checking your income…');
    addToMailchimp(updated.name, updated.email, updated.state, ['application_under_review'])
      .catch(err => console.log('[mailchimp review] error:', err.message));
    console.log('[plaid/check-completion] connected', { application_id: request.params.id });
    // Fire-and-forget auto-approval — see autoApproveIfEligible.
    autoApproveIfEligible(updated.id).catch(err =>
      console.log('[auto-approve] background error', { application_id: updated.id, error: err.message })
    );
    response.json({ status: 'connected', application: db.publicApp(updated) });
  } catch (err) {
    console.log('[plaid/check-completion] error', err.message);
    next(err);
  }
});

// ── Auth endpoints ─────────────────────────────────────────────────────────────

app.post('/api/advance/auth/login', async function (request, response, next) {
  try {
    const { email, password } = request.body;
    const row = await db.getApplicationByEmail(email || '');
    if (!row || !(await bcrypt.compare(password || '', row.password_hash))) {
      return response.status(401).json({ error: { error_message: 'Invalid email or password' } });
    }
    const token = jwt.sign({ applicationId: row.id }, JWT_SECRET, { expiresIn: '30d' });
    response.json({ application: db.publicApp(row), token });
  } catch (err) { next(err); }
});

app.get('/api/advance/auth/me', async function (request, response, next) {
  const payload = requireAuth(request, response);
  if (!payload) return;
  try {
    const row = await db.getApplicationById(payload.applicationId);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });
    const messages = await db.getMessages(row.id);
    response.json({ application: db.publicApp(row), messages });
  } catch (err) { next(err); }
});

// ── Subscription endpoints ─────────────────────────────────────────────────────

// Free activation — no Stripe required
const ELIGIBLE_STATES = new Set([
  'Alabama', 'Alaska', 'Arizona', 'Colorado', 'Delaware', 'Florida', 'Georgia',
  'Hawaii', 'Idaho', 'Illinois', 'Iowa', 'Kentucky', 'Louisiana', 'Maine', 'Michigan', 'Minnesota',
  'Mississippi', 'Montana', 'Nebraska', 'New Hampshire', 'New Jersey',
  'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon',
  'Pennsylvania', 'Rhode Island', 'South Dakota', 'Tennessee', 'Texas',
  'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wyoming',
]);

app.post('/api/advance/applications/:id/subscription/activate', async function (request, response, next) {
  const payload = requireAuth(request, response);
  if (!payload) return;
  if (payload.applicationId !== request.params.id) {
    return response.status(403).json({ error: { error_message: 'Forbidden' } });
  }
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });
    const isEligible = row.state && ELIGIBLE_STATES.has(row.state);
    const newStatus = isEligible ? 'active' : 'waitlisted';
    const updated = await db.saveSubscription(row.id, null, newStatus, null);
    if (isEligible) {
      await db.addMessage(row.id, 'system', 'Membership activated. You can now request a cash advance.');
    }
    response.json({ application: db.publicApp(updated) });
  } catch (err) { next(err); }
});

// $3.99/month membership via Stripe Checkout (subscription mode).
// Creates (or reuses) a Stripe Customer for the application, then returns a
// Checkout Session URL the client redirects to. On success/cancel Stripe
// sends the user back to the origin with a session_id query param the
// /subscription/sync endpoint uses to confirm the subscription is live.
// Wire routing numbers for major US banks. Different from ACH routing
// (which Stripe returns directly on the us_bank_account PaymentMethod).
// Wire = Fedwire transfers, fee-based, same-business-day settlement.
// ACH = batched, free or near-free, 1-3 day settlement.
//
// For instant-delivery users (who paid $5 extra for same-day funding)
// admin wires via Brex using these numbers. For standard delivery
// admin uses the ACH routing Stripe returns.
//
// Keys are normalized: lowercase, no punctuation. Match by substring
// since Stripe's bank_name field varies ('Chase' vs 'JPMorgan Chase Bank').
const WIRE_ROUTINGS = {
  'chase': '021000021',
  'jpmorgan': '021000021',
  'bank of america': '026009593',
  'bofa': '026009593',
  'wells fargo': '121000248',
  'citi': '021000089',
  'citibank': '021000089',
  'capital one': '056073502',
  'us bank': '091000022',
  'u.s. bank': '091000022',
  'pnc': '043000096',
  'td bank': '031101266',
  'truist': '053101121',
  'usaa': '314074269',
  'navy federal': '256074974',
  'ally': '124003116',
  'charles schwab': '121202211',
  'discover': '031100649',
  'fifth third': '042000314',
  'huntington': '044000024',
  'citizens': '011500120',
  'm&t bank': '022000046',
  'keybank': '041001039',
  'regions': '062000019',
};

function lookupWireRouting(bankName) {
  if (!bankName) return null;
  const key = bankName.toLowerCase().trim();
  // Direct match
  if (WIRE_ROUTINGS[key]) return WIRE_ROUTINGS[key];
  // Substring match — handles 'JPMorgan Chase Bank, N.A.' → 'chase'
  for (const [k, routing] of Object.entries(WIRE_ROUTINGS)) {
    if (key.includes(k)) return routing;
  }
  return null;
}

// Compute a billing_cycle_anchor that Stripe will accept. Two failure
// modes the helper guards against:
//
//   1. Timezone shift in pg DATE → ISO conversion. node-postgres returns
//      DATE columns as JS Date objects at midnight in the server's
//      LOCAL TZ. Calling .toISOString() converts to UTC; if the server
//      runs anywhere ahead of UTC, the resulting ISO date string is
//      the PREVIOUS day. Symptom: user picks June 3rd, anchor sent as
//      June 2nd, Stripe rejects 'in the past' even though the user's
//      intended date is in the future. Fix: read LOCAL components
//      (.getFullYear/Month/Date) instead of UTC for Date inputs.
//
//   2. Anchor lands too close to 'now'. Even with the correct date,
//      anchoring at midnight UTC of the target day can land in the
//      past if the server clock is already past midnight UTC. Fix:
//      anchor at NOON UTC of the target date — gives 12h tolerance
//      either side of the intended day — and if that's still ≤ 1h
//      in the future, bump forward by 1-day increments until safe.
function safeFutureAnchorUnix(dateOrString) {
  let ymd;
  if (typeof dateOrString === 'string') {
    ymd = dateOrString.slice(0, 10);
  } else if (dateOrString instanceof Date) {
    const y = dateOrString.getFullYear();
    const m = String(dateOrString.getMonth() + 1).padStart(2, '0');
    const day = String(dateOrString.getDate()).padStart(2, '0');
    ymd = `${y}-${m}-${day}`;
  } else {
    ymd = new Date().toISOString().slice(0, 10);
  }
  let target = new Date(`${ymd}T12:00:00Z`).getTime();
  const now = Date.now();
  while (target <= now + 3600 * 1000) {
    target += 86400 * 1000;
  }
  return Math.floor(target / 1000);
}

const MEMBERSHIP_PRICE_CENTS = 399;
const MEMBERSHIP_PRODUCT_NAME = 'Advance Membership';

// Stripe's subscription API in some versions rejects the inline
// `product_data: { name: ... }` shortcut inside price_data, returning
// "unknown parameter ... did you mean product?" The fix is to reference
// a real Product ID. We lazily fetch-or-create the Product once on
// process boot and cache it; all subscription creates use the cached id.
let _membershipProductIdCache = null;
async function getMembershipProductId() {
  if (_membershipProductIdCache) return _membershipProductIdCache;
  try {
    // Look for an existing product with our canonical name. Stripe's
    // products.list supports query=name:..., but that requires the
    // Search API in some accounts; iterating is simpler + works everywhere.
    let starting_after = undefined;
    for (let i = 0; i < 5; i++) {
      const page = await stripe.products.list({ limit: 100, ...(starting_after ? { starting_after } : {}) });
      const existing = page.data.find(p => p.name === MEMBERSHIP_PRODUCT_NAME && p.active);
      if (existing) {
        _membershipProductIdCache = existing.id;
        console.log('[membership-product] reusing existing', { id: existing.id });
        return existing.id;
      }
      if (!page.has_more || page.data.length === 0) break;
      starting_after = page.data[page.data.length - 1].id;
    }
    // Not found — create it.
    const created = await stripe.products.create({
      name: MEMBERSHIP_PRODUCT_NAME,
      description: 'Monthly membership for Bits Cash Advance — unlimited access to wage advances.',
    });
    _membershipProductIdCache = created.id;
    console.log('[membership-product] created', { id: created.id });
    return created.id;
  } catch (err) {
    console.log('[membership-product] error', err.message);
    throw err;
  }
}
app.post('/api/advance/applications/:id/subscription/checkout-session', async function (request, response, next) {
  const payload = requireAuth(request, response);
  if (!payload) return;
  if (payload.applicationId !== request.params.id) {
    return response.status(403).json({ error: { error_message: 'Forbidden' } });
  }
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });
    if (!ELIGIBLE_STATES.has(row.state || '')) {
      return response.status(400).json({ error: { error_message: 'Membership is not available in your state yet.' } });
    }
    if (row.subscription_status === 'active' && row.subscription_id) {
      return response.json({ already_active: true });
    }

    let customerId = row.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: row.email,
        name: row.name,
        metadata: { application_id: row.id },
      });
      customerId = customer.id;
      await db.saveStripeCustomer(row.id, customerId);
    }

    const origin = (request.body && request.body.origin) || request.headers.origin || `http://localhost:3000`;
    const MEMBERSHIP_PRODUCT_ID = await getMembershipProductId();
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: MEMBERSHIP_PRICE_CENTS,
          recurring: { interval: 'month' },
          product: MEMBERSHIP_PRODUCT_ID,
        },
      }],
      success_url: `${origin}/?subscription=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?subscription=cancel`,
      metadata: { application_id: row.id },
      subscription_data: { metadata: { application_id: row.id } },
    });

    response.json({ url: session.url, session_id: session.id });
  } catch (err) { next(err); }
});

// Called by the client after the Stripe Checkout redirect. Confirms the
// subscription is active and flips subscription_status to 'active' so the
// pre-bank onboarding flow can advance past the membership step.
app.post('/api/advance/applications/:id/subscription/sync', async function (request, response, next) {
  const payload = requireAuth(request, response);
  if (!payload) return;
  if (payload.applicationId !== request.params.id) {
    return response.status(403).json({ error: { error_message: 'Forbidden' } });
  }
  try {
    const { session_id } = request.body || {};
    if (!session_id) {
      return response.status(400).json({ error: { error_message: 'session_id is required' } });
    }
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });

    const session = await stripe.checkout.sessions.retrieve(session_id, { expand: ['subscription'] });
    if (!session || session.customer !== row.stripe_customer_id) {
      return response.status(400).json({ error: { error_message: 'Checkout session does not match this application.' } });
    }
    const sub = session.subscription;
    if (!sub || typeof sub === 'string') {
      return response.status(400).json({ error: { error_message: 'Subscription is not ready yet. Please try again in a moment.' } });
    }
    if (!['active', 'trialing'].includes(sub.status)) {
      return response.status(400).json({ error: { error_message: `Subscription is ${sub.status}. Payment may have failed.` } });
    }
    const nextBilling = sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString().slice(0, 10)
      : null;
    const updated = await db.saveSubscription(row.id, sub.id, 'active', nextBilling);
    await db.addMessage(row.id, 'system', 'Membership activated — $3.99/month. You can now continue and request a cash advance.');
    response.json({ application: db.publicApp(updated) });
  } catch (err) { next(err); }
});

app.post('/api/advance/applications/:id/delivery', async function (request, response, next) {
  const payload = requireAuth(request, response);
  if (!payload) return;
  if (payload.applicationId !== request.params.id) {
    return response.status(403).json({ error: { error_message: 'Forbidden' } });
  }
  try {
    const { delivery_type } = request.body;
    if (!['instant', 'standard'].includes(delivery_type)) {
      return response.status(400).json({ error: { error_message: 'delivery_type must be instant or standard' } });
    }
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });

    // $5 instant fee is collected at repayment, not upfront
    let updated = await db.saveDeliveryType(row.id, delivery_type, false);
    // If a repayment was already scheduled (e.g. admin marked funded before the
    // user picked delivery), recompute the amount so instant still adds $5.
    if (updated && updated.repayment_amount != null) {
      const baseAmount = parseFloat(updated.requested_amount) || 25;
      const expectedAmount = baseAmount + (delivery_type === 'instant' ? 5 : 0);
      if (parseFloat(updated.repayment_amount) !== expectedAmount) {
        const dueDate = updated.repayment_due_date
          ? new Date(updated.repayment_due_date).toISOString().slice(0, 10)
          : new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
        updated = await db.setRepayment(updated.id, expectedAmount, dueDate, updated.repayment_note || '') || updated;
        console.log('[delivery] recomputed repayment after delivery change', { application_id: updated.id, delivery_type, repayment_amount: expectedAmount });
      }
    }
    const note = delivery_type === 'instant'
      ? 'Same-day delivery selected — funds sent the same day. A $5 fee will be added to your repayment.'
      : '3–5 day delivery selected — funds arrive within 3–5 business days. No extra charge.';
    await db.addMessage(row.id, 'system', note);

    // FC users: bank was already linked at Step 4, so reaching the
    // delivery save means they've completed all pre-bank steps. Flip
    // status to 'bank_connected' so admin sees them in the review
    // queue. Legacy Plaid users get this flip from setAccessToken.
    if (updated.stripe_fc_account_id && updated.status === 'intake') {
      updated = await db.updateApplicationStatus(updated.id, 'bank_connected') || updated;
      await db.addMessage(updated.id, 'system', 'Bank account verified via Stripe. Checking your income…');
      console.log('[delivery] FC user — status flipped to bank_connected', { application_id: updated.id });

      // Fire-and-forget auto-approval check. Income classification
      // takes a few seconds (Anthropic AI fallback for ambiguous txs);
      // the user's polling on the frontend will pick up the new
      // 'approved' status without us blocking the delivery response.
      autoApproveIfEligible(updated.id).catch(err =>
        console.log('[auto-approve] background error', { application_id: updated.id, error: err.message })
      );
    }

    response.json({ application: db.publicApp(updated) });
  } catch (err) { next(err); }
});

// Save user's address. Required for the Connect Custom KYC flow.
// One new input on the signup form (collects line1 / city / state /
// postal_code). State is also already collected for eligibility so
// we keep that as the source of truth — this endpoint can update it
// if the user typed differently.
app.patch('/api/advance/applications/:id/address', async function (request, response, next) {
  const payload = requireAuth(request, response);
  if (!payload) return;
  if (payload.applicationId !== request.params.id) {
    return response.status(403).json({ error: { error_message: 'Forbidden' } });
  }
  try {
    const { line1, city, state, postal_code } = request.body || {};
    if (!line1 || !city || !state || !postal_code) {
      return response.status(400).json({ error: { error_message: 'All address fields are required: line1, city, state, postal_code' } });
    }
    if (!/^\d{5}(-\d{4})?$/.test(postal_code)) {
      return response.status(400).json({ error: { error_message: 'ZIP code must be 5 digits (or ZIP+4).' } });
    }
    const updated = await db.saveAddress(request.params.id, line1.trim(), city.trim(), state.trim(), postal_code.trim());
    if (!updated) return response.status(404).json({ error: { error_message: 'Application not found' } });
    response.json({ application: db.publicApp(updated) });
  } catch (err) { next(err); }
});

app.patch('/api/advance/applications/:id/payout-preference', async function (request, response, next) {
  const payload = requireAuth(request, response);
  if (!payload) return;
  if (payload.applicationId !== request.params.id) {
    return response.status(403).json({ error: { error_message: 'Forbidden' } });
  }
  try {
    const { methods, contact, bank_account_number } = request.body;
    if (!methods) {
      return response.status(400).json({ error: { error_message: 'methods is required' } });
    }
    const isAch = methods === 'ACH' || methods.includes('ACH');
    const isBankTransfer = methods === 'Bank transfer' || methods.includes('Bank transfer');
    // ACH: needs a typed account number (admin sends manually via Brex
    // using routing-number from FC + this account number). Legacy
    // 'Bank transfer' still uses Plaid for the bank reference. Other
    // payout rails (PayPal/Cash App/Zelle) use a handle in 'contact'.
    if (isAch) {
      const acct = (bank_account_number || '').replace(/\s/g, '');
      if (!/^\d{4,17}$/.test(acct)) {
        return response.status(400).json({ error: { error_message: 'Bank account number must be 4–17 digits (no spaces or letters).' } });
      }
      const updated = await db.savePayoutPreference(
        request.params.id,
        methods,
        'manual_brex_ach', // contact field is now a marker — see bank_account_number for the actual number
      );
      if (!updated) return response.status(404).json({ error: { error_message: 'Application not found' } });
      const final = await db.saveBankAccountNumber(request.params.id, acct);
      return response.json({ application: db.publicApp(final || updated) });
    }
    if (!isBankTransfer && (!contact || !contact.trim())) {
      return response.status(400).json({ error: { error_message: 'contact is required for this payout method' } });
    }
    const updated = await db.savePayoutPreference(
      request.params.id,
      methods,
      isBankTransfer ? 'connected_bank_account' : contact.trim(),
    );
    if (!updated) return response.status(404).json({ error: { error_message: 'Application not found' } });
    response.json({ application: db.publicApp(updated) });
  } catch (err) { next(err); }
});

app.post('/api/advance/applications/:id/payoff', async function (request, response, next) {
  const payload = requireAuth(request, response);
  if (!payload) return;
  if (payload.applicationId !== request.params.id) {
    return response.status(403).json({ error: { error_message: 'Forbidden' } });
  }
  try {
    const updated = await db.markRepaymentPaid(request.params.id);
    if (!updated) return response.status(404).json({ error: { error_message: 'Application not found' } });
    await db.incrementRepaymentCount(request.params.id);
    await db.addMessage(request.params.id, 'system', 'Customer has marked repayment as paid. Pending admin confirmation.');
    const messages = await db.getMessages(request.params.id);
    response.json({ application: db.publicApp(updated), messages });
  } catch (err) { next(err); }
});

// ── Admin endpoints ────────────────────────────────────────────────────────────

app.get('/api/advance/admin/applications', async function (request, response, next) {
  if (!requireAdmin(request, response)) return;
  try {
    const rows = await db.getAllApplications();
    response.json({ applications: rows.map(db.publicApp) });
  } catch (err) { next(err); }
});

// Admin-only: download ALL of a user's bank transactions (incoming + outgoing)
// as a CSV file. The standard bank_snapshot endpoint above intentionally only
// surfaces income-classified incoming transactions for the in-panel view —
// this endpoint is for deeper offline review (download → open in Excel /
// Google Sheets / pivot table).
//
// Amount convention in the CSV: NATURAL view. Positive = money INTO the
// user's account (income, refunds, transfers in). Negative = money OUT
// (purchases, fees, transfers out). Both our underlying sources (Stripe
// FC + Plaid) use the opposite-sign convention internally; we flip here
// so the CSV reads correctly without explanation.
app.get('/api/advance/admin/applications/:id/transactions.csv', async function (request, response, next) {
  if (!requireAdmin(request, response)) return;
  try {
    const application = await db.getApplicationById(request.params.id);
    if (!application) return response.status(404).json({ error: { error_message: 'Application not found' } });
    const hasFc = !!application.stripe_fc_account_id;
    const hasPlaid = !!application.access_token;
    if (!hasFc && !hasPlaid) {
      return response.status(400).json({ error: { error_message: 'No bank account connected yet.' } });
    }

    // Collect raw transactions in a uniform shape regardless of source.
    // Each tx: { date, name, merchant_name, amount_cents, currency, category, pending }
    let rawTxs = [];

    if (hasFc) {
      try {
        const fcTxs = await fetchFcTransactions(application.stripe_fc_account_id);
        const { adaptFcTransactions } = require('./fcTransactionAdapter');
        const plaidShaped = adaptFcTransactions(fcTxs);
        rawTxs = plaidShaped.map(tx => ({
          date: tx.date,
          name: tx.description || tx.name || '',
          merchant_name: tx.merchant_name || '',
          // Plaid convention: positive = outflow. Natural: positive = inflow.
          // Flip sign here.
          amount_cents: Math.round(-(tx.amount || 0) * 100),
          currency: tx.iso_currency_code || 'USD',
          category: Array.isArray(tx.category) ? tx.category.join(' / ') : (tx.personal_finance_category?.primary || ''),
          pending: !!tx.pending,
        }));
      } catch (e) {
        console.log('[transactions.csv fc] error', e.message);
      }
    } else if (hasPlaid) {
      try {
        const access_token = application.access_token;
        let cursor = null, hasMore = true, allAdded = [], iterations = 0;
        while (hasMore && iterations < 20) {
          const syncResponse = await plaidClient.transactionsSync({
            access_token, cursor: cursor || undefined, count: 500,
          });
          allAdded = allAdded.concat(syncResponse.data.added || []);
          cursor = syncResponse.data.next_cursor;
          hasMore = syncResponse.data.has_more;
          iterations++;
        }
        rawTxs = allAdded.map(tx => ({
          date: tx.date,
          name: tx.name || '',
          merchant_name: tx.merchant_name || '',
          amount_cents: Math.round(-(tx.amount || 0) * 100),
          currency: tx.iso_currency_code || 'USD',
          category: Array.isArray(tx.category) ? tx.category.join(' / ') : (tx.personal_finance_category?.primary || ''),
          pending: !!tx.pending,
        }));
      } catch (e) {
        console.log('[transactions.csv plaid] error', e.message);
      }
    }

    // Sort newest first for the CSV (most useful default ordering).
    rawTxs.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    // CSV escape: wrap in quotes + double internal quotes.
    const csvEscape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };

    const header = ['Date', 'Description', 'Merchant', 'Amount (USD)', 'Direction', 'Category', 'Pending'];
    const rows = rawTxs.map(tx => [
      tx.date || '',
      tx.name,
      tx.merchant_name,
      (tx.amount_cents / 100).toFixed(2),
      tx.amount_cents > 0 ? 'IN' : (tx.amount_cents < 0 ? 'OUT' : '—'),
      tx.category,
      tx.pending ? 'pending' : 'posted',
    ]);

    const csv = [header, ...rows]
      .map(r => r.map(csvEscape).join(','))
      .join('\r\n');

    // Filename: includes the user's name + today's date for at-a-glance
    // identification when downloads pile up.
    const today = new Date().toISOString().slice(0, 10);
    const safeName = (application.name || 'user').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="transactions_${safeName}_${today}.csv"`);
    response.send(csv);
  } catch (err) {
    console.log('[transactions.csv] error', err.message);
    next(err);
  }
});

app.get('/api/advance/admin/applications/:id/bank_snapshot', async function (request, response, next) {
  if (!requireAdmin(request, response)) return;
  try {
    const application = await db.getApplicationById(request.params.id);
    if (!application) return response.status(404).json({ error: { error_message: 'Application not found' } });
    const hasFc = !!application.stripe_fc_account_id;
    const hasPlaid = !!application.access_token;
    if (!hasFc && !hasPlaid) {
      return response.status(400).json({ error: { error_message: 'No bank account connected yet.' } });
    }

    let accounts = [];
    let rawTxs = [];

    if (hasFc) {
      // ── FC path ──────────────────────────────────────────────
      try {
        const fcAcct = await stripe.financialConnections.accounts.retrieve(application.stripe_fc_account_id);
        const balanceCents = fcAcct.balance?.current?.usd
          ? fcAcct.balance.current.usd  // already cents
          : null;
        accounts = [{
          id: fcAcct.id,
          display_name: fcAcct.display_name || fcAcct.institution_name || 'Bank Account',
          institution_name: fcAcct.institution_name || '',
          last4: fcAcct.last4 || null,
          routing_number: null,  // not exposed by FC default API
          category: fcAcct.subcategory || fcAcct.category,
          balance: { available: balanceCents, current: balanceCents },
        }];
      } catch (e) {
        console.log('[bank_snapshot fc] account fetch error', e.message);
      }
      try {
        const fcTxs = await fetchFcTransactions(application.stripe_fc_account_id);
        const { adaptFcTransactions } = require('./fcTransactionAdapter');
        const plaidShaped = adaptFcTransactions(fcTxs);
        // Same normalization as Plaid path (sign flip + cents) below.
        rawTxs = plaidShaped.map(tx => ({
          id: tx.transaction_id,
          description: tx.merchant_name || tx.name || '',
          amount: Math.round(-tx.amount * 100),
          currency: (tx.iso_currency_code || 'usd').toLowerCase(),
          date: tx.date,
          category: '',
          pfc: tx.personal_finance_category?.primary || null,
        }));
        console.log('[bank_snapshot fc] transactions count:', rawTxs.length);
      } catch (e) {
        console.log('[bank_snapshot fc] transactions error', e.message);
      }
    } else {
      // ── Plaid path (legacy, kept for users mid-flight) ───────
      // 1. Accounts + balances
      try {
        const acctResp = await client.accountsBalance.get({ access_token: application.access_token });
        accounts = acctResp.data.accounts.map(a => ({
          id: a.account_id,
          display_name: a.name,
          institution_name: '',
          last4: a.mask || null,
          routing_number: null,
          category: a.subtype || a.type,
          balance: {
            available: a.balances.available != null ? Math.round(a.balances.available * 100) : null,
            current:   a.balances.current  != null ? Math.round(a.balances.current  * 100) : null,
          },
        }));
      } catch (e) {
        console.log('[bank_snapshot plaid] accounts error:', e.message);
      }
      // 2. Routing number via Plaid Auth
      try {
        const authResp = await client.authGet({ access_token: application.access_token });
        const achNumbers = authResp.data.numbers.ach;
        accounts = accounts.map(a => {
          const ach = achNumbers.find(n => n.account_id === a.id);
          return ach ? { ...a, routing_number: ach.routing } : a;
        });
      } catch (e) {
        console.log('[bank_snapshot plaid] auth error (non-fatal):', e.message);
      }
      // 3. Transactions via transactionsSync (with personal_finance_category)
      let txs = [];
      try {
        let cursor, hasMore = true, iter = 0;
        while (hasMore && iter < 10) {
          const syncResp = await client.transactionsSync({
            access_token: application.access_token,
            cursor,
            count: 500,
            options: { include_personal_finance_category: true },
          });
          txs = txs.concat(syncResp.data.added || []);
          cursor = syncResp.data.next_cursor;
          hasMore = syncResp.data.has_more;
          iter++;
        }
        console.log('[bank_snapshot plaid] transactions count:', txs.length);
      } catch (e) {
        console.log('[bank_snapshot plaid] transactions error:', e.message);
      }
      // Plaid: positive amount = money leaving (debit), negative = money coming in (credit)
      // Normalise: positive = credit/income, negative = debit/spend (matches UI expectations)
      rawTxs = txs.map(tx => ({
        id: tx.transaction_id,
        description: tx.merchant_name || tx.name || '',
        amount: Math.round(-tx.amount * 100),
        currency: (tx.iso_currency_code || 'usd').toLowerCase(),
        date: tx.date,
        category: (tx.category || []).join(', '),
        pfc: tx.personal_finance_category?.primary || null,
      }));
    }

    // Classify incoming transactions through all layers
    const incoming = rawTxs.filter(tx => tx.amount > 0);
    const refundIds = buildRefundSet(rawTxs);
    const classified = await Promise.all(
      incoming.map(async tx => {
        const cls = await classifyTransaction(tx.description, tx.category, tx.pfc, refundIds.has(tx.id));
        return { ...tx, ...cls };
      })
    );

    // Outgoing transactions pass through unclassified
    const outgoing = rawTxs.filter(tx => tx.amount <= 0).map(tx => ({
      ...tx, status: 'outgoing', reason: null, ai_classified: false,
    }));

    const transactions = [...classified, ...outgoing].sort((a, b) => b.date.localeCompare(a.date));

    // Compute per-source accrued wages.
    // Include uncertain txs in the pool — employer names often don't match in
    // Plaid, so we rely on timing patterns instead of name filtering.
    const incomeCandidates = classified.filter(tx =>
      tx.status === 'wage_income' || tx.status === 'uncertain'
    );
    let incomeSources = await db.getIncomeSources(application.id);
    // Fall back to application row for pre-multi-source applications
    if (incomeSources.length === 0 && application.payday) {
      const fmtDate = v => v ? (typeof v === 'string' ? v.slice(0, 10) : new Date(v).toISOString().slice(0, 10)) : null;
      incomeSources = [{ id: null, employer: application.employer || '', payday: fmtDate(application.payday), pay_frequency: application.pay_frequency }];
    }
    const sourcesWithAccrued = incomeSources.map(src => calcSourceAccrued(src, incomeCandidates));
    const total_accrued_cents = sourcesWithAccrued.reduce((sum, s) => sum + (s.accrued_cents || 0), 0);

    response.json({ accounts, transactions, auth: null, income_sources: sourcesWithAccrued, total_accrued_cents });
  } catch (err) { next(err); }
});

app.get('/api/advance/admin/applications/:id/payment-method-details', async function (request, response, next) {
  if (!requireAdmin(request, response)) return;
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });

    // Prefer the us_bank_account PaymentMethod — it exposes
    // routing_number directly. FC account retrieve does NOT (needs
    // additional ownership permission). Earlier code hardcoded 'Not
    // available' here based on a wrong assumption.
    if (row.stripe_payment_method_id) {
      try {
        const pm = await stripe.paymentMethods.retrieve(row.stripe_payment_method_id);
        if (pm.us_bank_account) {
          return response.json({
            bank_name: pm.us_bank_account.bank_name || 'Bank Account',
            routing_number: pm.us_bank_account.routing_number || 'Not available',
            wire_routing_number: lookupWireRouting(pm.us_bank_account.bank_name),
            last4: pm.us_bank_account.last4 || '----',
            account_type: pm.us_bank_account.account_type || 'unknown',
            account_holder_type: pm.us_bank_account.account_holder_type || 'individual',
          });
        }
      } catch (e) {
        console.log('[payment-method-details pm] error', e.message);
      }
    }
    // Fallback for users who somehow have only an FC account ID but no PM
    if (row.stripe_fc_account_id) {
      try {
        const fc = await stripe.financialConnections.accounts.retrieve(row.stripe_fc_account_id);
        return response.json({
          bank_name: fc.display_name || fc.institution_name || 'Bank Account',
          routing_number: 'Not available',
          last4: fc.last4 || '----',
          account_type: fc.subcategory || fc.category || 'unknown',
          account_holder_type: 'individual',
        });
      } catch (e) {
        console.log('[payment-method-details fc] error', e.message);
      }
    }
    if (row.access_token) {
      let bankName = 'Bank Account', last4 = '----', accountType = 'unknown', routingNumber = 'Not available';
      try {
        const balResp = await client.accountsBalance.get({ access_token: row.access_token });
        const acct = balResp.data.accounts[0];
        bankName = acct?.official_name || acct?.name || 'Bank Account';
        last4 = acct?.mask || '----';
        accountType = acct?.subtype || acct?.type || 'unknown';
      } catch (e) {
        console.log('[payment-method-details plaid] balance error (non-fatal):', e.message);
      }
      try {
        const authResp = await client.authGet({ access_token: row.access_token });
        const ach = authResp.data.numbers.ach[0];
        if (ach?.routing) routingNumber = ach.routing;
      } catch (e) {
        console.log('[payment-method-details plaid] auth error (non-fatal):', e.message);
      }
      return response.json({ bank_name: bankName, routing_number: routingNumber, last4, account_type: accountType, account_holder_type: 'individual' });
    }

    return response.status(400).json({ error: { error_message: 'No bank account connected for this application' } });
  } catch (err) { next(err); }
});

app.get('/api/advance/admin/applications/:id/income_analysis', async function (request, response, next) {
  if (!requireAdmin(request, response)) return;
  try {
    const application = await db.getApplicationById(request.params.id);
    if (!application) return response.status(404).json({ error: { error_message: 'Application not found' } });
    if (!application.access_token) return response.status(400).json({ error: { error_message: 'Bank account is not connected yet' } });

  Promise.resolve()
    .then(async function () {
      // Paginate through all transactions via transactionsSync
      let allAdded = [];
      let cursor = undefined;
      let hasMore = true;
      let iterations = 0;
      while (hasMore && iterations < 20) {
        const syncResponse = await client.transactionsSync({
          access_token: application.access_token,
          cursor,
          count: 500,
        });
        allAdded = allAdded.concat(syncResponse.data.added || []);
        cursor = syncResponse.data.next_cursor;
        hasMore = syncResponse.data.has_more;
        iterations++;
      }

      const recentTransactions = allAdded;

      const employerName = (application.customer.employer || '').toLowerCase().trim();
      const employerWords = employerName.split(/\s+/).filter(w => w.length > 2);

      // Detect recurring credit amounts (same bucket ±$25, appearing 2+ times)
      const creditTxs = recentTransactions.filter(tx => tx.amount < 0);
      const amountBuckets = {};
      creditTxs.forEach(tx => {
        const key = Math.round(Math.abs(tx.amount) / 25) * 25;
        if (!amountBuckets[key]) amountBuckets[key] = [];
        amountBuckets[key].push(tx.transaction_id);
      });
      const recurringIds = new Set();
      Object.values(amountBuckets).forEach(ids => {
        if (ids.length >= 2) ids.forEach(id => recurringIds.add(id));
      });

      function scoreTransaction(tx) {
        // Only credits (money into account = negative amount in Plaid)
        if (tx.amount >= 0) return 0;

        let score = 0;
        const name = (tx.name || '').toLowerCase();

        // Employer name word match
        if (employerWords.length > 0) {
          const matched = employerWords.filter(w => name.includes(w)).length;
          if (matched > 0) score += Math.min(4, matched * 2);
        }

        // Plaid category match
        const categories = (tx.category || []).map(c => c.toLowerCase());
        if (categories.some(c => /payroll|income|salary|wage/.test(c))) score += 3;
        if (categories.some(c => /transfer/.test(c))) score += 1;

        // Common payroll deposit keywords
        const payrollKeywords = ['direct dep', 'dir dep', 'ddep', 'payroll', 'salary', 'wages', ' pay ', 'income', 'paystub', 'deposit'];
        if (payrollKeywords.some(k => name.includes(k))) score += 2;

        // Amount thresholds
        const abs = Math.abs(tx.amount);
        if (abs >= 1000) score += 2;
        else if (abs >= 300) score += 1;
        else if (abs < 50) score -= 2;

        // Recurring pattern bonus
        if (recurringIds.has(tx.transaction_id)) score += 1;

        return score;
      }

      // Collect income candidates (score >= 2)
      const incomeTransactions = recentTransactions
        .filter(tx => tx.amount < 0)
        .map(tx => ({ ...tx, income_score: scoreTransaction(tx) }))
        .filter(tx => tx.income_score >= 2)
        .sort((a, b) => new Date(b.date) - new Date(a.date));

      // Group by month (YYYY-MM)
      const byMonth = {};
      incomeTransactions.forEach(tx => {
        const month = tx.date.substring(0, 7);
        if (!byMonth[month]) byMonth[month] = [];
        byMonth[month].push(tx);
      });

      // Determine which of the last 3 calendar months have income
      const last3Months = [];
      for (let i = 2; i >= 0; i--) {
        const d = new Date();
        d.setDate(1);
        d.setMonth(d.getMonth() - i);
        last3Months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
      }
      const monthsWithIncome = last3Months.filter(m => byMonth[m] && byMonth[m].length > 0).length;

      // Consistency: coefficient of variation of amounts < 50%
      const amounts = incomeTransactions.map(tx => Math.abs(tx.amount));
      let consistentAmounts = true;
      if (amounts.length >= 2) {
        const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
        const variance = amounts.reduce((s, a) => s + Math.pow(a - mean, 2), 0) / amounts.length;
        consistentAmounts = Math.sqrt(variance) / mean < 0.5;
      }

      const avgAmount = amounts.length > 0
        ? Math.round((amounts.reduce((a, b) => a + b, 0) / amounts.length) * 100) / 100
        : 0;

      const stable = monthsWithIncome >= 3 && consistentAmounts;

      let reasoning;
      if (incomeTransactions.length === 0) {
        reasoning = 'No income deposits could be identified in the last 90 days.';
      } else if (monthsWithIncome < 3) {
        reasoning = `Income deposits found in only ${monthsWithIncome} of the last 3 months.`;
      } else if (!consistentAmounts) {
        reasoning = 'Income deposits are present each month but amounts vary significantly.';
      } else {
        reasoning = `Consistent income deposits detected in all 3 of the last 3 months.`;
      }

      response.json({
        stable,
        income_transactions: incomeTransactions.map(tx => ({
          transaction_id: tx.transaction_id,
          name: tx.name,
          amount: tx.amount,
          date: tx.date,
          income_score: tx.income_score,
        })),
        summary: {
          months_checked: 3,
          months_with_income: monthsWithIncome,
          transaction_count: incomeTransactions.length,
          avg_amount: avgAmount,
          consistent_amounts: consistentAmounts,
          reasoning,
        },
      });
    })
    .catch(next);
  } catch (err) { next(err); }
});

app.patch('/api/advance/admin/applications/:id/status', async function (request, response, next) {
  if (!requireAdmin(request, response)) return;
  try {
    const status = request.body.status;
    const allowedStatuses = ['intake', 'bank_connected', 'reviewing', 'approved', 'denied', 'expired', 'funded', 'repayment_scheduled', 'repaid', 'repayment_failed', 'subscription_failed', 'written_off'];
    if (!allowedStatuses.includes(status)) {
      return response.status(400).json({ error: { error_message: 'Unsupported status' } });
    }
    let updated = await db.updateApplicationStatus(request.params.id, status);
    if (!updated) return response.status(404).json({ error: { error_message: 'Application not found' } });
    if (status === 'approved') {
      const expiresAt = getOfferExpiresAt(new Date(), updated.state);
      updated = await db.saveOfferExpiry(updated.id, expiresAt) || updated;
      addToMailchimp(updated.name, updated.email, updated.state, ['approved'])
        .catch(err => console.log('[mailchimp approved] error:', err.message));
    }
    if (status === 'funded') {
      updated = await transitionToFunded(updated);
    }
    if (request.body.note) {
      await db.addMessage(request.params.id, 'admin', request.body.note);
    }
    if (status === 'denied') {
      addToMailchimp(updated.name, updated.email, updated.state, ['denied']).catch(() => {});
    }
    // Referral penalty: if written off on first advance, freeze referrer's limit progression for 3 months
    if (status === 'written_off' && (updated.repayment_count || 0) === 0 && updated.referred_by) {
      const referrer = await db.getApplicationByReferralCode(updated.referred_by);
      if (referrer) {
        const freezeUntil = new Date();
        freezeUntil.setMonth(freezeUntil.getMonth() + 3);
        await db.saveLimitFreeze(referrer.id, freezeUntil.toISOString().slice(0, 10));
        await db.addMessage(referrer.id, 'system', `A user you referred did not repay their first advance. Your limit progression is paused until ${freezeUntil.toISOString().slice(0, 10)}.`);
      }
    }
    response.json({ application: db.publicApp(updated) });
  } catch (err) { next(err); }
});

app.get('/api/advance/admin/applications/:id/referrals', async function (request, response, next) {
  if (!requireAdmin(request, response)) return;
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });
    const referred = await db.getReferredUsers(row.referral_code || '');
    const summary = {
      total: referred.length,
      got_advance: referred.filter(r => r.got_advance).length,
      repaid: referred.filter(r => r.status === 'repaid').length,
      defaulted: referred.filter(r => r.status === 'written_off').length,
      active: referred.filter(r => ['funded', 'repayment_scheduled'].includes(r.status)).length,
      referred,
    };
    response.json(summary);
  } catch (err) { next(err); }
});

const ADVANCE_TIERS = [25, 50, 75, 100, 150, 200];

app.post('/api/advance/applications/:id/reapply', async function (request, response, next) {
  const payload = requireAuth(request, response);
  if (!payload) return;
  if (payload.applicationId !== request.params.id) {
    return response.status(403).json({ error: { error_message: 'Forbidden' } });
  }
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });

    // Active loans cannot reapply
    if (['funded', 'repayment_scheduled'].includes(row.status)) {
      return response.status(400).json({ error: { error_message: 'You have an active advance. Please repay it before reapplying.' } });
    }
    // Lockout: failed advance repayment OR failed membership charge blocks
    // any new advance until the user resolves it. Source of truth lives
    // on the application row (status='repayment_failed') and on Stripe
    // (subscription_status='subscription_failed', set by the webhook).
    if (['repayment_failed', 'subscription_failed'].includes(row.status)) {
      return response.status(400).json({
        error: { error_message: 'Your previous repayment or membership charge failed. Please contact support to resolve before reapplying.' },
      });
    }

    // Cooldown: if a repayment due date exists and we are before the day after it, block
    // (expired and denied skip the cooldown entirely — no money was ever sent)
    if (!['expired', 'denied'].includes(row.status) && row.repayment_due_date) {
      const canReapplyAt = new Date(row.repayment_due_date);
      canReapplyAt.setDate(canReapplyAt.getDate() + 1);
      if (canReapplyAt > new Date()) {
        const days = Math.ceil((canReapplyAt - new Date()) / 86400000);
        return response.status(400).json({ error: { error_message: `You can reapply in ${days} day${days === 1 ? '' : 's'}.` } });
      }
    }

    const repaymentCount = row.repayment_count || 0;
    const isFrozen = row.limit_freeze_until && new Date(row.limit_freeze_until) > new Date();
    const tierIndex = isFrozen
      ? Math.max(0, repaymentCount - 1)
      : Math.min(repaymentCount, ADVANCE_TIERS.length - 1);
    const nextAmount = ADVANCE_TIERS[tierIndex];
    const updated = await db.resetForReapply(row.id, nextAmount);
    const frozenNote = isFrozen ? ' (limit progression is paused due to a referral penalty)' : '';
    await db.addMessage(row.id, 'system', `Application resubmitted for review. You are eligible for a $${nextAmount} advance${frozenNote}.`);
    response.json({ application: db.publicApp(updated) });
  } catch (err) { next(err); }
});

app.post('/api/advance/admin/applications/:id/repayment', async function (request, response, next) {
  if (!requireAdmin(request, response)) return;
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });
    const baseAmount = Number(request.body.amount || row.requested_amount || 25);
    const instantFee = row.delivery_type === 'instant' ? 5 : 0;
    const amount = baseAmount + instantFee;
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 30);
    const due_date = request.body.due_date || dueDate.toISOString().slice(0, 10);
    const feeNote = instantFee > 0 ? ` (includes $${instantFee} same-day delivery fee)` : '';
    const updated = await db.setRepayment(row.id, amount, due_date, 'Recorded for manual execution.');
    await db.addMessage(row.id, 'system', `Repayment of $${amount.toFixed(2)}${feeNote} is due by ${due_date}.`);
    response.json({ application: db.publicApp(updated) });
  } catch (err) { next(err); }
});

// ── Stripe card endpoints ──────────────────────────────────────────────────────

app.post('/api/advance/applications/:id/stripe/setup-intent', async function (request, response, next) {
  const payload = requireAuth(request, response);
  if (!payload) return;
  if (payload.applicationId !== request.params.id) {
    return response.status(403).json({ error: { error_message: 'Forbidden' } });
  }
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });

    let customerId = row.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: row.email,
        name: row.name,
        metadata: { application_id: row.id },
      });
      customerId = customer.id;
      await db.saveStripeCustomer(row.id, customerId);
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
      usage: 'off_session',
    });

    response.json({ client_secret: setupIntent.client_secret });
  } catch (err) { next(err); }
});

app.post('/api/advance/applications/:id/stripe/save-payment-method', async function (request, response, next) {
  const payload = requireAuth(request, response);
  if (!payload) return;
  if (payload.applicationId !== request.params.id) {
    return response.status(403).json({ error: { error_message: 'Forbidden' } });
  }
  try {
    const { payment_method_id } = request.body;
    if (!payment_method_id) {
      return response.status(400).json({ error: { error_message: 'payment_method_id is required' } });
    }
    // Debit-only enforcement. Credit cards are silently accepted by
    // Stripe Elements; we have to retrieve the PaymentMethod after the
    // fact and check the card.funding field. Reject + detach if it's
    // anything other than 'debit'. Reasons documented in the user-facing
    // error message below.
    try {
      const pm = await stripe.paymentMethods.retrieve(payment_method_id);
      const funding = pm?.card?.funding;
      if (funding && funding !== 'debit') {
        // Detach so the card doesn't sit on the customer record forever.
        try { await stripe.paymentMethods.detach(payment_method_id); } catch (_) { /* swallow */ }
        const label = funding === 'credit' ? 'credit card' : funding === 'prepaid' ? 'prepaid card' : `${funding} card`;
        return response.status(400).json({
          error: {
            error_message: `We only accept debit cards for repayment. You tried a ${label} — please use a debit card from your bank.`,
            funding,
          },
        });
      }
    } catch (e) {
      console.log('[stripe/save-payment-method] funding check error (failing open)', e.message);
      // Fail open — if we can't retrieve the PM, assume it's valid.
      // Saving the wrong card-type once isn't a disaster; the cascade
      // still tries ACH as a fallback.
    }
    const updated = await db.saveStripePaymentMethod(request.params.id, payment_method_id);
    if (!updated) return response.status(404).json({ error: { error_message: 'Application not found' } });
    // We DO NOT create the Stripe subscription here. The first membership
    // charge happens on the user's first repayment date — see the funded
    // status transition in PATCH /admin/applications/:id/status. Until then
    // the card sits on the customer and the user stays in 'pending_payment'.
    // After the first repayment, Stripe handles all subsequent monthly
    // charges on the same anchor day each month.
    if (updated.stripe_customer_id) {
      try {
        // Make the just-saved card the default for the customer so the
        // membership invoices (created later by funded transition) know
        // what to charge.
        await stripe.customers.update(updated.stripe_customer_id, {
          invoice_settings: { default_payment_method: payment_method_id },
        });
      } catch (e) {
        console.log('[stripe/save-payment-method] could not set default PM', { application_id: updated.id, error: e.message });
      }
    }
    response.json({ application: db.publicApp(updated) });
  } catch (err) { next(err); }
});

// ── Stripe Connect Express (ACH payouts) ─────────────────────────────────────
// Three endpoints make up the ACH onboarding flow:
//   1. POST /stripe/connect/onboarding-link
//      Creates the Connect Express account (idempotently) and returns a
//      hosted-onboarding URL the frontend redirects the user to. Stripe
//      collects identity (SSN, DOB, address) + bank info + sometimes ID
//      photo. Account is created with capabilities: { transfers: requested }
//      so the platform can later move money to it.
//
//   2. POST /stripe/connect/refresh-status
//      Called by the frontend on return from Stripe (?connect_complete=1).
//      Pulls the account state from Stripe and flips
//      stripe_connect_status to 'ready' when both charges_enabled and
//      payouts_enabled are true.
//
//   3. Webhook handler (see /api/webhooks/stripe below — already exists)
//      account.updated events from Stripe also keep stripe_connect_status
//      in sync, in case the user takes longer than expected to complete
//      onboarding or Stripe later restricts the account.
//
// Funded-handler later in this file calls stripe.transfers.create() when
// admin marks the application funded and the user picked ACH as payout.

app.post('/api/advance/applications/:id/stripe/connect/onboarding-link', async function (request, response, next) {
  const payload = requireAuth(request, response);
  if (!payload) return;
  if (payload.applicationId !== request.params.id) {
    return response.status(403).json({ error: { error_message: 'Forbidden' } });
  }
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });

    // Create the Connect account on first call; subsequent calls reuse it.
    let accountId = row.stripe_connect_account_id;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'US',
        email: row.email,
        capabilities: {
          transfers: { requested: true },
        },
        business_type: 'individual',
        // If the user already linked their bank via Stripe Financial
        // Connections at Step 4, pass the resulting PaymentMethod as the
        // external_account. Stripe accepts a us_bank_account PM here and
        // turns it into the connected account's bank for payouts — which
        // means the hosted onboarding can SKIP the bank step entirely.
        // We attach as a separate API call below (rather than inline) so
        // we can degrade gracefully if Stripe rejects the cross-attach.
        // Pre-fill the platform-perspective fields. Without these,
        // Stripe's hosted onboarding asks the recipient to provide a
        // business name / website / product description — which makes
        // zero sense for a wage-advance recipient. Setting them here
        // skips those screens entirely. Values describe what the
        // ACCOUNT does from our platform's perspective (recipient of
        // earned wage access), not what the recipient does for income.
        business_profile: {
          url: 'https://getbits.app',
          product_description: 'Recipient of earned wage advances from Bits Cash Advance.',
          // MCC 6051 = "Quasi Cash / Money Orders" — closest match for
          // cash-disbursement recipients. Stripe accepts most codes
          // here; the field is required for the transfers capability.
          mcc: '6051',
          support_email: 'advances@getbits.app',
          support_url: 'https://getbits.app',
        },
        // Pre-fill what we know to shave time off Stripe's hosted form.
        individual: {
          email: row.email,
          first_name: (row.name || '').split(' ')[0] || undefined,
          last_name: (row.name || '').split(' ').slice(1).join(' ') || undefined,
          phone: row.phone || undefined,
          dob: row.dob ? (() => {
            const d = new Date(row.dob);
            return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
          })() : undefined,
          ssn_last_4: row.ssn ? row.ssn.replace(/-/g, '').slice(-4) : (row.ssn_last4 || undefined),
        },
        // NOTE: we initially tried tos_acceptance.service_agreement=
        // 'recipient' here, but Stripe rejects it for US platforms
        // creating US accounts. That service_agreement is only valid
        // for cross-border payouts (US platform → non-US recipient or
        // vice versa). For domestic US accounts we fall back to the
        // default 'full' agreement, which the hosted onboarding
        // displays during the flow. The business_profile prefilling
        // above still reduces the questions the recipient sees.
        metadata: { application_id: row.id },
      });
      accountId = account.id;
      await db.saveStripeConnectAccount(row.id, accountId, 'onboarding');
      console.log('[stripe/connect] account created', { application_id: row.id, account_id: accountId });

      // Pre-attach the FC-verified bank as the Connect account's
      // external_account so the hosted onboarding can skip the bank step.
      // Best-effort: if Stripe rejects the cross-attach (e.g., FC PM
      // can't be reused for Connect), the user just types bank info
      // manually in the hosted form. No regression.
      if (row.stripe_payment_method_id) {
        try {
          await stripe.accounts.createExternalAccount(accountId, {
            external_account: row.stripe_payment_method_id,
          });
          console.log('[stripe/connect] external_account pre-attached', { application_id: row.id });
        } catch (e) {
          console.log('[stripe/connect] external_account pre-attach failed (non-fatal — user will enter bank in hosted form)', e.message);
        }
      }
    }

    const origin = (request.body && request.body.origin) || request.headers.origin || 'http://localhost:3000';
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${origin}/?connect_refresh=1`,
      return_url: `${origin}/?connect_complete=1`,
      type: 'account_onboarding',
    });

    response.json({ url: link.url, account_id: accountId });
  } catch (err) { next(err); }
});

app.post('/api/advance/applications/:id/stripe/connect/refresh-status', async function (request, response, next) {
  const payload = requireAuth(request, response);
  if (!payload) return;
  if (payload.applicationId !== request.params.id) {
    return response.status(403).json({ error: { error_message: 'Forbidden' } });
  }
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });
    if (!row.stripe_connect_account_id) {
      return response.json({ status: 'not_started', application: db.publicApp(row) });
    }
    const account = await stripe.accounts.retrieve(row.stripe_connect_account_id);
    const isReady = account.charges_enabled && account.payouts_enabled;
    const isRestricted = account.requirements?.disabled_reason || false;
    const newStatus = isReady ? 'ready' : (isRestricted ? 'restricted' : 'onboarding');
    const updated = await db.saveStripeConnectAccount(row.id, row.stripe_connect_account_id, newStatus);
    // When Connect onboarding finishes, also save 'ACH' as the payout
    // method so the rest of the pre-bank flow can advance.
    let final = updated;
    if (newStatus === 'ready' && !row.payout_methods) {
      final = await db.savePayoutPreference(row.id, 'ACH', 'stripe_connect') || updated;
    }
    response.json({ status: newStatus, application: db.publicApp(final) });
  } catch (err) {
    console.log('[stripe/connect/refresh-status] error', err.message);
    next(err);
  }
});

// ── Stripe Financial Connections (bank link, transactions, ACH debit) ────────
// FC is Stripe's bank-linking product. We use it as a Plaid replacement for:
//   1. Income verification (transactions feature)
//   2. ACH debit on repayment day (payment_method feature creates a
//      chargeable us_bank_account PaymentMethod on the platform Customer)
//   3. Pre-attaching the bank as external_account on the Connect Express
//      account so ACH payouts have a destination without re-linking
//
// Three-step backend flow:
//   1. POST /stripe/fc/create-session  → creates session, returns client_secret
//   2. Frontend uses stripe.collectFinancialConnectionsAccounts(clientSecret)
//      to launch the embedded bank-link UI
//   3. POST /stripe/fc/complete  → retrieves session, saves account info
//      + payment method, optionally subscribes to transactions feature
// Switched from the low-level FinancialConnectionsSession API to the
// high-level SetupIntent + us_bank_account API. Why:
//
//   FinancialConnectionsSession is the raw primitive — it gives you a
//   FC account back, but PaymentMethod creation is a SEPARATE
//   downstream step that fails silently across API versions in ways
//   that are basically impossible to debug from the outside (PM exists
//   but not attached, or attached to a different customer, or only
//   created if specific permissions were granted by the user, etc.).
//
//   SetupIntent with payment_method_types: ['us_bank_account'] uses FC
//   under the hood but handles the entire pipeline atomically — bank
//   link → FC account → PaymentMethod → attached to customer — in one
//   confirmable object. Either it's `succeeded` with a populated
//   payment_method, or it isn't. No silent multi-step failures.
//
// Endpoints (same URLs, different semantics underneath):
//   POST /stripe/fc/create-session
//     → creates a SetupIntent for us_bank_account, returns client_secret
//
//   POST /stripe/fc/complete
//     → retrieves the SetupIntent, extracts the PaymentMethod (always
//       there when status='succeeded'), saves it as the chargeable PM
//       AND extracts the underlying FC account id for transaction reads
app.post('/api/advance/applications/:id/stripe/fc/create-session', async function (request, response, next) {
  const payload = requireAuth(request, response);
  if (!payload) return;
  if (payload.applicationId !== request.params.id) {
    return response.status(403).json({ error: { error_message: 'Forbidden' } });
  }
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });

    let customerId = row.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: row.email,
        name: row.name,
        metadata: { application_id: row.id },
      });
      customerId = customer.id;
      await db.saveStripeCustomer(row.id, customerId);
    }

    const requestedOrigin = typeof request.body?.origin === 'string' ? request.body.origin : '';
    let returnUrl = null;
    try {
      const originUrl = requestedOrigin ? new URL(requestedOrigin) : null;
      const isLocalDev = originUrl && ['localhost', '127.0.0.1'].includes(originUrl.hostname);
      const isKnownFrontendHost = originUrl && (
        originUrl.hostname === 'getbits.app' ||
        originUrl.hostname === 'www.getbits.app' ||
        originUrl.hostname.endsWith('.vercel.app')
      );
      if (originUrl && (isKnownFrontendHost || isLocalDev) && (originUrl.protocol === 'https:' || (originUrl.protocol === 'http:' && isLocalDev))) {
        const url = new URL('/', originUrl.origin);
        url.searchParams.set('stripe_fc_return', '1');
        returnUrl = url.toString();
      }
    } catch (_) {
      returnUrl = null;
    }

    // FC permissions: full set ('payment_method', 'transactions',
    // 'balances'). Reducing to just 'payment_method' (tried in PR #60)
    // observably broke the post-bank-login completion step.
    //
    // return_url: critical for mobile. After the bank's logout screen,
    // some FC routes use a top-level redirect back to Stripe (rather
    // than postMessage to our iframe). Without return_url, Stripe
    // doesn't know where to send the user back, the FC widget never
    // shows its 'connecting your account' confirmation, the SetupIntent
    // ends up half-attached. Pass the originating page URL so Stripe
    // can route the user back properly.
    //
    // prefetch: tells Stripe to pre-fetch balance + transaction data
    // before closing the FC widget. Ensures data is loaded before the
    // user is bounced back to our app, which (anecdotally) keeps the
    // FC confirmation popup visible long enough for the SetupIntent
    // to fully attach.
    // return_url is required for the mobile OAuth handoff. Without it,
    // iOS Safari/Chrome can return from the bank page to our app while
    // the SetupIntent is still in its initial requires_payment_method
    // state, so Stripe never reaches the "connecting your account" step
    // that attaches the PaymentMethod.
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['us_bank_account'],
      payment_method_options: {
        us_bank_account: {
          financial_connections: {
            permissions: ['payment_method', 'transactions', 'balances'],
            prefetch: ['balances'],
            ...(returnUrl ? { return_url: returnUrl } : {}),
          },
          verification_method: 'automatic',
        },
      },
      usage: 'off_session',
      metadata: { application_id: row.id },
    });
    // We store the SetupIntent ID in the existing stripe_fc_session_id
    // column — semantically it's still "the bank-link session", and
    // we avoid a schema migration.
    await db.saveStripeFcSession(request.params.id, setupIntent.id);
    console.log('[stripe/fc/create-session] setup_intent created', { application_id: row.id, setup_intent_id: setupIntent.id, has_return_url: !!returnUrl });
    response.json({ client_secret: setupIntent.client_secret, setup_intent_id: setupIntent.id });
  } catch (err) {
    console.log('[stripe/fc/create-session] error', err.message);
    next(err);
  }
});

app.post('/api/advance/applications/:id/stripe/fc/native/create-session', async function (request, response, next) {
  const payload = requireAuth(request, response);
  if (!payload) return;
  if (payload.applicationId !== request.params.id) {
    return response.status(403).json({ error: { error_message: 'Forbidden' } });
  }
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });

    let customerId = row.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: row.email,
        name: row.name,
        phone: row.phone,
        metadata: { application_id: row.id },
      });
      customerId = customer.id;
      await db.saveStripeCustomer(row.id, customerId);
    }

    // Do not pass return_url for normal mobile web. Stripe marks that param as
    // webview-only; Safari/Chrome should stay inside the Stripe.js FC flow until
    // collectFinancialConnectionsAccounts resolves.
    const session = await stripe.financialConnections.sessions.create({
      account_holder: { type: 'customer', customer: customerId },
      permissions: ['payment_method', 'transactions', 'balances'],
      prefetch: ['balances'],
      filters: {
        countries: ['US'],
        account_subcategories: ['checking', 'savings'],
      },
    });

    await db.saveStripeFcSession(row.id, session.id);
    console.log('[stripe/fc/native/create-session] session created', {
      application_id: row.id,
      session_id: session.id,
      customer_id: customerId,
    });
    response.json({ client_secret: session.client_secret, session_id: session.id });
  } catch (err) {
    console.log('[stripe/fc/native/create-session] error', err.message);
    next(err);
  }
});

app.post('/api/advance/applications/:id/stripe/fc/native/complete', async function (request, response, next) {
  const payload = requireAuth(request, response);
  if (!payload) return;
  if (payload.applicationId !== request.params.id) {
    return response.status(403).json({ error: { error_message: 'Forbidden' } });
  }
  try {
    const row = await db.getApplicationById(request.params.id);
    const { session_id } = request.body || {};
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });
    const sessionId = session_id || row.stripe_fc_session_id;
    if (!sessionId || !String(sessionId).startsWith('fcsess_')) {
      return response.status(400).json({ error: { error_message: 'No Financial Connections session for this application' } });
    }
    if (!row.stripe_customer_id) {
      return response.status(400).json({ error: { error_message: 'Stripe customer is missing for this application' } });
    }

    const session = await stripe.financialConnections.sessions.retrieve(sessionId, {
      expand: ['accounts'],
    });
    const sessionAccounts = session.accounts?.data || [];
    let account = sessionAccounts[0];
    let accountSource = 'session';
    if (!account?.id) {
      // Mobile OAuth can complete at the bank (customer gets the Chase
      // "data shared" email) but fail to associate the returned account
      // with the FC Session object. In that case, recover from the
      // customer-level account list and use the latest eligible account.
      try {
        const listed = await stripe.financialConnections.accounts.list({
          account_holder: { customer: row.stripe_customer_id },
          limit: 10,
        });
        const customerAccounts = listed.data || [];
        account = customerAccounts.find(a =>
          (a.permissions || []).includes('payment_method') &&
          (a.supported_payment_method_types || []).includes('us_bank_account')
        ) || customerAccounts[0];
        accountSource = 'customer_account_list';
        console.log('[stripe/fc/native/complete] recovered account from customer list', {
          application_id: row.id,
          session_id: session.id,
          customer_id: row.stripe_customer_id,
          session_account_count: sessionAccounts.length,
          customer_account_count: customerAccounts.length,
          recovered_account_id: account?.id || null,
        });
      } catch (e) {
        console.log('[stripe/fc/native/complete] customer account recovery failed', {
          application_id: row.id,
          session_id: session.id,
          error: e.message,
        });
      }
    }
    if (!account?.id) {
      return response.status(400).json({
        error: {
          error_message: 'No bank account was returned by Stripe Financial Connections.',
          code: 'no_financial_connections_account',
          session_id: session.id,
          account_count: sessionAccounts.length,
        },
      });
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: row.stripe_customer_id,
      payment_method_types: ['us_bank_account'],
      payment_method_data: {
        type: 'us_bank_account',
        billing_details: {
          name: row.name,
          email: row.email,
        },
        us_bank_account: {
          financial_connections_account: account.id,
        },
      },
      mandate_data: {
        customer_acceptance: {
          type: 'online',
          online: {
            ip_address: request.ip,
            user_agent: request.headers['user-agent'] || 'unknown',
          },
        },
      },
      confirm: true,
      usage: 'off_session',
      metadata: {
        application_id: row.id,
        fc_session_id: session.id,
      },
    }, {
      idempotencyKey: `fc-native-complete-${row.id}-${session.id}`,
    });

    const bankPmId = typeof setupIntent.payment_method === 'string'
      ? setupIntent.payment_method
      : setupIntent.payment_method?.id;
    if (!bankPmId) {
      return response.status(400).json({
        error: {
          error_message: 'Stripe collected the bank account but did not create a PaymentMethod.',
          code: 'no_payment_method_after_fc_session',
          setup_intent_id: setupIntent.id,
          setup_intent_status: setupIntent.status,
          last_setup_error: setupIntent.last_setup_error || null,
        },
      });
    }

    console.log('[stripe/fc/native/complete] saving', {
      application_id: row.id,
      session_id: session.id,
      setup_intent_id: setupIntent.id,
      setup_intent_status: setupIntent.status,
      pm: bankPmId,
      fc_account: account.id,
      account_source: accountSource,
    });

    let updated = await db.saveStripeFcLinkedAccount(row.id, account.id, bankPmId);
    if (account.id && !updated.stripe_fc_subscribed_at) {
      try {
        await stripe.financialConnections.accounts.subscribe(account.id, {
          features: ['transactions'],
        });
        updated = await db.markStripeFcSubscribed(row.id) || updated;
      } catch (e) {
        console.log('[stripe/fc/native/complete] subscribe failed (non-fatal)', e.message);
      }
    }

    await db.addMessage(row.id, 'system', 'Bank account connected via Stripe. A reviewer will check your application and respond here.');
    addToMailchimp(updated.name, updated.email, updated.state, ['application_under_review'])
      .catch(err => console.log('[mailchimp review] error:', err.message));

    // ───── Connect Custom — runs in background after FC completes ─────
    // (Same logic as in /stripe/fc/complete — added here because the
    // frontend actually calls THIS endpoint, /stripe/fc/native/complete,
    // not the older /complete. My earlier setImmediate was in the wrong
    // endpoint and never fired.)
    //
    // Creates a Connect Custom account with programmatic KYC and
    // attaches the same FC bank as external_account. Result: user can
    // be paid out via Stripe instant payouts on funded.
    // setImmediate + try/catch so failure can't impact FC flow.
    setImmediate(async () => {
      try {
        await db.addMessage(updated.id, 'system', `[diag] Connect setup attempting (KYC fields: name=${!!updated.name} dob=${!!updated.dob} ssn=${!!updated.ssn} addr=${!!updated.address_line1}).`);
      } catch (diagErr) {
        console.warn('[connect-custom native] diag message write failed', diagErr.message);
      }
      const clientIp = request.ip || request.headers['x-forwarded-for'] || '0.0.0.0';
      try {
        const { accountId, payoutsEnabled, disabledReason, skipped, reason } =
          await connectCustom.ensureConnectAccount(stripe, db, updated, clientIp);
        if (skipped) {
          await db.addMessage(updated.id, 'system', `Connect setup skipped: ${reason}. Manual Brex payout will be used.`);
          return;
        }
        if (!payoutsEnabled) {
          await db.addMessage(updated.id, 'system', `Connect account created (KYC pending: ${disabledReason || 'currently_due'}). Manual Brex payout will be used until KYC clears.`);
        }
        const attach = await connectCustom.attachBankToConnectAccount(stripe, db, updated, bankPmId, accountId);
        if (attach.skipped) {
          await db.addMessage(updated.id, 'system', `Connect bank attach skipped: ${attach.reason}. Manual Brex payout will be used.`);
        } else {
          await db.addMessage(updated.id, 'system', `Connect bank linked. Instant payout ready ${payoutsEnabled ? 'now' : 'pending KYC'}.`);
        }
      } catch (e) {
        console.warn('[connect-custom native] background setup failed', { application_id: updated.id, error: e.message });
        await db.addMessage(updated.id, 'system', `Connect setup error: ${e.message}. Manual Brex payout will be used.`);
      }
    });

    response.json({
      status: 'connected',
      session_id: session.id,
      setup_intent_id: setupIntent.id,
      application: db.publicApp(updated),
    });
  } catch (err) {
    console.log('[stripe/fc/native/complete] error', err.message);
    next(err);
  }
});

// Diagnostic-only endpoint. Returns the SetupIntent's current state on
// Stripe without trying to save anything to our DB. Used by the frontend
// to display a 'Diagnostic info' panel on the bank-link page so the
// user / their engineer can see exactly what Stripe is reporting,
// without needing access to Render logs or Stripe Dashboard.
app.get('/api/advance/applications/:id/stripe/fc/diagnose', async function (request, response, next) {
  const payload = requireAuth(request, response);
  if (!payload) return;
  if (payload.applicationId !== request.params.id) {
    return response.status(403).json({ error: { error_message: 'Forbidden' } });
  }
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });
    if (!row.stripe_fc_session_id) {
      return response.json({ has_session: false });
    }
    if (String(row.stripe_fc_session_id).startsWith('fcsess_')) {
      let session;
      try {
        session = await stripe.financialConnections.sessions.retrieve(row.stripe_fc_session_id, {
          expand: ['accounts'],
        });
      } catch (e) {
        return response.json({ has_session: true, session_type: 'financial_connections_session', session_id: row.stripe_fc_session_id, retrieve_error: e.message });
      }
      const accounts = session.accounts?.data || [];
      let customerAccounts = [];
      if (row.stripe_customer_id) {
        try {
          const listed = await stripe.financialConnections.accounts.list({
            account_holder: { customer: row.stripe_customer_id },
            limit: 10,
          });
          customerAccounts = (listed.data || []).map(account => ({
            id: account.id,
            status: account.status || null,
            institution_name: account.institution_name || null,
            display_name: account.display_name || null,
            last4: account.last4 || null,
            permissions: account.permissions || [],
            supported_payment_method_types: account.supported_payment_method_types || [],
            subscriptions: account.subscriptions || [],
            created_at: account.created ? new Date(account.created * 1000).toISOString() : null,
          }));
        } catch (e) {
          customerAccounts = [{ retrieve_error: e.message }];
        }
      }
      return response.json({
        has_session: true,
        session_type: 'financial_connections_session',
        session_id: session.id,
        account_count: accounts.length,
        accounts: accounts.map(account => ({
          id: account.id,
          status: account.status || null,
          institution_name: account.institution_name || null,
          display_name: account.display_name || null,
          last4: account.last4 || null,
          permissions: account.permissions || [],
          supported_payment_method_types: account.supported_payment_method_types || [],
          subscriptions: account.subscriptions || [],
        })),
        customer_account_count: customerAccounts.filter(a => !a.retrieve_error).length,
        customer_accounts: customerAccounts,
        saved_pm_in_db: row.stripe_payment_method_id || null,
        saved_fc_account_in_db: row.stripe_fc_account_id || null,
      });
    }
    let si;
    try {
      si = await stripe.setupIntents.retrieve(row.stripe_fc_session_id, {
        expand: ['payment_method', 'latest_attempt'],
      });
    } catch (e) {
      return response.json({ has_session: true, setup_intent_id: row.stripe_fc_session_id, retrieve_error: e.message });
    }
    let setupAttempts = [];
    let stripeEvents = [];
    try {
      const attempts = await stripe.setupAttempts.list({
        setup_intent: row.stripe_fc_session_id,
        limit: 10,
        expand: ['data.payment_method'],
      });
      setupAttempts = (attempts.data || []).map(attempt => ({
        id: attempt.id,
        created_at: attempt.created ? new Date(attempt.created * 1000).toISOString() : null,
        status: attempt.status || null,
        usage: attempt.usage || null,
        customer: typeof attempt.customer === 'string' ? attempt.customer : attempt.customer?.id || null,
        payment_method_id: typeof attempt.payment_method === 'string' ? attempt.payment_method : attempt.payment_method?.id || null,
        payment_method_type: typeof attempt.payment_method === 'string' ? null : attempt.payment_method?.type || null,
        setup_error: attempt.setup_error ? {
          code: attempt.setup_error.code || null,
          decline_code: attempt.setup_error.decline_code || null,
          message: attempt.setup_error.message || null,
          type: attempt.setup_error.type || null,
        } : null,
      }));
    } catch (e) {
      setupAttempts = [{ retrieve_error: e.message }];
    }
    try {
      const events = await stripe.events.list({ limit: 20 });
      stripeEvents = (events.data || [])
        .filter(event => {
          const object = event.data?.object || {};
          return object.id === row.stripe_fc_session_id
            || object.setup_intent === row.stripe_fc_session_id
            || object.metadata?.application_id === row.id;
        })
        .map(event => ({
          id: event.id,
          type: event.type,
          created_at: event.created ? new Date(event.created * 1000).toISOString() : null,
          object_id: event.data?.object?.id || null,
          object_status: event.data?.object?.status || null,
        }));
    } catch (e) {
      stripeEvents = [{ retrieve_error: e.message }];
    }
    response.json({
      has_session: true,
      setup_intent_id: si.id,
      status: si.status,
      has_payment_method: !!si.payment_method,
      payment_method_type: si.payment_method?.type || null,
      payment_method_id: si.payment_method?.id || null,
      has_us_bank_account: !!si.payment_method?.us_bank_account,
      bank_name: si.payment_method?.us_bank_account?.bank_name || null,
      last_setup_error: si.last_setup_error || null,
      cancellation_reason: si.cancellation_reason || null,
      next_action_type: si.next_action?.type || null,
      created_at: si.created ? new Date(si.created * 1000).toISOString() : null,
      saved_pm_in_db: row.stripe_payment_method_id || null,
      saved_fc_account_in_db: row.stripe_fc_account_id || null,
      setup_attempt_count: Array.isArray(setupAttempts) ? setupAttempts.filter(a => !a.retrieve_error).length : 0,
      setup_attempts: setupAttempts,
      stripe_events: stripeEvents,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/advance/applications/:id/stripe/fc/client-event', async function (request, response, next) {
  const payload = requireAuth(request, response);
  if (!payload) return;
  if (payload.applicationId !== request.params.id) {
    return response.status(403).json({ error: { error_message: 'Forbidden' } });
  }
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });
    const event = String(request.body?.event || '').slice(0, 80);
    const details = request.body?.details && typeof request.body.details === 'object'
      ? request.body.details
      : {};
    console.log('[stripe/fc/client-event]', {
      application_id: row.id,
      setup_intent_id: row.stripe_fc_session_id || null,
      event,
      details,
      user_agent: request.headers['user-agent'] || null,
    });
    response.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/advance/applications/:id/stripe/fc/complete', async function (request, response, next) {
  const payload = requireAuth(request, response);
  if (!payload) return;
  if (payload.applicationId !== request.params.id) {
    return response.status(403).json({ error: { error_message: 'Forbidden' } });
  }
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row || !row.stripe_fc_session_id) {
      return response.status(400).json({ error: { error_message: 'No bank-link session for this application' } });
    }

    // Retrieve the SetupIntent. The PaymentMethod is created and attached
    // to the customer as soon as the FC widget collects the bank — the
    // SetupIntent's *status* may still be 'processing' (for a few
    // moments after collection) or 'requires_action' (when bank
    // verification is via micro-deposits instead of instant FC).
    //
    // Previously we rejected anything that wasn't 'succeeded', which
    // bounced users back to the Connect Bank screen even though their
    // bank was actually linked. Now we save the PM if it exists in any
    // of these intermediate states — Stripe will eventually flip the
    // SetupIntent to 'succeeded' on its own, and our cron/charge code
    // already handles 'processing' PaymentIntents (which is what an
    // ACH debit on this PM would produce anyway).
    const setupIntent = await stripe.setupIntents.retrieve(row.stripe_fc_session_id, {
      expand: ['payment_method', 'latest_attempt'],
    });
    // Verbose log so we can diagnose intermittent mobile failures from
    // Render logs. last_setup_error is the field Stripe populates with
    // a structured reason when the FC widget exits without completing.
    console.log('[stripe/fc/complete] setup_intent', {
      id: setupIntent.id,
      status: setupIntent.status,
      has_pm: !!setupIntent.payment_method,
      last_setup_error: setupIntent.last_setup_error || null,
      next_action_type: setupIntent.next_action?.type || null,
      cancellation_reason: setupIntent.cancellation_reason || null,
    });

    // Terminal-failure status — SetupIntent will never produce a PM
    // (Stripe explicitly canceled it, usually because the user dismissed
    // the FC widget before bank auth completed). Clear the session id
    // so the next Connect Bank click mints a fresh SetupIntent.
    if (setupIntent.status === 'canceled') {
      try { await db.saveStripeFcSession(row.id, null); } catch (_) {}
      const errMsg = setupIntent.last_setup_error?.message
        || `Bank link was cancelled. Please tap Connect bank again.`;
      return response.status(400).json({
        error: { error_message: errMsg, code: 'setup_intent_canceled', setup_intent_status: setupIntent.status, last_error: setupIntent.last_setup_error || null },
      });
    }

    // No PM attached yet. Could be transient (Stripe still finalizing
    // attach after the FC widget closed) or terminal (the user actually
    // cancelled). Don't clear the session — the frontend polls /complete
    // every 3s for ~30s after landing on the bank-link page. If Stripe
    // eventually attaches a PM, we'll pick it up on a subsequent poll.
    // After the polling window expires the user clicks Connect Bank
    // again, which mints a fresh SetupIntent via /create-session.
    const pm = setupIntent.payment_method;
    if (!pm || !pm.id) {
      return response.status(400).json({
        error: { error_message: 'Bank link not finalized yet.', code: 'no_payment_method_yet', setup_intent_status: setupIntent.status },
      });
    }

    const bankPmId = pm.id;
    // The FC account id is on the us_bank_account PM. We need it for
    // transactions reads later.
    const fcAccountId = pm.us_bank_account?.financial_connections_account || null;
    console.log('[stripe/fc/complete] saving', { application_id: row.id, pm: bankPmId, fc_account: fcAccountId });

    let updated = await db.saveStripeFcLinkedAccount(row.id, fcAccountId, bankPmId);

    // Subscribe to transactions for income classification. Only meaningful
    // if we have a real FC account id; some banks return verified bank
    // accounts via micro-deposit instead, which don't expose transactions.
    if (fcAccountId && !updated.stripe_fc_subscribed_at) {
      try {
        await stripe.financialConnections.accounts.subscribe(fcAccountId, {
          features: ['transactions'],
        });
        updated = await db.markStripeFcSubscribed(row.id) || updated;
        console.log('[stripe/fc/complete] subscribed to transactions', { account_id: fcAccountId });
      } catch (e) {
        console.log('[stripe/fc/complete] subscribe failed (non-fatal)', e.message);
      }
    }

    await db.addMessage(row.id, 'system', 'Bank account connected via Stripe. A reviewer will check your application and respond here.');
    addToMailchimp(updated.name, updated.email, updated.state, ['application_under_review'])
      .catch(err => console.log('[mailchimp review] error:', err.message));

    // ───── Connect Custom — runs in background after FC completes ─────
    // Creates a Connect Custom account with programmatic KYC, then
    // attaches the SAME bank (from FC) as an external_account on that
    // account. Result: the user can be paid out via Stripe instant
    // payouts when admin marks them funded — no second bank login needed.
    //
    // Wrapped in setImmediate + try/catch so:
    //   - The /complete response returns immediately
    //   - Any Connect-side failure can't impact the existing FC flow
    //   - Errors land in logs + a system message on the application
    // The FC flow (this endpoint's main job) has ALREADY completed by
    // the time this runs — Connect is purely an additional capability.
    setImmediate(async () => {
      // Loud diagnostic — if this message doesn't appear, setImmediate
      // itself never fired. Helps tell apart "code didn't run" vs
      // "code ran but ensureConnectAccount returned skipped/error".
      try {
        await db.addMessage(updated.id, 'system', `[diag] Connect setup attempting (KYC fields: name=${!!updated.name} dob=${!!updated.dob} ssn=${!!updated.ssn} addr=${!!updated.address_line1}).`);
      } catch (diagErr) {
        console.warn('[connect-custom] diag message write failed', diagErr.message);
      }
      const clientIp = request.ip || request.headers['x-forwarded-for'] || '0.0.0.0';
      try {
        const { accountId, payoutsEnabled, disabledReason, skipped, reason } =
          await connectCustom.ensureConnectAccount(stripe, db, updated, clientIp);
        if (skipped) {
          await db.addMessage(updated.id, 'system', `Connect setup skipped: ${reason}. Manual Brex payout will be used.`);
          return;
        }
        if (!payoutsEnabled) {
          await db.addMessage(updated.id, 'system', `Connect account created (KYC pending: ${disabledReason || 'currently_due'}). Manual Brex payout will be used until KYC clears.`);
          // Still try to attach the bank — payouts_enabled may flip later
        }
        const attach = await connectCustom.attachBankToConnectAccount(stripe, db, updated, bankPmId, accountId);
        if (attach.skipped) {
          await db.addMessage(updated.id, 'system', `Connect bank attach skipped: ${attach.reason}. Manual Brex payout will be used.`);
        } else {
          await db.addMessage(updated.id, 'system', `Connect bank linked. Instant payout ready ${payoutsEnabled ? 'now' : 'pending KYC'}.`);
        }
      } catch (e) {
        console.warn('[connect-custom] background setup failed', { application_id: updated.id, error: e.message });
        await db.addMessage(updated.id, 'system', `Connect setup error: ${e.message}. Manual Brex payout will be used.`);
      }
    });

    response.json({ status: 'connected', application: db.publicApp(updated) });
  } catch (err) {
    console.log('[stripe/fc/complete] error', err.message);
    next(err);
  }
});

// Helper used by income classification + the admin bank snapshot to read
// transactions from FC. Returns an array of transactions in chronological
// order. Stripe's API caps each page at 100 — paginate up to ~3 months
// of history (matches our existing Plaid window).
async function fetchFcTransactions(fcAccountId) {
  const transactions = [];
  let starting_after = undefined;
  for (let i = 0; i < 10; i++) {
    const page = await stripe.financialConnections.transactions.list({
      account: fcAccountId,
      limit: 100,
      ...(starting_after ? { starting_after } : {}),
    });
    transactions.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    starting_after = page.data[page.data.length - 1].id;
  }
  return transactions;
}
module.exports.fetchFcTransactions = fetchFcTransactions;

// Returns { ok: true } if safe to charge, { ok: false, reason } if it would overdraft.
// Fails open (ok: true) when balance is unavailable so card-only users are unaffected.
// Balance check before charging. Prefers Stripe Financial Connections
// (FC) since that's the new bank-link primitive; falls back to legacy
// Plaid access_token for any older accounts mid-flight. Fails open
// (returns ok=true) if balance is unavailable — better to attempt the
// charge than block legitimate collections on data gaps.
async function checkOverdraft(row, amountCents) {
  // Try FC first
  if (row.stripe_fc_account_id) {
    try {
      // Refresh the balance feature so we get up-to-the-minute data.
      // This is critical for "see when money lands, then pull" — the
      // cached value can be hours stale otherwise. Stripe charges a
      // small fee per refresh; for us it's worth it to avoid pulling
      // before payroll arrives.
      try {
        await stripe.financialConnections.accounts.refresh(row.stripe_fc_account_id, {
          features: ['balance'],
        });
      } catch (refreshErr) {
        // Refresh isn't critical — if it fails, we read whatever cached
        // value Stripe has and proceed.
        console.log('[overdraft_check fc] refresh failed (non-fatal)', refreshErr.message);
      }
      const fcAcct = await stripe.financialConnections.accounts.retrieve(row.stripe_fc_account_id);
      const availableCents = fcAcct.balance?.current?.usd ?? null;
      console.log(`[overdraft_check fc] available=${availableCents} cents | charge=${amountCents} cents`);
      if (availableCents === null) return { ok: true };
      if (availableCents < amountCents) {
        const avail = (availableCents / 100).toFixed(2);
        const needed = (amountCents / 100).toFixed(2);
        return { ok: false, reason: `Payment skipped — bank balance is $${avail} but repayment is $${needed}. We'll retry tomorrow.` };
      }
      return { ok: true };
    } catch (e) {
      console.log('[overdraft_check fc] error (failing open)', e.message);
      // Fall through to Plaid path or success
    }
  }
  // Legacy Plaid path (for users from before FC migration)
  if (!row.access_token) return { ok: true };
  try {
    const resp = await client.accountsBalance.get({ access_token: row.access_token });
    const checking = resp.data.accounts.find(a => a.type === 'depository') || resp.data.accounts[0];
    const availableCents = checking?.balances.available != null
      ? Math.round(checking.balances.available * 100) : null;
    console.log(`[overdraft_check plaid] available=${availableCents} cents | charge=${amountCents} cents`);
    if (availableCents === null) return { ok: true };
    if (availableCents < amountCents) {
      const avail = (availableCents / 100).toFixed(2);
      const needed = (amountCents / 100).toFixed(2);
      return { ok: false, reason: `Payment skipped — bank balance is $${avail} but repayment is $${needed}. We'll retry tomorrow.` };
    }
    return { ok: true };
  } catch (e) {
    console.log('[overdraft_check plaid] balance unavailable:', e.message, '— proceeding');
    return { ok: true };
  }
}

// Charge amount in cents. Prefer repayment_amount (fee already baked in
// at funded-time / admin setRepayment); fall back to requested_amount +
// instant fee so a charge before the funded transition still collects $30
// for instant delivery instead of dropping the $5.
function computeChargeAmountCents(row) {
  if (row.repayment_amount != null) {
    return Math.round(parseFloat(row.repayment_amount) * 100);
  }
  const baseAmount = parseFloat(row.requested_amount) || 25;
  const instantFee = row.delivery_type === 'instant' ? 5 : 0;
  return Math.round((baseAmount + instantFee) * 100);
}

// Auto-approval. Reuses the same classification + accrual pipeline
// that powers /admin/income_analysis: pulls transactions from FC (or
// Plaid for legacy users), classifies each, and sums per-source
// accrued wages. If accrued income comfortably covers the requested
// advance, we flip status to 'approved' automatically and set the
// offer-expiry timer. Otherwise we leave the application as
// 'bank_connected' for manual review.
//
// Safeguards (any one fails → manual review):
//   - First advance only (repayment_count == 0)
//   - State must be eligible (not waitlisted)
//   - User must not have any historical repayment_failed state
//   - Accrued income must be >= 1.2x the requested amount (20% buffer
//     against classification noise)
//
// Marks an application 'funded' and performs the three downstream
// side effects:
//   1. Schedule the repayment row (amount + due date)
//   2. (ACH payout only) Fire stripe.transfers.create() to push money
//      to the Connect external_account. If same-day delivery, also
//      stripe.payouts.create({method: 'instant'}) for RTP delivery.
//   3. Create the $3.99/mo subscription anchored to the repayment date
//
// Extracted from the funded branch of PATCH /admin/applications/:id/status
// so it can be called from auto-approval too (and from anywhere else
// in the future). Idempotent on the subscription (won't recreate if
// subscription_id is already set) and on the transfer (no idempotency
// key today — relies on the caller not invoking it twice for the same
// application in 'funded' state).
//
// Always returns the updated row. Does NOT throw on Stripe errors;
// errors are logged + system-messaged but the caller still sees a
// funded application.
async function transitionToFunded(row) {
  let updated = await db.updateApplicationStatus(row.id, 'funded') || row;
  // 1. Schedule the repayment row
  const baseAmount = parseFloat(updated.requested_amount) || 25;
  const instantFee = updated.delivery_type === 'instant' ? 5 : 0;
  const repayAmount = baseAmount + instantFee;
  const dueDate = updated.payday
    ? new Date(updated.payday).toISOString().slice(0, 10)
    : new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  updated = await db.setRepayment(updated.id, repayAmount, dueDate, '') || updated;
  await db.addMessage(updated.id, 'system', `Your advance has been sent. Repayment of $${repayAmount.toFixed(2)} is due on ${dueDate}.`);

  // 2. Disbursement.
  // PREFERRED: Stripe Connect Custom (zero-friction, instant payouts).
  // Tries automatically when the user has a Connect account in good
  // KYC standing AND a cloned external_account. If any of those aren't
  // true, falls back to manual Brex (admin copies routing/account from
  // the admin panel into Brex).
  if (updated.payout_methods === 'ACH') {
    try {
      const amountCents = Math.round(baseAmount * 100);
      const deliveryType = updated.delivery_type === 'instant' ? 'instant' : 'standard';
      const result = await connectCustom.disburseViaConnect(stripe, db, updated, amountCents, deliveryType);
      if (result.paid) {
        await db.addMessage(updated.id, 'system', `Advance paid via Stripe (${result.method}). Payout id ${result.payoutId}.`);
        updated = await db.getApplicationById(updated.id) || updated;
      } else {
        // Falls through to manual Brex. Surface the reason so admin
        // knows whether to expect KYC to clear or whether they need
        // to handle this user manually.
        await db.addMessage(updated.id, 'system', `Stripe payout not available (${result.reason}). Use Brex for manual ACH disbursement — routing + account number visible in admin panel.`);
      }
    } catch (connectErr) {
      console.warn('[funded] Connect disbursement error (fall back to Brex)', connectErr.message);
      await db.addMessage(updated.id, 'system', `Stripe payout errored (${connectErr.message}). Use Brex for manual ACH disbursement.`);
    }
  }

  // 3. Subscription bootstrap
  if (
    !updated.subscription_id &&
    updated.stripe_customer_id &&
    updated.stripe_payment_method_id
  ) {
    try {
      const paymentMethodId = updated.stripe_payment_method_id;
      const MEMBERSHIP_PRODUCT_ID = await getMembershipProductId();
      // Anchor the first $3.99 invoice to the user's repayment_due_date
      // so the membership charge fires the SAME DAY as the advance
      // repayment — both come out together. Monthly recurrence from
      // that same date going forward.
      //
      // safeFutureAnchorUnix handles two failure modes:
      //   - TZ shift: pg DATE → ISO conversion shifting the day back
      //   - Anchor-in-past: if due_date is already past (e.g. backfill
      //     of legacy user), bumps forward by 1-day increments until
      //     safely in the future.
      const anchor = safeFutureAnchorUnix(dueDate);
      const sub = await stripe.subscriptions.create({
        customer: updated.stripe_customer_id,
        items: [{
          price_data: {
            currency: 'usd',
            product: MEMBERSHIP_PRODUCT_ID,
            unit_amount: MEMBERSHIP_PRICE_CENTS,
            recurring: { interval: 'month' },
          },
        }],
        default_payment_method: paymentMethodId,
        payment_settings: {
          payment_method_types: ['us_bank_account'],
          payment_method_options: {
            us_bank_account: { verification_method: 'instant' },
          },
          save_default_payment_method: 'on_subscription',
        },
        billing_cycle_anchor: anchor,
        proration_behavior: 'none',
        metadata: { application_id: updated.id },
      });
      const anchorDate = new Date(anchor * 1000).toISOString().slice(0, 10);
      const nextBilling = sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString().slice(0, 10)
        : anchorDate;
      updated = await db.saveSubscription(updated.id, sub.id, 'active', nextBilling);
      await db.addMessage(updated.id, 'system', `Membership starts on ${anchorDate} — $3.99 charged alongside your first advance repayment, then monthly on the same date.`);
      console.log('[funded] subscription created', { application_id: updated.id, subscription_id: sub.id, anchor_date: anchorDate });
    } catch (subErr) {
      console.log('[funded] subscription create failed', { application_id: updated.id, error: subErr.message });
      await db.addMessage(updated.id, 'system', `Membership setup failed: ${subErr.message}. Contact us to resolve.`);
    }
  }
  return updated;
}

// Returns { approved, total_accrued_cents, reason }. Caller decides
// what to do with the result (we currently fire-and-forget).
async function autoApproveIfEligible(applicationId) {
  const row = await db.getApplicationById(applicationId);
  if (!row) return { approved: false, reason: 'not found' };

  // Status gate — only auto-approve from 'bank_connected'
  if (row.status !== 'bank_connected') {
    return { approved: false, reason: `status is ${row.status}, expected bank_connected` };
  }

  // Safeguard: first-advance only. Repeat customers go to manual
  // review until we trust the auto-approval signal more.
  if ((row.repayment_count || 0) > 0) {
    return { approved: false, reason: 'repeat customer — manual review' };
  }

  // Safeguard: state must be eligible (sanity — shouldn't have reached
  // bank_connected if not, but defense in depth)
  if (row.subscription_status === 'waitlisted') {
    return { approved: false, reason: 'waitlisted state' };
  }

  // Compute accrued income via the same pipeline as the admin
  // income-analysis endpoint.
  try {
    let txs = [];
    if (row.stripe_fc_account_id) {
      const fcTxs = await fetchFcTransactions(row.stripe_fc_account_id);
      const { adaptFcTransactions } = require('./fcTransactionAdapter');
      txs = adaptFcTransactions(fcTxs);
    } else if (row.access_token) {
      // Legacy Plaid path
      let cursor, hasMore = true, iter = 0;
      while (hasMore && iter < 10) {
        const syncResp = await client.transactionsSync({
          access_token: row.access_token,
          cursor,
          count: 500,
          options: { include_personal_finance_category: true },
        });
        txs = txs.concat(syncResp.data.added || []);
        cursor = syncResp.data.next_cursor;
        hasMore = syncResp.data.has_more;
        iter++;
      }
    } else {
      return { approved: false, reason: 'no bank linked' };
    }

    // Normalise: positive cents = income, negative = spend (matches
    // what classifyTransaction expects)
    const rawTxs = txs.map(tx => ({
      id: tx.transaction_id,
      description: tx.merchant_name || tx.name || '',
      amount: Math.round(-tx.amount * 100),
      currency: (tx.iso_currency_code || 'usd').toLowerCase(),
      date: tx.date,
      category: '',
      pfc: tx.personal_finance_category?.primary || null,
    }));

    const incoming = rawTxs.filter(tx => tx.amount > 0);
    const refundIds = buildRefundSet(rawTxs);
    const classified = await Promise.all(
      incoming.map(async tx => {
        const cls = await classifyTransaction(tx.description, tx.category, tx.pfc, refundIds.has(tx.id));
        return { ...tx, ...cls };
      })
    );

    const incomeCandidates = classified.filter(tx =>
      tx.status === 'wage_income' || tx.status === 'uncertain'
    );
    let incomeSources = await db.getIncomeSources(row.id);
    if (incomeSources.length === 0 && row.payday) {
      const fmtDate = v => v ? (typeof v === 'string' ? v.slice(0, 10) : new Date(v).toISOString().slice(0, 10)) : null;
      incomeSources = [{ id: null, employer: row.employer || '', payday: fmtDate(row.payday), pay_frequency: row.pay_frequency }];
    }
    const sourcesWithAccrued = incomeSources.map(src => calcSourceAccrued(src, incomeCandidates));
    const total_accrued_cents = sourcesWithAccrued.reduce((sum, s) => sum + (s.accrued_cents || 0), 0);

    const requested_cents = Math.round((parseFloat(row.requested_amount) || 25) * 100);
    // Safeguard: 20% buffer against classification noise — accrued
    // must comfortably exceed the requested amount.
    const threshold_cents = Math.round(requested_cents * 1.2);

    if (total_accrued_cents < threshold_cents) {
      const accruedDollars = (total_accrued_cents / 100).toFixed(2);
      const requestedDollars = (requested_cents / 100).toFixed(2);
      const reason = `accrued $${accruedDollars} < threshold (1.2x $${requestedDollars})`;
      console.log('[auto-approve] insufficient accrual', { application_id: row.id, accrued: total_accrued_cents, requested: requested_cents, threshold: threshold_cents });
      await db.addMessage(row.id, 'system', `Awaiting manual review — automated income check: $${accruedDollars} accrued, needs at least $${(threshold_cents/100).toFixed(2)}.`);
      return { approved: false, total_accrued_cents, reason };
    }

    // ── Auto-approve ──────────────────────────────────────────────
    let updated = await db.updateApplicationStatus(row.id, 'approved');
    const expiresAt = getOfferExpiresAt(new Date(), row.state);
    await db.saveOfferExpiry(row.id, expiresAt);
    await db.addMessage(row.id, 'system', `Auto-approved! Your bank shows $${(total_accrued_cents/100).toFixed(2)} in accrued earnings — more than enough to cover a $${(requested_cents/100).toFixed(2)} advance.`);
    addToMailchimp(updated?.name || row.name, updated?.email || row.email, updated?.state || row.state, ['approved'])
      .catch(err => console.log('[mailchimp approved] error:', err.message));
    console.log('[auto-approve] approved', { application_id: row.id, accrued: total_accrued_cents, requested: requested_cents });

    // (Removed) Auto-fund. Since we now send money manually via
    // Brex using the user's bank routing + account number, the
    // funded transition only fires when admin explicitly clicks
    // 'Mark funded' in the admin panel — that's when the repayment
    // gets scheduled and the membership subscription is created.
    // Until then the application sits in the Approved tab waiting
    // for the manual Brex send.
    return { approved: true, total_accrued_cents };
  } catch (err) {
    console.log('[auto-approve] error — falling back to manual review', { application_id: applicationId, error: err.message });
    return { approved: false, reason: `error: ${err.message}` };
  }
}

// Repayment-collection cascade. The user's spec:
//   Day 0 (attempt 1): try card → if fails, immediately try ACH same-day
//                      (no balance check). Both happen in one cron tick.
//   Day 1-3 (attempts 2-4): retry card daily.
//   Day 4 (attempt 5): balance check via FC + ACH same-day.
//   Day 5+ : locked out (status='repayment_failed').
//
// One thing worth knowing: between Day 0's ACH (status=processing) and
// the Day 1+ card retries, the ACH might still be in flight. To avoid
// double-collecting, we cancel any prior pending ACH PaymentIntent
// before each card retry. If the cancellation fails (e.g. the ACH
// already settled), we abort the retry — it was a no-op anyway.
async function cancelPendingChargeIfAny(row) {
  if (!row.charge_intent_id) return false;
  try {
    const pi = await stripe.paymentIntents.retrieve(row.charge_intent_id);
    if (pi.status === 'processing' || pi.status === 'requires_payment_method' || pi.status === 'requires_action') {
      await stripe.paymentIntents.cancel(pi.id);
      console.log('[cascade] cancelled prior pending PI', { application_id: row.id, pi_id: pi.id });
      return true;
    }
    if (pi.status === 'succeeded') {
      console.log('[cascade] prior PI already succeeded — skipping retry to avoid double-collect', { application_id: row.id, pi_id: pi.id });
      return 'already_succeeded';
    }
  } catch (e) {
    console.log('[cascade] could not retrieve/cancel prior PI', { application_id: row.id, error: e.message });
  }
  return false;
}

async function tryCardCharge(row, amount, attemptLabel) {
  if (!row.stripe_card_pm_id) return { ok: false, reason: 'no card on file' };
  try {
    const pi = await stripe.paymentIntents.create({
      amount, currency: 'usd',
      customer: row.stripe_customer_id,
      payment_method: row.stripe_card_pm_id,
      payment_method_types: ['card'],
      off_session: true, confirm: true,
      description: `Cash advance repayment — ${row.name} (${attemptLabel})`,
      metadata: { application_id: row.id, method: 'card', attempt_label: attemptLabel },
    });
    return { ok: pi.status === 'succeeded', pi, method: 'card', status: pi.status };
  } catch (e) {
    return { ok: false, reason: e.message, error: e, method: 'card' };
  }
}

async function tryAchCharge(row, amount, attemptLabel) {
  if (!row.stripe_payment_method_id) return { ok: false, reason: 'no bank on file' };
  try {
    // Note: payment_method_options.us_bank_account.preferred_settlement_speed
    // was deprecated by Stripe. Same-Day ACH is no longer requestable via
    // this parameter — standard 3-5 day ACH is what we get. If Stripe ships
    // a replacement for Same-Day ACH on PaymentIntents, plug it in here.
    const pi = await stripe.paymentIntents.create({
      amount, currency: 'usd',
      customer: row.stripe_customer_id,
      payment_method: row.stripe_payment_method_id,
      payment_method_types: ['us_bank_account'],
      off_session: true, confirm: true,
      description: `Cash advance repayment — ${row.name} (${attemptLabel})`,
      metadata: { application_id: row.id, method: 'ach', attempt_label: attemptLabel },
    });
    // ACH returns 'processing' immediately; 'succeeded' arrives later via webhook.
    return { ok: pi.status === 'succeeded' || pi.status === 'processing', pi, method: 'ach', status: pi.status };
  } catch (e) {
    return { ok: false, reason: e.message, error: e, method: 'ach' };
  }
}

// Returns { paid, processing, failed, pi, method, message } describing
// the result. Caller is responsible for updating DB state.
async function chargeRepaymentWithCascade(row, amount) {
  const attemptCount = row.repayment_attempt_count || 0;
  const hasCard = !!row.stripe_card_pm_id;

  // ── Attempt 1 (Day 0): card-then-ACH waterfall ──────────────────
  if (attemptCount === 0) {
    // Try card first IF we have one. Skip-card users go straight to ACH.
    if (hasCard) {
      const cardResult = await tryCardCharge(row, amount, 'attempt 1 — card');
      if (cardResult.ok) {
        return { paid: true, pi: cardResult.pi, method: 'card', message: `Card charged successfully.` };
      }
    }
    // No card OR card failed — try ACH same-day (no balance check).
    const achResult = await tryAchCharge(row, amount, hasCard ? 'attempt 1 — ACH fallback (card failed)' : 'attempt 1 — ACH (no card on file)');
    if (achResult.ok && achResult.status === 'succeeded') {
      return { paid: true, pi: achResult.pi, method: 'ach', message: hasCard ? `Card failed; ACH succeeded.` : `ACH succeeded.` };
    }
    if (achResult.ok && achResult.status === 'processing') {
      return { processing: true, pi: achResult.pi, method: 'ach', message: hasCard ? `Card failed; ACH same-day initiated.` : `ACH same-day initiated.` };
    }
    return { failed: true, reason: hasCard ? `Card and ACH both failed.` : `ACH failed: ${achResult.reason}` };
  }

  // ── Attempts 2-4 (Days 1-3): card-only retries, ONLY if card exists ──
  // Skip-card users branch straight to balance-check ACH on attempts 1+.
  if (hasCard && attemptCount >= 1 && attemptCount <= 3) {
    const cancelResult = await cancelPendingChargeIfAny(row);
    if (cancelResult === 'already_succeeded') {
      return { paid: true, message: 'Prior ACH actually settled — marking as paid.' };
    }
    const cardResult = await tryCardCharge(row, amount, `attempt ${attemptCount + 1} — card retry ${attemptCount}/3`);
    if (cardResult.ok) {
      return { paid: true, pi: cardResult.pi, method: 'card', message: `Card retry ${attemptCount}/3 succeeded.` };
    }
    return { failed: true, reason: `Card retry ${attemptCount}/3 failed: ${cardResult.reason}`, error: cardResult.error };
  }

  // ── Attempt 5 (Day 4) for card users OR ALL retry attempts for
  //    skip-card users: balance check + ACH same-day ──────────────
  // For card users: this is the final stage after 3 failed card retries.
  // For skip-card users: this is every retry attempt from attempt 1 on.
  if ((hasCard && attemptCount === 4) || (!hasCard && attemptCount >= 1 && attemptCount <= 4)) {
    const cancelResult = await cancelPendingChargeIfAny(row);
    if (cancelResult === 'already_succeeded') {
      return { paid: true, message: 'Prior ACH actually settled — marking as paid.' };
    }
    const overdraft = await checkOverdraft(row, amount);
    if (!overdraft.ok) {
      return { failed: true, reason: `ACH retry skipped — ${overdraft.reason}` };
    }
    const labelStage = hasCard ? 'final ACH with balance check' : `ACH retry ${attemptCount}/4 with balance check`;
    const achResult = await tryAchCharge(row, amount, `attempt ${attemptCount + 1} — ${labelStage}`);
    if (achResult.ok && achResult.status === 'succeeded') {
      return { paid: true, pi: achResult.pi, method: 'ach', message: `ACH (balance-checked) succeeded.` };
    }
    if (achResult.ok && achResult.status === 'processing') {
      return { processing: true, pi: achResult.pi, method: 'ach', message: `ACH (balance-checked) initiated.` };
    }
    return { failed: true, reason: `ACH attempt failed: ${achResult.reason}`, error: achResult.error };
  }

  // attempt >= 5 means we've exhausted the cascade.
  return { failed: true, reason: `All 5 collection attempts exhausted.`, terminal: true };
}

// Force the user's membership subscription to bill RIGHT NOW.
// Called after a successful advance charge so the $3.99 membership
// PaymentIntent fires alongside the $25 (or whatever) advance PI in
// Stripe → Payments — within seconds of each other rather than
// hours/days apart on Stripe's own schedule.
//
// Safe to call even if the subscription's current period was already
// billed: Stripe returns 'invoice_no_customer_balance_available' or
// similar, we swallow and move on.
async function forceBillSubscriptionNow(row) {
  if (!row.subscription_id || !row.stripe_customer_id) {
    return { ok: false, reason: 'no subscription on file' };
  }
  try {
    // Create-and-finalize an invoice on the subscription's current
    // period. auto_advance:true makes Stripe charge it as soon as it
    // finalizes (no separate finalize/pay step needed).
    const invoice = await stripe.invoices.create({
      customer: row.stripe_customer_id,
      subscription: row.subscription_id,
      auto_advance: true,
      description: `Bits Cash Advance — monthly membership ($3.99) — billed alongside advance repayment`,
      metadata: { application_id: row.id, trigger: 'advance-charge-companion' },
    });
    console.log('[forceBillSubscription] invoice created', { application_id: row.id, invoice_id: invoice.id, status: invoice.status });
    return { ok: true, invoice };
  } catch (err) {
    // Common reasons: nothing to invoice (already billed this period),
    // or the subscription is in a non-billable state. None are fatal —
    // the next scheduled invoice fires on its own anchor date.
    console.log('[forceBillSubscription] skipped', { application_id: row.id, reason: err.message });
    return { ok: false, reason: err.message };
  }
}

app.post('/api/advance/admin/applications/:id/charge', async function (request, response, next) {
  if (!requireAdmin(request, response)) return;
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });

    const hasAnyPm = !!(row.stripe_card_pm_id || row.stripe_payment_method_id);
    if (!row.stripe_customer_id || !hasAnyPm) {
      return response.status(400).json({ error: { error_message: 'No payment method on file for this application' } });
    }

    const amount = computeChargeAmountCents(row);
    console.log('[charge] computed amount', { application_id: row.id, amount_cents: amount, attempt_count: row.repayment_attempt_count });

    // Run the card→ACH cascade. Each call to the cascade represents ONE
    // cron-tick / admin-button click; the attempt counter is bumped
    // after the call resolves.
    const result = await chargeRepaymentWithCascade(row, amount);
    await db.bumpRepaymentAttemptCount(row.id);
    const newAttemptCount = (row.repayment_attempt_count || 0) + 1;

    if (result.paid) {
      await db.markRepaymentPaid(row.id);
      await db.incrementRepaymentCount(row.id);
      await db.resetRepaymentAttemptCount(row.id);
      if (result.pi) await db.saveStripeCharge(row.id, result.pi.id, result.pi.status);
      await db.addMessage(row.id, 'system', `Payment of $${(amount / 100).toFixed(2)} collected successfully via ${result.method || 'card'}.`);
      await forceBillSubscriptionNow(row);
      const updated = await db.getApplicationById(request.params.id);
      return response.json({ application: db.publicApp(updated), status: 'paid', method: result.method });
    }
    if (result.processing) {
      if (result.pi) await db.saveStripeCharge(row.id, result.pi.id, result.pi.status);
      await db.addMessage(row.id, 'system', `${result.message} (attempt ${newAttemptCount}/5)`);
      await forceBillSubscriptionNow(row);
      const updated = await db.getApplicationById(request.params.id);
      return response.json({ application: db.publicApp(updated), status: 'processing' });
    }
    // result.failed
    if (result.terminal || newAttemptCount >= 5) {
      await db.updateApplicationStatus(row.id, 'repayment_failed');
      await db.addMessage(row.id, 'system', `Payment failed after ${newAttemptCount} attempts. ${result.reason}. Account locked from new advances.`);
      return response.status(402).json({ error: { error_message: result.reason }, attempt: newAttemptCount, terminal: true });
    }
    await db.addMessage(row.id, 'system', `Payment attempt ${newAttemptCount}/5 failed. ${result.reason}. We'll retry tomorrow.`);
    return response.status(402).json({ error: { error_message: result.reason }, attempt: newAttemptCount });
  } catch (err) {
    next(err);
  }
});

// Backfill: create the $3.99 monthly subscription for an existing user
// who's missing one. Used when a user was funded BEFORE the subscription-
// creation code was added (or before the payment_settings config was
// added and the previous attempt failed silently). Idempotent — if the
// user already has a subscription_id, returns it without creating a new one.
app.post('/api/advance/admin/applications/:id/membership/setup', async function (request, response, next) {
  if (!requireAdmin(request, response)) return;
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });
    if (row.subscription_id) {
      return response.json({ application: db.publicApp(row), already: true, subscription_id: row.subscription_id });
    }
    if (!row.stripe_customer_id || !row.stripe_payment_method_id) {
      return response.status(400).json({ error: { error_message: 'User needs a Stripe customer + bank PaymentMethod before membership can be set up.' } });
    }

    // Anchor the first $3.99 invoice to the user's repayment_due_date
    // so the membership charge fires alongside the advance repayment.
    // Falls back to today if no repayment_due_date is set yet (unusual
    // for backfill since the funded handler usually sets it first).
    const anchor = safeFutureAnchorUnix(row.repayment_due_date);
    const anchorDate = new Date(anchor * 1000).toISOString().slice(0, 10);
    const MEMBERSHIP_PRODUCT_ID = await getMembershipProductId();

    const sub = await stripe.subscriptions.create({
      customer: row.stripe_customer_id,
      items: [{
        price_data: {
          currency: 'usd',
          product: MEMBERSHIP_PRODUCT_ID,
          unit_amount: MEMBERSHIP_PRICE_CENTS,
          recurring: { interval: 'month' },
        },
      }],
      default_payment_method: row.stripe_payment_method_id,
      payment_settings: {
        payment_method_types: ['us_bank_account'],
        payment_method_options: {
          us_bank_account: { verification_method: 'instant' },
        },
        save_default_payment_method: 'on_subscription',
      },
      billing_cycle_anchor: anchor,
      proration_behavior: 'none',
      metadata: { application_id: row.id, backfilled: 'true' },
    });

    const nextBilling = sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString().slice(0, 10)
      : anchorDate;
    const updated = await db.saveSubscription(row.id, sub.id, 'active', nextBilling);
    await db.addMessage(row.id, 'system', `Membership ($3.99/mo) starts on ${anchorDate} — first charge fires alongside the advance repayment.`);
    console.log('[admin/membership/setup] subscription backfilled', { application_id: row.id, subscription_id: sub.id, anchor_date: anchorDate });
    response.json({ application: db.publicApp(updated), subscription_id: sub.id });
  } catch (err) {
    console.log('[admin/membership/setup] error', err.message);
    next(err);
  }
});

app.post('/api/advance/admin/run-due-repayments', async function (request, response, next) {
  if (!requireAdmin(request, response)) return;
  try {
    const due = await db.getDueApplications();
    const results = [];

    for (const row of due) {
      const amount = computeChargeAmountCents(row);
      const hasAnyPm = !!(row.stripe_card_pm_id || row.stripe_payment_method_id);
      if (!hasAnyPm) { results.push({ id: row.id, name: row.name, status: 'skipped', error: 'No payment method' }); continue; }
      try {
        const result = await chargeRepaymentWithCascade(row, amount);
        await db.bumpRepaymentAttemptCount(row.id);
        const newAttemptCount = (row.repayment_attempt_count || 0) + 1;

        if (result.paid) {
          await db.markRepaymentPaid(row.id);
          await db.resetRepaymentAttemptCount(row.id);
          if (result.pi) await db.saveStripeCharge(row.id, result.pi.id, result.pi.status);
          await db.addMessage(row.id, 'system', `Payment of $${(amount / 100).toFixed(2)} collected via ${result.method}.`);
          await forceBillSubscriptionNow(row);
          results.push({ id: row.id, name: row.name, status: 'paid', method: result.method });
        } else if (result.processing) {
          if (result.pi) await db.saveStripeCharge(row.id, result.pi.id, result.pi.status);
          await db.addMessage(row.id, 'system', `${result.message} (attempt ${newAttemptCount}/5)`);
          await forceBillSubscriptionNow(row);
          results.push({ id: row.id, name: row.name, status: 'processing', method: result.method });
        } else {
          // failed
          if (result.terminal || newAttemptCount >= 5) {
            await db.updateApplicationStatus(row.id, 'repayment_failed');
            await db.addMessage(row.id, 'system', `Payment failed after ${newAttemptCount} attempts. ${result.reason}. Account locked.`);
          } else {
            await db.addMessage(row.id, 'system', `Attempt ${newAttemptCount}/5 failed: ${result.reason}. Retrying tomorrow.`);
          }
          results.push({ id: row.id, name: row.name, status: 'failed', reason: result.reason, attempt: newAttemptCount });
        }
      } catch (err) {
        const msg = err.message || 'Unknown error';
        await db.addMessage(row.id, 'system', `Cron error during charge: ${msg}`);
        results.push({ id: row.id, name: row.name, status: 'error', error: msg });
      }
    }

    response.json({ processed: results.length, results });
  } catch (err) { next(err); }
});



// Create a link token with configs which we can then use to initialize Plaid Link client-side.
// See https://plaid.com/docs/#create-link-token
app.post('/api/create_link_token', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const configs = {
        user: {
          // This should correspond to a unique id for the current user.
          client_user_id: 'user-id',
        },
        client_name: 'Plaid Quickstart',
        products: PLAID_PRODUCTS,
        country_codes: PLAID_COUNTRY_CODES,
        language: 'en',
      };

      if (PLAID_REDIRECT_URI !== '') {
        configs.redirect_uri = PLAID_REDIRECT_URI;
      }

      if (PLAID_ANDROID_PACKAGE_NAME !== '') {
        configs.android_package_name = PLAID_ANDROID_PACKAGE_NAME;
      }
      if (PLAID_PRODUCTS.includes(Products.Statements)) {
        const statementConfig = {
          end_date: moment().format('YYYY-MM-DD'),
          start_date: moment().subtract(30, 'days').format('YYYY-MM-DD'),
        }
        configs.statements = statementConfig;
      }

      if (PLAID_PRODUCTS.some(product => product.startsWith("cra_"))) {
        // Use user_token if available, otherwise use user_id
        if (USER_TOKEN) {
          configs.user_token = USER_TOKEN;
          // Keep user object when using user_token
        } else if (USER_ID) {
          configs.user_id = USER_ID;
          // Remove user object when using user_id
          delete configs.user;
        }
        configs.cra_options = {
          days_requested: 60
        };
        configs.consumer_report_permissible_purpose = 'ACCOUNT_REVIEW_CREDIT';
      }
      const createTokenResponse = await client.linkTokenCreate(configs);
      prettyPrintResponse(createTokenResponse);
      response.json(createTokenResponse.data);
    })
    .catch(next);
});

// Create a user token which can be used for Plaid Check, Income, or Multi-Item link flows
// https://plaid.com/docs/api/users/#usercreate
app.post('/api/create_user_token', function (request, response, next) {
  Promise.resolve()
    .then(async function () {

      const userRequest = {
        // Typically this will be a user ID number from your application.
        client_user_id: 'user_' + uuidv4()
      }

      if (PLAID_PRODUCTS.some(product => product.startsWith("cra_"))) {
        // Default to sending identity object
        userRequest.identity = {
          name: {
            given_name: 'Harry',
            family_name: 'Potter'
          },
          date_of_birth: '1980-07-31',
          phone_numbers: [{
            data: '+16174567890',
            primary: true
          }],
          emails: [{
            data: 'harrypotter@example.com',
            primary: true
          }],
          addresses: [{
            street_1: '4 Privet Drive',
            city: 'New York',
            region: 'NY',
            postal_code: '11111',
            country: 'US',
            primary: true
          }]
        }
      }

      try {
        const user = await client.userCreate(userRequest);

        if (user.data.user_token) {
          USER_TOKEN = user.data.user_token;
        }
        if (user.data.user_id) {
          USER_ID = user.data.user_id;
        }

        response.json(user.data);
      } catch (error) {
        if (error.response && error.response.data &&
            error.response.data.error_code === 'INVALID_FIELD' &&
            PLAID_PRODUCTS.some(product => product.startsWith("cra_"))) {

          // Retry with consumer_report_user_identity
          delete userRequest.identity;
          userRequest.consumer_report_user_identity = {
            date_of_birth: '1980-07-31',
            first_name: 'Harry',
            last_name: 'Potter',
            phone_numbers: ['+16174567890'],
            emails: ['harrypotter@example.com'],
            primary_address: {
              city: 'New York',
              region: 'NY',
              street: '4 Privet Drive',
              postal_code: '11111',
              country: 'US'
            }
          }

          const retryUser = await client.userCreate(userRequest);

          if (retryUser.data.user_token) {
            USER_TOKEN = retryUser.data.user_token;
          }
          if (retryUser.data.user_id) {
            USER_ID = retryUser.data.user_id;
          }

          response.json(retryUser.data);
        } else {
          throw error;
        }
      }
    }).catch(next);
});


// Create a link token with configs which we can then use to initialize Plaid Link client-side
// for a 'payment-initiation' flow.
// See:
// - https://plaid.com/docs/payment-initiation/
// - https://plaid.com/docs/#payment-initiation-create-link-token-request
app.post(
  '/api/create_link_token_for_payment',
  function (request, response, next) {
    Promise.resolve()
      .then(async function () {
        const createRecipientResponse =
          await client.paymentInitiationRecipientCreate({
            name: 'Harry Potter',
            iban: 'GB33BUKB20201555555555',
            address: {
              street: ['4 Privet Drive'],
              city: 'Little Whinging',
              postal_code: '11111',
              country: 'GB',
            },
          });
        const recipientId = createRecipientResponse.data.recipient_id;
        prettyPrintResponse(createRecipientResponse);

        const createPaymentResponse =
          await client.paymentInitiationPaymentCreate({
            recipient_id: recipientId,
            reference: 'paymentRef',
            amount: {
              value: 1.23,
              currency: 'GBP',
            },
          });
        prettyPrintResponse(createPaymentResponse);
        const paymentId = createPaymentResponse.data.payment_id;

        // We store the payment_id in memory for demo purposes - in production, store it in a secure
        // persistent data store along with the Payment metadata, such as userId.
        PAYMENT_ID = paymentId;

        const configs = {
          client_name: 'Plaid Quickstart',
          user: {
            // This should correspond to a unique id for the current user.
            // Typically, this will be a user ID number from your application.
            // Personally identifiable information, such as an email address or phone number, should not be used here.
            client_user_id: uuidv4(),
          },
          // Institutions from all listed countries will be shown.
          country_codes: PLAID_COUNTRY_CODES,
          language: 'en',
          // The 'payment_initiation' product has to be the only element in the 'products' list.
          products: [Products.PaymentInitiation],
          payment_initiation: {
            payment_id: paymentId,
          },
        };
        if (PLAID_REDIRECT_URI !== '') {
          configs.redirect_uri = PLAID_REDIRECT_URI;
        }
        const createTokenResponse = await client.linkTokenCreate(configs);
        prettyPrintResponse(createTokenResponse);
        response.json(createTokenResponse.data);
      })
      .catch(next);
  },
);

// Exchange token flow - exchange a Link public_token for
// an API access_token
// https://plaid.com/docs/#exchange-token-flow
app.post('/api/set_access_token', function (request, response, next) {
  PUBLIC_TOKEN = request.body.public_token;
  Promise.resolve()
    .then(async function () {
      const tokenResponse = await client.itemPublicTokenExchange({
        public_token: PUBLIC_TOKEN,
      });
      prettyPrintResponse(tokenResponse);
      ACCESS_TOKEN = tokenResponse.data.access_token;
      ITEM_ID = tokenResponse.data.item_id;
      response.json({
        // the 'access_token' is a private token, DO NOT pass this token to the frontend in your production environment
        access_token: ACCESS_TOKEN,
        item_id: ITEM_ID,
        error: null,
      });
    })
    .catch(next);
});

// Retrieve ACH or ETF Auth data for an Item's accounts
// https://plaid.com/docs/#auth
app.get('/api/auth', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const authResponse = await client.authGet({
        access_token: ACCESS_TOKEN,
      });
      prettyPrintResponse(authResponse);
      response.json(authResponse.data);
    })
    .catch(next);
});

// Retrieve Transactions for an Item
// https://plaid.com/docs/#transactions
app.get('/api/transactions', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      // Set cursor to empty to receive all historical updates
      let cursor = null;

      // New transaction updates since "cursor"
      let added = [];
      let modified = [];
      // Removed transaction ids
      let removed = [];
      let hasMore = true;
      // Iterate through each page of new transaction updates for item
      while (hasMore) {
        const request = {
          access_token: ACCESS_TOKEN,
          cursor: cursor,
        };
        const response = await client.transactionsSync(request)
        const data = response.data;

        // If no transactions are available yet, wait and poll the endpoint.
        // Normally, we would listen for a webhook, but the Quickstart doesn't
        // support webhooks. For a webhook example, see
        // https://github.com/plaid/tutorial-resources or
        // https://github.com/plaid/pattern
        cursor = data.next_cursor;
        if (cursor === "") {
          await sleep(2000);
          continue;
        }

        // Add this page of results
        added = added.concat(data.added);
        modified = modified.concat(data.modified);
        removed = removed.concat(data.removed);
        hasMore = data.has_more;

        prettyPrintResponse(response);
      }

      const compareTxnsByDateAscending = (a, b) => (a.date > b.date) - (a.date < b.date);
      // Return the 8 most recent transactions
      const recently_added = [...added].sort(compareTxnsByDateAscending).slice(-8);
      response.json({ latest_transactions: recently_added });
    })
    .catch(next);
});

// Retrieve Investment Transactions for an Item
// https://plaid.com/docs/#investments
app.get('/api/investments_transactions', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const startDate = moment().subtract(30, 'days').format('YYYY-MM-DD');
      const endDate = moment().format('YYYY-MM-DD');
      const configs = {
        access_token: ACCESS_TOKEN,
        start_date: startDate,
        end_date: endDate,
      };
      const investmentTransactionsResponse =
        await client.investmentsTransactionsGet(configs);
      prettyPrintResponse(investmentTransactionsResponse);
      response.json({
        error: null,
        investments_transactions: investmentTransactionsResponse.data,
      });
    })
    .catch(next);
});

// Retrieve Identity for an Item
// https://plaid.com/docs/#identity
app.get('/api/identity', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const identityResponse = await client.identityGet({
        access_token: ACCESS_TOKEN,
      });
      prettyPrintResponse(identityResponse);
      response.json({ identity: identityResponse.data.accounts });
    })
    .catch(next);
});

// Retrieve real-time Balances for each of an Item's accounts
// https://plaid.com/docs/#balance
app.get('/api/balance', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const balanceResponse = await client.accountsBalanceGet({
        access_token: ACCESS_TOKEN,
      });
      prettyPrintResponse(balanceResponse);
      response.json({ accounts: balanceResponse.data.accounts });
    })
    .catch(next);
});

// Retrieve Holdings for an Item
// https://plaid.com/docs/#investments
app.get('/api/holdings', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const holdingsResponse = await client.investmentsHoldingsGet({
        access_token: ACCESS_TOKEN,
      });
      prettyPrintResponse(holdingsResponse);
      response.json({ error: null, holdings: holdingsResponse.data });
    })
    .catch(next);
});

// Retrieve Liabilities for an Item
// https://plaid.com/docs/#liabilities
app.get('/api/liabilities', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const liabilitiesResponse = await client.liabilitiesGet({
        access_token: ACCESS_TOKEN,
      });
      prettyPrintResponse(liabilitiesResponse);
      response.json({ error: null, liabilities: liabilitiesResponse.data });
    })
    .catch(next);
});

// Retrieve information about an Item
// https://plaid.com/docs/#retrieve-item
app.get('/api/item', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      // Pull the Item - this includes information about available products,
      // billed products, webhook information, and more.
      const itemResponse = await client.itemGet({
        access_token: ACCESS_TOKEN,
      });
      // Also pull information about the institution
      const configs = {
        institution_id: itemResponse.data.item.institution_id,
        country_codes: PLAID_COUNTRY_CODES,
      };
      const instResponse = await client.institutionsGetById(configs);
      prettyPrintResponse(itemResponse);
      response.json({
        item: itemResponse.data.item,
        institution: instResponse.data.institution,
      });
    })
    .catch(next);
});

// Retrieve an Item's accounts
// https://plaid.com/docs/#accounts
app.get('/api/accounts', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const accountsResponse = await client.accountsGet({
        access_token: ACCESS_TOKEN,
      });
      prettyPrintResponse(accountsResponse);
      response.json(accountsResponse.data);
    })
    .catch(next);
});

// Create and then retrieve an Asset Report for one or more Items. Note that an
// Asset Report can contain up to 100 items, but for simplicity we're only
// including one Item here.
// https://plaid.com/docs/#assets
app.get('/api/assets', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      // You can specify up to two years of transaction history for an Asset
      // Report.
      const daysRequested = 10;

      // The `options` object allows you to specify a webhook for Asset Report
      // generation, as well as information that you want included in the Asset
      // Report. All fields are optional.
      const options = {
        client_report_id: 'Custom Report ID #123',
        // webhook: 'https://your-domain.tld/plaid-webhook',
        user: {
          client_user_id: 'Custom User ID #456',
          first_name: 'Alice',
          middle_name: 'Bobcat',
          last_name: 'Cranberry',
          ssn: '123-45-6789',
          phone_number: '555-123-4567',
          email: 'alice@example.com',
        },
      };
      const configs = {
        access_tokens: [ACCESS_TOKEN],
        days_requested: daysRequested,
        options,
      };
      const assetReportCreateResponse = await client.assetReportCreate(configs);
      prettyPrintResponse(assetReportCreateResponse);
      const assetReportToken =
        assetReportCreateResponse.data.asset_report_token;
      const getResponse = await getAssetReportWithRetries(
        client,
        assetReportToken,
      );
      const pdfRequest = {
        asset_report_token: assetReportToken,
      };

      const pdfResponse = await client.assetReportPdfGet(pdfRequest, {
        responseType: 'arraybuffer',
      });
      prettyPrintResponse(getResponse);
      prettyPrintResponse(pdfResponse);
      response.json({
        json: getResponse.data.report,
        pdf: pdfResponse.data.toString('base64'),
      });
    })
    .catch(next);
});

app.get('/api/statements', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const statementsListResponse = await client.statementsList({ access_token: ACCESS_TOKEN });
      prettyPrintResponse(statementsListResponse);
      const pdfRequest = {
        access_token: ACCESS_TOKEN,
        statement_id: statementsListResponse.data.accounts[0].statements[0].statement_id
      };

      const statementsDownloadResponse = await client.statementsDownload(pdfRequest, {
        responseType: 'arraybuffer',
      });
      prettyPrintResponse(statementsDownloadResponse);
      response.json({
        json: statementsListResponse.data,
        pdf: statementsDownloadResponse.data.toString('base64'),
      });
    })
    .catch(next);
});

// This functionality is only relevant for the UK/EU Payment Initiation product.
// Retrieve Payment for a specified Payment ID
app.get('/api/payment', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const paymentGetResponse = await client.paymentInitiationPaymentGet({
        payment_id: PAYMENT_ID,
      });
      prettyPrintResponse(paymentGetResponse);
      response.json({ error: null, payment: paymentGetResponse.data });
    })
    .catch(next);
});

// This endpoint is still supported but is no longer recommended
// For Income best practices, see https://github.com/plaid/income-sample instead
app.get('/api/income/verification/paystubs', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const paystubsGetResponse = await client.incomeVerificationPaystubsGet({
        access_token: ACCESS_TOKEN
      });
      prettyPrintResponse(paystubsGetResponse);
      response.json({ error: null, paystubs: paystubsGetResponse.data })
    })
    .catch(next);
})

// Only bind the port when run directly (`node index.js`). When the file is
// `require`d (Jest + supertest), we skip the listen so multiple test files
// don't fight over the same port — supertest hits the in-memory app instead.
let server;
if (require.main === module) {
  server = app.listen(APP_PORT, function () {
    console.log('plaid-quickstart server listening on port ' + APP_PORT);
  });
}

const prettyPrintResponse = (response) => {
  console.log(util.inspect(response.data, { colors: true, depth: 4 }));
};

// This is a helper function to poll for the completion of an Asset Report and
// then send it in the response to the client. Alternatively, you can provide a
// webhook in the `options` object in your `/asset_report/create` request to be
// notified when the Asset Report is finished being generated.

const getAssetReportWithRetries = (
  plaidClient,
  asset_report_token,
  ms = 1000,
  retriesLeft = 20,
) => {
  const request = {
    asset_report_token,
  };

  return pollWithRetries(
    async () => {
      return await plaidClient.assetReportGet(request);
    }
  );
}

const formatError = (error) => {
  return {
    error: { ...error.data, status_code: error.status },
  };
};

app.get('/api/transfer_authorize', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const accountsResponse = await client.accountsGet({
        access_token: ACCESS_TOKEN,
      });
      ACCOUNT_ID = accountsResponse.data.accounts[0].account_id;

      const transferAuthorizationCreateResponse = await client.transferAuthorizationCreate({
        access_token: ACCESS_TOKEN,
        account_id: ACCOUNT_ID,
        type: 'debit',
        network: 'ach',
        amount: '1.00',
        ach_class: 'ppd',
        user: {
          legal_name: 'FirstName LastName',
          email_address: 'foobar@email.com',
          address: {
            street: '123 Main St.',
            city: 'San Francisco',
            region: 'CA',
            postal_code: '94053',
            country: 'US',
          },
        },
      });
      prettyPrintResponse(transferAuthorizationCreateResponse);
      AUTHORIZATION_ID = transferAuthorizationCreateResponse.data.authorization.id;
      response.json(transferAuthorizationCreateResponse.data);
    })
    .catch(next);
});


app.get('/api/transfer_create', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const transferCreateResponse = await client.transferCreate({
        access_token: ACCESS_TOKEN,
        account_id: ACCOUNT_ID,
        authorization_id: AUTHORIZATION_ID,
        description: 'Debit',
      });
      prettyPrintResponse(transferCreateResponse);
      TRANSFER_ID = transferCreateResponse.data.transfer.id
      response.json({
        error: null,
        transfer: transferCreateResponse.data.transfer,
      });
    })
    .catch(next);
});

app.get('/api/signal_evaluate', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const accountsResponse = await client.accountsGet({
        access_token: ACCESS_TOKEN,
      });
      ACCOUNT_ID = accountsResponse.data.accounts[0].account_id;

      // Generate unique transaction ID using timestamp and random component
      const clientTransactionId = `txn-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;

      const signalEvaluateRequest = {
        access_token: ACCESS_TOKEN,
        account_id: ACCOUNT_ID,
        client_transaction_id: clientTransactionId,
        amount: 100.00,
      };

      if (SIGNAL_RULESET_KEY) {
        signalEvaluateRequest.ruleset_key = SIGNAL_RULESET_KEY;
      }

      const signalEvaluateResponse = await client.signalEvaluate(signalEvaluateRequest);
      prettyPrintResponse(signalEvaluateResponse);
      response.json(signalEvaluateResponse.data);
    })
    .catch(next);
});

// Retrieve CRA Base Report and PDF
// Base report: https://plaid.com/docs/check/api/#cracheck_reportbase_reportget
// PDF: https://plaid.com/docs/check/api/#cracheck_reportpdfget
app.get('/api/cra/get_base_report', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      // Use user_token if available, otherwise use user_id
      const userIdentifier = USER_TOKEN || USER_ID;
      const identifierKey = USER_TOKEN ? 'user_token' : 'user_id';

      const getResponse = await getCraBaseReportWithRetries(client, userIdentifier, identifierKey);
      prettyPrintResponse(getResponse);

      const pdfRequest = {};
      pdfRequest[identifierKey] = userIdentifier;

      const pdfResponse = await client.craCheckReportPdfGet(pdfRequest, {
        responseType: 'arraybuffer'
      });

      response.json({
        report: getResponse.data.report,
        pdf: pdfResponse.data.toString('base64'),
      });
    })
    .catch(next);
});

const getCraBaseReportWithRetries = (
  plaidClient,
  userIdentifier,
  identifierKey = 'user_token'
) => {
  const requestBody = {};
  requestBody[identifierKey] = userIdentifier;

  return pollWithRetries(
    async () => {
      return await plaidClient.craCheckReportBaseReportGet(requestBody)
    }
  );
};

// Retrieve CRA Income Insights and PDF with Insights
// Income insights: https://plaid.com/docs/check/api/#cracheck_reportincome_insightsget
// PDF w/ income insights: https://plaid.com/docs/check/api/#cracheck_reportpdfget
app.get('/api/cra/get_income_insights', async (req, res, next) => {
  Promise.resolve()
    .then(async function () {
      // Use user_token if available, otherwise use user_id
      const userIdentifier = USER_TOKEN || USER_ID;
      const identifierKey = USER_TOKEN ? 'user_token' : 'user_id';

      const getResponse = await getCheckInsightsWithRetries(client, userIdentifier, identifierKey)
      prettyPrintResponse(getResponse);

      const pdfRequest = {};
      pdfRequest[identifierKey] = userIdentifier;
      pdfRequest.add_ons = ['cra_income_insights'];

      const pdfResponse = await client.craCheckReportPdfGet(pdfRequest, {
        responseType: 'arraybuffer'
      });

      res.json({
        report: getResponse.data.report,
        pdf: pdfResponse.data.toString('base64'),
      });
    })
    .catch(next);
});


const getCheckInsightsWithRetries = (
  plaidClient,
  userIdentifier,
  identifierKey
) => pollWithRetries(
  async () => {
    const request = {};
    request[identifierKey] = userIdentifier;
    return await plaidClient.craCheckReportIncomeInsightsGet(request);
  }
);

// Retrieve CRA Partner Insights
// https://plaid.com/docs/check/api/#cracheck_reportpartner_insightsget
app.get('/api/cra/get_partner_insights', async (req, res, next) => {
  Promise.resolve()
    .then(async function () {
      // Use user_token if available, otherwise use user_id
      const userIdentifier = USER_TOKEN || USER_ID;
      const identifierKey = USER_TOKEN ? 'user_token' : 'user_id';

      const response = await getCheckParnterInsightsWithRetries(client, userIdentifier, identifierKey);
      prettyPrintResponse(response);

      res.json(response.data);
    })
    .catch(next);
});


const getCheckParnterInsightsWithRetries = (
  plaidClient,
  userIdentifier,
  identifierKey = 'user_token'
) => {
  const requestBody = {};
  requestBody[identifierKey] = userIdentifier;

  return pollWithRetries(
    async () => {
      return await plaidClient.craCheckReportPartnerInsightsGet(requestBody);
    }
  );
};

// Since this quickstart does not support webhooks, this function can be used to poll
// an API that would otherwise be triggered by a webhook.
// For a webhook example, see
// https://github.com/plaid/tutorial-resources or
// https://github.com/plaid/pattern
const pollWithRetries = (
  requestCallback,
  ms = 1000,
  retriesLeft = 20,
) =>
  new Promise((resolve, reject) => {
    requestCallback()
      .then(resolve)
      .catch((error) => {
        const errorCode = error?.response?.data?.error_code;
        const statusCode = error?.response?.status;
        const isRetryable = errorCode === 'PRODUCT_NOT_READY' || (statusCode >= 500 && statusCode < 600);
        if (!isRetryable) {
          reject(error);
          return;
        }
        if (retriesLeft === 1) {
          reject('Ran out of retries while polling');
          return;
        }
        setTimeout(() => {
          pollWithRetries(
            requestCallback,
            ms,
            retriesLeft - 1,
          ).then(resolve).catch(reject);
        }, ms);
      });
  });

app.post('/api/link_exit_error', function (request, response, next) {
  console.log('[Link Exit Error (frontend)]');
  console.log(util.inspect(request.body, { colors: true, depth: 4 }));
  response.json({ status: 'logged' });
});

app.use('/api', function (request, response, next) {
  response.status(404).json({ error: { error_message: `Route not found: ${request.method} ${request.originalUrl}` } });
});

app.use('/api', function (error, request, response, next) {
  if (error.response?.data) {
    prettyPrintResponse(error.response);
    response.status(error.response.status || 500).json(formatError(error.response));
  } else {
    console.log(error.message || error);
    response.status(500).json({ error: { error_message: error.message || 'Internal server error' } });
  }
});

// Test-only exports. Lets Jest import the Express app for supertest and
// exercise the pure helper functions directly without booting the server
// or any background timers. Adding to module.exports is harmless in prod —
// nothing in the app depends on these names from outside.
module.exports = {
  app,
  // Plaid + Stripe clients exposed so integration tests can swap them via jest.mock
  client,
  stripe,
  // Pure functions — unit-testable
  isPlausibleSSN,
  payPeriodDays,
  findPaychecksByPattern,
  calcSourceAccrued,
  buildRefundSet,
  isExcludedByPFC,
  isExcludedByKeyword,
  classifyTransaction,
  getOfferExpiresAt,
  computeChargeAmountCents,
  generateReferralSlug,
  makeUniqueReferralCode,
  // Tag dispatch helper (lets mailchimp tests assert on side effects)
  addToMailchimp,
  // Cron task body (callable directly without waiting for setInterval)
  sendDueDateReminders,
  // Eligibility data
  ELIGIBLE_STATES,
  STATE_TIMEZONES,
};
