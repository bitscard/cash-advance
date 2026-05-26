# Advance — System Design

A reference document for engineers, product, support, and ops working on the Advance wage-advance platform. Covers system architecture, data model, customer & admin flows, all backend endpoints, integrations (Plaid, Stripe, Claude, Mailchimp), business rules, validation, edge cases, and known gaps.

> **Scope of truth:** this document describes the codebase at the time of writing. The source files in `node/` and `frontend/src/` are the authoritative spec — when this doc and the code disagree, the code wins. File:line references are sprinkled throughout so you can jump to the canonical source.

---

## 1. Executive summary

Advance is a **state-gated, no-credit-check wage-advance product**. A borrower signs up, subscribes to a $3.99/month membership, links a bank account via Plaid so we can verify income, and (if approved) receives a $25–$200 cash advance paid out to PayPal / Cash App / Zelle. Repayment is automatically scheduled for the borrower's next payday and collected via Stripe (ACH primary, card fallback).

Trust is built incrementally: the first advance is capped at $25, and each on-time repayment unlocks the next tier in `[25, 50, 75, 100, 150, 200]`. Defaulted referrals freeze the referrer's tier progression. Failed repayments are written off rather than sent to collections.

Key design choices:

| Choice | Rationale |
| --- | --- |
| **State-gated eligibility (35 of 50 US states live)** | Lending laws vary by state; ineligible users go on a waitlist instead of being blocked outright. |
| **Invite-only with a master gate code** | Word-of-mouth growth; `neworleans` is the master code that unlocks signup regardless of personal referral. |
| **Plaid for income verification, Stripe for money movement** | Plaid handles the read-only bank connection (Hosted Link flow); Stripe handles ACH debits, card fallback, and the $3.99/mo subscription (created at funded-time with `billing_cycle_anchor` set to first repayment day). |
| **3-layer income classification** | Plaid PFC codes → keyword blocklist → Claude Haiku fallback. Cuts false positives (refunds, transfers, SSI/VA benefits) from being counted as wages. |
| **Server-side enforcement of every business rule** | The React app mirrors logic for UX, but eligibility, expiry, charge fallback, etc. are all enforced server-side. |

---

## 2. Architecture overview

```
                       ┌────────────────────────────┐
                       │       Browser (SPA)        │
                       │  frontend/src/App.tsx      │
                       │  React + Vite + Stripe.js  │
                       └────────────────────────────┘
                                   │
                  ┌────────────────┼────────────────┐
                  │                │                │
                  ▼                ▼                ▼
            Vercel rewrites   Plaid Hosted Link   Stripe Checkout
            (/api/* → API)    (full-page)         (full-page)
                  │
                  ▼
       ┌─────────────────────────────────────┐
       │    Node/Express API (node/index.js) │
       │ - JWT auth, admin token             │
       │ - Plaid client, Stripe client       │
       │ - Anthropic SDK (Claude Haiku)      │
       │ - Mailchimp HTTP                    │
       │ - Internal cron (setInterval)       │
       └─────────────────────────────────────┘
                  │            │           │           │
                  ▼            ▼           ▼           ▼
              PostgreSQL    Plaid API   Stripe API   Mailchimp API
              (pg pool)     (sandbox/   (Subs, PI,   (audience tags)
              applications, prod)        Setup)
              messages,
              income_sources
```

**Hosted in production:** Frontend on Vercel; backend on Render (`plaid-backend-gr01.onrender.com`); Postgres provider TBD via `DATABASE_URL`. Frontend talks to the backend through Vercel rewrites (`/api/*` → Render) so CORS stays simple.

---

## 3. Tech stack

| Layer | Stack | Notes |
| --- | --- | --- |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, `@stripe/react-stripe-js`, `react-plaid-link` | Single-page app. Routing is path-based in `App.tsx` (no router lib). |
| Backend | Node 18+, Express 4, `pg`, `stripe`, `plaid`, `@anthropic-ai/sdk`, `jsonwebtoken`, `bcryptjs` | One `index.js` file, ~2500 lines. |
| Database | Postgres (any provider with `pgcrypto` for UUIDs) | `node/schema.sql` is base; `db.js` runs additive migrations on startup. |
| Integrations | Plaid (Transactions, Auth, Hosted Link), Stripe (Customers, SetupIntents, PaymentIntents, Subscriptions, Checkout), Mailchimp (audience tags), Anthropic Claude Haiku 4.5 (income classification) | All read from env vars. |
| Hosting | Vercel (frontend), Render (backend) | `vercel.json` rewrites `/api/*` to Render. |

---

## 4. Repository layout

```
quickstart/
├── frontend/
│   ├── src/
│   │   ├── App.tsx              ~3700 LOC — landing, signup, customer dashboard,
│   │   │                        AdminApp, LoanApp, all pre-bank onboarding pages
│   │   ├── ConsentPage.tsx      Static legal page (E-SIGN consent)
│   │   ├── PrivacyPage.tsx      Static legal page (privacy + 35-state addenda)
│   │   ├── TermsPage.tsx        Static legal page (T&Cs + 35-state addenda)
│   │   ├── api.ts               apiUrl() helper — joins VITE_API_HOST with path
│   │   ├── App.module.css       All styling — CSS modules + custom properties
│   │   └── index.tsx            React entry
│   ├── public/oauth-return.html Plaid OAuth redirect target (popup-close shim)
│   ├── vite.config.ts           Dev proxy to local backend on :8000
│   └── vercel.json              Prod rewrites: /api/* → Render, /oauth-return → static
├── node/
│   ├── index.js                 The entire backend — Express routes + cron
│   ├── db.js                    Postgres pool, public DTO mapper, all SQL
│   ├── schema.sql               Base schema (also re-asserted via `ALTER … IF NOT EXISTS`)
│   ├── start.sh                 Convenience launcher (loads .env, runs `npm start`)
│   └── package.json             No test script; nodemon for dev
├── TERMS_AND_CONDITIONS.md      Source of truth for T&Cs (mirrored in TermsPage.tsx)
└── README.md
```

The Plaid quickstart leaves stub clients under `go/`, `python/`, `java/`, `ruby/` — these are unused.

---

## 5. Data model

Two real tables plus one join table. All access goes through `node/db.js`, which also runs additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migrations on boot.

