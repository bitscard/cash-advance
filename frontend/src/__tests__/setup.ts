// Loaded by Vitest before each test file. Adds the jest-dom matchers,
// stubs window APIs the app relies on (location, history, alert), and
// installs a global fetch mock that's resettable per-test.

import "@testing-library/jest-dom";
import { afterEach, beforeEach, vi } from "vitest";

// Reset every spy between tests so one test's mock state can't leak.
afterEach(() => {
  vi.restoreAllMocks();
  // Clear localStorage / sessionStorage so per-test state is fresh.
  try { window.localStorage.clear(); } catch {}
  try { window.sessionStorage.clear(); } catch {}
});

// Components routinely call `fetch` directly. Default to a stub that
// throws an obvious error so tests are forced to opt in explicitly via
// `vi.spyOn(global, 'fetch').mockResolvedValue(...)`.
beforeEach(() => {
  if (!("fetch" in globalThis)) {
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(() => {
      throw new Error("fetch was called in a test without being mocked");
    });
  }
});
