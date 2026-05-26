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
    // The new copy mentions $300 and weekly
    await expect(page.getByText(/\$300 cash/i).first()).toBeVisible();
    await expect(page.getByText(/every week/i).first()).toBeVisible();
    // The OLD Cancún copy should NOT appear anywhere
    await expect(page.locator("body")).not.toContainText(/cancún|cancun/i);
  });

  test("footer links to terms / privacy / consent", async ({ page }) => {
    await page.goto("/");
    const footer = page.locator("text=/Available in 35 states/i").first();
    await footer.scrollIntoViewIfNeeded();
    await expect(page.locator('a[href="/terms"]').first()).toBeVisible();
    await expect(page.locator('a[href="/privacy"]').first()).toBeVisible();
    await expect(page.locator('a[href="/consent"]').first()).toBeVisible();
  });
});