### `applications`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID PK | `gen_random_uuid()` |
| `name`, `email` (unique), `phone` | TEXT NOT NULL | Email is the login identity. |
| `employer`, `payday`, `pay_frequency`, `state`, `dob`, `ssn`, `ssn_last4` | TEXT/DATE | Intake fields. `ssn` is stored cleaned (no dashes); `ssn_last4` is the only thing that goes back to the client. |
| `requested_amount` | DECIMAL | Tier amount: 25 / 50 / 75 / 100 / 150 / 200. |
| `status` | TEXT | App lifecycle (see §7). |
| `password_hash` | TEXT | bcrypt. |
| `access_token`, `item_id` | TEXT | Plaid handles. |
| `stripe_customer_id` | TEXT | Created lazily. |
| `stripe_payment_method_id` | TEXT | **Bank ACH** PM (from Plaid → Stripe). Primary charge target. |
| `stripe_card_pm_id` | TEXT | **Card** PM (from `SetupIntent`). Fallback charge target. |
| `stripe_charge_id`, `stripe_charge_status` | TEXT | Last PaymentIntent. |
| `stripe_fc_account_id` | TEXT | Legacy Stripe Financial Connections id; replaced by Plaid. |
| `repayment_amount`, `repayment_due_date`, `repayment_note`, `repayment_status` | mixed | One active repayment per app. |
| `subscription_id`, `subscription_status`, `subscription_next_billing` | TEXT/DATE | Membership state. |
| `delivery_type` | TEXT | `instant` (+$5) or `standard`. |
| `instant_fee_paid` | BOOL | Currently always false at delivery — the $5 is collected at repayment, not upfront. |
| `payout_methods`, `payout_contact` | TEXT | CSV of `PayPal/CashApp/Zelle/Bank transfer` + contact handle. |
| `offer_expires_at` | TIMESTAMPTZ | When an `approved` offer auto-expires. |
| `repayment_count` | INT | Successful repayments; drives tier progression. |
| `referral_code` | TEXT UNIQUE | Per-user invite code, autogenerated from name. |
| `referred_by` | TEXT | Personal referral code of inviter (or `neworleans` master). |
| `limit_freeze_until` | DATE | Set when one of your referrals defaults — locks your tier progression. |
| `due_date_reminder_sent_at` | TIMESTAMPTZ | Idempotency for the 2-days-before reminder cron. |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

### `messages`

| Column | Notes |
| --- | --- |
| `id` UUID PK, `application_id` UUID FK → applications | |
| `sender` | `customer` / `admin` / `system` |
| `text` | Body |
| `created_at` | Timestamp |

Indexed on `(application_id, created_at)`. This is the chat thread shown to the customer and the admin — it doubles as an audit log because every status transition writes a system message.

### `income_sources`

A user can declare multiple jobs at signup. Each becomes a row here. The first source's `employer`/`payday`/`pay_frequency` is mirrored onto the `applications` row for backwards compatibility with single-job code.

### `publicApp(row)`

`db.publicApp` is the **only** function that produces the JSON shape sent to the client. Notable masking:

- `customer.ssn_last4`: full SSN is never returned, only last 4.
- `plaid_connected`: `Boolean(stripe_fc_account_id || access_token)`.
- `stripe_card_saved`: `Boolean(stripe_card_pm_id || (stripe_payment_method_id && !stripe_fc_account_id))`.

If you add a new column that should reach the client, add it to `publicApp` — the row is otherwise opaque.

---

## 6. Authentication & authorization

### Customer auth

- **Signup** (`POST /api/advance/applications`) issues a JWT signed with `JWT_SECRET`, payload `{ applicationId }`, 30-day expiry. Frontend stores it in `localStorage` under `advance_user_token`.
- **Login** (`POST /api/advance/auth/login`) returns the same token shape after `bcrypt.compare` succeeds.
- All authenticated endpoints accept `Authorization: Bearer <jwt>` and call `requireAuth(req, res)` (`node/index.js:472–484`). It returns the decoded payload or null (with a 401 already sent). The endpoint additionally checks that `payload.applicationId === req.params.id` so a JWT can only manipulate its own application.

### Admin auth

- `ADMIN_TOKEN` env var. Admin actions check `x-admin-token` against it via `requireAdmin` (`node/index.js:465–470`).
- **If `ADMIN_TOKEN` is unset (dev), `requireAdmin` always passes.** That's intentional for local development — do **not** ship to prod without setting it.
- The admin token is stored in `sessionStorage` under `advance_admin_token` so it dies with the tab.

### Storage keys (frontend)

| Key | Value |
| --- | --- |
| `advance_application_id` | Current customer's app id (so reloads pick up the session). |
| `advance_user_token` | Customer JWT. |
| `advance_admin_token` | Admin shared secret. |
| `advance_plaid_oauth_link_token` | Stashed Plaid link token across OAuth round-trip (so the same session can be resumed). |
| `plaid_hosted_link_token` | Same idea for hosted link `?plaid_complete=1` return. |

---

## 7. Application lifecycle (status state machine)

Stored in `applications.status`. The label map lives in `App.tsx`.

```
                    intake
                      │
            (Plaid connected)
                      ▼
              bank_connected
                      │
            (admin reviews)
                      ▼
                  reviewing
                  ┌───┴───┐
            approved   denied
              │
   ┌──────────┼──────────┐
   │          │          │
expired    funded    (admin can also push to denied here)
              │
              │  (funded handler also creates Stripe subscription
              │   with billing_cycle_anchor = repayment_due_date)
              ▼
   repayment_scheduled
              │
   ┌──────────┼─────────────────────────────────┐
   │          │              │                  │
 repaid   repayment_failed   subscription_failed   │
              │                                  │
          written_off  ◄───────────────────── (after cooldown / admin write-off)
```

Transitions are admin-driven through `PATCH /api/advance/admin/applications/:id/status`, with a few automated edges:

- `approved → expired`: lazy expiry; if `GET /applications/:id` sees `status='approved' && !delivery_type && offer_expires_at < now`, it transitions in-place.
- `approved → funded`: admin marks `funded`. Same handler auto-schedules `repayment = requested_amount + (instant ? 5 : 0)` due on `payday`, AND creates the Stripe subscription with `billing_cycle_anchor = repayment_due_date` (see §11).
- `funded → repayment_scheduled`: happens on `setRepayment`.
- `funded → repayment_failed`: `/admin/charge` sets this when the Stripe PaymentIntent fails. Locks out reapply.
- `funded → subscription_failed`: Stripe webhook sets this when the membership invoice fails (`invoice.payment_failed`). Locks out reapply.
- `funded → written_off` with `repayment_count = 0` and `referred_by` set: also writes `limit_freeze_until = today + 3 months` to the referrer and posts a system message to that referrer's thread.

