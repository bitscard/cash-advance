// Authorization on the customer-facing application/messages endpoints.
// Proves the Phase-2 security fixes (#1–#3): these endpoints used to be
// unauthenticated, leaking PII / accepting spoofed messages by application id.
// Also proves the JWT_SECRET boot guard (#4).

const { spawnSync } = require('child_process');
const path = require('path');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../../index');
const db = require('../../db');
const { applyMigrations, truncateAll, closePool } = require('../dbHelpers');
const { makeApplication } = require('../factories');

const tokenFor = (id) => jwt.sign({ applicationId: id }, process.env.JWT_SECRET, { expiresIn: '1h' });
const ADMIN = { 'x-admin-token': process.env.ADMIN_TOKEN };

beforeAll(async () => {
  await applyMigrations();
});
beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await closePool();
});

describe('Authorization on customer endpoints', () => {
  let appA, appB, tokenA, tokenB;
  beforeEach(async () => {
    appA = await db.createApplication(makeApplication());
    appB = await db.createApplication(makeApplication());
    tokenA = tokenFor(appA.id);
    tokenB = tokenFor(appB.id);
  });

  describe('GET /api/advance/applications/:id', () => {
    test('401 with no token', async () => {
      const res = await request(app).get(`/api/advance/applications/${appA.id}`);
      expect(res.status).toBe(401);
    });
    test('403 with a different applicant token', async () => {
      const res = await request(app)
        .get(`/api/advance/applications/${appA.id}`)
        .set('Authorization', `Bearer ${tokenB}`);
      expect(res.status).toBe(403);
    });
    test('200 with the owner token', async () => {
      const res = await request(app)
        .get(`/api/advance/applications/${appA.id}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.application.id).toBe(appA.id);
    });
    test('200 with an admin token (admin can read any application)', async () => {
      const res = await request(app)
        .get(`/api/advance/applications/${appA.id}`)
        .set(ADMIN);
      expect(res.status).toBe(200);
      expect(res.body.application.id).toBe(appA.id);
    });
  });

  describe('GET /api/advance/applications/:id/messages', () => {
    test('401 with no token', async () => {
      const res = await request(app).get(`/api/advance/applications/${appA.id}/messages`);
      expect(res.status).toBe(401);
    });
    test('403 with a different applicant token', async () => {
      const res = await request(app)
        .get(`/api/advance/applications/${appA.id}/messages`)
        .set('Authorization', `Bearer ${tokenB}`);
      expect(res.status).toBe(403);
    });
    test('200 with the owner token', async () => {
      const res = await request(app)
        .get(`/api/advance/applications/${appA.id}/messages`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.messages)).toBe(true);
    });
    test('200 with an admin token', async () => {
      const res = await request(app)
        .get(`/api/advance/applications/${appA.id}/messages`)
        .set(ADMIN);
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/advance/applications/:id/messages', () => {
    test('401 posting a customer message with no token', async () => {
      const res = await request(app)
        .post(`/api/advance/applications/${appA.id}/messages`)
        .send({ sender: 'customer', text: 'hi' });
      expect(res.status).toBe(401);
    });
    test('403 posting a customer message to someone else’s application', async () => {
      const res = await request(app)
        .post(`/api/advance/applications/${appA.id}/messages`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ sender: 'customer', text: 'hi' });
      expect(res.status).toBe(403);
    });
    test('200 owner posts a customer message', async () => {
      const res = await request(app)
        .post(`/api/advance/applications/${appA.id}/messages`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ sender: 'customer', text: 'hi from owner' });
      expect(res.status).toBe(200);
      expect(res.body.message.sender).toBe('customer');
    });
    test('401 posting an admin message without admin creds', async () => {
      const res = await request(app)
        .post(`/api/advance/applications/${appA.id}/messages`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ sender: 'admin', text: 'fake admin' });
      expect(res.status).toBe(401);
    });
    test('200 admin posts an admin message', async () => {
      const res = await request(app)
        .post(`/api/advance/applications/${appA.id}/messages`)
        .set(ADMIN)
        .send({ sender: 'admin', text: 'real admin' });
      expect(res.status).toBe(200);
      expect(res.body.message.sender).toBe('admin');
    });
  });
});

describe('JWT_SECRET boot guard (#4)', () => {
  test('server refuses to start when JWT_SECRET is unset', () => {
    const env = { ...process.env };
    delete env.JWT_SECRET;
    const result = spawnSync(process.execPath, ['-e', "require('./index.js')"], {
      cwd: path.join(__dirname, '..', '..'),
      env,
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/JWT_SECRET/);
  });
});
