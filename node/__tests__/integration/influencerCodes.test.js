// Influencer codes: admin-created vanity codes shared via /?ref=<code>.
// They validate like master codes (skip the invite gate) and are recorded on
// applications.referred_by for attribution.

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

const FUTURE_PAYDAY = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
const ADMIN = { 'x-admin-token': process.env.ADMIN_TOKEN };

beforeAll(async () => { await applyMigrations(); });
beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await closePool(); });

function signup(referralCode) {
  const body = {
    name: 'Test', email: `inf-${Date.now()}-${Math.random()}@example.com`,
    phone: '+15555550100', dob: '1990-01-01', requested_amount: 25,
    password: 'test-password', ssn: '111223333', state: 'Georgia',
    income_sources: [{ employer: 'Acme', payday: FUTURE_PAYDAY, pay_frequency: 'biweekly' }],
  };
  if (referralCode) body.referral_code = referralCode;
  return request(app).post('/api/advance/applications').send(body);
}

const createCode = (code, name) =>
  request(app).post('/api/advance/admin/influencer-codes').set(ADMIN).send({ code, name });

describe('admin create influencer code', () => {
  test('creates a normalized code', async () => {
    const res = await createCode('  MrBeast ', 'MrBeast');
    expect(res.status).toBe(200);
    expect(res.body.code.code).toBe('mrbeast');
    expect(res.body.code.active).toBe(true);
  });

  test('requires admin auth', async () => {
    const res = await request(app).post('/api/advance/admin/influencer-codes').send({ code: 'x', name: 'y' });
    expect(res.status).toBe(401);
  });

  test('rejects a code that collides with a master code', async () => {
    const res = await createCode('atlanta', 'Someone');
    expect(res.status).toBe(409);
  });

  test('rejects a code that collides with an existing user referral code', async () => {
    // Create a real applicant, then try to mint an influencer code equal to
    // that user's personal referral_code.
    const s = await signup();
    const appRow = await db.getApplicationById(s.body.application.id);
    const res = await createCode(appRow.referral_code, 'Imposter');
    expect(res.status).toBe(409);
  });

  test('rejects duplicate influencer code', async () => {
    expect((await createCode('summer24', 'A')).status).toBe(200);
    expect((await createCode('summer24', 'B')).status).toBe(409);
  });

  test('rejects invalid characters', async () => {
    expect((await createCode('bad code!', 'X')).status).toBe(400);
  });
});

describe('influencer code validation (/referral/:code)', () => {
  test('active code validates with the influencer name', async () => {
    await createCode('mrbeast', 'MrBeast');
    const res = await request(app).get('/api/advance/referral/mrbeast');
    expect(res.body).toEqual({ valid: true, referrer_name: 'MrBeast' });
  });

  test('deactivated code does not validate', async () => {
    await createCode('mrbeast', 'MrBeast');
    await request(app).patch('/api/advance/admin/influencer-codes/mrbeast').set(ADMIN).send({ active: false });
    const res = await request(app).get('/api/advance/referral/mrbeast');
    expect(res.body.valid).toBe(false);
  });
});

describe('attribution', () => {
  test('signup with an influencer code records referred_by', async () => {
    await createCode('mrbeast', 'MrBeast');
    const s = await signup('mrbeast');
    expect(s.status).toBe(200);
    const appRow = await db.getApplicationById(s.body.application.id);
    expect(appRow.referred_by).toBe('mrbeast');
  });

  test('admin list reports signup count per code', async () => {
    await createCode('mrbeast', 'MrBeast');
    await signup('mrbeast');
    await signup('mrbeast');
    const res = await request(app).get('/api/advance/admin/influencer-codes').set(ADMIN);
    const row = res.body.codes.find(c => c.code === 'mrbeast');
    expect(row.signups).toBe(2);
    expect(row.funded).toBe(0);
  });

  test('a deactivated code is not attributed at signup', async () => {
    await createCode('mrbeast', 'MrBeast');
    await request(app).patch('/api/advance/admin/influencer-codes/mrbeast').set(ADMIN).send({ active: false });
    const s = await signup('mrbeast');
    const appRow = await db.getApplicationById(s.body.application.id);
    expect(appRow.referred_by).toBeNull();
  });
});
