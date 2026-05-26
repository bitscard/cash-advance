// Mobile viewport rendering — Playwright's `iphone` project covers the
// iOS Safari rendering surface that's been the source of most Plaid
// OAuth regressions. We just need to confirm the landing page and legal
// pages render without horizontal scroll and have the hero / CTA visible.

import { test, expect } from "@playwright/test";

// This file is exercised by every Playwright project (chromium, webkit,
// iphone). The iphone project gives us the iOS Safari viewport which is
// what we actually care about for mobile coverage. Other projects just
// confirm desktop layout still renders within the viewport.

test.describe("Mobile viewport rendering", () => {
  test("landing page hero renders without horizontal overflow", async ({ page }) => {
    await page.goto("/");
    const heroH1 = page.locator("h1").first();
    await expect(heroH1).toBeVisible();

    // Confirm body width matches viewport (no horizontal scroll)
    const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
    const innerWidth = await page.evaluate(() => window.innerWidth);
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
  });

  test("legal pages render readable text on mobile", async ({ page }) => {
    await page.goto("/terms");
    await expect(page.locator("h1")).toBeVisible();
    // Confirm at least one body paragraph is visible
    await expect(page.locator("p").first()).toBeVisible();
  });
});
