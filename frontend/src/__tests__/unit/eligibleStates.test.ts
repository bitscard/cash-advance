// Verifies the eligible-state list is consistent across:
//   - the frontend ELIGIBLE_STATES Set (App.tsx)
//   - the backend ELIGIBLE_STATES Set (node/index.js)
//   - the T&Cs STATE_PROVISIONS table (TermsPage.tsx)
//   - the Privacy Policy list (PrivacyPage.tsx)
//
// Each file owns its own copy because they live in different runtime
// boundaries (Node vs browser). The risk: someone updates one and forgets
// the others. These tests catch that drift.

import { describe, test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..", "..", "..");

// Pulls the list of state names out of an arbitrary file by matching
// the ELIGIBLE_STATES Set literal specifically. Brittle by design — if
// the format ever changes we want this to break loudly.
function extractStateSet(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  const match = src.match(/ELIGIBLE_STATES\s*=\s*new Set\(\[([^\]]+)\]\)/);
  if (!match) throw new Error(`No ELIGIBLE_STATES Set literal found in ${file}`);
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]).sort();
}

function extractStateProvisions(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  const matches = [...src.matchAll(/state:\s*["']([^"']+)["']/g)];
  return matches.map((m) => m[1]).sort();
}

function extractPrivacyList(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  // PrivacyPage's ELIGIBLE_STATES is a const array literal
  const match = src.match(/ELIGIBLE_STATES\s*=\s*\[([^\]]+)\]/);
  if (!match) throw new Error(`No ELIGIBLE_STATES literal in ${file}`);
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]).sort();
}

describe("Eligible state list consistency across files", () => {
  test("backend (node/index.js) and frontend (App.tsx) lists match", () => {
    const backend = extractStateSet(path.join(ROOT, "node", "index.js"));
    const frontend = extractStateSet(path.join(ROOT, "frontend", "src", "App.tsx"));
    expect(frontend).toEqual(backend);
  });

  test("App.tsx and TermsPage STATE_PROVISIONS match", () => {
    const frontend = extractStateSet(path.join(ROOT, "frontend", "src", "App.tsx"));
    const terms = extractStateProvisions(path.join(ROOT, "frontend", "src", "TermsPage.tsx"));
    expect(terms).toEqual(frontend);
  });

  test("PrivacyPage list matches App.tsx", () => {
    const frontend = extractStateSet(path.join(ROOT, "frontend", "src", "App.tsx"));
    const privacy = extractPrivacyList(path.join(ROOT, "frontend", "src", "PrivacyPage.tsx"));
    expect(privacy).toEqual(frontend);
  });

  test("expected list size is 35", () => {
    const list = extractStateSet(path.join(ROOT, "frontend", "src", "App.tsx"));
    expect(list).toHaveLength(35);
  });
});

describe("STATE_PROVISIONS structural integrity (TermsPage)", () => {
  test("every entry has state, venue, regulator fields", () => {
    const src = fs.readFileSync(
      path.join(ROOT, "frontend", "src", "TermsPage.tsx"),
      "utf8",
    );
    // Loose check — each STATE_PROVISIONS entry must contain all three keys.
    const entries = src.match(/{\s*state:[^}]*}/g) || [];
    expect(entries.length).toBeGreaterThan(30);
    for (const entry of entries) {
      expect(entry).toMatch(/state:/);
      expect(entry).toMatch(/venue:/);
      expect(entry).toMatch(/regulator:/);
    }
  });
});
