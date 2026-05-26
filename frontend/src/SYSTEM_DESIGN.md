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
| **Plaid for income verification, Stripe for money movement** | Plaid handles the read-only bank connection; Stripe handles ACH debits, card fallback, and now the $3.99/mo subscription via Checkout. |
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

Stored in `applications.status`. The label map lives at `App.tsx:148`.

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
   repayment_scheduled
              │
   ┌──────────┼──────────────┐
   │          │              │
 repaid   repayment_failed   │
              │              │
          written_off  ◄─────┘
```

Transitions are admin-driven through `PATCH /api/advance/admin/applications/:id/status`, with a few automated edges:

- `approved → expired`: lazy expiry; if `GET /applications/:id` sees `status='approved' && !delivery_type && offer_expires_at < now`, it transitions in-place.
- `approved → funded`: when admin marks `funded`, the same handler auto-schedules `repayment = requested_amount + (instant ? 5 : 0)`, due on `payday`.
- `funded → repayment_scheduled`: happens on `setRepayment`.
- `funded → written_off` with `repayment_count = 0` and `referred_by` set: also writes `limit_freeze_until = today + 3 months` to the referrer (`saveLimitFreeze`) and posts a system message to that referrer's thread.

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

### 8.4 7-step pre-bank onboarding

After signup the customer is gated by:

```ts
const preBankActive =
  application.status === "intake" &&
  (application.subscription_status === "active" ||
   application.subscription_status === "pending_payment") &&
  !application.plaid_connected;
