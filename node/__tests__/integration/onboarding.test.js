// Tests the onboarding endpoints that the 6-step pre-bank flow hits:
//   PATCH /payout-preference (single-method save)
//   POST  /delivery (saves delivery_type, recomputes repayment if needed)
//
// Stripe endpoints (/stripe/setup-intent, /stripe/save-payment-method)
// live in a separate file and need a deeper SDK mock.

const request = require('supertest');
const { app } = require('../../index');
const db = require('../../db');
const { applyMigrations, truncateAll, closePool } = require('../dbHelpers');

beforeAll(async () => {
  await applyMigrations();
});
beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await closePool();
});

async function createApp(overrides = {}) {
  const res = await request(app).post('/api/advance/applications').send({
    name: 'Test', email: `onboard-${Date.now()}-${Math.random()}@example.com`,
    phone: '+15555550100', dob: '1990-01-01', requested_amount: 25,
    password: 'test-password', ssn: '111223333', state: 'Georgia',
    income_sources: [{ employer: 'Acme', payday: '2026-06-15', pay_frequency: 'biweekly' }],
    ...overrides,
  });
  return { application: res.body.application, token: res.body.token };
}

describe('PATCH /api/advance/applications/:id/payout-preference', () => {
  test('saves a single payout method + contact', async () => {
    const { application, token } = await createApp();
    const res = await request(app)
      .patch(`/api/advance/applications/${application.id}/payout-preference`)
      .set('Authorization', `Bearer ${token}`)
      .send({ methods: 'PayPal', contact: 'jane@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.application.payout_methods).toBe('PayPal');
    expect(res.body.application.payout_contact).toBe('jane@example.com');
  });

  test('Bank transfer method requires no contact', async () => {
    const { application, token } = await createApp();
    const res = await request(app)
      .patch(`/api/advance/applications/${application.id}/payout-preference`)
      .set('Authorization', `Bearer ${token}`)
      .send({ methods: 'Bank transfer', contact: '' });
    expect(res.status).toBe(200);
  });

  test('non-bank method requires contact', async () => {
    const { application, token } = await createApp();
    const res = await request(app)
      .patch(`/api/advance/applications/${application.id}/payout-preference`)
      .set('Authorization', `Bearer ${token}`)
      .send({ methods: 'CashApp', contact: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.error_message).toMatch(/contact/i);
  });
});

describe('POST /api/advance/applications/:id/delivery', () => {
  test('saves delivery_type=instant', async () => {
    const { application, token } = await createApp();
    const res = await request(app)
      .post(`/api/advance/applications/${application.id}/delivery`)
      .set('Authorization', `Bearer ${token}`)
      .send({ delivery_type: 'instant' });
    expect(res.status).toBe(200);
    expect(res.body.application.delivery_type).toBe('instant');
  });

  test('rejects invalid delivery_type', async () => {
    const { application, token } = await createApp();
    const res = await request(app)
      .post(`/api/advance/applications/${application.id}/delivery`)
      .set('Authorization', `Bearer ${token}`)
      .send({ delivery_type: 'overnight' });
    expect(res.status).toBe(400);
  });

  describe('regression for 5d49f24 — recompute repayment_amount on delivery change', () => {
    test('admin funds BEFORE user picks delivery, then user picks instant → repayment bumped to $30', async () => {
      const { application, token } = await createApp();
      // Simulate the admin-funded-before-delivery scenario:
      // Set a $25 repayment row directly (mimics auto-schedule with no delivery_type).
      await db.setRepayment(application.id, 25, '2026-06-15', '');

      // Now user picks instant — backend should bump repayment to $30.
      const res = await request(app)
        .post(`/api/advance/applications/${application.id}/delivery`)
        .set('Authorization', `Bearer ${token}`)
        .send({ delivery_type: 'instant' });
      expect(res.status).toBe(200);

      const dbRow = await db.getApplicationById(application.id);
      expect(parseFloat(dbRow.repayment_amount)).toBe(30);
    });

    test('user picks standard → no fee added even if repayment already exists', async () => {
      const { application, token } = await createApp();
      await db.setRepayment(application.id, 25, '2026-06-15', '');
      const res = await request(app)
        .post(`/api/advance/applications/${application.id}/delivery`)
        .set('Authorization', `Bearer ${token}`)
        .send({ delivery_type: 'standard' });
      expect(res.status).toBe(200);
      const dbRow = await db.getApplicationById(application.id);
      expect(parseFloat(dbRow.repayment_amount)).toBe(25);
    });

    test('user changes mind from instant → standard → fee removed', async () => {
      const { application, token } = await createApp();
      // First save delivery=instant before any repayment row exists
      await request(app)
        .post(`/api/advance/applications/${application.id}/delivery`)
        .set('Authorization', `Bearer ${token}`)
        .send({ delivery_type: 'instant' });
      // Admin marks funded → repayment scheduled at $30
      await request(app)
        .patch(`/api/advance/admin/applications/${application.id}/status`)
        .set('x-admin-token', process.env.ADMIN_TOKEN)
        .send({ status: 'funded' });
      let dbRow = await db.getApplicationById(application.id);
      expect(parseFloat(dbRow.repayment_amount)).toBe(30);

      // User changes their mind to standard
      await request(app)
        .post(`/api/advance/applications/${application.id}/delivery`)
        .set('Authorization', `Bearer ${token}`)
        .send({ delivery_type: 'standard' });
      dbRow = await db.getApplicationById(application.id);
      expect(parseFloat(dbRow.repayment_amount)).toBe(25);
    });
  });
});
