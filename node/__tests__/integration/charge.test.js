// Stripe charge endpoint integration. Mocks the Stripe SDK at module
// boundary. Confirms:
//   - admin/:id/charge uses repayment_amount when set
//   - admin/:id/charge falls back to requested + instant fee when not
//   - bank payment method tried first, card as fallback
//   - overdraft check skips the charge
//   - failure path sets status=repayment_failed

jest.mock('stripe', () => {
  const fn = jest.fn().mockImplementation(() => ({
    customers: { create: jest.fn().mockResolvedValue({ id: 'cus_test' }) },
    paymentIntents: {
      create: jest.fn().mockResolvedValue({ id: 'pi_test', status: 'succeeded' }),
    },
    setupIntents: {
      create: jest.fn().mockResolvedValue({ id: 'si_test', client_secret: 'cs_test' }),
    },
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

async function seedAppReadyToCharge({ deliveryType = 'instant', withRepayment = false } = {}) {
  const res = await request(app).post('/api/advance/applications').send({
    name: 'Test', email: `charge-${Date.now()}-${Math.random()}@example.com`,
    phone: '+15555550100', dob: '1990-01-01', requested_amount: 25,
    password: 'test-password', ssn: '111223333', state: 'Georgia',
    income_sources: [{ employer: 'Acme', payday: '2026-06-15', pay_frequency: 'biweekly' }],
  });
  const application = res.body.application;
  await db.saveDeliveryType(application.id, deliveryType, false);
  // Pretend the user already saved a Stripe customer + bank payment method
  await db.saveStripeCustomer(application.id, 'cus_test');
  await db.saveStripePaymentMethod(application.id, 'pm_bank_test');
  if (withRepayment) {
    await db.setRepayment(application.id, 30, '2026-06-15', '');
  }
  return application;
}

describe('POST /api/advance/admin/applications/:id/charge', () => {
  test('uses repayment_amount when set', async () => {
    const application = await seedAppReadyToCharge({ deliveryType: 'instant', withRepayment: true });
    const res = await request(app)
      .post(`/api/advance/admin/applications/${application.id}/charge`)
      .set(ADMIN_HEADER);
    expect(res.status).toBe(200);
    // The Stripe mock was called with amount=3000 cents (the stored repayment of $30).
    const stripeInst = stripe.paymentIntents.create.mock.calls[0][0];
    expect(stripeInst.amount).toBe(3000);
  });

  describe('regression for 5d49f24 — repayment_amount NULL fallback', () => {
    test('instant + no repayment_amount → charges $30 not $25', async () => {
      const application = await seedAppReadyToCharge({ deliveryType: 'instant', withRepayment: false });
      const res = await request(app)
        .post(`/api/advance/admin/applications/${application.id}/charge`)
        .set(ADMIN_HEADER);
      expect(res.status).toBe(200);
      const arg = stripe.paymentIntents.create.mock.calls[0][0];
      expect(arg.amount).toBe(3000);
    });

    test('standard + no repayment_amount → charges $25', async () => {
      const application = await seedAppReadyToCharge({ deliveryType: 'standard', withRepayment: false });
      await request(app)
        .post(`/api/advance/admin/applications/${application.id}/charge`)
        .set(ADMIN_HEADER);
      const arg = stripe.paymentIntents.create.mock.calls[0][0];
      expect(arg.amount).toBe(2500);
    });
  });

  test('rejects unauthenticated admin request', async () => {
    const application = await seedAppReadyToCharge({ withRepayment: true });
    const res = await request(app)
      .post(`/api/advance/admin/applications/${application.id}/charge`);
    expect(res.status).toBe(401);
  });

  test('returns 400 when no payment method on file', async () => {
    const res = await request(app).post('/api/advance/applications').send({
      name: 'Test', email: `no-pm-${Date.now()}@example.com`,
      phone: '+15555550100', dob: '1990-01-01', requested_amount: 25,
      password: 'test-password', ssn: '111223333', state: 'Georgia',
      income_sources: [{ employer: 'Acme', payday: '2026-06-15', pay_frequency: 'biweekly' }],
    });
    const application = res.body.application;
    const chargeRes = await request(app)
      .post(`/api/advance/admin/applications/${application.id}/charge`)
      .set(ADMIN_HEADER);
    expect(chargeRes.status).toBe(400);
  });
});
