// Debit-card validation on POST /stripe/save-payment-method.
//
// This card is the primary repayment rail for post-card-step users, so the
// endpoint fails CLOSED: it requires a succeeded SetupIntent for the exact
// card, the card attached to THIS app's Stripe customer, debit funding, and a
// non-failing CVC check. Credit/prepaid/unverified cards are rejected (and
// detached so they don't linger on the customer).

// Stripe mock driven by globals so each test sets the PM / SetupIntent shape.
jest.mock('stripe', () => {
  const fn = jest.fn().mockImplementation(() => ({
    customers: {
      create: jest.fn().mockResolvedValue({ id: 'cus_test' }),
      update: jest.fn().mockResolvedValue({}),
    },
    paymentMethods: {
      retrieve: jest.fn().mockImplementation(() =>
        global.__pm === 'throw' ? Promise.reject(new Error('No such PaymentMethod')) : Promise.resolve(global.__pm)),
      detach: jest.fn().mockResolvedValue({}),
    },
    setupIntents: {
      retrieve: jest.fn().mockImplementation(() => Promise.resolve(global.__si)),
    },
    subscriptions: { list: jest.fn().mockResolvedValue({ data: [] }) },
    invoices: { list: jest.fn().mockResolvedValue({ data: [] }) },
  }));
  return fn;
});

const request = require('supertest');
const { app, stripe } = require('../../index');
const db = require('../../db');
const { applyMigrations, truncateAll, closePool } = require('../dbHelpers');

// Payday must be today-or-later at signup; keep it comfortably in the future
// so these tests don't rot as the calendar advances.
const FUTURE_PAYDAY = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);

beforeAll(async () => { await applyMigrations(); });
beforeEach(async () => {
  await truncateAll();
  jest.clearAllMocks();
  global.__pm = undefined;
  global.__si = undefined;
});
afterAll(async () => { await closePool(); });

// Create an application (returns owner token) with a Stripe customer attached,
// the state the card step runs in.
async function seedApp() {
  const res = await request(app).post('/api/advance/applications').send({
    name: 'Test', email: `card-${Date.now()}-${Math.random()}@example.com`,
    phone: '+15555550100', dob: '1990-01-01', requested_amount: 25,
    password: 'test-password', ssn: '111223333', state: 'Georgia',
    income_sources: [{ employer: 'Acme', payday: FUTURE_PAYDAY, pay_frequency: 'biweekly' }],
  });
  expect(res.status).toBe(200);
  const application = res.body.application;
  const token = res.body.token;
  await db.saveStripeCustomer(application.id, 'cus_test');
  return { application, token };
}

function save(application, token, body) {
  return request(app)
    .post(`/api/advance/applications/${application.id}/stripe/save-payment-method`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

const debitPm = (over = {}) => ({
  id: 'pm_debit', customer: 'cus_test',
  card: { funding: 'debit', checks: { cvc_check: 'pass' } },
  ...over,
});

describe('save-payment-method debit-card validation', () => {
  test('valid debit card → 200 and saved as stripe_card_pm_id', async () => {
    const { application, token } = await seedApp();
    global.__pm = debitPm();
    global.__si = { status: 'succeeded', payment_method: 'pm_debit' };

    const res = await save(application, token, { payment_method_id: 'pm_debit', setup_intent_id: 'si_1' });
    expect(res.status).toBe(200);
    const after = await db.getApplicationById(application.id);
    expect(after.stripe_card_pm_id).toBe('pm_debit');
    expect(stripe.paymentMethods.detach).not.toHaveBeenCalled();
  });

  test('missing payment_method_id → 400', async () => {
    const { application, token } = await seedApp();
    const res = await save(application, token, {});
    expect(res.status).toBe(400);
  });

  test('credit card → 400 and detached', async () => {
    const { application, token } = await seedApp();
    global.__pm = debitPm({ card: { funding: 'credit', checks: { cvc_check: 'pass' } } });
    const res = await save(application, token, { payment_method_id: 'pm_credit' });
    expect(res.status).toBe(400);
    expect(res.body.error.error_message).toMatch(/credit card/i);
    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith('pm_credit');
    const after = await db.getApplicationById(application.id);
    expect(after.stripe_card_pm_id).toBeFalsy();
  });

  test('prepaid card → 400 and detached', async () => {
    const { application, token } = await seedApp();
    global.__pm = debitPm({ card: { funding: 'prepaid', checks: { cvc_check: 'pass' } } });
    const res = await save(application, token, { payment_method_id: 'pm_prepaid' });
    expect(res.status).toBe(400);
    expect(res.body.error.error_message).toMatch(/prepaid card/i);
    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith('pm_prepaid');
  });

  test('card not attached to this app\'s customer → 400', async () => {
    const { application, token } = await seedApp();
    global.__pm = debitPm({ customer: 'cus_someone_else' });
    const res = await save(application, token, { payment_method_id: 'pm_debit' });
    expect(res.status).toBe(400);
    expect(res.body.error.error_message).toMatch(/not been verified/i);
  });

  test('SetupIntent not succeeded → 400', async () => {
    const { application, token } = await seedApp();
    global.__pm = debitPm();
    global.__si = { status: 'processing', payment_method: 'pm_debit' };
    const res = await save(application, token, { payment_method_id: 'pm_debit', setup_intent_id: 'si_1' });
    expect(res.status).toBe(400);
    expect(res.body.error.error_message).toMatch(/verification did not complete/i);
  });

  test('SetupIntent for a different card → 400', async () => {
    const { application, token } = await seedApp();
    global.__pm = debitPm();
    global.__si = { status: 'succeeded', payment_method: 'pm_other' };
    const res = await save(application, token, { payment_method_id: 'pm_debit', setup_intent_id: 'si_1' });
    expect(res.status).toBe(400);
  });

  test('failed CVC check → 400 and detached', async () => {
    const { application, token } = await seedApp();
    global.__pm = debitPm({ card: { funding: 'debit', checks: { cvc_check: 'fail' } } });
    const res = await save(application, token, { payment_method_id: 'pm_debit' });
    expect(res.status).toBe(400);
    expect(res.body.error.error_message).toMatch(/CVC/i);
    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith('pm_debit');
  });
});
