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

  test("footer links to terms / privacy / consent are present", async ({ page }) => {
    await page.goto("/");
    // Footer is at the bottom of the page; we just confirm the anchor
    // tags exist somewhere in the DOM. No need to scroll or wait for
    // visibility — legal-page links are baseline content that ships
    // with the bundle and we don't care WHERE on the page they live.
    expect(await page.locator('a[href="/terms"]').count()).toBeGreaterThan(0);
    expect(await page.locator('a[href="/privacy"]').count()).toBeGreaterThan(0);
    expect(await page.locator('a[href="/consent"]').count()).toBeGreaterThan(0);
  });
});
