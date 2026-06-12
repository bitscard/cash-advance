// Repayment integrity (Phase 3, fixes #5/#6):
//   - The customer self-payoff endpoint is gone (it let a borrower mark a
//     loan repaid with no money, and was the only thing bumping the tier
//     counter → free $25 + tier climb to $200).
//   - The tier counter (repayment_count) now advances only on a real
//     collected charge — proven here via the cron path.

jest.mock('stripe', () => {
  const fn = jest.fn().mockImplementation(() => ({
    customers: { create: jest.fn().mockResolvedValue({ id: 'cus_test' }) },
    paymentIntents: {
      create: jest.fn().mockResolvedValue({ id: 'pi_test', status: 'succeeded' }),
    },
    setupIntents: {
      create: jest.fn().mockResolvedValue({ id: 'si_test', client_secret: 'cs_test' }),
    },
    subscriptions: { list: jest.fn().mockResolvedValue({ data: [] }) },
    invoices: { list: jest.fn().mockResolvedValue({ data: [] }) },
  }));
  return fn;
});

const request = require('supertest');
const { app } = require('../../index');
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

async function seedDueApp() {
  const res = await request(app).post('/api/advance/applications').send({
    name: 'Test', email: `rep-${Date.now()}-${Math.random()}@example.com`,
    phone: '+15555550100', dob: '1990-01-01', requested_amount: 25,
    password: 'test-password', ssn: '111223333', state: 'Georgia',
    income_sources: [{ employer: 'Acme', payday: '2026-06-15', pay_frequency: 'biweekly' }],
  });
  expect(res.status).toBe(200);
  expect(res.body.application?.id).toBeDefined();
  const application = res.body.application;
  await db.saveStripeCustomer(application.id, 'cus_test');
  // Bank link (income verification / payouts) — not used for collection.
  await db.saveBankAccount(application.id, 'pm_bank_test', 'fca_test');
  // Collection is debit-card-only: getDueApplications requires stripe_card_pm_id.
  await db.saveStripePaymentMethod(application.id, 'pm_card_test');
  // Past due date so getDueApplications() picks it up; status=pending.
  await db.setRepayment(application.id, 30, '2020-01-01', '');
  return application;
}

describe('Self-payoff endpoint removed (#5)', () => {
  test('POST /api/advance/applications/:id/payoff → 404', async () => {
    const application = await seedDueApp();
    const res = await request(app)
      .post(`/api/advance/applications/${application.id}/payoff`)
      .send({});
    expect(res.status).toBe(404);
  });
});

describe('Tier counter advances only on a real collected charge (#6)', () => {
  test('cron run-due-repayments increments repayment_count on success', async () => {
    const application = await seedDueApp();
    const before = await db.getApplicationById(application.id);
    expect(before.repayment_count || 0).toBe(0);

    const res = await request(app)
      .post('/api/advance/admin/run-due-repayments')
      .set(ADMIN_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.results.some(r => r.id === application.id && r.status === 'paid')).toBe(true);

    const after = await db.getApplicationById(application.id);
    expect(after.repayment_count).toBe(1);
    expect(after.repayment_status).toBe('paid');
  });
});
