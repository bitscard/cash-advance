// Verifies the Mailchimp tag-add side effects fire at the right moments.
// We intercept addToMailchimp itself rather than mocking fetch — simpler,
// and matches the actual code surface our tests should pin down.

const indexModule = require('../../index');
const originalAddToMailchimp = indexModule.addToMailchimp;

// Replace with a spy. Need to also override the binding the rest of
// index.js uses; since we exported it, callers see the export reference.
// (Mailchimp env vars are empty by default → addToMailchimp short-circuits.
// We need to spy on the export to observe the call, but the internal calls
// reference the local `addToMailchimp` symbol, not the module.exports one.)
//
// Strategy: assert on Mailchimp env behavior via an environment-level mock —
// we set the env vars to truthy values and intercept fetch instead.

const realFetch = global.fetch;
let fetchSpy;

beforeEach(() => {
  process.env.MAILCHIMP_API_KEY = 'test-mc-key';
  process.env.MAILCHIMP_LIST_ID = 'test-list';
  process.env.MAILCHIMP_SERVER_PREFIX = 'us12';
  fetchSpy = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'subscribed' }) });
  global.fetch = fetchSpy;
});

afterEach(() => {
  global.fetch = realFetch;
  process.env.MAILCHIMP_API_KEY = '';
  process.env.MAILCHIMP_LIST_ID = '';
  process.env.MAILCHIMP_SERVER_PREFIX = '';
});

const request = require('supertest');
const { app } = require('../../index');
const db = require('../../db');
const { applyMigrations, truncateAll, closePool } = require('../dbHelpers');

beforeAll(async () => { await applyMigrations(); });
beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await closePool(); });

const ADMIN_HEADER = { 'x-admin-token': process.env.ADMIN_TOKEN };

function payload(overrides = {}) {
  return {
    name: 'Test', email: `mc-${Date.now()}-${Math.random()}@example.com`,
    phone: '+15555550100', dob: '1990-01-01', requested_amount: 25,
    password: 'test-password', ssn: '111223333', state: 'Georgia',
    income_sources: [{ employer: 'Acme', payday: global.TEST_FUTURE_PAYDAY, pay_frequency: 'biweekly' }],
    ...overrides,
  };
}

function assertMailchimpCalledWithTag(tag) {
  // addToMailchimp now hits two Mailchimp endpoints per call:
  //   1. PUT /lists/{id}/members/{hash}    — upsert the member
  //   2. POST /lists/{id}/members/{hash}/tags — add tags additively
  // The tags endpoint sends [{ name, status: 'active' }, ...].
  const hit = fetchSpy.mock.calls.some(([url, options]) => {
    if (!url || !/api\.mailchimp\.com/.test(String(url))) return false;
    try {
      const body = JSON.parse(options?.body || '{}');
      if (!Array.isArray(body.tags)) return false;
      // New shape: [{name, status}]. Old shape (back-compat): ['tag1', 'tag2'].
      return body.tags.some(t => t === tag || (t && t.name === tag));
    } catch {
      return false;
    }
  });
  expect(hit).toBe(true);
}

describe('Mailchimp tag side effects', () => {
  test('signup with eligible state fires welcome tag', async () => {
    await request(app).post('/api/advance/applications').send(payload({ state: 'Georgia' }));
    await new Promise((r) => setTimeout(r, 50)); // fire-and-forget
    assertMailchimpCalledWithTag('welcome');
  });

  test('signup with ineligible state fires welcome + waitlist tags', async () => {
    await request(app).post('/api/advance/applications').send(payload({ state: 'California' }));
    await new Promise((r) => setTimeout(r, 50));
    assertMailchimpCalledWithTag('welcome');
    assertMailchimpCalledWithTag('waitlist');
  });

  test('admin approval fires approved tag', async () => {
    const res = await request(app).post('/api/advance/applications').send(payload());
    fetchSpy.mockClear();
    await request(app)
      .patch(`/api/advance/admin/applications/${res.body.application.id}/status`)
      .set(ADMIN_HEADER)
      .send({ status: 'approved' });
    await new Promise((r) => setTimeout(r, 50));
    assertMailchimpCalledWithTag('approved');
  });

  test('Mailchimp call failure does NOT 500 the response', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('Mailchimp is down'));
    const res = await request(app).post('/api/advance/applications').send(payload({ email: `mc-fail-${Date.now()}@x.com` }));
    expect(res.status).toBe(200);
  });
});
