CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS applications (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL,
  email           TEXT        NOT NULL UNIQUE,
  phone           TEXT        NOT NULL,
  employer        TEXT        NOT NULL,
  payday          DATE        NOT NULL,
  requested_amount DECIMAL(10,2) NOT NULL DEFAULT 25,
  status          TEXT        NOT NULL DEFAULT 'intake',
  access_token    TEXT,
  item_id         TEXT,
  -- Nullable: Supabase-created accounts have no local password.
  password_hash   TEXT,
  -- Supabase Auth user id (auth.users.id / access-token 'sub') that owns this row.
  supabase_user_id UUID UNIQUE,
  repayment_amount     DECIMAL(10,2),
  repayment_due_date   DATE,
  repayment_note       TEXT,
  repayment_status     TEXT,
  stripe_customer_id       TEXT,
  stripe_payment_method_id TEXT,
  stripe_charge_id         TEXT,
  stripe_charge_status     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  UUID        NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  sender          TEXT        NOT NULL CHECK (sender IN ('customer', 'admin', 'system')),
  text            TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_application_id_idx ON messages(application_id, created_at);

-- Multi-source income (one row per employer). Was previously created via
-- fire-and-forget pool.query() in db.js at module load — moved here so the
-- table is guaranteed to exist before any code that INSERTs into it runs.
CREATE TABLE IF NOT EXISTS income_sources (
  id              SERIAL      PRIMARY KEY,
  application_id  TEXT        NOT NULL,
  employer        TEXT        NOT NULL,
  payday          DATE        NOT NULL,
  pay_frequency   TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS income_sources_application_id_idx ON income_sources(application_id);
ALTER TABLE income_sources ADD COLUMN IF NOT EXISTS pay_amount_cents INTEGER;

-- Payout preference columns (migration-safe)
ALTER TABLE applications ADD COLUMN IF NOT EXISTS payout_methods TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS payout_contact TEXT;

-- SSN last 4
ALTER TABLE applications ADD COLUMN IF NOT EXISTS ssn_last4 TEXT;

-- Subscription + delivery columns
ALTER TABLE applications ADD COLUMN IF NOT EXISTS subscription_id TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS subscription_status TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS subscription_next_billing DATE;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS delivery_type TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS instant_fee_paid BOOLEAN DEFAULT FALSE;

-- Stripe Financial Connections (replaces Plaid)
ALTER TABLE applications ADD COLUMN IF NOT EXISTS stripe_fc_account_id TEXT;

-- Separate card PM from bank PM so they don't overwrite each other
ALTER TABLE applications ADD COLUMN IF NOT EXISTS stripe_card_pm_id TEXT;

-- Extended intake fields
ALTER TABLE applications ADD COLUMN IF NOT EXISTS ssn TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS pay_frequency TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS state TEXT;

-- Migrations previously fired by db.js at module load (fire-and-forget
-- pool.query). Moved here so tests' applyMigrations() gets a complete
-- schema synchronously before any test code runs.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS dob DATE;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS offer_expires_at TIMESTAMPTZ;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS repayment_count INTEGER DEFAULT 0;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS referred_by TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS limit_freeze_until DATE;

-- ACH payouts via Stripe Connect Express. Set when the user picks
-- "Bank account (ACH)" as their payout method during Step 2 of
-- onboarding. stripe_connect_status mirrors the state of the connected
-- account: 'onboarding' (account created, hosted form not finished),
-- 'ready' (charges_enabled && payouts_enabled both true — we can
-- transfer money to them), 'restricted' (Stripe flagged the account,
-- transfers will fail). transfer_id is set at funded-time so we have
-- a traceable Stripe transfer per advance.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS stripe_connect_account_id TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS stripe_connect_status TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS transfer_id TEXT;

-- Tracks when we've sent the "2 days until due date" Mailchimp tag so the
-- recurring cron doesn't double-send. Reset to NULL whenever a new
-- repayment is scheduled (next advance cycle).
ALTER TABLE applications ADD COLUMN IF NOT EXISTS due_date_reminder_sent_at TIMESTAMPTZ;

-- Card-first / ACH-fallback cascade tracking.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS repayment_attempt_count INTEGER DEFAULT 0;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS repayment_last_attempt_at TIMESTAMPTZ;

-- ACH payout via Brex (manual). Bank account number the user types at
-- Step 2 — admin uses this + the bank routing from FC for manual wires.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS bank_account_number TEXT;

-- "Do you use other cash advance apps?" disclosure at signup (risk signal).
ALTER TABLE applications ADD COLUMN IF NOT EXISTS uses_other_advances BOOLEAN;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS other_advances TEXT;

-- Address fields (for Stripe Connect Custom KYC + future ACH compliance).
ALTER TABLE applications ADD COLUMN IF NOT EXISTS address_line1 TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS address_city TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS address_state TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS address_postal_code TEXT;

-- Stripe Connect Custom (zero-friction Stripe-native payouts; gated on KYC).
ALTER TABLE applications ADD COLUMN IF NOT EXISTS stripe_connect_external_account_id TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS stripe_connect_payouts_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS stripe_connect_disabled_reason TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS stripe_connect_kyc_checked_at TIMESTAMPTZ;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS connect_tos_accepted_at TIMESTAMPTZ;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS connect_tos_accepted_ip TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS connect_payout_id TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS connect_transfer_id TEXT;

-- Stripe FC session id (used during the bank-link OAuth flow).
ALTER TABLE applications ADD COLUMN IF NOT EXISTS stripe_fc_session_id TEXT;

-- Tracks whether we've subscribed to the FC account's transaction stream
-- (one-time setup that costs Stripe credits).
ALTER TABLE applications ADD COLUMN IF NOT EXISTS stripe_fc_subscribed_at TIMESTAMPTZ;

-- admin_users — multi-user admin login system.
CREATE TABLE IF NOT EXISTS admin_users (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT        NOT NULL UNIQUE,
  password_hash   TEXT        NOT NULL,
  name            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at   TIMESTAMPTZ
);