```

Steps render in this order (`App.tsx:1429+`); each has its own gate so a refresh always returns to the right place.

| # | Step | Gate | What it does |
| --- | --- | --- | --- |
| 1 | Benefits | `!benefitsSeen` | Pitches "no credit check, no interest, no collections, weekly raffle." Pure presentation. |
| 2 | **Membership ($3.99/mo)** | `subscription_status !== "active"` | Server creates a Stripe Checkout subscription session; user is redirected to Stripe; on success `?subscription=success&session_id=…` triggers `/subscription/sync` to flip `subscription_status` to `active`. |
| 3 | Receive money | `!payout_methods \|\| !payout_contact` | Single-select PayPal / Cash App / Zelle + handle, with a confirmation block. |
| 4 | Trust ladder | `!trustScreenSeen` | Static screen showing $25 → $200 milestones and how trust building works. |
| 5 | Backup card | `!stripe_card_saved` | Stripe `CardElement` + `SetupIntent` → saves `stripe_card_pm_id`. |
| 6 | Delivery speed | `!delivery_type` | Same-day (+$5 at repayment) vs 3–5 days (free). |
| 7 | Bank verification | otherwise | Plaid Hosted Link. On `?plaid_complete=1` return, calls `/plaid/check-completion` to finalize. |

After step 7 the app is `reviewing` and gets out of `preBankActive`.

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

Added recently. The customer must subscribe before they can pick a payout method, link a bank, or take an advance.

### Backend (`node/index.js`)

| Endpoint | What it does |
| --- | --- |
| `POST /api/advance/applications/:id/subscription/activate` | Legacy free-activation path. **No longer used by the new signup flow** — left in place for compatibility. Flips to `active` (eligible) or `waitlisted` (ineligible). |
| `POST /api/advance/applications/:id/subscription/checkout-session` | Creates (or reuses) the Stripe Customer and returns a **Checkout Session URL** in subscription mode, $3.99/mo, inline `price_data` so no Stripe Dashboard price ID is required. Success URL: `${origin}/?subscription=success&session_id={CHECKOUT_SESSION_ID}`. |
| `POST /api/advance/applications/:id/subscription/sync` | Called by the frontend on return from Stripe. Retrieves the session, asserts customer match, asserts `sub.status ∈ {active, trialing}`, flips `subscription_status` to `active`, stores `subscription_id` + `subscription_next_billing`, writes a system message. |

### Signup-time change

Eligible signups now land on `subscription_status='pending_payment'` instead of `'active'` (`node/index.js:580`). Waitlisted users still land on `'waitlisted'`. This is what makes the new "Step 2 — Membership" gate fire.

### Frontend (`frontend/src/App.tsx`)

- A `useEffect` watches `?subscription=success&session_id=…` on mount; if present, calls `/subscription/sync` and strips the query params via `history.replaceState`.
- `startMembershipCheckout()` POSTs to `/subscription/checkout-session` and does `window.location.href = data.url`.
- The Membership step (`App.tsx:1475+`) renders only when `preBankActive && subscription_status !== "active"`.

### What's not (yet) wired

- **Webhook handling** for `customer.subscription.updated`, `invoice.payment_failed`, etc. Today we only learn the subscription is alive at first-charge sync time. If a renewal fails, nothing in our DB changes automatically — we'd find out by Stripe email until a webhook is added.
- **Cancellation UX.** No in-app "cancel membership" button. The customer would do it from the Stripe billing portal (not wired) or by emailing support.

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

There's **one** real background job today: due-date reminders.

```js
setInterval(sendDueDateReminders, 60 * 60 * 1000);  // hourly
setTimeout(sendDueDateReminders, 30_000);           // also 30s after boot
```

`sendDueDateReminders` queries apps with `repayment_due_date = CURRENT_DATE + 2`, status ∈ `{funded, repayment_scheduled}`, `due_date_reminder_sent_at IS NULL`. For each, it tags the user in Mailchimp (`due_date_reminder`) and stamps `due_date_reminder_sent_at = NOW()` so we never double-send. Also exposed as `POST /api/cron/due-date-reminders` for external schedulers (Render cron, GitHub Actions, etc.) if you'd rather not rely on an in-process timer.

Other cron-shaped operations (`run-due-repayments`) are **admin-triggered**, not scheduled. There's no membership-billing cron because Stripe handles that itself.

---

## 18. Mailchimp tagging

Single function `addToMailchimp(name, email, state, tags)`. Always upserts (idempotent on "Member Exists"). Tags fire at:

| Event | Tags |
| --- | --- |
| Signup, eligible state | `welcome` |
| Signup, ineligible state | `welcome`, `waitlist` |
| Bank connected → reviewing | `application_under_review` |
| Status → `approved` | `approved` |
| Status → `denied` | `denied` |
| 2 days before due date | `due_date_reminder` |

This is also where the marketing team wires drip campaigns — keep the tag names stable.

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

**There is no test suite.** `node/package.json` literally has:

```json
"test": "echo \"Error: no test specified\" && exit 1"
```

The frontend has no `*.test.*` / `*.spec.*` / `__tests__/` files either.

### What we lean on instead

| Mitigation | What it actually buys you |
| --- | --- |
| TypeScript on the frontend | Catches shape mismatches and obvious typos; CI runs `tsc` via `npm run build`. |
| Manual smoke through Plaid sandbox | Most flows are exercised end-to-end before merge. |
| Lazy expiry / idempotent crons | Bugs in time-based code are recoverable by re-running. |
| Server-side enforcement of every rule | The React app can't be tricked into a state the backend wouldn't allow. |

### Recommended test additions (in order)

1. **Unit:** `isPlausibleSSN`, `classifyTransaction` (PFC + keyword layers — no AI), `calcSourceAccrued`, the reapply tier math, `checkOverdraft` decision tree. These are all pure functions or close to it.
2. **Integration:** Express handlers with a test Postgres database (`pg-mem` or a docker-compose Postgres). Cover signup → subscription → Plaid mock → admin approval → funded → repayment success and the two failure variants (overdraft skip, card fallback).
3. **Contract:** Snapshot a `publicApp(row)` return for each status. This is the most regression-prone surface — any new column needs to land here.
4. **E2E:** Playwright against a sandbox stack. Just the four critical paths: signup-to-bank-link, approve-to-funded, mark-as-paid happy path, reapply.

---

## 22. Configuration & deployment

### Backend env vars

| Var | Required? | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Postgres connection string. `ssl: { rejectUnauthorized: false }` is hardcoded. |
| `JWT_SECRET` | Yes (prod) | Falls back to `dev_jwt_secret_change_in_production` in dev. |
| `ADMIN_TOKEN` | Yes (prod) | If unset, `requireAdmin` always passes — dev only. |
| `STRIPE_SECRET_KEY` | Yes | Powers cards, charges, subscriptions. |
| `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` | Yes | `PLAID_ENV` defaults to `sandbox`. |
| `PLAID_PRODUCTS`, `PLAID_COUNTRY_CODES`, `PLAID_REDIRECT_URI`, `PLAID_ANDROID_PACKAGE_NAME`, `SIGNAL_RULESET_KEY` | Optional | Plaid quickstart leftovers, only some are still used. |
| `ANTHROPIC_API_KEY` | Yes (for income classification) | Without it, layer 3 of classification returns `uncertain` for everything. |
| `MAILCHIMP_API_KEY`, `MAILCHIMP_LIST_ID`, `MAILCHIMP_SERVER` | Yes (for tagging) | If unset, tagging silently no-ops. |
| `TEST_SSNS` | Optional | Comma-separated 9-digit SSNs that bypass plausibility + dupe checks. |
| `APP_PORT` | Optional | Defaults to 8000. |

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

These are documented here so they're not lost — every one is a real production risk before scale.

| # | Gap | Impact | Owner / status |
| --- | --- | --- | --- |
| 1 | **No Stripe webhook handler** | Subscription renewal failures, disputes, refunds, and cancellations don't update our DB. We'd find out by email. | Open. Recommend `POST /api/stripe/webhook` with at minimum `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`. |
| 2 | **No in-app subscription cancel** | Customers have to email or use Stripe billing portal (not wired). | Open. Plug the billing portal once the webhook is in place. |
| 3 | **No automated test suite** | Regressions ride to prod on type checks + manual smoke. | Open. See §21 for staged plan. |
| 4 | **In-process cron** | If Render restarts at the wrong minute, a day of reminders could be missed (idempotency saves us from double-sends, not from skips). | Move to Render cron jobs or an external trigger hitting `/api/cron/due-date-reminders`. |
| 5 | **Free `/subscription/activate` endpoint still mounted** | Anyone with a JWT can flip themselves to `active` without paying. Currently unused by the UI but reachable. | Either gate it behind `requireAdmin` or remove. |
| 6 | **In-memory AI classification cache** | Per-process; a horizontal scale-up multiplies Anthropic calls. | Acceptable for today's volume; move to Redis if/when we shard. |
| 7 | **PLAID_ENV defaults to sandbox** | Prod misconfig would silently approve sandbox accounts as real income. | Make `PLAID_ENV=production` an explicit prod requirement (assert at boot). |
| 8 | **`ADMIN_TOKEN` unset = open admin** | Useful in dev, dangerous if the env var ever drops in prod. | Assert at boot in production. |
| 9 | **Single `applications` row per user** | "Reapply" mutates the same row instead of creating a new one. History is reconstructed from `messages`. | Acceptable today; if we ever want true loan-by-loan analytics, introduce a `loans` child table. |

---

## 24. Quick reference: endpoint index

### Public (no auth)

- `GET  /api/advance/referral/:code` — validate an invite code.
- `POST /api/advance/applications` — signup.
- `POST /api/advance/auth/login` — email + password → JWT.
- `POST /api/waitlist` — Mailchimp waitlist tag (no DB row).
- `POST /api/cron/due-date-reminders` — externally triggerable cron.

### Customer (requireAuth, must match `payload.applicationId`)

- `GET  /api/advance/applications/:id` — pull current app + lazy-expire approved offers.
- `GET  /api/advance/applications/:id/messages` — chat thread.
- `POST /api/advance/applications/:id/messages` — customer-sent message.
- `POST /api/advance/applications/:id/subscription/checkout-session` — start Stripe Checkout.
- `POST /api/advance/applications/:id/subscription/sync` — confirm after Stripe return.
- `POST /api/advance/applications/:id/subscription/activate` — **legacy free path** (see Gap #5).
- `POST /api/advance/applications/:id/delivery` — pick instant vs standard.
- `PATCH /api/advance/applications/:id/payout-preference` — set payout method + contact.
- `POST /api/advance/applications/:id/plaid/link-token` — start Plaid Hosted Link.
- `POST /api/advance/applications/:id/plaid/check-completion` — finalize after `?plaid_complete=1`.
- `POST /api/advance/applications/:id/stripe/setup-intent` — start card setup.
- `POST /api/advance/applications/:id/stripe/save-payment-method` — store card PM.
- `POST /api/advance/applications/:id/payoff` — customer-initiated "I paid it" marker.
- `POST /api/advance/applications/:id/reapply` — tier-aware reapply.

### Admin (requireAdmin)

- `GET  /api/advance/admin/applications` — inbox.
- `GET  /api/advance/admin/applications/:id/bank_snapshot` — full classified bank view.
- `GET  /api/advance/admin/applications/:id/income_analysis` — heuristic "is income stable?" report.
- `GET  /api/advance/admin/applications/:id/payment-method-details` — bank name, routing, last4.
- `GET  /api/advance/admin/applications/:id/referrals` — referral tree summary.
- `PATCH /api/advance/admin/applications/:id/status` — state transitions w/ optional note.
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
