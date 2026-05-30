# Stripe-only architecture: migration plan

Replace Plaid with Stripe Financial Connections so users link their bank exactly once, and that single link powers all three things we currently do with two separate bank connections + a card:

1. Income verification (transaction reads)
2. ACH payout to user's bank (via Connect Express `external_account`)
3. ACH pull from user's bank on repayment day (via platform `PaymentMethod`)

This document is the plan only — no code changes yet. Review and approve before any implementation PR opens.

---

## 1. Current architecture (what we're moving away from)

```
Signup flow today
─────────────────
Step 2: Receive money → picks ACH → triggers Stripe Connect onboarding
        ↓
        Stripe Connect Express hosted form
        ↓ user adds bank ───────────────────────→  external_account (payout dest)
        ↓ user verifies identity

Step 4: Card + membership → Stripe Elements ─────→  card PaymentMethod (repayment debit)

Step 6: Bank verification → Plaid Hosted Link ───→  access_token (income verification)
```

Three bank-related linkages, three separate trust steps. Repayment debit goes through CARD (2.9% + $0.30 fee). Plaid is the primary data source for income classification.

## 2. Target architecture

```
Signup flow target
──────────────────
Step 2: Receive money → picks ACH (default)

Step 4: Bank link via Stripe Financial Connections (ONE link)
        ↓ Stripe FC hosted form (Plaid-powered under the hood)
        ↓
        ├─→ FinancialConnectionsAccount (transactions API for income classification)
        ├─→ us_bank_account PaymentMethod (chargeable for repayment debit)
        └─→ bank_account token (attached to Connect Express as external_account)

Step 5: Delivery speed (unchanged)

Step 6: Identity verification only (Stripe Connect Express hosted form)
        ↓ user confirms pre-filled name/DOB/SSN-4, enters address
        ↓ NO BANK STEP — bank pre-attached from Step 4
```

One bank link, three capabilities. Plaid gone. Card optional.

## 3. Stripe primitives we'll use

| Primitive | Purpose | Stripe API |
|---|---|---|
| **FinancialConnectionsSession** | Hosted bank-link flow | `stripe.financialConnections.sessions.create()` |
| **FinancialConnectionsAccount** | Verified bank account with capabilities | Returned by FC session |
| **us_bank_account PaymentMethod** | Chargeable bank PM on platform Customer | Auto-created when FC PM permission requested |
| **Connect external_account** | Payout destination on Connect Express account | `stripe.accounts.update()` or `createExternalAccount()` |
| **FC Transactions API** | Read transactions for income verification | `stripe.financialConnections.transactions.list()` |

## 4. Stripe FC permissions we'll request

When creating the FC session:

```javascript
permissions: [
  'payment_method',  // creates us_bank_account PM (chargeable)
  'transactions',    // enables transaction reads for income verification
  'balances',        // optional but useful for overdraft checks
]
```

`ownership` and `account_numbers` are optional — we don't need raw routing/account numbers since the PaymentMethod abstraction covers everything we do.

## 5. Migration phases

Three phases. Each lands as its own PR. Phase 1 is the bulk of new code. Phases 2 and 3 are cleanup.

### Phase 1 — Add Stripe FC alongside existing flow (parallel deployment)

Goal: ship FC as an option without breaking anything. New signups can opt into FC; existing signups still use Plaid.

**Backend changes**

- New endpoint `POST /api/advance/applications/:id/stripe/fc/create-session`
  - Creates a FinancialConnectionsSession with permissions above
  - Returns `client_secret` for the frontend to launch the flow
- New endpoint `POST /api/advance/applications/:id/stripe/fc/complete`
  - Called from frontend with the FC session result
  - Stores the linked account info on the application:
    - `stripe_fc_account_id` (already a column)
    - `stripe_bank_pm_id` (new column — the us_bank_account PM)
  - Detaches/marks Plaid integration unused for this application
