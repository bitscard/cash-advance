import { defineConfig, devices } from "@playwright/test";

// E2E config — runs the full app at http://localhost:3000 (Vite dev
// server). Backend has to be running separately at the URL the frontend's
// Vite proxy points at (default: API_HOST or the production Render URL).
// CI sets BASE_URL to a preview URL when running against a deployment.

const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Mobile Safari is the highest-risk surface for this app (Plaid
      // OAuth, viewport edge cases). Run a webkit project too.
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "iphone",
      use: { ...devices["iPhone 13"] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_NO_WEBSERVER
    ? undefined
    : {
        command: "npm run dev",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
