'use strict';

// read env vars from .env file
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Configuration, PlaidApi, Products, PlaidEnvironments, CraCheckReportProduct } = require('plaid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

const app = express();
app.use(
  bodyParser.urlencoded({
    extended: false,
  }),
);
app.use(bodyParser.json());
app.use(cors());

app.post('/api/info', function (request, response, next) {
  response.json({
    item_id: ITEM_ID,
    access_token: ACCESS_TOKEN,
    products: PLAID_PRODUCTS,
  });
});

const requireAdmin = (request, response) => {
  if (!ADMIN_TOKEN) return true;
  if (request.headers['x-admin-token'] === ADMIN_TOKEN) return true;
  response.status(401).json({ error: { error_message: 'Admin token is required' } });
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

// ── Advance application endpoints ─────────────────────────────────────────────

app.post('/api/advance/applications', async function (request, response, next) {
  try {
    const { name, email, phone, employer, payday, requested_amount, password, ssn, pay_frequency, state } = request.body;
    if (!password || password.length < 6) {
      return response.status(400).json({ error: { error_message: 'Password must be at least 6 characters' } });
    }
    const password_hash = await bcrypt.hash(password, 10);
    const row = await db.createApplication({ name: name || '', email: email || '', phone: phone || '', employer: employer || '', payday, requested_amount, password_hash, ssn: ssn || null, pay_frequency: pay_frequency || null, state: state || null });
    await db.addMessage(row.id, 'admin', `Thanks ${name || 'there'}. I have your $10 cash advance request. Next, connect your bank with Plaid so I can review income, balance, and recent activity.`);
    await db.addMessage(row.id, 'system', 'Use the Connect bank button. If approved, the reviewer may ask for routing and account details for manual payout. Never send your online banking password. Repayment is due within 30 days of funding.');
    const token = jwt.sign({ applicationId: row.id }, JWT_SECRET, { expiresIn: '30d' });
    response.json({ application: db.publicApp(row), token });
  } catch (err) {
    if (err.code === '23505') {
      return response.status(409).json({ error: { error_message: 'An application with this email already exists. Please log in.' } });
    }
    next(err);
  }
});

app.get('/api/advance/applications/:id', async function (request, response, next) {
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });
    response.json({ application: db.publicApp(row) });
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

// ── Stripe Financial Connections — bank verification + ACH payment method ─────

app.post('/api/advance/applications/:id/stripe/bank-setup-intent', async function (request, response, next) {
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
      payment_method_types: ['us_bank_account'],
      payment_method_options: {
        us_bank_account: {
          financial_connections: {
            permissions: ['payment_method', 'balances', 'transactions'],
          },
        },
      },
    });

    response.json({ client_secret: setupIntent.client_secret });
  } catch (err) { next(err); }
});

app.post('/api/advance/applications/:id/stripe/save-bank-account', async function (request, response, next) {
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

    // Retrieve the PM server-side — more reliable than trusting the client-side expand
    const pm = await stripe.paymentMethods.retrieve(payment_method_id);
    const fc_account_id = pm?.us_bank_account?.financial_connections_account ?? null;
    console.log('[save-bank-account] pm type:', pm.type, '| fc_account_id:', fc_account_id);

    // Subscribe to transactions so we can list them later
    if (fc_account_id) {
      try {
        await stripe.financialConnections.accounts.subscribe(fc_account_id, {
          features: ['transactions'],
        });
        console.log('[save-bank-account] subscribed to transactions for', fc_account_id);
      } catch (e) {
        console.log('[save-bank-account] subscribe error:', e.message);
      }
    }

    const updated = await db.saveBankAccount(request.params.id, payment_method_id, fc_account_id);
    if (!updated) return response.status(404).json({ error: { error_message: 'Application not found' } });
    await db.addMessage(request.params.id, 'system', 'Bank account connected. A reviewer will check the application and respond here.');
    response.json({ application: db.publicApp(updated) });
  } catch (err) { next(err); }
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
app.post('/api/advance/applications/:id/subscription/activate', async function (request, response, next) {
  const payload = requireAuth(request, response);
  if (!payload) return;
  if (payload.applicationId !== request.params.id) {
    return response.status(403).json({ error: { error_message: 'Forbidden' } });
  }
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });
    const updated = await db.saveSubscription(row.id, null, 'active', null);
    await db.addMessage(row.id, 'system', 'Membership activated. You can now request a cash advance.');
    response.json({ application: db.publicApp(updated) });
  } catch (err) { next(err); }
});

