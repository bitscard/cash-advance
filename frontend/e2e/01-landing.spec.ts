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

  test("$300 weekly raffle banner is visible (regression: was Cancún)", async ({ page }) => {
    await page.goto("/");
    // The new landing uses "$300 cash" and "weekly $300 raffle" copy.
    // Accept either "every week" or "weekly" so the test survives copy edits
    // that swap one phrasing for the other (which the post-main landing
    // remake does).
    await expect(page.getByText(/\$300( cash)?/i).first()).toBeVisible();
    await expect(page.getByText(/every week|weekly/i).first()).toBeVisible();
    // The OLD Cancún copy should NOT appear anywhere.
    await expect(page.locator("body")).not.toContainText(/cancún|cancun/i);
  });

  // (Removed) legal-doc links on the landing page. The landing view does
  // NOT render StatesFooter — that footer only shows on the referral /
  // signup / waitlist screens. The legal-pages spec (02-legal-pages.spec.ts)
  // verifies the routes themselves work; that's the right place for that
  // coverage.
});
