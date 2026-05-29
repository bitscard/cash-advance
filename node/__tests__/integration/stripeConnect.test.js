// Tests the Stripe Connect Express ACH payout flow:
//   - POST /stripe/connect/onboarding-link (creates account + returns AccountLink)
//   - POST /stripe/connect/refresh-status (syncs account state from Stripe)
//   - Funded handler ACH branch (fires stripe.transfers.create + optional
//     instant payout)
//
// Stripe SDK is fully mocked at module boundary — no network. We assert
// on what gets passed to the mocked SDK so we can verify the right amounts
// and metadata flow through.

jest.mock('stripe', () => {
  const fn = jest.fn().mockImplementation(() => ({
    customers: { create: jest.fn().mockResolvedValue({ id: 'cus_test' }) },
    paymentIntents: { create: jest.fn().mockResolvedValue({ id: 'pi_test', status: 'succeeded' }) },
    setupIntents: { create: jest.fn().mockResolvedValue({ id: 'si_test', client_secret: 'cs_test' }) },
    subscriptions: { create: jest.fn().mockResolvedValue({ id: 'sub_test', current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }) },
    accounts: {
      create: jest.fn().mockResolvedValue({ id: 'acct_test_xyz' }),
      retrieve: jest.fn().mockResolvedValue({
        id: 'acct_test_xyz',
        charges_enabled: true,
        payouts_enabled: true,
        requirements: { disabled_reason: null },
      }),
    },
    accountLinks: {
      create: jest.fn().mockResolvedValue({
        url: 'https://connect.stripe.com/setup/acct_test_xyz',
        expires_at: Math.floor(Date.now() / 1000) + 300,
      }),
    },
    transfers: { create: jest.fn().mockResolvedValue({ id: 'tr_test_abc' }) },
    payouts: { create: jest.fn().mockResolvedValue({ id: 'po_test_inst', method: 'instant' }) },
  }));
  return fn;
});

const request = require('supertest');
const { app, stripe } = require('../../index');
const db = require('../../db');
const { applyMigrations, truncateAll, closePool } = require('../dbHelpers');

beforeAll(async () => {
  await applyMigrations();
});
beforeEach(async () => {
  await truncateAll();
  jest.clearAllMocks();
});
afterAll(async () => {
  await closePool();
});

const ADMIN_HEADER = { 'x-admin-token': process.env.ADMIN_TOKEN };

async function signup() {
  const res = await request(app).post('/api/advance/applications').send({
    name: 'Jane Doe', email: `ach-${Date.now()}-${Math.random()}@example.com`,
    phone: '+15555550100', dob: '1990-01-01', requested_amount: 25,
    password: 'test-password', ssn: '111223333', state: 'Georgia',
    income_sources: [{ employer: 'Acme', payday: '2026-06-15', pay_frequency: 'biweekly' }],
  });
  return { application: res.body.application, token: res.body.token };
}