app.post('/api/advance/applications/:id/subscription/setup', async function (request, response, next) {
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

app.post('/api/advance/applications/:id/subscription/confirm', async function (request, response, next) {
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
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });

    const customerId = row.stripe_customer_id;

    await stripe.paymentMethods.attach(payment_method_id, { customer: customerId });
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: payment_method_id },
    });

    // Charge first month's $1.99 via PaymentIntent, then track renewal ourselves
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 199,
      currency: 'usd',
      customer: customerId,
      payment_method: payment_method_id,
      off_session: true,
      confirm: true,
      description: 'Advance Monthly Membership — Month 1',
      metadata: { application_id: row.id },
    });

    if (paymentIntent.status !== 'succeeded') {
      return response.status(402).json({ error: { error_message: 'Membership payment did not complete. Please try a different card.' } });
    }

    // Store subscription_next_billing so the monthly action knows when to charge again
    const nextBilling = new Date();
    nextBilling.setMonth(nextBilling.getMonth() + 1);
    const updated = await db.saveSubscription(row.id, paymentIntent.id, 'active', nextBilling.toISOString().slice(0, 10));
    await db.addMessage(row.id, 'system', 'Membership activated — $1.99/month. You can now request a cash advance each month.');
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

    let instant_fee_paid = false;
    if (delivery_type === 'instant' && row.stripe_customer_id) {
      const customer = await stripe.customers.retrieve(row.stripe_customer_id);
      const pm = customer.invoice_settings?.default_payment_method;
      if (pm) {
        const pi = await stripe.paymentIntents.create({
          amount: 100,
          currency: 'usd',
          customer: row.stripe_customer_id,
          payment_method: typeof pm === 'string' ? pm : pm.id,
          off_session: true,
          confirm: true,
          description: 'Instant delivery fee',
          metadata: { application_id: row.id },
        });
        if (pi.status === 'succeeded') instant_fee_paid = true;
      }
    }

    const updated = await db.saveDeliveryType(row.id, delivery_type, instant_fee_paid);
    const note = delivery_type === 'instant'
      ? 'Instant delivery selected — funds will be sent within minutes of approval.'
      : 'Standard delivery selected — funds will arrive within 2-3 business days of approval.';
    await db.addMessage(row.id, 'system', note);
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
    const { methods, contact } = request.body;
    if (!methods) {
      return response.status(400).json({ error: { error_message: 'methods is required' } });
    }
    const isBankTransfer = methods === 'Bank transfer' || methods.includes('Bank transfer');
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

app.get('/api/advance/admin/applications/:id/bank_snapshot', async function (request, response, next) {
  if (!requireAdmin(request, response)) return;
  try {
    const application = await db.getApplicationById(request.params.id);
    if (!application) return response.status(404).json({ error: { error_message: 'Application not found' } });

    const fcAccountId = application.stripe_fc_account_id;
    console.log('[bank_snapshot] fc_account_id from DB:', fcAccountId);
    if (!fcAccountId) return response.status(400).json({ error: { error_message: 'No bank account connected yet. Ask the customer to connect their bank.' } });

    // 1. Retrieve account to inspect permissions and refresh state
    let acct = null;
    try {
      acct = await stripe.financialConnections.accounts.retrieve(fcAccountId);
      console.log('[bank_snapshot] account permissions:', JSON.stringify(acct.permissions));
      console.log('[bank_snapshot] transaction_refresh:', JSON.stringify(acct.transaction_refresh));
    } catch (e) {
      console.log('[bank_snapshot] retrieve error:', e.message);
    }

    const hasTransactionPermission = acct?.permissions?.includes('transactions');
    if (!hasTransactionPermission) {
      console.log('[bank_snapshot] WARNING: transactions permission not on this FC account. Customer must re-connect bank.');
    }

    // 2. Subscribe (idempotent — only works if permission was granted in the original session)
    let subscribeOk = false;
    try {
      await stripe.financialConnections.accounts.subscribe(fcAccountId, { features: ['transactions'] });
      subscribeOk = true;
      console.log('[bank_snapshot] subscribe ok');
    } catch (e) {
      console.log('[bank_snapshot] subscribe error (full):', e.message, '| code:', e.code);
    }

    // 3. Fetch balance
    const balanceResult = await Promise.resolve(
      stripe.rawRequest('GET', `/v1/financial_connections/accounts/${fcAccountId}/balance`)
    ).catch(e => { console.log('[bank_snapshot] balance error:', e.message); return null; });

    // 4. List transactions (skip refresh — it's async and we can't wait for it)
    let txs = [];
    try {
      const txList = await stripe.financialConnections.transactions.list({ account: fcAccountId, limit: 200 });
      txs = txList.data;
      console.log('[bank_snapshot] transactions count:', txs.length, '| has_more:', txList.has_more);
    } catch (e) {
      console.log('[bank_snapshot] list error:', e.message);
    }

    const bal = balanceResult;

    // Get routing number from the saved PM (not available on FC account object)
    let routingNumber = null;
    if (application.stripe_payment_method_id) {
      try {
        const pm = await stripe.paymentMethods.retrieve(application.stripe_payment_method_id);
        if (pm.type === 'us_bank_account') routingNumber = pm.us_bank_account.routing_number || null;
      } catch (e) { /* non-fatal */ }
    }

    const accounts = acct ? [{
      id: acct.id,
      display_name: acct.display_name || 'Bank Account',
      institution_name: acct.institution_name,
      last4: acct.last4 || null,
      routing_number: routingNumber,
      category: acct.category,
      balance: bal ? {
        available: bal.cash?.available?.usd ?? null,
        current:   bal.cash?.current?.usd   ?? null,
      } : null,
    }] : [];

    // Return ALL transactions (positive = credit/income, negative = debit/spend)
    const transactions = txs.map(tx => ({
      id: tx.id,
      description: tx.description || '',
      amount: tx.amount,
      currency: tx.currency,
      date: new Date(tx.transacted_at * 1000).toISOString().slice(0, 10),
      category: tx.category || 'other',
      status: tx.status,
    }));

    const needs_reconnect = !hasTransactionPermission || !subscribeOk;

    response.json({ accounts, transactions, auth: null, needs_reconnect });
  } catch (err) { next(err); }
});

