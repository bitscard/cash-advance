// Signup + login flow. Covers SSN validation, age gate, password rules,
// duplicate email handling, and the JWT round-trip via /auth/me.

const request = require('supertest');
const { app } = require('../../index');
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

const basePayload = {
  name: 'Jane Doe',
  email: 'jane@example.com',
  phone: '+15555550100',
  dob: '1990-01-01',
  requested_amount: 25,
  password: 'test-password',
  ssn: '111223333',
  state: 'Georgia',
  income_sources: [{ employer: 'Acme', payday: '2026-06-15', pay_frequency: 'biweekly' }],
};

describe('POST /api/advance/applications', () => {
  test('happy path returns application + token', async () => {
    const res = await request(app).post('/api/advance/applications').send(basePayload);
    expect(res.status).toBe(200);
    expect(res.body.application.id).toBeDefined();
    expect(res.body.application.customer.email).toBe('jane@example.com');
    expect(res.body.token).toBeDefined();
    expect(res.body.application.referral_code).toBeDefined();
  });

  test('rejects password < 6 chars', async () => {
    const res = await request(app).post('/api/advance/applications').send({ ...basePayload, password: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error.error_message).toMatch(/password/i);
  });

  test('rejects missing dob', async () => {
    const res = await request(app).post('/api/advance/applications').send({ ...basePayload, dob: undefined });
    expect(res.status).toBe(400);
    expect(res.body.error.error_message).toMatch(/date of birth/i);
  });

  test('rejects under-18 applicants', async () => {
    const tooYoung = new Date();
    tooYoung.setFullYear(tooYoung.getFullYear() - 17);
    const res = await request(app)
      .post('/api/advance/applications')
      .send({ ...basePayload, dob: tooYoung.toISOString().slice(0, 10) });
    expect(res.status).toBe(400);
    expect(res.body.error.error_message).toMatch(/18/);
  });

  test('rejects empty income_sources', async () => {
    const res = await request(app)
      .post('/api/advance/applications')
      .send({ ...basePayload, income_sources: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.error_message).toMatch(/income source/i);
  });

  test('rejects invalid SSN format (when not in TEST_SSNS allowlist)', async () => {
    const res = await request(app)
      .post('/api/advance/applications')
      .send({ ...basePayload, ssn: '000111111' /* invalid 000 area */ });
    expect(res.status).toBe(400);
    expect(res.body.error.error_message).toMatch(/social security/i);
  });

  test('duplicate email returns 409', async () => {
    await request(app).post('/api/advance/applications').send(basePayload);
    const res = await request(app)
      .post('/api/advance/applications')
      .send({ ...basePayload, ssn: '222334444' });
    expect(res.status).toBe(409);
  });

  test('duplicate active SSN returns 409', async () => {
    await request(app).post('/api/advance/applications').send(basePayload);
    const res = await request(app)
      .post('/api/advance/applications')
      .send({ ...basePayload, email: 'different@example.com' });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/advance/auth/login', () => {
  beforeEach(async () => {
    await request(app).post('/api/advance/applications').send(basePayload);
  });

  test('correct credentials → token', async () => {
    const res = await request(app)
      .post('/api/advance/auth/login')
      .send({ email: basePayload.email, password: basePayload.password });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.application.customer.email).toBe(basePayload.email);
  });

  test('wrong password → 401', async () => {
    const res = await request(app)
      .post('/api/advance/auth/login')
      .send({ email: basePayload.email, password: 'wrong' });
    expect(res.status).toBe(401);
  });

  test('unknown email → 401', async () => {
    const res = await request(app)
      .post('/api/advance/auth/login')
      .send({ email: 'nobody@example.com', password: basePayload.password });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/advance/auth/me', () => {
  test('valid token returns application', async () => {
    const signup = await request(app).post('/api/advance/applications').send(basePayload);
    const token = signup.body.token;
    const res = await request(app)
      .get('/api/advance/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.application.customer.email).toBe(basePayload.email);
  });

  test('missing token → 401', async () => {
    const res = await request(app).get('/api/advance/auth/me');
    expect(res.status).toBe(401);
  });

  test('garbage token → 401', async () => {
    const res = await request(app)
      .get('/api/advance/auth/me')
      .set('Authorization', 'Bearer garbage');
    expect(res.status).toBe(401);
  });
});
