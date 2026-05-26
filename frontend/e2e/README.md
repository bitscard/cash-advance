# Playwright E2E tests

These tests run against a live frontend dev server. Playwright's config
auto-boots `npm run dev` on `localhost:3000`.

## Running locally

```bash
# Install browsers (one-time)
npm run e2e:install

# Run the suite (all projects: chromium, webkit, iphone)
npm run e2e

# Open the Playwright UI to debug interactively
npx playwright test --ui

# Run just one project
npx playwright test --project=chromium
npx playwright test --project=iphone
```

## What's covered

| Spec                       | Coverage |
|----------------------------|----------|
| `01-landing.spec.ts`       | Landing hero, $300 weekly raffle banner (regression for the Cancún → weekly-raffle copy swap), footer legal links |
| `02-legal-pages.spec.ts`   | `/terms`, `/privacy`, `/consent` routes serve correct content; state subsections in Section O of T&Cs |
| `03-mobile-viewport.spec.ts` | iPhone 13 viewport rendering — no horizontal overflow, hero visible, legal pages readable |

## What's NOT covered yet (and why)

Full-funnel signup → onboarding → Plaid → admin approval tests would
need the backend running locally with the Docker Postgres test database.
Right now those live as backend integration tests
(`node/__tests__/integration/`), which exercise the same endpoints
through supertest. End-to-end coverage of the UI funnel is a follow-up
once we have a docker-compose for the full stack (frontend + backend +
Postgres) — see plan section "Phase 5 — Playwright E2E".

## Plaid + Stripe in E2E

We deliberately do NOT hit live Plaid/Stripe in E2E. The current specs
only cover routes and content that don't require either. When we add
funnel E2E, we'll either:

1. Run the backend with `PLAID_ENV=sandbox` + sandbox creds and let
   Plaid's test bank flow through; or
2. Mount a mock backend that intercepts the Plaid/Stripe endpoints.

Option 2 is more reliable in CI; option 1 is more realistic.