- New helper: `fetchFcTransactions(accountId, startDate, endDate)` — wraps `stripe.financialConnections.transactions.list()`
- New helper: `attachBankToConnectAccount(connectAccountId, bankToken)` — extracts the bank account token from the FC payment method, attaches as external_account

**Backend changes — income classification**

- New module `node/incomeClassification.js` extracted from `index.js`
  - `classifyTransaction()` already pure — moves as-is
  - `isExcludedByPFC()` already pure — moves as-is
  - `buildRefundSet()` already pure — moves as-is
- New shim `node/fcTransactionAdapter.js`
  - Takes FC transaction objects, returns Plaid-shaped transaction objects
  - Maps Stripe's MCC + category fields to Plaid's `personal_finance_category` format
  - This is the only NEW classification code we write — everything else stays
- `/admin/bank_snapshot` endpoint: accepts BOTH `access_token` (Plaid) and `stripe_fc_account_id` (FC); picks whichever is set on the application
- `/admin/income_analysis`: same dual-path handling

**Frontend changes**

- Step 4 (Card + membership): becomes "Connect your bank or add a card"
  - Default option: "Connect bank for lower fees" → launches Stripe FC via `stripe.confirmFinancialConnectionsAccount()`
  - Secondary: "Use a debit card instead" → existing Stripe Elements flow
- Step 6 (Bank verification): skipped if `stripe_fc_account_id` is set
- Add a small status indicator showing which path the user is on (bank vs card) in the dashboard

**Database changes**

- New column: `stripe_bank_pm_id TEXT` on `applications` — the chargeable us_bank_account PM
- `stripe_fc_account_id` already exists (legacy of an earlier exploration)
- All existing columns stay for backward compat

**Connect Express integration changes**

- In `/stripe/connect/onboarding-link`:
  - If `stripe_bank_pm_id` exists, mint a bank_account token from the FC payment method
  - Pre-attach as external_account when creating the Connect Express account
  - The Connect hosted form skips the "add bank" step (user only confirms identity)

**Repayment cron**

- No code changes — existing logic in `run-due-repayments` already prefers `stripe_payment_method_id` over `stripe_card_pm_id`. We just need to start populating the bank PM column. Update one variable name from `stripe_payment_method_id` to `stripe_bank_pm_id` for clarity.

**Tests**

- New integration test: `stripeFc.test.js` covering session creation, completion, transaction fetching
- Update `stripeConnect.test.js` for the new pre-attached external_account path
- Update `charge.test.js` to assert ACH PM is preferred over card

**What stays**

- Plaid integration (entire codepath)
- Card option (just no longer the default)
- All existing tests

**What you'll need to do**

- Enable **Stripe Financial Connections** in Stripe Dashboard → Connect → Financial Connections → Get started (~5 min)
- Confirm Stripe FC pricing applies to your account ($1.50/account/month for transactions + per-call fees)
- Decide whether to default new users to FC or card (recommend FC for cost savings)

### Phase 2 — Default new signups to FC, deprecate Plaid

Goal: stop sending new users through Plaid. Keep code paths for existing users.

**Backend changes**

- Add env var `BANK_LINK_PROVIDER` with values `plaid` or `fc` (default `fc` after this phase)
- Signup creates the link based on this flag
- Existing Plaid-linked users keep working (we still call Plaid APIs for them)
- Add a "switch to FC" button in the user dashboard for existing Plaid users (optional)

**Frontend changes**

- Remove the "Use card instead" option at Step 4 (FC becomes the only path)
- Step 6 removed entirely for new signups (only existing Plaid users see it on next login if they need to re-link)

**Tests**

- Remove tests that assume Plaid is the only path
- Add tests for the FC-only flow

**Risk mitigation**

- Feature flag the cutover; can revert in seconds via env var
- Monitor approval rates between cohorts for 2 weeks
- If FC's transaction data is materially worse for our classification, hold here

### Phase 3 — Remove Plaid

Goal: remove Plaid from the stack entirely.

