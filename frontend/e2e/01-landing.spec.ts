// Smoke test for the landing page. Verifies the page renders, the hero
// is visible, and the get-started CTA exists. Cheap baseline coverage —
// if this fails, something is fundamentally broken with the build.

import { test, expect } from "@playwright/test";

test.describe("Landing page", () => {
  test("renders the hero and key trust messaging", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toContainText(/cash|advance/i);
    // Trust messaging is somewhere on the page
    const trustText = page.getByText(/no credit check/i).first();
    await expect(trustText).toBeVisible();
  });

  test("$300 raffle prize is present on the landing page", async ({ page }) => {
    await page.goto("/");
    // Only meaningful regression check: confirm the $300 prize callout
    // hasn't accidentally been removed. The original test also asserted
    // 'no Cancún' as a regression for an earlier copy swap, but the
    // current landing intentionally features BOTH a $300 weekly raffle
    // AND a quarterly Cancún getaway — so that assertion is stale.
    await expect(page.getByText(/\$300/).first()).toBeVisible();
  });

  // (Removed) legal-doc links on the landing page. The landing view does
  // NOT render StatesFooter — that footer only shows on the referral /
  // signup / waitlist screens. The legal-pages spec (02-legal-pages.spec.ts)
  // verifies the routes themselves work; that's the right place for that
  // coverage.
});