describe('POST /stripe/connect/onboarding-link', () => {
  test('creates Connect account on first call + returns hosted URL', async () => {
    const { application, token } = await signup();
    const res = await request(app)
      .post(`/api/advance/applications/${application.id}/stripe/connect/onboarding-link`)
      .set('Authorization', `Bearer ${token}`)
      .send({ origin: 'https://test.example.com' });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/connect\.stripe\.com/);
    expect(res.body.account_id).toBe('acct_test_xyz');

    expect(stripe.accounts.create).toHaveBeenCalledTimes(1);
    const args = stripe.accounts.create.mock.calls[0][0];
    expect(args.type).toBe('express');
    expect(args.country).toBe('US');
    expect(args.capabilities.transfers.requested).toBe(true);

    expect(stripe.accountLinks.create).toHaveBeenCalledTimes(1);
    const linkArgs = stripe.accountLinks.create.mock.calls[0][0];
    expect(linkArgs.account).toBe('acct_test_xyz');
    expect(linkArgs.return_url).toMatch(/connect_complete=1/);
    expect(linkArgs.refresh_url).toMatch(/connect_refresh=1/);

    const dbRow = await db.getApplicationById(application.id);
    expect(dbRow.stripe_connect_account_id).toBe('acct_test_xyz');
    expect(dbRow.stripe_connect_status).toBe('onboarding');
  });

  test('reuses existing Connect account on second call', async () => {
    const { application, token } = await signup();
    await request(app)
      .post(`/api/advance/applications/${application.id}/stripe/connect/onboarding-link`)
      .set('Authorization', `Bearer ${token}`)
      .send({ origin: 'https://test.example.com' });
    expect(stripe.accounts.create).toHaveBeenCalledTimes(1);

    // Second call — should NOT create another account
    await request(app)
      .post(`/api/advance/applications/${application.id}/stripe/connect/onboarding-link`)
      .set('Authorization', `Bearer ${token}`)
      .send({ origin: 'https://test.example.com' });
    expect(stripe.accounts.create).toHaveBeenCalledTimes(1);
    // But it DOES mint a fresh link each time (links expire fast)
    expect(stripe.accountLinks.create).toHaveBeenCalledTimes(2);
  });

  test('rejects request from a different applicant', async () => {
    const { application } = await signup();
    const other = await signup();
    const res = await request(app)
      .post(`/api/advance/applications/${application.id}/stripe/connect/onboarding-link`)
      .set('Authorization', `Bearer ${other.token}`)
      .send({});
    expect(res.status).toBe(403);
  });
});

describe('POST /stripe/connect/refresh-status', () => {
  test('flips status to ready + saves ACH payout method when account is ready', async () => {
    const { application, token } = await signup();
    // First create the Connect account
    await request(app)
      .post(`/api/advance/applications/${application.id}/stripe/connect/onboarding-link`)
      .set('Authorization', `Bearer ${token}`)
      .send({ origin: 'https://test.example.com' });

    const res = await request(app)
      .post(`/api/advance/applications/${application.id}/stripe/connect/refresh-status`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.application.stripe_connect_status).toBe('ready');
    expect(res.body.application.payout_methods).toBe('ACH');
  });

  test('returns onboarding status when account is not yet enabled', async () => {
    // Override the retrieve mock for this one test
    stripe.accounts.retrieve.mockResolvedValueOnce({
      id: 'acct_test_xyz',
      charges_enabled: false,
      payouts_enabled: false,
      requirements: { disabled_reason: null },
    });

    const { application, token } = await signup();
    await request(app)
      .post(`/api/advance/applications/${application.id}/stripe/connect/onboarding-link`)
      .set('Authorization', `Bearer ${token}`)
      .send({ origin: 'https://test.example.com' });

    const res = await request(app)
      .post(`/api/advance/applications/${application.id}/stripe/connect/refresh-status`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.body.status).toBe('onboarding');
  });

  test('returns restricted status when Stripe flagged the account', async () => {
    stripe.accounts.retrieve.mockResolvedValueOnce({
      id: 'acct_test_xyz',
      charges_enabled: false,
      payouts_enabled: false,
      requirements: { disabled_reason: 'rejected.fraud' },
    });

    const { application, token } = await signup();
    await request(app)
      .post(`/api/advance/applications/${application.id}/stripe/connect/onboarding-link`)
      .set('Authorization', `Bearer ${token}`)
      .send({ origin: 'https://test.example.com' });

    const res = await request(app)
      .post(`/api/advance/applications/${application.id}/stripe/connect/refresh-status`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.body.status).toBe('restricted');
  });

  test('returns not_started when no Connect account exists yet', async () => {
    const { application, token } = await signup();
    const res = await request(app)
      .post(`/api/advance/applications/${application.id}/stripe/connect/refresh-status`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.body.status).toBe('not_started');
  });
});

