// Plaid Hosted Link integration. Mocks the Plaid SDK at the module
// boundary so tests are offline and deterministic.

// Mock the Plaid SDK BEFORE requiring index.js.
jest.mock('plaid', () => {
  const actual = jest.requireActual('plaid');
  return {
    ...actual,
    PlaidApi: jest.fn().mockImplementation(() => ({
      linkTokenCreate: jest.fn().mockResolvedValue({
        data: {
          link_token: 'test-link-token-abc',
          hosted_link_url: 'https://cdn.plaid.com/link/v2/hosted-link/test',
        },
      }),
      linkTokenGet: jest.fn().mockResolvedValue({
        data: {
          link_sessions: [
            {
              results: {
                item_add_results: [{ public_token: 'public-test-xyz' }],
              },
            },
          ],
        },
      }),
      itemPublicTokenExchange: jest.fn().mockResolvedValue({
        data: { access_token: 'access-test-token', item_id: 'item-test-id' },
      }),
    })),
  };
});

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

async function createApp() {
  const res = await request(app).post('/api/advance/applications').send({
    name: 'Test',
    email: `plaid-${Date.now()}@example.com`,
    phone: '+15555550100',
    dob: '1990-01-01',
    requested_amount: 25,
    password: 'test-password',
    ssn: '111223333',
    state: 'Georgia',
    income_sources: [{ employer: 'Acme', payday: '2026-06-15', pay_frequency: 'biweekly' }],
  });
  return { application: res.body.application, token: res.body.token };
}

describe('POST /plaid/link-token', () => {
  test('returns link_token + hosted_link_url for the owner', async () => {
    const { application, token } = await createApp();
    const res = await request(app)
      .post(`/api/advance/applications/${application.id}/plaid/link-token`)
      .set('Authorization', `Bearer ${token}`)
      .send({ origin: 'https://test.example.com' });
    expect(res.status).toBe(200);
    expect(res.body.link_token).toBe('test-link-token-abc');
    expect(res.body.hosted_link_url).toMatch(/cdn\.plaid\.com/);
  });

  test('rejects unauthenticated request', async () => {
    const { application } = await createApp();
    const res = await request(app)
      .post(`/api/advance/applications/${application.id}/plaid/link-token`)
      .send({});
    expect(res.status).toBe(401);
  });

  test('rejects token belonging to a different applicant', async () => {
    const { application } = await createApp();
    const other = await request(app).post('/api/advance/applications').send({
      name: 'Other', email: `other-${Date.now()}@example.com`, phone: '+15555550101',
      dob: '1990-01-01', requested_amount: 25, password: 'test-password',
      ssn: '222334444', state: 'Georgia',
      income_sources: [{ employer: 'Acme', payday: '2026-06-15', pay_frequency: 'biweekly' }],
    });
    const otherToken = other.body.token;
    const res = await request(app)
      .post(`/api/advance/applications/${application.id}/plaid/link-token`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({});
    expect(res.status).toBe(403);
  });
});

describe('POST /plaid/check-completion', () => {
  test('exchanges public_token and marks plaid_connected', async () => {
    const { application, token } = await createApp();
    const res = await request(app)
      .post(`/api/advance/applications/${application.id}/plaid/check-completion`)
      .set('Authorization', `Bearer ${token}`)
      .send({ link_token: 'test-link-token-abc' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('connected');
    expect(res.body.application.plaid_connected).toBe(true);

    const dbRow = await db.getApplicationById(application.id);
    expect(dbRow.access_token).toBe('access-test-token');
    expect(dbRow.item_id).toBe('item-test-id');
    expect(dbRow.status).toBe('bank_connected');
  });

  test('returns pending when Plaid session has no public_token yet', async () => {
    // Override the mock for this one test to return an empty session
    const plaid = require('plaid');
    const inst = plaid.PlaidApi.mock.results[0].value;
    inst.linkTokenGet.mockResolvedValueOnce({ data: { link_sessions: [] } });

    const { application, token } = await createApp();
    const res = await request(app)
      .post(`/api/advance/applications/${application.id}/plaid/check-completion`)
      .set('Authorization', `Bearer ${token}`)
      .send({ link_token: 'test-link-token-abc' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
  });

  test('rejects missing link_token', async () => {
    const { application, token } = await createApp();
    const res = await request(app)
      .post(`/api/advance/applications/${application.id}/plaid/check-completion`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /plaid/exchange-token (legacy iframe flow)', () => {
  test('still works for legacy in-flight tokens', async () => {
    const { application, token } = await createApp();
    const res = await request(app)
      .post(`/api/advance/applications/${application.id}/plaid/exchange-token`)
      .set('Authorization', `Bearer ${token}`)
      .send({ public_token: 'public-legacy-xyz' });
    expect(res.status).toBe(200);
    expect(res.body.application.plaid_connected).toBe(true);
  });
});
