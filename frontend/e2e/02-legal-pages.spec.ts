// E2E coverage for the three legal pages. These are static enough that
// failure means we broke a route, the build, or the document content.

import { test, expect } from "@playwright/test";

test.describe("Legal pages route + content", () => {
  test("/terms renders the document with Section O state subsections", async ({ page }) => {
    await page.goto("/terms");
    await expect(page.locator("h1")).toContainText(/terms/i);
    // Section O is the per-state table. Look for a couple known state subheadings.
    await expect(page.getByRole("heading", { name: "Georgia", level: 3 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Texas", level: 3 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Wyoming", level: 3 })).toBeVisible();
  });

  test("/privacy renders with state-specific privacy callouts", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.locator("h1")).toContainText(/privacy/i);
    // FACTS GLBA notice block
    await expect(page.getByText(/^FACTS$/)).toBeVisible();
    // Should call out California, Vermont, Virginia, Colorado
    await expect(page.getByText(/California \(CCPA/i)).toBeVisible();
  });

  test("/consent renders all 7 sections + the long title", async ({ page }) => {
    await page.goto("/consent");
    await expect(page.locator("h1")).toContainText(/Consent to the Use of Electronic Documents and Signatures/i);
    await expect(page.getByRole("heading", { name: /Definitions/, level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: /I hereby:/, level: 2 })).toBeVisible();
  });

  test("legal pages link back to the homepage", async ({ page }) => {
    for (const route of ["/terms", "/privacy", "/consent"]) {
      await page.goto(route);
      const back = page.locator('a:has-text("Back to Advance")').first();
      await expect(back).toHaveAttribute("href", "/");
    }
  });
});
