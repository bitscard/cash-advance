// Repayment-rail grandfathering:
//   - Users with a debit card on file (onboarded after the card step) are
//     charged card-first, with ACH from the linked bank as a same-attempt
//     backup if the card fails.
//   - Users with no card (grandfathered — connected before the card step)
//     are collected via ACH from their linked bank.
// getDueApplications() must pick up BOTH cohorts.

// Stripe mock whose paymentIntents.create branches on the rail:
//   - card: succeeds unless global.__cardShouldFail is set (then throws)
//   - us_bank_account: returns global.__achStatus (default 'succeeded')
jest.mock('stripe', () => {
  const fn = jest.fn().mockImplementation(() => ({
    customers: { create: jest.fn().mockResolvedValue({ id: 'cus_test' }) },
    paymentIntents: {
      create: jest.fn().mockImplementation((args) => {
        const types = args.payment_method_types || [];
        if (types.includes('card')) {
          if (global.__cardShouldFail) return Promise.reject(new Error('card declined'));
          return Promise.resolve({ id: 'pi_card', status: 'succeeded' });
        }
        // us_bank_account (ACH)
        return Promise.resolve({ id: 'pi_ach', status: global.__achStatus || 'succeeded' });
      }),
    },
    setupIntents: { create: jest.fn().mockResolvedValue({ id: 'si_test', client_secret: 'cs_test' }) },
    subscriptions: { list: jest.fn().mockResolvedValue({ data: [] }) },
    invoices: {
      list: jest.fn().mockResolvedValue({ data: [] }),
      create: jest.fn().mockResolvedValue({ id: 'inv_test', status: 'open' }),
    },
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

beforeAll(async () => { await applyMigrations(); });
beforeEach(async () => {
  await truncateAll();
  jest.clearAllMocks();
  global.__cardShouldFail = false;
  global.__achStatus = 'succeeded';
});
afterAll(async () => { await closePool(); });

const ADMIN_HEADER = { 'x-admin-token': process.env.ADMIN_TOKEN };

// Seed a due application. opts.card controls whether a debit card is on file;
// every user always has a linked bank PM (the ACH rail).
async function seedDue({ card }) {
  const res = await request(app).post('/api/advance/applications').send({
    name: 'Test', email: `gf-${Date.now()}-${Math.random()}@example.com`,
    phone: '+15555550100', dob: '1990-01-01', requested_amount: 25,
    password: 'test-password', ssn: '111223333', state: 'Georgia',
    income_sources: [{ employer: 'Acme', payday: FUTURE_PAYDAY, pay_frequency: 'biweekly' }],
  });
  expect(res.status).toBe(200);
  const application = res.body.application;
  await db.saveStripeCustomer(application.id, 'cus_test');
  await db.saveBankAccount(application.id, 'pm_bank_test', 'fca_test'); // bank PM (ACH rail)
  if (card) await db.saveStripePaymentMethod(application.id, 'pm_card_test'); // debit card
  await db.setRepayment(application.id, 30, '2020-01-01', '');
  return application;
}

async function runCron() {
  const res = await request(app).post('/api/advance/admin/run-due-repayments').set(ADMIN_HEADER);
  expect(res.status).toBe(200);
  return res.body;
}

describe('getDueApplications picks up both cohorts', () => {
  test('grandfathered (bank only, no card) is collectable', async () => {
    const application = await seedDue({ card: false });
    const due = await db.getDueApplications();
    expect(due.some(r => r.id === application.id)).toBe(true);
  });
});

describe('Repayment rail selection', () => {
  test('grandfathered user (no card) is charged via ACH', async () => {
    const application = await seedDue({ card: false });
    const body = await runCron();
    const r = body.results.find(x => x.id === application.id);
    expect(r.status).toBe('paid');
    expect(r.method).toBe('ach');
    const after = await db.getApplicationById(application.id);
    expect(after.repayment_status).toBe('paid');
  });

  test('card user is charged via card (ACH not used)', async () => {
    const application = await seedDue({ card: true });
    const body = await runCron();
    const r = body.results.find(x => x.id === application.id);
    expect(r.status).toBe('paid');
    expect(r.method).toBe('card');
  });

  test('card user with a failing card falls back to ACH', async () => {
    global.__cardShouldFail = true;
    const application = await seedDue({ card: true });
    const body = await runCron();
    const r = body.results.find(x => x.id === application.id);
    expect(r.status).toBe('paid');
    expect(r.method).toBe('ach');
  });

  test('ACH that returns processing is recorded as processing, not paid', async () => {
    global.__achStatus = 'processing';
    const application = await seedDue({ card: false });
    const body = await runCron();
    const r = body.results.find(x => x.id === application.id);
    expect(r.status).toBe('processing');
    expect(r.method).toBe('ach');
  });
});