describe('Funded handler — ACH transfer branch', () => {
  test('standard delivery: creates transfer but no instant payout', async () => {
    const { application } = await signup();
    // Simulate full onboarding completion
    await db.saveStripeConnectAccount(application.id, 'acct_test_xyz', 'ready');
    await db.savePayoutPreference(application.id, 'ACH', 'stripe_connect');
    await db.saveDeliveryType(application.id, 'standard', false);

    await request(app)
      .patch(`/api/advance/admin/applications/${application.id}/status`)
      .set(ADMIN_HEADER)
      .send({ status: 'funded' });

    expect(stripe.transfers.create).toHaveBeenCalledTimes(1);
    const args = stripe.transfers.create.mock.calls[0][0];
    expect(args.destination).toBe('acct_test_xyz');
    expect(args.amount).toBe(2500); // $25 advance
    expect(args.currency).toBe('usd');
    expect(stripe.payouts.create).not.toHaveBeenCalled();

    const dbRow = await db.getApplicationById(application.id);
    expect(dbRow.transfer_id).toBe('tr_test_abc');
  });

  test('same-day delivery: creates transfer AND instant payout', async () => {
    const { application } = await signup();
    await db.saveStripeConnectAccount(application.id, 'acct_test_xyz', 'ready');
    await db.savePayoutPreference(application.id, 'ACH', 'stripe_connect');
    await db.saveDeliveryType(application.id, 'instant', false);

    await request(app)
      .patch(`/api/advance/admin/applications/${application.id}/status`)
      .set(ADMIN_HEADER)
      .send({ status: 'funded' });

    expect(stripe.transfers.create).toHaveBeenCalledTimes(1);
    expect(stripe.payouts.create).toHaveBeenCalledTimes(1);

    const payoutArgs = stripe.payouts.create.mock.calls[0][0];
    const payoutOpts = stripe.payouts.create.mock.calls[0][1];
    expect(payoutArgs.method).toBe('instant');
    expect(payoutArgs.amount).toBe(2500);
    expect(payoutOpts.stripeAccount).toBe('acct_test_xyz');
  });

  test('falls back gracefully when instant payout fails (e.g. bank doesnt support RTP)', async () => {
    stripe.payouts.create.mockRejectedValueOnce(new Error('Instant payouts not available for this bank account'));

    const { application } = await signup();
    await db.saveStripeConnectAccount(application.id, 'acct_test_xyz', 'ready');
    await db.savePayoutPreference(application.id, 'ACH', 'stripe_connect');
    await db.saveDeliveryType(application.id, 'instant', false);

    // Funded transition should still succeed
    const res = await request(app)
      .patch(`/api/advance/admin/applications/${application.id}/status`)
      .set(ADMIN_HEADER)
      .send({ status: 'funded' });
    expect(res.status).toBe(200);

    // Transfer happened, instant payout was attempted but failed
    expect(stripe.transfers.create).toHaveBeenCalledTimes(1);
    expect(stripe.payouts.create).toHaveBeenCalledTimes(1);

    // System message explains the fallback
    const messages = await db.getMessages(application.id);
    expect(messages.some(m => /same-day transfers/i.test(m.text))).toBe(true);
  });

  test('non-ACH users (PayPal etc) do not trigger transfers', async () => {
    const { application } = await signup();
    await db.savePayoutPreference(application.id, 'PayPal', 'jane@example.com');
    await db.saveDeliveryType(application.id, 'standard', false);

    await request(app)
      .patch(`/api/advance/admin/applications/${application.id}/status`)
      .set(ADMIN_HEADER)
      .send({ status: 'funded' });

    expect(stripe.transfers.create).not.toHaveBeenCalled();
    expect(stripe.payouts.create).not.toHaveBeenCalled();
  });

  test('ACH user with no ready Connect account: no transfer fires, system message logs the issue', async () => {
    const { application } = await signup();
    // Picked ACH but never finished onboarding
    await db.savePayoutPreference(application.id, 'ACH', 'stripe_connect');
    await db.saveStripeConnectAccount(application.id, 'acct_test_xyz', 'onboarding');
    await db.saveDeliveryType(application.id, 'standard', false);

    await request(app)
      .patch(`/api/advance/admin/applications/${application.id}/status`)
      .set(ADMIN_HEADER)
      .send({ status: 'funded' });

    expect(stripe.transfers.create).not.toHaveBeenCalled();

    const messages = await db.getMessages(application.id);
    expect(messages.some(m => /direct deposit isn't set up yet/i.test(m.text))).toBe(true);
  });
});
