// Async repayment settlement via Stripe webhook.
//
// ACH repayment PaymentIntents return 'processing' at charge time and settle
// (or bounce) days later. The webhook resolves them: payment_intent.succeeded
// → mark repaid + advance the tier counter; payment_intent.payment_failed →
// mark repayment_failed. Guards: act only on the PI recorded as this
// repayment's charge (stripe_charge_id), and never on an already-resolved
// repayment (so the tier counter can't double-increment, and a membership
// PaymentIntent is never mistaken for a repayment).

jest.mock('stripe', () => {
  const fn = jest.fn().mockImplementation(() => ({
    customers: { create: jest.fn().mockResolvedValue({ id: 'cus_test' }) },
    subscriptions: { list: jest.fn().mockResolvedValue({ data: [] }) },
    invoices: { list: jest.fn().mockResolvedValue({ data: [] }) },
  }));
  return fn;
});

const request = require('supertest');
const { app } = require('../../index');
const db = require('../../db');
const { applyMigrations, truncateAll, closePool } = require('../dbHelpers');

// Payday must be today-or-later at signup; keep it comfortably in the future
// so these tests don't rot as the calendar advances.
const FUTURE_PAYDAY = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  // Force the no-signature parse path so tests can post plain JSON events.
  delete process.env.STRIPE_WEBHOOK_SECRET;
  await applyMigrations();
});
beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await closePool(); });

// Seed an application mid-ACH-settlement: repayment pending, the ACH PI
// recorded as its charge, one attempt already made (cron won't retry).
async function seedProcessing({ chargeId = 'pi_ach_1' } = {}) {
  const res = await request(app).post('/api/advance/applications').send({
    name: 'Test', email: `wh-${Date.now()}-${Math.random()}@example.com`,
    phone: '+15555550100', dob: '1990-01-01', requested_amount: 25,
    password: 'test-password', ssn: '111223333', state: 'Georgia',
    income_sources: [{ employer: 'Acme', payday: FUTURE_PAYDAY, pay_frequency: 'biweekly' }],
  });
  expect(res.status).toBe(200);
  const id = res.body.application.id;
  await db.setRepayment(id, 30, '2030-01-01', ''); // pending + repayment_scheduled
  await db.saveStripeCharge(id, chargeId, 'processing');
  await db.bumpRepaymentAttemptCount(id);
  return id;
}

function postEvent(type, object) {
  return request(app)
    .post('/api/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ type, data: { object } }));
}

const pi = (over = {}) => ({
  id: 'pi_ach_1', amount_received: 3000, amount: 3000, status: 'succeeded',
  metadata: { application_id: over.appId, method: 'ach' },
  ...over,
});

describe('payment_intent webhook settles ACH repayments', () => {
  test('succeeded → marks repaid and advances the tier counter', async () => {
    const id = await seedProcessing();
    const before = await db.getApplicationById(id);
    expect(before.repayment_status).toBe('pending');
    expect(before.repayment_count || 0).toBe(0);

    const res = await postEvent('payment_intent.succeeded', pi({ appId: id }));
    expect(res.status).toBe(200);

    const after = await db.getApplicationById(id);
    expect(after.repayment_status).toBe('paid');
    expect(after.status).toBe('repaid');
    expect(after.repayment_count).toBe(1);
  });

  test('payment_failed → marks repayment_failed', async () => {
    const id = await seedProcessing();
    const res = await postEvent('payment_intent.payment_failed',
      pi({ appId: id, status: 'requires_payment_method', last_payment_error: { message: 'insufficient funds' } }));
    expect(res.status).toBe(200);

    const after = await db.getApplicationById(id);
    expect(after.status).toBe('repayment_failed');
    expect(after.repayment_count || 0).toBe(0);
  });

  test('idempotent — succeeded on an already-paid repayment does NOT double-increment', async () => {
    const id = await seedProcessing();
    await db.markRepaymentPaid(id);
    await db.incrementRepaymentCount(id); // simulate the synchronous success path
    const before = await db.getApplicationById(id);
    expect(before.repayment_count).toBe(1);

    await postEvent('payment_intent.succeeded', pi({ appId: id }));

    const after = await db.getApplicationById(id);
    expect(after.repayment_count).toBe(1); // unchanged
  });

  test('ignores a PaymentIntent that is not the recorded repayment charge', async () => {
    const id = await seedProcessing({ chargeId: 'pi_ach_1' });
    // e.g. a membership/subscription PI for the same application
    await postEvent('payment_intent.succeeded', pi({ id: 'pi_membership_xyz', appId: id }));

    const after = await db.getApplicationById(id);
    expect(after.repayment_status).toBe('pending'); // untouched
    expect(after.repayment_count || 0).toBe(0);
  });
});
