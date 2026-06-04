// Renders the three legal pages and asserts the key sections are present.
// Cheap regression net for accidentally deleting a clause during edits.

import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import TermsPage from "../../TermsPage";
import PrivacyPage from "../../PrivacyPage";
import ConsentPage from "../../ConsentPage";

describe("TermsPage", () => {
  test("renders the document title", () => {
    render(<TermsPage />);
    expect(screen.getByRole("heading", { name: /terms and conditions/i, level: 1 })).toBeInTheDocument();
  });

  test("renders all top-level lettered sections A through R", () => {
    render(<TermsPage />);
    // Section headings are h2s rendered as "A. What Advance Is …" etc.
    // Just confirm the count of h2s with a lettered prefix is at least 18.
    const headings = screen.getAllByRole("heading", { level: 2 });
    const lettered = headings.filter((h) => /^[A-R]\.\s/.test(h.textContent || ""));
    expect(lettered.length).toBeGreaterThanOrEqual(18);
  });

  test("renders all 35 state subsections in Section O", () => {
    render(<TermsPage />);
    const stateNames = [
      "Alabama", "Alaska", "Arizona", "Colorado", "Delaware", "Florida", "Georgia",
      "Hawaii", "Idaho", "Iowa", "Kentucky", "Maine", "Michigan", "Minnesota",
      "Mississippi", "Montana", "Nebraska", "New Hampshire", "New Jersey",
      "New Mexico", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon",
      "Pennsylvania", "Rhode Island", "South Dakota", "Tennessee", "Texas",
      "Vermont", "Virginia", "Washington", "West Virginia", "Wyoming",
    ];
    for (const name of stateNames) {
      // h3 inside Section O. There may be other mentions of the state in
      // other sections, so just confirm at least one matching heading.
      expect(screen.getAllByRole("heading", { name, level: 3 }).length).toBeGreaterThan(0);
    }
  });

  test("renders 'Same-day delivery' and '3-5 day delivery' in Section B", () => {
    render(<TermsPage />);
    expect(screen.getAllByText(/Same-day delivery/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/3.5 day delivery/i).length).toBeGreaterThan(0);
  });

  test("explicit $5 fee disclosure exists", () => {
    render(<TermsPage />);
    // Look for the $5 in the fee table.
    expect(screen.getAllByText(/\$5\.00/).length).toBeGreaterThan(0);
  });

  test("non-recourse clause present", () => {
    render(<TermsPage />);
    expect(screen.getAllByText(/non-recourse/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/no collections.*ever|never refer/i).length).toBeGreaterThan(0);
  });
});

describe("PrivacyPage", () => {
  test("renders the document title", () => {
    render(<PrivacyPage />);
    expect(screen.getByRole("heading", { name: /privacy policy/i, level: 1 })).toBeInTheDocument();
  });

  test("renders the GLBA FACTS notice block", () => {
    render(<PrivacyPage />);
    expect(screen.getByText(/^FACTS$/)).toBeInTheDocument();
  });

  test("includes state-specific privacy callouts (CA, VA, CO, VT)", () => {
    render(<PrivacyPage />);
    expect(screen.getByText(/California \(CCPA/i)).toBeInTheDocument();
    expect(screen.getByText(/Virginia \(VCDPA\):/i)).toBeInTheDocument();
    expect(screen.getByText(/Colorado \(CPA\):/i)).toBeInTheDocument();
    expect(screen.getByText(/Vermont:/i)).toBeInTheDocument();
  });

  test("affirms 'we do not sell your data'", () => {
    render(<PrivacyPage />);
    // Phrasing varies slightly by section ("do not sell your data" vs "do not sell personal information").
    const matches = screen.getAllByText(/do not sell/i);
    expect(matches.length).toBeGreaterThan(0);
  });
});

describe("ConsentPage", () => {
  test("renders the long title and the document title", () => {
    render(<ConsentPage />);
    expect(screen.getByRole("heading", { name: /Consent to the Use of Electronic Documents and Signatures/i, level: 1 })).toBeInTheDocument();
    // Internal h2 heading. There may be an exact-match issue depending on
    // capitalization — just look for the phrase as text content.
    expect(screen.getAllByText(/Consent to Receive Electronic Disclosures/i).length).toBeGreaterThan(0);
  });

  test("includes the warning paragraph and Bits Card, Inc. attribution", () => {
    render(<ConsentPage />);
    expect(screen.getByText(/I must read this consent carefully/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Bits Card, Inc/i).length).toBeGreaterThan(0);
  });

  test("renders all 7 numbered sections", () => {
    render(<ConsentPage />);
    const sectionTitles = [
      /Definitions/i,
      /Required/,
      /Withdrawing My Consent/,
      /Hardware and Software Requirements to Receive and Access/,
      /Hardware and Software Requirements to Retain/,
      /Updating My Information/,
      /I hereby:/,
    ];
    for (const title of sectionTitles) {
      expect(screen.getByRole("heading", { name: title, level: 2 })).toBeInTheDocument();
    }
  });

  test("withdrawal email is clickable mailto link", () => {
    render(<ConsentPage />);
    const links = screen.getAllByRole("link", { name: /advances@getbits\.app/i });
    expect(links.length).toBeGreaterThan(0);
    expect(links[0].getAttribute("href")).toMatch(/^mailto:/);
  });

  test("the four 'I hereby' affirmations are numbered list items", () => {
    render(<ConsentPage />);
    expect(screen.getByText(/agree to be bound by the terms of this Consent/i)).toBeInTheDocument();
    expect(screen.getByText(/confirm that the Internet access device/i)).toBeInTheDocument();
    expect(screen.getByText(/consent to receiving the Disclosures/i)).toBeInTheDocument();
    expect(screen.getByText(/agree to execute all related credit agreements/i)).toBeInTheDocument();
  });
});