app.get('/api/advance/admin/applications/:id/payment-method-details', async function (request, response, next) {
  if (!requireAdmin(request, response)) return;
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });
    if (!row.stripe_payment_method_id) {
      return response.status(400).json({ error: { error_message: 'No bank account connected for this application' } });
    }
    const pm = await stripe.paymentMethods.retrieve(row.stripe_payment_method_id);
    if (pm.type !== 'us_bank_account') {
      return response.status(400).json({ error: { error_message: 'Payment method on file is not a bank account' } });
    }
    response.json({
      bank_name: pm.us_bank_account.bank_name || 'Unknown bank',
      routing_number: pm.us_bank_account.routing_number,
      last4: pm.us_bank_account.last4,
      account_type: pm.us_bank_account.account_type,
      account_holder_type: pm.us_bank_account.account_holder_type,
    });
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
    const allowedStatuses = ['intake', 'bank_connected', 'reviewing', 'approved', 'denied', 'funded', 'repayment_scheduled', 'repaid', 'repayment_failed'];
    if (!allowedStatuses.includes(status)) {
      return response.status(400).json({ error: { error_message: 'Unsupported status' } });
    }
    const updated = await db.updateApplicationStatus(request.params.id, status);
    if (!updated) return response.status(404).json({ error: { error_message: 'Application not found' } });
    if (request.body.note) {
      await db.addMessage(request.params.id, 'admin', request.body.note);
    }
    response.json({ application: db.publicApp(updated) });
  } catch (err) { next(err); }
});

app.post('/api/advance/admin/applications/:id/repayment', async function (request, response, next) {
  if (!requireAdmin(request, response)) return;
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });
    const amount = Number(request.body.amount || row.requested_amount || 25);
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 30);
    const due_date = request.body.due_date || dueDate.toISOString().slice(0, 10);
    const updated = await db.setRepayment(row.id, amount, due_date, 'Recorded for manual execution.');
    await db.addMessage(row.id, 'system', `Repayment of $${amount.toFixed(2)} is due by ${due_date}. You have 30 days from funding to repay this advance.`);
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
    const updated = await db.saveStripePaymentMethod(request.params.id, payment_method_id);
    if (!updated) return response.status(404).json({ error: { error_message: 'Application not found' } });
    response.json({ application: db.publicApp(updated) });
  } catch (err) { next(err); }
});