---

## 8. Customer flow (end-to-end)

The customer-facing routing is in `App` (`App.tsx:371`):

```ts
if (path === "/admin") return <AdminApp />;
if (path === "/loan") return <LoanApp />;
if (path === "/terms") return <TermsPage />;
if (path === "/privacy") return <PrivacyPage />;
if (path === "/consent") return <ConsentPage />;
if (path === "/oauth-return") return <OauthReturn />;
return <CustomerApp />;   // default
```

Inside `CustomerApp`, the **render is computed purely from `application.status + subscription_status + plaid_connected + delivery_type + payout_methods + stripe_card_saved + …`** — no client-side routing state. Reloading the tab always lands the user on the right step.

### 8.1 Landing (`view === "landing"`)

- Hero with alien mascot, raffle banner ($300/wk), trust stats (700k+, $0 hidden fees, 0% interest), "How it works" steps, trust pillars, partner strip.
- Two CTAs both lead to the referral gate.

### 8.2 Referral gate (`view === "referral"`)

- One input: invite code.
- Submitting calls `GET /api/advance/referral/:code`. The master code `neworleans` is always valid; personal codes only activate **once the referrer has selected `delivery_type`** (i.e., funded their first advance). This prevents fraud rings from chain-creating referrers without paying through one.
- If valid, advances to signup with `form.referralCode` filled in.

### 8.3 Signup (`view === "signup"`)

Fields: `name`, `email`, `phone`, `dob`, **one or more** income sources (each with `employer`, `payday`, `pay_frequency`, plus a freeform `pay_frequency_other` if `pay_frequency === "other"`), `ssn`, `state`, `password`, `confirmPassword`.

Client-side validation (`handleSignupSubmit`):

| Rule | Error |
| --- | --- |
| `dob` set | "Please enter your date of birth" |
| Age ≥ 18 | "You must be at least 18 years old to apply." |
| `ssn` is 9 digits | "Please enter your full 9-digit Social Security Number" |
| Each source has `pay_frequency` (and `pay_frequency_other` if `=== "other"`) | per-source error |
| `state` selected | "Please select your state" |
| `password === confirmPassword` | "Passwords do not match" |

Submit hits `POST /api/advance/applications` with the cleaned shape:

```ts
{
  name, email, phone, dob, password, state, ssn,            // ssn stripped of dashes
  income_sources: [{ employer, payday, pay_frequency }],    // pay_frequency_other folded in
  requested_amount: 25,                                     // first-time always $25
  referral_code: "neworleans" | "<personal>" | undefined,
}
```

If the state isn't eligible and there's no gate code, the frontend also fires `POST /api/waitlist` for Mailchimp tagging. (Backend signup independently tags the user `welcome` + `waitlist`.)

### 8.4 6-step pre-bank onboarding

After signup the customer is gated by:

```ts
const preBankActive =
  application.status === "intake" &&
  (application.subscription_status === "active" ||
   application.subscription_status === "pending_payment") &&
  !application.plaid_connected;
```

Steps render in this order; each has its own gate so a refresh always returns to the right place.

| # | Step | Gate | What it does |
| --- | --- | --- | --- |
| 1 | Benefits | `!benefitsSeen` | Pitches "no credit check, no interest, no collections, weekly raffle." Pure presentation. |
| 2 | Receive money | `!payout_methods \|\| !payout_contact` | Single-select PayPal / Cash App / Zelle + handle, with a confirmation block. |
| 3 | Trust ladder | `!trustScreenSeen` | Static screen showing $25 → $200 milestones and how trust building works. |
| 4 | **Card + membership** | `!stripe_card_saved` | Stripe `CardElement` + `SetupIntent` → saves `stripe_card_pm_id`. Page also discloses the bundled $3.99/mo membership that will charge to this card starting on the user's first repayment day. The Stripe subscription is **not** created here — it's deferred until `funded` (see §11). |
| 5 | Delivery speed | `!delivery_type` | Same-day (+$5 at repayment) vs 3–5 days (free). Live "first month" breakdown shows advance + same-day fee + $3.99 membership. |
| 6 | Bank verification | otherwise | Plaid Hosted Link. On `?plaid_complete=1` return, calls `/plaid/check-completion` to finalize. |

After step 6 the app is `bank_connected` and gets out of `preBankActive`. The standalone Stripe Checkout subscription step that used to live between Steps 1 and 2 has been removed — the membership is now bundled into Step 4's card collection and the actual Stripe subscription is created later at funded-time.

### 8.5 Waitlist

If `subscription_status === "waitlisted"` (ineligible state and no master gate code), the customer is parked on a confirmation page promising email when their state goes live. They can't access any of the onboarding steps.

### 8.6 Approved / Funded / Repayment

Once an admin approves, the customer dashboard shows the offer + offer expiry countdown. After `funded`, the dashboard shows the repayment due date, amount, and the option to "Mark as paid" (`POST /payoff` — customer-initiated; flips `repayment_status=paid` and adds a system message awaiting admin confirmation).

When `status='repaid'`, the customer is invited to reapply.

### 8.7 Reapply

`POST /api/advance/applications/:id/reapply`. Server-enforced rules:

- Blocked if status ∈ `{funded, repayment_scheduled}` (active loan).
- If a prior `repayment_due_date` exists and status isn't `expired` / `denied`, blocks until `due_date + 1 day` (cooldown).
- Computes new requested amount from `ADVANCE_TIERS = [25, 50, 75, 100, 150, 200]` keyed by `repayment_count`. If `limit_freeze_until > now`, uses `max(0, repayment_count - 1)` — i.e., one tier penalty.
- Calls `db.resetForReapply()` which clears delivery, offer expiry, repayment fields and flips `status='reviewing'`.

---

## 9. Admin flow (`/admin`)

`AdminApp` is gated by the admin token (entered once, kept in `sessionStorage`).

**Inbox.** `GET /api/advance/admin/applications` returns every application. Each row shows the status badge and created date; clicking opens a review panel.

**Review panel.** Pulls four parallel endpoints:

| Endpoint | Used for |
| --- | --- |
| `GET .../bank_snapshot` | Accounts + balances, classified transactions, per-source accrued wages. |
| `GET .../income_analysis` | Heuristic "stable income?" boolean with a score breakdown. |
| `GET .../referrals` | This user's referral tree summary (got_advance, repaid, defaulted, active). |
| `GET .../payment-method-details` | Bank name, routing, last4, account type — i.e., the prettified ACH coordinates. |

**Actions.** Admin can:

- Approve / deny / mark funded / mark repaid / mark repayment_failed / write off (via `PATCH .../status` with an optional note that gets posted as an admin message).
- Schedule a repayment with a custom amount + due date (`POST .../repayment`).
- Manually trigger a charge attempt (`POST .../charge` — runs the same overdraft check + primary→fallback path as the cron).
- Bulk-run all due repayments (`POST .../run-due-repayments`).
- Send a free-text admin message to the customer.

Every status transition fires the right side effects: Mailchimp tag, auto-schedule of repayment on `funded`, offer expiry computation on `approved`, referral freeze on `written_off + repayment_count=0`.

---

## 10. Loan sign-in (`/loan`)

Lightweight dashboard for existing borrowers who want to log in directly (rather than the auto-resume path through the main app).

- Login: email + password → `/auth/login` → JWT.
- Once authed: same payout-method selector, save-card form, and "mark as paid" / reapply controls that the main `CustomerApp` exposes.

It exists because the main flow keys off `localStorage.advance_application_id` — if a borrower clears their browser, `/loan` is the recovery path.

---

## 11. Subscription / membership ($3.99/mo)

The customer pays $3.99/month as a recurring Stripe subscription. Billing model is precise about when the first charge fires and how it relates to advance repayments — read carefully because the wording matters for support conversations.

### Billing model

- **No charge at card save.** When the user saves their card in Step 4 of pre-bank onboarding, the card is stored as the Stripe customer's default payment method and the subscription is NOT created yet. `subscription_status` stays `'pending_payment'`.
- **First charge fires on first repayment day.** When admin marks `status='funded'`, the backend creates a Stripe subscription with `billing_cycle_anchor = repayment_due_date` (UTC midnight of that day) and `proration_behavior: 'none'`. Stripe's first invoice fires on that anchor date — as a **separate transaction from the advance repayment**.
- **Monthly thereafter.** Stripe handles the recurring schedule on the anchor day of each subsequent month. Independent of whether the user takes another advance.
- **Subsequent advance paydays only collect the loan + same-day fee.** The membership stays on its own monthly cadence and is never bundled with advance repayment charges.

### Backend (`node/index.js`)

| Endpoint | Status | What it does |
| --- | --- | --- |
| `POST /api/advance/applications/:id/stripe/setup-intent` | Active | Creates the Stripe Customer (if needed) and a `SetupIntent` for the card collection step. |
| `POST /api/advance/applications/:id/stripe/save-payment-method` | Active | Stores the saved payment method on the application row and sets it as the Stripe customer's default PM. **Does NOT create the subscription** — that happens at funded-time. |
| `PATCH /api/advance/admin/applications/:id/status` (when `status='funded'`) | Active | Auto-schedules the advance repayment AND creates the Stripe subscription with `billing_cycle_anchor=repayment_due_date`. Subscription failure is logged but does not block the funded transition. |
| `POST /api/webhooks/stripe` | Active | Listens for `invoice.payment_failed` (→ `status='subscription_failed'` lockout), `invoice.payment_succeeded` (→ updates `subscription_next_billing`), `customer.subscription.deleted` (→ `subscription_status='cancelled'`). Verifies signature when `STRIPE_WEBHOOK_SECRET` is set. |
| `POST /api/advance/applications/:id/subscription/checkout-session` | **Legacy / unused by current UI** | Older flow that opened Stripe Checkout for a standalone subscription step. Kept on the backend in case we ever want to expose a separate "manage membership" path. Not called from the customer app today. |
| `POST /api/advance/applications/:id/subscription/sync` | **Legacy / unused** | Pair to the Checkout endpoint above. Same reasoning. |
| `POST /api/advance/applications/:id/subscription/activate` | **Legacy / unused** | Free-activation predecessor. No longer called from the UI. |

### Signup-time state

Eligible signups land on `subscription_status='pending_payment'`. Waitlisted users land on `'waitlisted'`. Card-save does not flip status. `funded` transition flips it to `'active'` once the Stripe subscription is created.

### Failure lockout

If either the advance repayment OR the membership invoice fails, the user is locked out of new advances until they resolve:
- Advance repayment failure → `status='repayment_failed'` (set by `/admin/charge`).
- Membership invoice failure → `status='subscription_failed'` (set by the webhook).
- `POST /reapply` rejects both with a 400 pointing the user to support.

### Webhook setup (required)

The lockout only works if the Stripe webhook is wired. In the Stripe Dashboard → Webhooks → Add endpoint:
- URL: `https://plaid-backend-gr01.onrender.com/api/webhooks/stripe`
- Events: `invoice.payment_failed`, `invoice.payment_succeeded`, `customer.subscription.deleted`
- Copy the signing secret into the Render env as `STRIPE_WEBHOOK_SECRET`. Without this var, the endpoint still works in dev but logs a warning ("webhook secret not configured — event accepted without verification").

### What's still not wired

- **In-app cancellation UX.** Customers email support; we don't yet expose a "Cancel membership" button or Stripe billing portal link.

---

## 12. Plaid integration

Used for **income verification only** — we don't move money through Plaid.

| Endpoint | Notes |
| --- | --- |
| `POST .../plaid/link-token` | Creates a hosted link token. Returns `link_token + hosted_link_url`. The frontend stashes `plaid_hosted_link_token` in localStorage before redirecting, so the return trip can resume the same session. |
| `POST .../plaid/check-completion` | On `?plaid_complete=1` return, exchanges the public token and persists the access token, item id, and ACH coordinates. Transitions status to `reviewing` and fires Mailchimp `application_under_review`. |
| `GET .../bank_snapshot` (admin) | The big one. See §13. |
| `/oauth-return` | Dedicated static page Plaid bounces to mid-OAuth; closes the popup and lets the parent tab resume. Implemented as both a static HTML file (`public/oauth-return.html`) and a React route fallback so it survives both popup and redirect strategies. |

`PLAID_ENV` is `sandbox` by default; flip to `production` (and refresh `PLAID_SECRET`) to go live.

---

## 13. Income classification pipeline