**Pre-conditions**

- All in-progress / active users have either moved to FC or completed their advance lifecycle
- Or: we migrate stragglers by force (block their dashboard until they re-link via FC)

**Code removals**

- Drop `plaid` SDK from `node/package.json`
- Drop `react-plaid-link` from `frontend/package.json`
- Remove Plaid env vars from Render config
- Delete routes: `/plaid/link-token`, `/plaid/check-completion`, `/plaid/exchange-token`
- Delete columns: `access_token`, `item_id` (or leave nullable for historical lookup)
- Remove `frontend/oauth-return.html`
- Drop `vercel.json` rewrite for `/oauth-return`
- Remove all `plaid_*` state on frontend
- Remove all `PLAID_*` env var checks
- Delete Plaid-related tests
- Drop `node/dataUtilities.js` (or whatever Plaid-shape transforms exist)

**Documentation**

- Update `SYSTEM_DESIGN.md` to reflect Stripe-only architecture
- Update `.env.example` files
- Add a note in the README about the migration date

## 6. Income classification: detailed mapping

Plaid's transaction shape vs Stripe FC's shape (the only non-trivial part of this migration):

| Plaid field | Stripe FC field | Notes |
|---|---|---|
| `personal_finance_category.primary` | Not directly available | Map from MCC + description |
| `personal_finance_category.detailed` | Not available | Reuse Plaid's PFC taxonomy in our shim |
| `merchant_name` | `description` (parsed) | Stripe doesn't normalize merchant names — we'll need fuzzy matching |
| `amount` (positive = outflow) | `amount` (sign convention may differ) | Verify in sandbox |
| `iso_currency_code` | `currency` | Same |
| `transaction_id` | `id` | Same |
| `date` | `transacted_at` | Format conversion |
| `category` (legacy) | n/a | Already deprecated in Plaid — don't use |

The shim approach: write `fcTransactionAdapter.js` that takes FC transactions and returns Plaid-shaped objects. Then the existing classification logic (`classifyTransaction`, `isExcludedByPFC`, etc.) runs unchanged.

Risk: FC's data quality for transaction categorization may be different from Plaid's. We'll need to spot-check 50-100 sandbox transactions during Phase 1 to validate.

## 7. Cost analysis

### Plaid today

Estimated based on current usage:
- Auth (per call): ~$0.30 (not currently in our stack)
- Transactions (per call): ~$0.30 per transaction fetch
- Per-item monthly fee: $0 (free tier for low volume)
- Total for 100 active users: ~$30/month estimated

### Stripe FC after migration

- Per-account monthly fee for transactions: ~$1.50
- Per-call fees: included
- Total for 100 active users: ~$150/month

**Net cost: Stripe FC is more expensive per account, but absorbs the per-call costs.** At low volume Plaid is cheaper; at scale they converge. The win is architectural, not financial.

### Repayment fees

This is where the real savings show up:
- Card-based debit: 2.9% + $0.30 per repayment
- ACH (us_bank_account) debit: 0.8% capped at $5

On 100 users × 2 advances/month × avg $50: card costs $206/mo, ACH costs $80/mo. **$126/mo savings on repayment fees alone**, dwarfs the FC monthly cost difference.

Net: switching saves money once you have ~100 active users.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| FC's transaction categorization is worse than Plaid's | Run both in parallel during Phase 1; spot-check 50+ classifications; hold if accuracy drops materially |
| Users abandon at Stripe FC's hosted form | Add tracking on FC session creation vs completion; hold Phase 2 if completion rate drops |
| Connect Express pre-attached external_account doesn't actually skip the bank step in Stripe's hosted form | Verify with a prototype branch before committing to Phase 1 — this is the single biggest UX assumption |
| Stripe FC outage | Plaid is still in the code during Phase 1 and 2; can flip back via env var |
| Existing Plaid users get confused by mid-flight migration | Phase 2 keeps existing Plaid users on Plaid; only new signups see FC |
| Production DB migration adds nullable column but old code reads it as NOT NULL | All new columns are nullable from the start; no breaking schema changes |