// Returns { ok: true } if safe to charge, { ok: false, reason } if it would overdraft.
// Fails open (ok: true) when balance is unavailable so card-only users are unaffected.
async function checkOverdraft(fcAccountId, amountCents) {
  if (!fcAccountId) return { ok: true };

  // Refresh to get the latest balance from the institution
  try {
    await stripe.financialConnections.accounts.refresh(fcAccountId, { features: ['balance'] });
  } catch (e) {
    console.log('[overdraft_check] refresh error (non-fatal):', e.message);
  }

  let availableCents = null;
  try {
    const bal = await stripe.rawRequest('GET', `/v1/financial_connections/accounts/${fcAccountId}/balance`);
    availableCents = bal.cash?.available?.usd ?? null;
    console.log(`[overdraft_check] available=${availableCents} cents | charge=${amountCents} cents`);
  } catch (e) {
    console.log('[overdraft_check] balance unavailable:', e.message, '— proceeding');
    return { ok: true };
  }

  if (availableCents === null) {
    console.log('[overdraft_check] balance null — proceeding');
    return { ok: true };
  }

  if (availableCents < amountCents) {
    const avail = (availableCents / 100).toFixed(2);
    const needed = (amountCents / 100).toFixed(2);
    console.log(`[overdraft_check] BLOCKED — $${avail} available, $${needed} needed`);
    return {
      ok: false,
      reason: `Payment skipped to avoid overdraft — account has $${avail} available but repayment is $${needed}. We'll retry when funds are available.`,
    };
  }

  console.log('[overdraft_check] balance sufficient — proceeding');
  return { ok: true };
}

app.post('/api/advance/admin/applications/:id/charge', async function (request, response, next) {
  if (!requireAdmin(request, response)) return;
  try {
    const row = await db.getApplicationById(request.params.id);
    if (!row) return response.status(404).json({ error: { error_message: 'Application not found' } });

    // Bank ACH is primary; card is fallback
    const bankPmId = row.stripe_payment_method_id;
    const cardPmId = row.stripe_card_pm_id;
    const primaryPmId = bankPmId || cardPmId;

    if (!row.stripe_customer_id || !primaryPmId) {
      return response.status(400).json({ error: { error_message: 'No payment method on file for this application' } });
    }

    const amount = Math.round(parseFloat(row.repayment_amount || row.requested_amount) * 100);

    // Overdraft check — uses FC balance if available
    const overdraft = await checkOverdraft(row.stripe_fc_account_id, amount);
    if (!overdraft.ok) {
      await db.addMessage(row.id, 'system', overdraft.reason);
      return response.status(402).json({ error: { error_message: overdraft.reason } });
    }

    let paymentIntent = null;

    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount, currency: 'usd',
        customer: row.stripe_customer_id,
        payment_method: primaryPmId,
        off_session: true, confirm: true,
        description: `Cash advance repayment — ${row.name}`,
        metadata: { application_id: row.id },
      });
    } catch (primaryErr) {
      // If bank failed and a card backup exists, try the card
      if ((primaryErr.type === 'StripeCardError' || primaryErr.type === 'StripeInvalidRequestError')
          && cardPmId && cardPmId !== primaryPmId) {
        await db.addMessage(row.id, 'system', `Direct debit failed: ${primaryErr.message}. Retrying with backup card.`);
        paymentIntent = await stripe.paymentIntents.create({
          amount, currency: 'usd',
          customer: row.stripe_customer_id,
          payment_method: cardPmId,
          off_session: true, confirm: true,
          description: `Cash advance repayment (card backup) — ${row.name}`,
          metadata: { application_id: row.id },
        });
      } else {
        throw primaryErr;
      }
    }

    await db.saveStripeCharge(row.id, paymentIntent.id, paymentIntent.status);

    if (paymentIntent.status === 'succeeded') {
      await db.markRepaymentPaid(row.id);
      await db.addMessage(row.id, 'system', `Payment of $${(amount / 100).toFixed(2)} collected successfully.`);
    } else if (paymentIntent.status === 'processing') {
      await db.addMessage(row.id, 'system', `Bank debit of $${(amount / 100).toFixed(2)} initiated. ACH payments settle in 3-5 business days.`);
    }

    const updated = await db.getApplicationById(request.params.id);
    response.json({ application: db.publicApp(updated), status: paymentIntent.status });
  } catch (err) {
    if (err.type === 'StripeCardError' || err.type === 'StripeInvalidRequestError') {
      await db.saveStripeCharge(request.params.id, err.payment_intent?.id || null, 'failed');
      await db.updateApplicationStatus(request.params.id, 'repayment_failed');
      await db.addMessage(request.params.id, 'system', `Payment failed: ${err.message}`);
      return response.status(402).json({ error: { error_message: err.message } });
    }
    next(err);
  }
});

