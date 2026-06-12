// Auto-deny on negative bank balance at apply time.
//
// Rule under test: a NEW applicant whose connected bank account is overdrawn
// (negative available balance) when they finish linking their bank is denied
// automatically. Repeat customers are exempt, and a balance we can't read
// must never trigger a denial (fail-safe).
//
// autoApproveIfEligible() is the single auto-decision funnel (fired
// fire-and-forget by the bank-link handlers); we import and await it directly
// so its DB side effects are observable.

// Mock Stripe at the module boundary. retrieve() reports the balance held in
// global.__mockBalanceCents (null => no balance object, i.e. unknown).
jest.mock('stripe', () => {
  const fn = jest.fn().mockImplementation(() => ({
    customers: { create: jest.fn().mockResolvedValue({ id: 'cus_test' }) },
    setupIntents: { create: jest.fn().mockResolvedValue({ id: 'si_test', client_secret: 'cs_test' }) },
    financialConnections: {
      accounts: {
        refresh: jest.fn().mockResolvedValue({}),
        subscribe: jest.fn().mockResolvedValue({}),
        retrieve: jest.fn().mockImplementation(() => Promise.resolve(
          global.__mockBalanceCents == null
            ? { id: 'fca_test' }
            : { id: 'fca_test', balance: { current: { usd: global.__mockBalanceCents } } },
        )),
      },
      transactions: { list: jest.fn().mockResolvedValue({ data: [], has_more: false }) },
    },
  }));
  return fn;
});

const request = require('supertest');
const { app, autoApproveIfEligible } = require('../../index');
const db = require('../../db');
const { applyMigrations, truncateAll, closePool } = require('../dbHelpers');

beforeAll(async () => {
  await applyMigrations();
});
beforeEach(async () => {
  await truncateAll();
  global.__mockBalanceCents = null;
});
afterAll(async () => {
  await closePool();
});

// Create an application and advance it to 'bank_connected' with an FC account
// linked, exactly as the FC bank-link handler leaves it before auto-decision.
async function seedBankConnected() {
  const res = await request(app).post('/api/advance/applications').send({
    name: 'Test', email: `deny-${Date.now()}-${Math.random()}@example.com`,
    phone: '+15555550100', dob: '1990-01-01', requested_amount: 25,
    password: 'test-password', ssn: '111223333', state: 'Georgia',
    income_sources: [{ employer: 'Acme', payday: '2026-06-15', pay_frequency: 'biweekly' }],
  });
  expect(res.status).toBe(200);
  const application = res.body.application;
  // saveBankAccount also flips status to 'bank_connected'.
  await db.saveBankAccount(application.id, 'pm_bank_test', 'fca_test');
  return application;
}

describe('auto-deny on negative bank balance (new applicants)', () => {
  test('new applicant with negative balance → denied', async () => {
    const application = await seedBankConnected();
    global.__mockBalanceCents = -1234; // overdrawn by $12.34

    const result = await autoApproveIfEligible(application.id);
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/negative bank balance/i);

    const after = await db.getApplicationById(application.id);
    expect(after.status).toBe('denied');

    // A user-facing system message explains the auto-denial.
    const messages = await db.getMessages(application.id);
    expect(messages.some(m => m.sender === 'system' && /negative balance/i.test(m.text))).toBe(true);
  });

  test('repeat customer with negative balance → NOT auto-denied (exempt)', async () => {
    const application = await seedBankConnected();
    await db.incrementRepaymentCount(application.id); // repayment_count = 1 → repeat
    global.__mockBalanceCents = -5000;

    const result = await autoApproveIfEligible(application.id);
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/repeat customer/i);

    const after = await db.getApplicationById(application.id);
    expect(after.status).toBe('bank_connected'); // untouched — goes to manual review
  });

  test('unknown balance → NOT denied (fails safe)', async () => {
    const application = await seedBankConnected();
    global.__mockBalanceCents = null; // balance unavailable

    const result = await autoApproveIfEligible(application.id);
    expect(result.approved).toBe(false);
    expect(result.reason).not.toMatch(/negative bank balance/i);

    const after = await db.getApplicationById(application.id);
    expect(after.status).toBe('bank_connected'); // not denied; left for income check
  });

  test('zero balance → NOT denied (only strictly negative denies)', async () => {
    const application = await seedBankConnected();
    global.__mockBalanceCents = 0;

    const result = await autoApproveIfEligible(application.id);
    expect(result.approved).toBe(false);
    expect(result.reason).not.toMatch(/negative bank balance/i);

    const after = await db.getApplicationById(application.id);
    expect(after.status).toBe('bank_connected');
  });
});
