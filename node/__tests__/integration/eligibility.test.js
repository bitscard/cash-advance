// Integration tests for the eligibility / waitlist gating logic.
// Hits the real POST /api/advance/applications endpoint with a real
// Postgres backing store. Mocks Mailchimp at the env-var level (empty
// creds → addToMailchimp short-circuits silently).
//
// Regression coverage:
//   - 8f1edeb: "neworleans" master code does NOT grant state eligibility
//   - bc51022: waitlist check reads customer.state, not subscription_status
//   - af84bea: personal referral codes do NOT bypass state gating

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

function makeSignupPayload(overrides = {}) {
  return {
    name: 'Test User',
    email: `test-${Date.now()}@example.com`,
    phone: '+15555550100',
    dob: '1990-01-01',
    requested_amount: 25,
    password: 'test-password',
    ssn: '111223333', // in TEST_SSNS allowlist
    state: 'Georgia',
    income_sources: [
      { employer: 'Acme Corp', payday: '2026-06-15', pay_frequency: 'biweekly' },
    ],
    ...overrides,
  };
}

// Eligible signups start in 'pending_payment' until they complete the
// bundled-membership step (which happens when they save a Stripe payment
// method during the Card onboarding step). Non-eligible states are
// immediately 'waitlisted' and never see the rest of the flow.
const ACTIVE_OR_PENDING = ['active', 'pending_payment'];

describe('POST /api/advance/applications — eligibility gating', () => {
  test('eligible state (Georgia) → subscription_status in pending_payment / active', async () => {
    const res = await request(app)
      .post('/api/advance/applications')
      .send(makeSignupPayload({ state: 'Georgia' }));
    expect(res.status).toBe(200);
    expect(res.body.application).toBeDefined();
    expect(ACTIVE_OR_PENDING).toContain(res.body.application.subscription_status);
    expect(res.body.application.subscription_status).not.toBe('waitlisted');
    expect(res.body.token).toBeDefined();
  });

  test('eligible state (Texas) → subscription_status not waitlisted', async () => {
    const res = await request(app)
      .post('/api/advance/applications')
      .send(makeSignupPayload({ state: 'Texas' }));
    expect(res.status).toBe(200);
    expect(ACTIVE_OR_PENDING).toContain(res.body.application.subscription_status);
  });

  test('non-eligible state (California) → subscription_status = waitlisted', async () => {
    const res = await request(app)
      .post('/api/advance/applications')
      .send(makeSignupPayload({ state: 'California' }));
    expect(res.status).toBe(200);
    expect(res.body.application.subscription_status).toBe('waitlisted');
  });

  test('regression for 8f1edeb — neworleans master code does NOT grant active', async () => {
    // The "neworleans" referral code originally bypassed the state gate;
    // it should now only grant signup access, not active eligibility.
    const res = await request(app)
      .post('/api/advance/applications')
      .send(
        makeSignupPayload({
          state: 'California', // not in the eligible list
          referral_code: 'neworleans',
        }),
      );
    expect(res.status).toBe(200);
    expect(res.body.application.subscription_status).toBe('waitlisted');
  });

  test('regression for af84bea — personal referral code does NOT grant active for ineligible state', async () => {
    // First create a referrer who has gotten their first advance (so their
    // referral code is "live"). Then try to sign up an ineligible-state
    // user with that referral code — they should still be waitlisted.
    const referrerRes = await request(app)
      .post('/api/advance/applications')
      .send(makeSignupPayload({ state: 'Georgia', ssn: '222334444' }));
    const referrer = referrerRes.body.application;
    // Mark the referrer as funded so their referral code "activates"
    await db.updateApplicationStatus(referrer.id, 'funded');
    await db.saveDeliveryType(referrer.id, 'standard', false);

    // Now sign up an ineligible-state user with that referral code
    const inviteeRes = await request(app)
      .post('/api/advance/applications')
      .send(
        makeSignupPayload({
          state: 'California',
          referral_code: referrer.referral_code,
          ssn: '333445555',
        }),
      );
    expect(inviteeRes.status).toBe(200);
    expect(inviteeRes.body.application.subscription_status).toBe('waitlisted');
  });

  test('regression for bc51022 — waitlist field actually populated, not the wrong column', async () => {
    // The bug was the waitlist check read subscription_status from a stale
    // path. Sanity-check that the response reflects the state-eligibility
    // truth and matches what's in the DB.
    const res = await request(app)
      .post('/api/advance/applications')
      .send(makeSignupPayload({ state: 'Wyoming' })); // eligible
    expect(ACTIVE_OR_PENDING).toContain(res.body.application.subscription_status);

    const dbRow = await db.getApplicationById(res.body.application.id);
    expect(ACTIVE_OR_PENDING).toContain(dbRow.subscription_status);
  });
});
