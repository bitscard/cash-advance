// Phase 5 — admin access via a Supabase app_metadata.role='admin' claim,
// gated to @getbits.app. Exercised through requireAdmin on the admin list
// endpoint. Also guards the cron's x-admin-token path and the legacy admin JWT.

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../../index');
const { applyMigrations, truncateAll, closePool } = require('../dbHelpers');
const { makeSupabaseToken } = require('../supabaseToken');

beforeAll(async () => {
  await applyMigrations();
});
beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await closePool();
});

const ADMIN_LIST = '/api/advance/admin/applications';

describe('requireAdmin via Supabase role claim', () => {
  test('200 with role=admin + @getbits.app email', async () => {
    const { token } = makeSupabaseToken({ email: 'staff@getbits.app', role: 'admin' });
    const res = await request(app).get(ADMIN_LIST).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  test('401 with role=admin but a non-getbits email', async () => {
    const { token } = makeSupabaseToken({ email: 'attacker@evil.com', role: 'admin' });
    const res = await request(app).get(ADMIN_LIST).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  test('401 with a @getbits.app email but no admin role', async () => {
    const { token } = makeSupabaseToken({ email: 'intern@getbits.app' });
    const res = await request(app).get(ADMIN_LIST).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

describe('requireAdmin — other paths still work', () => {
  test('200 with the shared x-admin-token (cron path)', async () => {
    const res = await request(app).get(ADMIN_LIST).set('x-admin-token', process.env.ADMIN_TOKEN);
    expect(res.status).toBe(200);
  });

  test('200 with a legacy admin JWT (transition)', async () => {
    const legacy = jwt.sign({ kind: 'admin', adminId: 'abc', email: 'a@getbits.app' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const res = await request(app).get(ADMIN_LIST).set('Authorization', `Bearer ${legacy}`);
    expect(res.status).toBe(200);
  });

  test('401 with no credentials', async () => {
    const res = await request(app).get(ADMIN_LIST);
    expect(res.status).toBe(401);
  });
});