## 9. Testing strategy

Each phase ships with:

| Test layer | What |
|---|---|
| Unit | New `fcTransactionAdapter` against snapshot transactions; classification logic unchanged |
| Integration | New FC session + completion endpoints; updated Connect Express path; ACH-debit cron |
| Manual smoke | Real bank account in Stripe sandbox; end-to-end signup → bank link → admin approve → mark funded → wait for repayment day → verify debit hits |

E2E Playwright will need updates to the bank-link step. Specifically: the test that currently mocks Plaid Hosted Link will need to mock Stripe FC's hosted form (or skip into a stubbed `?fc_complete=1` return).

## 10. Rollback plan

- Phase 1: revert PR; no data migration. Risk-free.
- Phase 2: flip `BANK_LINK_PROVIDER=plaid` env var; new signups go through Plaid again. Takes 1 minute.
- Phase 3: irreversible without re-adding Plaid integration. By this point we should have months of FC-only data confirming it works.

## 11. Order of operations (the actual plan)

This is the proposed sequence of PRs:

1. **PR A: Phase 1 — Add FC alongside Plaid** (this branch, eventually)
   - All Phase 1 work as listed above
   - Test thoroughly in Vercel/Render previews before merge
   - Ship with FC as opt-in (default still Plaid)
2. **PR B: Default new signups to FC** (Phase 2 first half)
   - Flip the default to FC
   - Keep Plaid code paths
3. **PR C: Stop offering Plaid for new signups** (Phase 2 second half)
   - Remove the "use card" alternative
   - Cut Step 6 for FC users (Plaid users keep it as a re-link path if needed)
4. **PR D: Drop Plaid entirely** (Phase 3)
   - After all active users have either completed or migrated
   - Code/dependency/env-var cleanup

Each phase pauses for 1-2 weeks in production before the next ships. Total migration time: ~6 weeks.

## 12. Open questions (need decisions before PR A starts)

1. **Default option at Step 4 in Phase 1: FC or card?**
   Recommend **card stays default initially** so the parallel path is opt-in. Less risk while we validate FC behavior. Flip in Phase 2.

2. **Existing Plaid users: do we migrate them?**
   Recommend **no force-migration**. They naturally cycle off after their final advance lifecycle. New advances they take after FC ships will use whichever path was active when they signed up. After all existing users have completed or churned, Plaid code can come out.

3. **What to do about the Connect Express bank pre-attach?**
   This is the single largest unknown. Stripe docs say it's possible but the hosted onboarding behavior depends on capabilities/requirements at the time of account creation. Recommend a **5-day prototype spike** before committing to the rest of Phase 1 — just stand up an Express account with a pre-attached bank in test mode and verify the hosted onboarding skips the bank step.

4. **Pricing approval**
   Need to confirm with Stripe rep (or their pricing page) that FC pricing applies as expected. Sometimes there are platform-specific discounts.

## 13. What this document is NOT

- Not a code change. Nothing happens until you approve this plan.
- Not exhaustive on UI design — the picker at Step 4 needs visual design that's not specified here.
- Not a marketing plan — if you tell users "now use bank instead of card for repayment," there's a comms angle. Outside scope.
- Not a regulatory analysis — FC and Plaid both raise the same consumer-protection / GLBA / CCPA / state privacy considerations. Same legal-review caveat applies.

---

## Approve to proceed

Reply with one of:

- **Approve the plan as-is** → I open the Phase 1 PR (significant code change, ~500-800 lines)
- **Approve with changes** → tell me what to adjust
- **Spike first** → I write a 50-line prototype for the Connect-Express-pre-attach piece to validate the single biggest UX assumption before committing to the full plan

Recommend the **spike first** path. The pre-attach behavior is the make-or-break detail and is the easiest thing to prove out cheaply.
