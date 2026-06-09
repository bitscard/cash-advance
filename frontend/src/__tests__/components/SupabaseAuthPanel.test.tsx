// Phase 6 — the Supabase auth surface. The real ./supabase module is mocked
// so no network/env is needed: we assert the panel wires its buttons to the
// Supabase client.

import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// vi.mock is hoisted above imports, so the mock fns must be hoisted too.
const { signInWithOAuth, signInWithPassword, signUp } = vi.hoisted(() => ({
  signInWithOAuth: vi.fn(),
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
}));

vi.mock("../../supabase", () => ({
  isSupabaseConfigured: true,
  supabase: { auth: { signInWithOAuth, signInWithPassword, signUp } },
}));

import SupabaseAuthPanel from "../../SupabaseAuthPanel";

beforeEach(() => {
  signInWithOAuth.mockReset().mockResolvedValue({ error: null });
  signInWithPassword.mockReset().mockResolvedValue({ error: null });
  signUp.mockReset().mockResolvedValue({ error: null });
});

describe("SupabaseAuthPanel", () => {
  test("renders Google + email/password and triggers OAuth", () => {
    render(<SupabaseAuthPanel redirectTo="https://app.test/loan" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: "https://app.test/loan" },
    });
  });

  test("submits email/password sign-in", async () => {
    render(<SupabaseAuthPanel />);
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByPlaceholderText("Your password"), { target: { value: "pw123456" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() =>
      expect(signInWithPassword).toHaveBeenCalledWith({ email: "a@b.com", password: "pw123456" }),
    );
  });

  test("switches to sign-up mode and calls signUp", async () => {
    render(<SupabaseAuthPanel />);
    // In sign-in mode the toggle reads "Create an account".
    fireEvent.click(screen.getByRole("button", { name: "Create an account" }));
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "c@d.com" } });
    fireEvent.change(screen.getByPlaceholderText("Your password"), { target: { value: "pw123456" } });
    // Now the submit button reads "Create account →".
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    await waitFor(() =>
      expect(signUp).toHaveBeenCalledWith({ email: "c@d.com", password: "pw123456" }),
    );
  });
});
