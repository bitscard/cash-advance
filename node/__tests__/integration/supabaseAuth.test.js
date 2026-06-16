// Phase 4 — Supabase token verification + application linking (dual-auth).
// Proves the backend accepts Supabase access tokens alongside legacy JWTs,
// links the application to the Supabase user, and that the email fallback
// backfills the link for pre-existing rows.

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../../index');
const db = require('../../db');
const { applyMigrations, truncateAll, closePool } = require('../dbHelpers');
const { makeApplication } = require('../factories');
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

const signupBody = (over = {}) => ({
  name: 'Supa User',
  phone: '+15555550100',
  dob: '1990-01-01',
  requested_amount: 25,
  ssn: '222334444',
  state: 'Georgia',
  income_sources: [{ employer: 'Acme', payday: global.TEST_FUTURE_PAYDAY, pay_frequency: 'biweekly' }],
  ...over,
});

describe('Supabase signup (POST /applications with a Supabase token)', () => {
  test('creates an application linked to the Supabase user, with no password and no legacy token', async () => {
    const { token, sub, email } = makeSupabaseToken();
    const res = await request(app)
      .post('/api/advance/applications')
      .set('Authorization', `Bearer ${token}`)
      .send(signupBody());
    expect(res.status).toBe(200);
    expect(res.body.application.id).toBeDefined();
    expect(res.body.application.customer.email).toBe(email);
    expect(res.body.token).toBeUndefined(); // Supabase session — no legacy JWT minted

    const row = await db.getApplicationById(res.body.application.id);
    expect(row.supabase_user_id).toBe(sub);
    expect(row.password_hash).toBeNull();
  });

  test('uses the token email, not a spoofed body email', async () => {
    const { token, email } = makeSupabaseToken();
    const res = await request(app)
      .post('/api/advance/applications')
      .set('Authorization', `Bearer ${token}`)
      .send(signupBody({ email: 'attacker@evil.com' }));
    expect(res.status).toBe(200);
    expect(res.body.application.customer.email).toBe(email);
  });

  test('rejects a second application for the same Supabase user', async () => {
    const { token } = makeSupabaseToken();
    await request(app).post('/api/advance/applications').set('Authorization', `Bearer ${token}`).send(signupBody());
    const res = await request(app)
      .post('/api/advance/applications')
      .set('Authorization', `Bearer ${token}`)
      .send(signupBody({ ssn: '333445555' }));
    expect(res.status).toBe(409);
  });
});

describe('Supabase token authenticates protected routes', () => {
  test('GET /auth/me works with a Supabase token after signup', async () => {
    const { token } = makeSupabaseToken();
    const signup = await request(app)
      .post('/api/advance/applications')
      .set('Authorization', `Bearer ${token}`)
      .send(signupBody());
    const id = signup.body.application.id;

    const me = await request(app).get('/api/advance/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.application.id).toBe(id);
  });

  test('owns its own application but is forbidden from another', async () => {
    const { token } = makeSupabaseToken();
    const mine = await request(app)
      .post('/api/advance/applications')
      .set('Authorization', `Bearer ${token}`)
      .send(signupBody());
    const other = await db.createApplication(makeApplication());

    const ok = await request(app).get(`/api/advance/applications/${mine.body.application.id}`).set('Authorization', `Bearer ${token}`);
    expect(ok.status).toBe(200);
    const forbidden = await request(app).get(`/api/advance/applications/${other.id}`).set('Authorization', `Bearer ${token}`);
    expect(forbidden.status).toBe(403);
  });
});

describe('Email-fallback linking (migrated rows)', () => {
  test('a pre-existing row with the same email is linked + backfilled on first authenticated call', async () => {
    // Legacy row created without a supabase_user_id.
    const legacy = await db.createApplication(makeApplication({ email: 'migrated@example.com' }));
    expect(legacy.supabase_user_id).toBeNull();

    const { token, sub } = makeSupabaseToken({ email: 'migrated@example.com' });
    const me = await request(app).get('/api/advance/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.application.id).toBe(legacy.id);

    const linked = await db.getApplicationById(legacy.id);
    expect(linked.supabase_user_id).toBe(sub);
  });
});

describe('Legacy JWT still works during transition', () => {
  test('a legacy { applicationId } token authenticates', async () => {
    const row = await db.createApplication(makeApplication());
    const legacyToken = jwt.sign({ applicationId: row.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const me = await request(app).get('/api/advance/auth/me').set('Authorization', `Bearer ${legacyToken}`);
    expect(me.status).toBe(200);
    expect(me.body.application.id).toBe(row.id);
  });
});