Lives in `node/index.js:128–251`. Runs server-side every time admin views `bank_snapshot`. Three layers, in order:

### Layer 1: Plaid PFC blocklist

Set: retirement pensions, dividends, social security, unemployment, tax refunds, government benefits, in/out investment & retirement transfers. If `tx.pfc ∈ EXCLUDED_PFC`, classified as `excluded` with `reason: 'pfc'`. No further layers run.

### Layer 2: Keyword blocklist

70+ phrases on description: `social security`, `ssa treas`, `ssdi`, `va comp`, `unemployment`, `tax refund`, `eitc`, `stimulus`, `pension`, `tanf`, `workers comp`, `child support`, `rental income`, `refund`, `merchandise credit`, brokerage names (`fidelity`, `vanguard`, `schwab`, `etrade`, `robinhood`, `wealthfront`, `betterment`, `acorns`), `dividend`, `401k`, `ira distribution`, etc. Case-insensitive substring. If any matches → `excluded`, `reason: 'keyword'`.

### Layer 3: Claude Haiku

For anything not yet excluded, calls `claude-haiku-4-5-20251001` with a small prompt (max 10 tokens) classifying as `wage_income | excluded | uncertain`. Cached in-memory by normalized description so repeat admin views are free. On API error: falls back to `uncertain` (never crashes the request).

### Refund detection (bonus layer)

`buildRefundSet` pairs incoming amounts with prior outgoing spend at the same merchant within ±10%. Matched incomings are reclassified `excluded`, `reason: 'refund'` — this catches Amazon-style returns that the layered classifier might otherwise count as income.

### Per-source accrual math

`calcSourceAccrued` aligns the last 3–4 paychecks against the declared `payday` and `pay_frequency`, with frequency-aware slack (±2–4 days). It averages those paychecks, divides by the period length, multiplies by days elapsed since the last payday. The admin UI shows this as "$X accrued (Y of Z days)."

---

## 14. Stripe integration

### Customers & payment methods

- **Customer** created lazily on first SetupIntent or first checkout session.
- **Bank ACH PM** (`stripe_payment_method_id`) comes from the Plaid `processor/stripe/bank_account_token` exchange when the bank is linked.
- **Card PM** (`stripe_card_pm_id`) comes from the SetupIntent flow in onboarding step 5.

### Charging (repayment)

`POST .../charge` and the cron's `run-due-repayments` use the same path:

1. Compute amount: prefer scheduled `repayment_amount`; fall back to `requested_amount + (delivery_type === 'instant' ? 5 : 0)`. The `$5` instant fee is **not** prepaid — it rides on the repayment.
2. `checkOverdraft(access_token, amountCents)`: if Plaid balance is available and `< amount`, **skip the charge** and post a system message ("Payment skipped to avoid overdraft — account has $X but repayment is $Y. We'll retry when funds are available."). Fails open if Plaid balance is unavailable (so card-only users aren't blocked).
3. Try the bank ACH PM (`stripe.paymentIntents.create` with `off_session: true`).
4. On `StripeCardError` / `StripeInvalidRequestError` and a card PM exists, retry with the card.
5. On success → `markRepaymentPaid`, `incrementRepaymentCount`, system message.
6. On failure → mark `status='repayment_failed'`, log the Stripe charge id (or `null`) and status, post system message.

### Subscriptions

See §11. Subscription mode is Stripe Checkout-hosted; everything else is direct API.

---

## 15. Referral system & credit ladder

### Codes

- `referral_code` is auto-generated from the user's first name (slug → `name123` if taken) at signup. Globally unique.
- `referred_by` records the code that brought the user in. The master code `neworleans` is allowed to populate this for users in eligible states who weren't personally invited.

### Activation rules

Personal referral codes only validate after the **referrer** has chosen `delivery_type` (i.e., proved they're a real funded user). The master code is always valid. This deters someone from creating ten accounts and seeding their own pyramid.

### Penalties

Writing off a referral's first advance (`repayment_count = 0`) triggers `saveLimitFreeze(referrer.id, today + 3 months)`. While `limit_freeze_until > now`, the referrer's next reapply uses `repayment_count - 1` as the tier index — one rung lower than otherwise. We never frame this as a "penalty" to the customer; the system message is gentle ("Your limit will hold steady on your next advance because a recent referral didn't repay").

### Trust ladder

`ADVANCE_TIERS = [25, 50, 75, 100, 150, 200]`. Tier index = `repayment_count` (clamped). Frozen users get `tier_index - 1`. The Step 4 onboarding screen shows this as a visual roadmap.

---

## 16. Offer expiry & state timezones

Approving an application sets `offer_expires_at` to **end-of-day local time** in the customer's state. State-timezone map (e.g., GA → `America/New_York`, TX → `America/Chicago`) is hardcoded in `index.js`. If the customer doesn't pick a delivery option before that timestamp, the next `GET /applications/:id` transitions them to `expired`.

That lazy-expiry pattern (rather than a cron) keeps the data eventually-consistent without a worker.

---

## 17. Cron / background jobs

Two parallel triggers for due-date reminders, plus admin-driven jobs for repayment charging.

### Due-date reminders (`due_date_reminder` Mailchimp tag, 2 days before repayment)

- **GitHub Actions scheduled workflow** (primary). `.github/workflows/cron-due-date-reminders.yml` runs daily at **14:00 UTC** (10am ET / 7am PT) and POSTs `https://<backend>/api/cron/due-date-reminders` with the `ADMIN_TOKEN` header. Manually triggerable from the Actions tab. Uses repo secrets `BACKEND_URL` and `ADMIN_TOKEN`.
- **In-process backup** (defense in depth). Same code path also runs from a `setInterval(sendDueDateReminders, 60 * 60 * 1000)` plus a `setTimeout(..., 30_000)` on boot. Guarded by `if (require.main === module)` so the timer doesn't fire during tests. Won't fire while the Render service is asleep.

Both paths call `sendDueDateReminders()`, which queries:
```sql
SELECT * FROM applications
WHERE status IN ('funded', 'repayment_scheduled')
  AND repayment_due_date::date = CURRENT_DATE + INTERVAL '2 days'
  AND due_date_reminder_sent_at IS NULL
  AND email IS NOT NULL
```
For each match, it tags the user (`due_date_reminder`) and stamps `due_date_reminder_sent_at = NOW()`. Idempotent — re-runs the same day no-op. The stamp resets to NULL whenever `setRepayment` runs, so each new advance cycle gets its own reminder.

### Other scheduled workflows

- `.github/workflows/charge-due-repayments.yml` — daily ping of `/admin/run-due-repayments` to auto-charge any due repayments.
- `.github/workflows/charge-due-memberships.yml` — predecessor; relevant only if we ever stop letting Stripe handle membership renewals.

### Admin-triggered jobs

`run-due-repayments` is also reachable directly from the admin panel. Stripe handles all subscription renewals natively — no cron on our side for membership billing.

---

## 18. Mailchimp tagging

Single function `addToMailchimp(name, email, state, tags)`. Two-step pattern per call:

1. **`PUT /lists/{id}/members/{md5(email)}`** — upserts the member record + merge fields (FNAME, LNAME, STATE). `status_if_new: 'subscribed'` so new members aren't stuck in pending.
2. **`POST /lists/{id}/members/{md5(email)}/tags`** — adds the tags additively. Existing tags are preserved.

**Important history:** the earlier implementation used `POST /lists/{id}/members` which only creates new members. After the welcome tag created the contact, every subsequent call returned "Member Exists" and silently dropped the new tags — so `application_under_review`, `approved`, and `due_date_reminder` never reached the inbox. The PUT-then-tags pattern fixes that and is idempotent for re-runs.

Tags fire at:

| Event | Tags | Code site |
| --- | --- | --- |
| Signup, eligible state | `welcome` | `POST /api/advance/applications` |
| Signup, ineligible state | `welcome`, `waitlist` | same |
| Bank connected (Hosted Link) | `application_under_review` | `/plaid/check-completion` |
| Bank connected (legacy iframe) | `application_under_review` | `/plaid/exchange-token` |
| Status → `approved` | `approved` | `PATCH /admin/applications/:id/status` |
| Status → `denied` | `denied` | same |
| 2 days before due date | `due_date_reminder` | `sendDueDateReminders()` cron |

The marketing team wires Customer Journeys against these tag names. **Keep them stable** — renaming a tag breaks the journey trigger.

---

## 19. Validation rules (server-enforced)

| Field | Rule | Location |
| --- | --- | --- |
| `name`, `email`, `phone` | Non-empty | Signup handler |
| `email` | Unique across applications (Postgres unique constraint) | DB |
| `password` | bcrypt hashed; minimum length enforced client-side (6) | Signup handler |
| `dob` | Required; age ≥ 18 calculated against today | Signup |
| `ssn` | 9 digits after stripping dashes; passes `isPlausibleSSN` (no 000/666/9xx area, no 00 group, no 0000 serial, no all-same-digit, not in the hardcoded fake list); not a duplicate in any active status (`intake`, `bank_connected`, `reviewing`, `approved`, `funded`, `repayment_scheduled`, `repayment_failed`). `TEST_SSNS` env bypass for QA. | Signup, `isPlausibleSSN` |
| `state` | Must be in the 50-state list; eligibility = `ELIGIBLE_STATES` (35 states) determines `pending_payment` vs `waitlisted` | Signup |
| `income_sources[].pay_frequency` | One of `weekly / biweekly / semimonthly / monthly / daily / <freetext>` | Signup |
| `income_sources[].payday` | A future date | Client; not strictly enforced server-side |
| `requested_amount` | Always 25 on signup; on reapply derived from `repayment_count` + freeze | Reapply handler |
| `delivery_type` | `instant` or `standard` | Delivery handler |
| `payout_methods` | Comma-separated subset of `PayPal, CashApp, Zelle, Bank transfer`; if not `Bank transfer`, `contact` required | Payout handler |
| `subscription/sync` | session.customer must match the application's `stripe_customer_id`; `sub.status ∈ {active, trialing}` | Sync handler |
| Reapply | Blocked while `status ∈ {funded, repayment_scheduled}`; cooldown until `due_date + 1 day` unless previous status was `expired` or `denied` | Reapply handler |
| Charge | Skip if Plaid balance shows insufficient funds (overdraft guard); fall through Bank ACH → Card on Stripe error | `checkOverdraft`, charge handler |

---

## 20. Edge cases & how they're handled

| Scenario | Behavior |
| --- | --- |
| User signs up in an ineligible state | Lands on `waitlisted`; cannot proceed past the waitlist screen. Gets `welcome + waitlist` Mailchimp tags. Frontend also sends a separate `POST /api/waitlist` for the marketing list. |
| Master code `neworleans` in an ineligible state | The code unlocks **signup**, but state eligibility still gates `subscription_status` — so they still hit `waitlisted`. This is intentional: the master code is for friend-of-team beta, not a state bypass. |
| User clears localStorage mid-flow | They can recover via `/loan` (email + password login). Token round-trips back into `advance_user_token`. |
| Plaid OAuth bank loops back to a popup | `/oauth-return` closes the popup and lets the original tab finish via `check-completion`. Falls back to a redirect to `/` after 600ms if `window.close()` is refused. |
| Approved offer not actioned by end of day | `offer_expires_at` is set at approval time in the customer's state's local timezone. Any subsequent `GET /applications/:id` lazily transitions the status to `expired`. |
| Bank balance too low at repayment time | `checkOverdraft` aborts the charge and posts a system message. The repayment stays `pending`; the next cron run retries. |
| Bank ACH PM fails (closed account, NSF) | Falls back to the saved card PM. If both fail, status → `repayment_failed`. |
| Customer's referral defaults on their first advance | Referrer gets `limit_freeze_until = today + 3 months`. Their next reapply pulls tier `repayment_count - 1`. |
| Customer tries to reapply during an active loan | 400 with "Active loan in progress." |
| Subscription renewal fails (no card, dispute) | **Today: silent** — no webhook handler. The next reapply or onboarding would still see `subscription_status='active'` in our DB. Add a webhook before launch. |
| Stripe Checkout session returns to a tab that's already authenticated as a different user | The sync handler asserts `session.customer === row.stripe_customer_id` and 400s otherwise. |
| Anthropic API down during income classification | `classifyWithAI` returns `uncertain` per transaction; the admin UI flags it explicitly so they can eyeball it. |
| Plaid API down during balance check | `checkOverdraft` fails open (`{ok: true}`), so card-only users keep working. |
| Test SSN reuse during QA | `TEST_SSNS` env var (comma-separated, dashes optional) bypasses both plausibility and dupe checks. |

---

## 21. Test suite

Comprehensive automated suite, ~150 tests across three layers. CI runs every PR via `.github/workflows/test.yml` (backend job uses a Postgres service container; frontend job runs Vitest + Playwright with browser install).

### Backend (`node/`)

Jest + supertest. `npm test`, `npm run test:unit`, `npm run test:integration`.

| Layer | Files | What's covered |
| --- | --- | --- |
| **Unit (104 cases)** | `__tests__/unit/*.test.js` | All pure functions: `isPlausibleSSN` (SSA rules, advertised fakes), `payPeriodDays`, `findPaychecksByPattern` (daily/weekly/biweekly/monthly), `calcSourceAccrued`, `buildRefundSet`, `isExcludedByPFC` + `isExcludedByKeyword` + `classifyTransaction` (with mocked Anthropic), `getOfferExpiresAt` + `STATE_TIMEZONES` (ET/CT/MT/PT/AZ/HI/AK + DST), `computeChargeAmountCents` (the regression fix for the missing $5 instant fee), `generateReferralSlug`. |
| **Integration (~50 cases)** | `__tests__/integration/*.test.js` | Express endpoints against an ephemeral Postgres on port 5433 via `docker-compose.test.yml`. Plaid + Stripe + Anthropic SDKs are jest-mocked at module boundary. Coverage: signup happy path + validation; eligibility gate (3 named regressions for waitlist bypass bugs); Plaid Hosted Link + legacy `/exchange-token`; payout/delivery/recompute; full admin status state machine; charge endpoint (regression for null-`repayment_amount` instant-fee drop); due-date cron idempotency; Mailchimp tag-add side effects; reapply tier ladder + frozen referrals. |

### Frontend (`frontend/`)

Vitest + React Testing Library + Playwright. `npm test`, `npm run e2e`.

| Layer | Files | What's covered |
| --- | --- | --- |
| **Unit (8 cases)** | `src/__tests__/unit/*.test.ts` | `dataUtilities.ts` transform samples + cross-file consistency check that backend `ELIGIBLE_STATES`, frontend `ELIGIBLE_STATES`, T&Cs `STATE_PROVISIONS`, and Privacy `ELIGIBLE_STATES` all match (35 states). |
| **Component (18 cases)** | `src/__tests__/components/*.test.tsx` | `TermsPage` renders all 35 state subsections; `PrivacyPage` state callouts; `ConsentPage` 7 sections + the 4-item "I hereby" list; `StatesFooter` legal links; signup-form consent line links all three legal docs. |
| **E2E (~27 across chromium / webkit / iphone)** | `e2e/*.spec.ts` | Landing hero + $300 weekly raffle (regression for the Cancún copy swap); `/terms`, `/privacy`, `/consent` route content; mobile viewport rendering at iPhone 13. |

### CI workflow

`.github/workflows/test.yml`:
- Triggers on push to `main` and on PRs targeting `main`.
- Two parallel jobs (`backend tests`, `frontend tests`).
- Backend job spins up Postgres 16 as a service container, runs Jest with `--runInBand`.
- Frontend job runs Vitest, then installs Playwright browsers and runs E2E across all three projects.
- Failure artifact: Playwright HTML report uploaded on failure for 7 days.

Recommended branch protection on `main`: require both jobs before merging (GitHub → Settings → Branches).

---

## 22. Configuration & deployment

### Backend env vars

| Var | Required? | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Postgres connection string. SSL enabled by default; disabled when `NODE_ENV=test` (matches the CI test container, no SSL). |
| `NODE_ENV` | — | Set to `test` by Jest; left unset in prod. |
| `JWT_SECRET` | Yes (prod) | Falls back to `dev_jwt_secret_change_in_production` in dev. |
| `ADMIN_TOKEN` | Yes (prod) | If unset, `requireAdmin` always passes — dev only. Also used by the GitHub Actions cron workflows (via the `ADMIN_TOKEN` repo secret). |
| `STRIPE_SECRET_KEY` | Yes | Powers cards, charges, subscriptions. |
| `STRIPE_WEBHOOK_SECRET` | Yes (prod) | Signing secret from Stripe Dashboard → Webhooks. Without it, `/api/webhooks/stripe` accepts events but logs a warning (unsafe in prod — anyone could spoof a payment failure to lock a user out). |
| `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` | Yes | `PLAID_ENV` defaults to `sandbox`. |
| `PLAID_PRODUCTS`, `PLAID_COUNTRY_CODES`, `PLAID_REDIRECT_URI`, `PLAID_ANDROID_PACKAGE_NAME`, `SIGNAL_RULESET_KEY` | Optional | Plaid quickstart leftovers. With Hosted Link, `PLAID_REDIRECT_URI` is no longer needed — explicitly leave it unset. |
| `ANTHROPIC_API_KEY` | Yes (for income classification) | Without it, layer 3 of classification returns `uncertain` for everything. |
| `MAILCHIMP_API_KEY`, `MAILCHIMP_LIST_ID`, `MAILCHIMP_SERVER_PREFIX` | Yes (for tagging) | If unset, tagging silently no-ops. |
| `TEST_SSNS` | Optional | Comma-separated 9-digit SSNs that bypass plausibility + dupe checks. |
| `APP_PORT` | Optional | Defaults to 8000. |

### GitHub repo secrets (for CI + cron workflows)

Set under repo → Settings → Secrets and variables → Actions:

| Var | Used by | Notes |
| --- | --- | --- |
| `ADMIN_TOKEN` | `cron-due-date-reminders.yml`, `charge-due-repayments.yml` | Same value as on Render. |
| `BACKEND_URL` | same | Production base URL of the backend, no trailing slash. |

### Frontend env vars

| Var | Notes |
| --- | --- |
| `VITE_API_HOST` | API origin (e.g., `https://plaid-backend-gr01.onrender.com` in prod, blank in Vercel since rewrites handle it). |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Required for the card setup step and the membership step. Without it the Subscribe button is disabled. |

### Deployment topology

- **Frontend** → Vercel. `vercel.json` rewrites `/api/*` to the Render backend and `/oauth-return` to a static HTML shim. SPA fallback for everything else.
- **Backend** → Render web service (`plaid-backend-gr01.onrender.com`). Runs `node index.js`; uses `setInterval` for the due-date reminder cron in-process.
- **Database** → external Postgres (any provider with `pgcrypto`). `node/db.js` runs idempotent migrations on every boot, so deploying new columns is just-deploy — no separate migration step.

---

## 23. Known gaps & follow-ups

| # | Gap | Impact | Status |
| --- | --- | --- | --- |
| 1 | ~~No Stripe webhook handler~~ | — | **Resolved.** `/api/webhooks/stripe` handles `invoice.payment_failed` (→ `subscription_failed` lockout), `invoice.payment_succeeded` (→ next-billing sync), `customer.subscription.deleted`. Needs `STRIPE_WEBHOOK_SECRET` env var on Render. |
| 2 | **No in-app subscription cancel** | Customers have to email support; Stripe billing portal not wired. | Open. Plug the billing portal as an "Manage membership" button on the dashboard. |
| 3 | ~~No automated test suite~~ | — | **Resolved.** ~150 tests + GitHub Actions CI. See §21. |
| 4 | ~~In-process cron~~ | — | **Resolved.** `.github/workflows/cron-due-date-reminders.yml` runs daily at 14:00 UTC and POSTs the cron endpoint. In-process `setInterval` left in place as a redundancy. |
| 5 | **Legacy `/subscription/activate` + `/subscription/checkout-session` + `/subscription/sync` endpoints still mounted** | Unused by the current UI but reachable. The `/activate` one in particular could flip subscription_status to `active` without payment if called directly with a customer JWT. | Open. Remove or gate behind admin once we're confident no in-flight clients call them. |
| 6 | **In-memory AI classification cache** | Per-process; horizontal scale-up multiplies Anthropic calls. | Acceptable for today's volume; move to Redis if/when we shard. |
| 7 | **`PLAID_ENV` defaults to sandbox** | Prod misconfig would silently approve sandbox accounts as real income. | Make `PLAID_ENV=production` an explicit prod requirement (assert at boot). |
| 8 | **`ADMIN_TOKEN` unset = open admin** | Useful in dev, dangerous if the env var ever drops in prod. | Assert at boot in production. |
| 9 | **Single `applications` row per user** | "Reapply" mutates the same row instead of creating a new one. History reconstructed from `messages`. | Acceptable today; introduce a `loans` child table if/when we want loan-by-loan analytics. |
| 10 | **Legal docs not lawyer-reviewed** | T&Cs (35-state version with per-state regulators in Section O), Privacy Policy (state-specific privacy callouts), and Consent doc (E-SIGN consent) all carry "not reviewed by counsel" footers. | Open. Get an attorney pass before any new state goes live or before scaling marketing. |

---

## 24. Quick reference: endpoint index

### Public (no auth)

- `GET  /api/advance/referral/:code` — validate an invite code.
- `POST /api/advance/applications` — signup.
- `POST /api/advance/auth/login` — email + password → JWT.
- `POST /api/waitlist` — Mailchimp waitlist tag (no DB row).
- `POST /api/cron/due-date-reminders` — externally triggerable cron (requires `x-admin-token`).
- `POST /api/webhooks/stripe` — Stripe webhook receiver (signature-verified when `STRIPE_WEBHOOK_SECRET` is set).

### Customer (requireAuth, must match `payload.applicationId`)

- `GET  /api/advance/applications/:id` — pull current app + lazy-expire approved offers.
- `GET  /api/advance/auth/me` — pull current app via JWT.
- `GET  /api/advance/applications/:id/messages` — chat thread.
- `POST /api/advance/applications/:id/messages` — customer-sent message.
- `POST /api/advance/applications/:id/delivery` — pick same-day vs 3–5 days.
- `PATCH /api/advance/applications/:id/payout-preference` — set payout method + contact.
- `POST /api/advance/applications/:id/plaid/link-token` — start Plaid Hosted Link, returns `hosted_link_url`.
- `POST /api/advance/applications/:id/plaid/check-completion` — finalize after `?plaid_complete=1`.
- `POST /api/advance/applications/:id/plaid/exchange-token` — legacy iframe flow; still works for any in-flight clients.
- `POST /api/advance/applications/:id/stripe/setup-intent` — start card setup (creates Stripe Customer if needed).
- `POST /api/advance/applications/:id/stripe/save-payment-method` — store card PM + set as customer default.
- `POST /api/advance/applications/:id/payoff` — customer-initiated "I paid it" marker.
- `POST /api/advance/applications/:id/reapply` — tier-aware reapply (blocks `repayment_failed` and `subscription_failed`).
- `POST /api/advance/applications/:id/subscription/checkout-session` — **legacy**, not called by current UI.
- `POST /api/advance/applications/:id/subscription/sync` — **legacy**, pair to above.
- `POST /api/advance/applications/:id/subscription/activate` — **legacy free path** (see Gap #5).

### Admin (requireAdmin)

- `GET  /api/advance/admin/applications` — inbox.
- `GET  /api/advance/admin/applications/:id/bank_snapshot` — full classified bank view.
- `GET  /api/advance/admin/applications/:id/income_analysis` — heuristic "is income stable?" report.
- `GET  /api/advance/admin/applications/:id/payment-method-details` — bank name, routing, last4.
- `GET  /api/advance/admin/applications/:id/referrals` — referral tree summary.
- `PATCH /api/advance/admin/applications/:id/status` — state transitions; on `funded` also creates the Stripe subscription with `billing_cycle_anchor` = repayment date.
- `POST /api/advance/admin/applications/:id/repayment` — schedule custom repayment.
- `POST /api/advance/admin/applications/:id/charge` — manual charge attempt.
- `POST /api/advance/admin/run-due-repayments` — bulk run.

---

## 25. Glossary

- **Tier / ladder** — the credit progression `[25, 50, 75, 100, 150, 200]`, advanced by `repayment_count`.
- **Limit freeze** — 3-month penalty on tier progression triggered by a referral's first-advance default.
- **Master code** — `neworleans`, the always-valid invite code for friend-of-team beta access.
- **Pre-bank flow** — the 7-step onboarding gauntlet that runs while `application.status === 'intake'`.
- **Instant fee** — $5 surcharge for same-day delivery, collected on repayment (not upfront).
- **PFC** — Plaid's `personal_finance_category` code (e.g., `INCOME_WAGES`).
- **Membership** — the $3.99/month Stripe subscription introduced in step 2 of the pre-bank flow.
- **Hosted Link** — Plaid's redirect-based bank-linking UI, used here in lieu of the embedded iframe.

---

*Doc generated 2026-05-25. If you edit something in `node/index.js` that contradicts this page, update this page in the same PR.*
