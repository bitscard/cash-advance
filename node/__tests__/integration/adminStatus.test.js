// Admin status state machine. Tests the PATCH /admin/applications/:id/status
// endpoint that drives the application through intake → bank_connected →
// reviewing → approved → funded → repayment_scheduled → repaid (plus
// denied/expired/written_off branches).
//
// Includes the regression for 5d49f24: funded with delivery_type='instant'
// must auto-schedule repayment at $30.

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

const ADMIN_HEADER = { 'x-admin-token': process.env.ADMIN_TOKEN };

async function seed(overrides = {}) {
  const res = await request(app).post('/api/advance/applications').send({
    name: 'Test', email: `admin-${Date.now()}-${Math.random()}@example.com`,
    phone: '+15555550100', dob: '1990-01-01', requested_amount: 25,
    password: 'test-password', ssn: '111223333', state: 'Georgia',
    income_sources: [{ employer: 'Acme', payday: global.TEST_FUTURE_PAYDAY, pay_frequency: 'biweekly' }],
    ...overrides,
  });
  return res.body.application;
}

describe('PATCH /api/advance/admin/applications/:id/status', () => {
  test('rejects unknown status', async () => {
    const application = await seed();
    const res = await request(app)
      .patch(`/api/advance/admin/applications/${application.id}/status`)
      .set(ADMIN_HEADER)
      .send({ status: 'super-funded' });
    expect(res.status).toBe(400);
  });

  test('rejects request without admin token', async () => {
    const application = await seed();
    const res = await request(app)
      .patch(`/api/advance/admin/applications/${application.id}/status`)
      .send({ status: 'approved' });
    expect(res.status).toBe(401);
  });

  test('approved → also sets offer_expires_at', async () => {
    const application = await seed();
    const res = await request(app)
      .patch(`/api/advance/admin/applications/${application.id}/status`)
      .set(ADMIN_HEADER)
      .send({ status: 'approved' });
    expect(res.status).toBe(200);
    expect(res.body.application.status).toBe('approved');
    const dbRow = await db.getApplicationById(application.id);
    expect(dbRow.offer_expires_at).toBeDefined();
  });

  describe('funded → auto-schedules repayment', () => {
    test('with delivery_type=instant, schedules $30 (regression for 5d49f24)', async () => {
      const application = await seed();
      await db.saveDeliveryType(application.id, 'instant', false);
      const res = await request(app)
        .patch(`/api/advance/admin/applications/${application.id}/status`)
        .set(ADMIN_HEADER)
        .send({ status: 'funded' });
      expect(res.status).toBe(200);
      const dbRow = await db.getApplicationById(application.id);
      expect(parseFloat(dbRow.repayment_amount)).toBe(30);
      expect(dbRow.status).toBe('repayment_scheduled');
    });

    test('with delivery_type=standard, schedules $25', async () => {
      const application = await seed();
      await db.saveDeliveryType(application.id, 'standard', false);
      await request(app)
        .patch(`/api/advance/admin/applications/${application.id}/status`)
        .set(ADMIN_HEADER)
        .send({ status: 'funded' });
      const dbRow = await db.getApplicationById(application.id);
      expect(parseFloat(dbRow.repayment_amount)).toBe(25);
    });

    test('with no delivery_type (admin too eager), schedules $25', async () => {
      // Edge case: admin clicks funded before the user has picked delivery.
      // Backend defaults to standard ($0 fee). The follow-up /delivery
      // recompute (tested in onboarding.test.js) handles the late pick.
      const application = await seed();
      await request(app)
        .patch(`/api/advance/admin/applications/${application.id}/status`)
        .set(ADMIN_HEADER)
        .send({ status: 'funded' });
      const dbRow = await db.getApplicationById(application.id);
      expect(parseFloat(dbRow.repayment_amount)).toBe(25);
    });
  });

  test('denied transitions cleanly', async () => {
    const application = await seed();
    const res = await request(app)
      .patch(`/api/advance/admin/applications/${application.id}/status`)
      .set(ADMIN_HEADER)
      .send({ status: 'denied' });
    expect(res.status).toBe(200);
    expect(res.body.application.status).toBe('denied');
  });

  test('admin note is recorded in the message thread', async () => {
    const application = await seed();
    await request(app)
      .patch(`/api/advance/admin/applications/${application.id}/status`)
      .set(ADMIN_HEADER)
      .send({ status: 'approved', note: 'looks good — approved' });
    const messages = await db.getMessages(application.id);
    expect(messages.some(m => m.sender === 'admin' && /approved/.test(m.text))).toBe(true);
  });
});
