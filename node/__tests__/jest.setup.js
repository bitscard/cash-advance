// Loaded by Jest before any test code runs. Forces all the env vars the
// backend reads (`node/index.js` references ~15 of them) into a known
// test-safe state so the app boots without hitting real Plaid / Stripe /
// Mailchimp / Anthropic / DATABASE_URL.
//
// Tests that need different values can override on process.env in their
// own setup blocks — Jest gives each file its own module registry.

const path = require('path');

// Try a project-local .env.test first; fall back to inline defaults
require('dotenv').config({ path: path.join(__dirname, 'test.env'), quiet: true });

// Defaults if .env.test wasn't found
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5433/bits_test';
process.env.PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID || 'test-client-id';
process.env.PLAID_SECRET = process.env.PLAID_SECRET || 'test-secret';
process.env.PLAID_ENV = process.env.PLAID_ENV || 'sandbox';
process.env.PLAID_PRODUCTS = process.env.PLAID_PRODUCTS || 'transactions';
process.env.PLAID_COUNTRY_CODES = process.env.PLAID_COUNTRY_CODES || 'US';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-dummy';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';
// Supabase access-token verification secret (HS256). Distinct from JWT_SECRET
// so the dual-auth path is exercised honestly. Tests forge tokens with this.
process.env.SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || 'test-supabase-jwt-secret';
// Empty Mailchimp creds make addToMailchimp() short-circuit silently — safe.
process.env.MAILCHIMP_API_KEY = process.env.MAILCHIMP_API_KEY || '';
process.env.MAILCHIMP_LIST_ID = process.env.MAILCHIMP_LIST_ID || '';
process.env.MAILCHIMP_SERVER_PREFIX = process.env.MAILCHIMP_SERVER_PREFIX || '';
// Allow ANY test SSN through validation; integration tests pass the value
// they want through this list.
process.env.TEST_SSNS = process.env.TEST_SSNS
  || '111223333,222334444,333445555,444556666,555667777,666778888,777889999';
