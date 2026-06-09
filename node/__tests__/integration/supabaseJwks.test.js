// Phase 4 (revised) — asymmetric Supabase token verification via JWKS, no
// shared secret. Generates a real RSA keypair, mocks the project JWKS endpoint
// to serve its public key, signs an RS256 token, and verifies it authenticates
// through /auth/me. Proves the no-SUPABASE_JWT_SECRET path.

const crypto = require('crypto');

// Must be set BEFORE requiring index.js (SUPABASE_URL is read at module load).
process.env.SUPABASE_URL = 'https://jwks-test.supabase.co';
delete process.env.SUPABASE_JWT_SECRET; // prove we don't need the HS256 secret

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-rsa-kid';
const jwkPublic = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

// Mock the JWKS fetch the backend performs at startup / on kid miss.
global.fetch = jest.fn(async (url) => {
  if (String(url).includes('/auth/v1/.well-known/jwks.json')) {
    return { ok: true, json: async () => ({ keys: [jwkPublic] }) };
  }
  return { ok: false, json: async () => ({}) };
});

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app, loadSupabaseJwks } = require('../../index');
const db = require('../../db');
const { applyMigrations, truncateAll, closePool } = require('../dbHelpers');
const { makeApplication } = require('../factories');
const { v4: uuidv4 } = require('uuid');

beforeAll(async () => {
  await applyMigrations();
  await loadSupabaseJwks(); // deterministically warm the JWKS cache via the mock
});
beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await closePool();
});

const rs256Token = (claims) =>
  jwt.sign({ aud: 'authenticated', ...claims }, privateKey, { algorithm: 'RS256', keyid: KID, expiresIn: '1h' });

describe('Asymmetric Supabase token verification (JWKS, no secret)', () => {
  test('an RS256 token signed by the project key authenticates via /auth/me', async () => {
    const sub = uuidv4();
    const row = await db.createApplication(makeApplication({ email: 'jwks@example.com' }));
    await db.linkSupabaseUser(row.id, sub);

    const token = rs256Token({ sub, email: 'jwks@example.com' });
    const res = await request(app).get('/api/advance/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.application.id).toBe(row.id);
  });

  test('an RS256 token signed by a DIFFERENT key is rejected', async () => {
    const sub = uuidv4();
    const row = await db.createApplication(makeApplication({ email: 'evil@example.com' }));
    await db.linkSupabaseUser(row.id, sub);

    const { privateKey: otherKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const forged = jwt.sign({ aud: 'authenticated', sub, email: 'evil@example.com' }, otherKey, { algorithm: 'RS256', keyid: KID, expiresIn: '1h' });
    const res = await request(app).get('/api/advance/auth/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });
});
