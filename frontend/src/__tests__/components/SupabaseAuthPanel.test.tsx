// Phase 6 — the Supabase auth surface. The real ./supabase module is mocked
// so no network/env is needed: we assert the panel wires its buttons to the
// Supabase client.

import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// vi.mock is hoisted above imports, so the mock fns must be hoisted too.
const { signInWithOAuth, signInWithPassword, signUp, resetPasswordForEmail } = vi.hoisted(() => ({
  signInWithOAuth: vi.fn(),
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  resetPasswordForEmail: vi.fn(),
}));

vi.mock("../../supabase", () => ({
  isSupabaseConfigured: true,
  supabase: { auth: { signInWithOAuth, signInWithPassword, signUp, resetPasswordForEmail } },
}));

import SupabaseAuthPanel from "../../SupabaseAuthPanel";

beforeEach(() => {
  signInWithOAuth.mockReset().mockResolvedValue({ error: null });
  signInWithPassword.mockReset().mockResolvedValue({ error: null });
  signUp.mockReset().mockResolvedValue({ error: null, data: { session: null } });
  resetPasswordForEmail.mockReset().mockResolvedValue({ error: null });
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
    // signUp must carry emailRedirectTo so the confirmation link returns into
    // the app (falls back to the origin when no redirectTo prop is given).
    await waitFor(() =>
      expect(signUp).toHaveBeenCalledWith({
        email: "c@d.com",
        password: "pw123456",
        options: { emailRedirectTo: window.location.origin },
      }),
    );
  });

  test("forgot-password sends a reset link", async () => {
    render(<SupabaseAuthPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "r@e.com" } });
    fireEvent.click(screen.getByRole("button", { name: /send reset link/i }));
    await waitFor(() => expect(resetPasswordForEmail).toHaveBeenCalled());
    expect(resetPasswordForEmail.mock.calls[0][0]).toBe("r@e.com");
    // Shows the "check your email" confirmation afterward.
    expect(await screen.findByText(/Reset your password/i)).toBeTruthy();
  });
});
