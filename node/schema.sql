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
  password_hash   TEXT        NOT NULL,
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

-- Payout preference columns (migration-safe)
ALTER TABLE applications ADD COLUMN IF NOT EXISTS payout_methods TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS payout_contact TEXT;

-- Subscription + delivery columns
ALTER TABLE applications ADD COLUMN IF NOT EXISTS subscription_id TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS subscription_status TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS subscription_next_billing DATE;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS delivery_type TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS instant_fee_paid BOOLEAN DEFAULT FALSE;
