// StatesFooter is an exported-from-App-via-default component. Easier
// than mounting all of App, we render the legal pages (which all use
// the same StatesFooter via React rendering — but in this codebase the
// footer is local to App.tsx). We'll cover it via a smoke test that
// scans the App module's source for the right links, since the footer
// component isn't independently exported.

import { describe, test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const APP_TSX = fs.readFileSync(
  path.join(__dirname, "..", "..", "App.tsx"),
  "utf8",
);

describe("StatesFooter (App.tsx)", () => {
  test("links to /terms, /privacy, /consent, and the support email", () => {
    // Find the StatesFooter component body.
    const start = APP_TSX.indexOf("const StatesFooter");
    expect(start).toBeGreaterThan(-1);
    const slice = APP_TSX.slice(start, start + 1500);
    expect(slice).toMatch(/href="\/terms"/);
    expect(slice).toMatch(/href="\/privacy"/);
    expect(slice).toMatch(/href="\/consent"/);
    expect(slice).toMatch(/mailto:usa@getbits\.app/);
  });

  test("declares it's available in 36 states", () => {
    const start = APP_TSX.indexOf("const StatesFooter");
    const slice = APP_TSX.slice(start, start + 2000);
    expect(slice).toMatch(/36 states/i);
  });
});

describe("Signup form consent line (App.tsx)", () => {
  // The consent line below the password fields links to all three legal docs.
  // We can't render the full form without a heavy mock harness, so we verify
  // the source has the right links + wording.
  test("links to all three legal documents", () => {
    // Locate the consent line. It's unique by its leading "By submitting".
    const idx = APP_TSX.indexOf("By submitting this form and creating an account");
    expect(idx).toBeGreaterThan(-1);
    const slice = APP_TSX.slice(idx, idx + 1200);
    expect(slice).toMatch(/href="\/terms"/);
    expect(slice).toMatch(/href="\/privacy"/);
    expect(slice).toMatch(/href="\/consent"/);
    expect(slice).toMatch(/Consent to electronic signatures/);
  });
});