app.post('/api/advance/admin/run-due-repayments', async function (request, response, next) {
  if (!requireAdmin(request, response)) return;
  try {
    const due = await db.getDueApplications();
    const results = [];

    for (const row of due) {
      const amount = Math.round(parseFloat(row.repayment_amount || row.requested_amount) * 100);
      const bankPmId = row.stripe_payment_method_id;
      const cardPmId = row.stripe_card_pm_id;
      const primaryPmId = bankPmId || cardPmId;
      if (!primaryPmId) { results.push({ id: row.id, name: row.name, status: 'skipped', error: 'No payment method' }); continue; }
      try {
        // Overdraft check before charging
        const overdraft = await checkOverdraft(row.stripe_fc_account_id, amount);
        if (!overdraft.ok) {
          await db.addMessage(row.id, 'system', overdraft.reason);
          results.push({ id: row.id, name: row.name, status: 'skipped_overdraft', reason: overdraft.reason });
          continue;
        }

        let paymentIntent = null;
        try {
          paymentIntent = await stripe.paymentIntents.create({
            amount, currency: 'usd',
            customer: row.stripe_customer_id,
            payment_method: primaryPmId,
            off_session: true, confirm: true,
            description: `Cash advance repayment — ${row.name}`,
            metadata: { application_id: row.id },
          });
        } catch (primaryErr) {
          if ((primaryErr.type === 'StripeCardError' || primaryErr.type === 'StripeInvalidRequestError')
              && cardPmId && cardPmId !== primaryPmId) {
            await db.addMessage(row.id, 'system', `Direct debit failed: ${primaryErr.message}. Retrying with backup card.`);
            paymentIntent = await stripe.paymentIntents.create({
              amount, currency: 'usd',
              customer: row.stripe_customer_id,
              payment_method: cardPmId,
              off_session: true, confirm: true,
              description: `Cash advance repayment (card backup) — ${row.name}`,
              metadata: { application_id: row.id },
            });
          } else { throw primaryErr; }
        }

        await db.saveStripeCharge(row.id, paymentIntent.id, paymentIntent.status);

        if (paymentIntent.status === 'succeeded') {
          await db.markRepaymentPaid(row.id);
          await db.addMessage(row.id, 'system', `Payment of $${(amount / 100).toFixed(2)} collected successfully.`);
        } else if (paymentIntent.status === 'processing') {
          await db.addMessage(row.id, 'system', `Bank debit of $${(amount / 100).toFixed(2)} initiated. ACH payments settle in 3-5 business days.`);
        }

        results.push({ id: row.id, name: row.name, status: paymentIntent.status });
      } catch (err) {
        const msg = err.message || 'Unknown error';
        await db.saveStripeCharge(row.id, err.payment_intent?.id || null, 'failed');
        await db.updateApplicationStatus(row.id, 'repayment_failed');
        await db.addMessage(row.id, 'system', `Payment failed: ${msg}`);
        results.push({ id: row.id, name: row.name, status: 'failed', error: msg });
      }
    }

    response.json({ processed: results.length, results });
  } catch (err) { next(err); }
});

app.post('/api/advance/admin/run-due-memberships', async function (request, response, next) {
  if (!requireAdmin(request, response)) return;
  try {
    const due = await db.getDueMemberships();
    const results = [];

    for (const row of due) {
      const customer = await stripe.customers.retrieve(row.stripe_customer_id);
      const pm = customer.invoice_settings?.default_payment_method;
      if (!pm) {
        results.push({ id: row.id, name: row.name, status: 'skipped', error: 'No default payment method' });
        continue;
      }
      try {
        const pi = await stripe.paymentIntents.create({
          amount: 199,
          currency: 'usd',
          customer: row.stripe_customer_id,
          payment_method: typeof pm === 'string' ? pm : pm.id,
          off_session: true,
          confirm: true,
          description: 'Advance Monthly Membership renewal',
          metadata: { application_id: row.id },
        });
        const nextBilling = new Date();
        nextBilling.setMonth(nextBilling.getMonth() + 1);
        await db.saveSubscription(row.id, pi.id, 'active', nextBilling.toISOString().slice(0, 10));
        results.push({ id: row.id, name: row.name, status: pi.status });
      } catch (err) {
        await db.saveSubscription(row.id, row.subscription_id, 'past_due', null);
        results.push({ id: row.id, name: row.name, status: 'failed', error: err.message });
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

const server = app.listen(APP_PORT, function () {
  console.log('plaid-quickstart server listening on port ' + APP_PORT);
});

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

app.use('/api', function (error, request, response, next) {
  if (error.response?.data) {
    prettyPrintResponse(error.response);
    response.status(error.response.status || 500).json(formatError(error.response));
  } else {
    console.log(error.message || error);
    response.status(500).json({ error: { error_message: error.message || 'Internal server error' } });
  }
});
