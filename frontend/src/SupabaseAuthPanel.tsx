// Supabase auth surface: "Continue with Google" + email/password sign-in /
// sign-up + password reset. Establishing a session is all this does — the
// parent app picks the session up reactively (useSupabaseAccessToken) and
// switches its API calls to the Supabase bearer. Renders nothing when Supabase
// isn't configured, so the legacy login/signup screens are unaffected.
//
// Styled with the app's bld* design system (those rules are scoped under
// .bldPage, the ancestor on the /loan and signup screens where this renders).

import React, { useState } from "react";
import { supabase, isSupabaseConfigured } from "./supabase";
import styles from "./App.module.css";

type Props = {
  // Where Google OAuth returns to after the redirect round-trip.
  redirectTo?: string;
  // Optional heading shown above the form.
  heading?: string;
  // Which mode to open in — "signup" on the apply screen, "signin" on /loan.
  defaultMode?: "signin" | "signup";
};

type Mode = "signin" | "signup" | "reset";

const SupabaseAuthPanel: React.FC<Props> = ({ redirectTo, heading, defaultMode }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<Mode>(defaultMode ?? "signin");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After sign-up (confirmation) or reset-request, show a dedicated
  // "check your email" screen instead of the form.
  const [sent, setSent] = useState<{ kind: "signup" | "reset"; email: string } | null>(null);

  if (!isSupabaseConfigured || !supabase) return null;
  const sb = supabase; // non-null past the guard (narrowing doesn't reach closures)

  // Post-submit "check your email" screen (sign-up confirmation OR reset link).
  if (sent) {
    const isReset = sent.kind === "reset";
    return (
      <div style={{ textAlign: "center", padding: "1rem 0" }}>
        <div style={{ fontSize: 40, marginBottom: 8 }} aria-hidden="true">✉️</div>
        <p className={styles.bldSectionLabel}>Check your email</p>
        <h2 style={{ margin: "0 0 12px", fontSize: 26, lineHeight: 1.2 }}>
          {isReset ? "Reset your password" : "Confirm your account"}
        </h2>
        <p style={{ color: "var(--bld-muted, rgba(255,255,255,0.6))", fontSize: 15, lineHeight: 1.5, margin: "0 auto 20px", maxWidth: 360 }}>
          We sent {isReset ? "a password reset link" : "a confirmation link"} to{" "}
          <strong style={{ color: "var(--bld-fg, #fff)" }}>{sent.email}</strong>.{" "}
          {isReset ? "Open it to choose a new password." : "Open it to verify your email, then come back and sign in."}
        </p>
        <button
          type="button"
          className={styles.bldFootLink}
          style={{ background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit" }}
          onClick={() => { setSent(null); setMode("signin"); setPassword(""); }}
        >
          ← Back to sign in
        </button>
      </div>
    );
  }

  const withGoogle = async () => {
    setError(null);
    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: redirectTo || window.location.origin },
    });
    if (error) setError(error.message);
  };

  const withEmail = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "signup") {
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        // Auto-confirm projects return a session (onAuthStateChange handles it);
        // otherwise show the "check your email" screen.
        if (!data.session) setSent({ kind: "signup", email });
      } else if (mode === "reset") {
        const { error } = await sb.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (error) throw error;
        setSent({ kind: "reset", email });
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  };

  const submitLabel = busy
    ? "…"
    : mode === "signup"
      ? <>Create account <span aria-hidden="true">→</span></>
      : mode === "reset"
        ? <>Send reset link <span aria-hidden="true">→</span></>
        : <>Sign in <span aria-hidden="true">→</span></>;

  return (
    <div>
      {heading && <p className={styles.bldSectionLabel}>{mode === "reset" ? "Reset your password" : heading}</p>}

      {/* Google + divider only for sign in / sign up, not the reset step. */}
      {mode !== "reset" && (
        <>
          <button
            type="button"
            onClick={withGoogle}
            className={styles.bldBtn}
            style={{ background: "#fff", color: "#111", textTransform: "none", letterSpacing: "-0.005em" }}
          >
            Continue with Google
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "18px 0", color: "var(--bld-muted, rgba(255,255,255,0.5))", fontSize: 13 }}>
            <span style={{ flex: 1, height: 1, background: "currentColor", opacity: 0.25 }} />
            or
            <span style={{ flex: 1, height: 1, background: "currentColor", opacity: 0.25 }} />
          </div>
        </>
      )}

      {mode === "reset" && (
        <p style={{ color: "var(--bld-muted, rgba(255,255,255,0.6))", fontSize: 14, lineHeight: 1.5, margin: "0 0 16px" }}>
          Enter your email and we&apos;ll send you a link to set a new password.
        </p>
      )}

      <form onSubmit={withEmail}>
        <label className={styles.bldField}>
          <span className={styles.bldLabel}>Email</span>
          <input
            required
            type="email"
            autoComplete="email"
            value={email}
            placeholder="you@example.com"
            onChange={(e) => setEmail(e.target.value)}
            className={styles.bldInput}
          />
        </label>

        {mode !== "reset" && (
          <label className={styles.bldField}>
            <span className={styles.bldLabel}>Password</span>
            <input
              required
              type="password"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              value={password}
              placeholder="Your password"
              onChange={(e) => setPassword(e.target.value)}
              className={styles.bldInput}
            />
          </label>
        )}

        {/* Forgot password — only on the sign-in form. */}
        {mode === "signin" && (
          <button
            type="button"
            className={styles.bldFootLink}
            style={{ background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit", display: "block", marginTop: 4 }}
            onClick={() => { setMode("reset"); setError(null); setPassword(""); }}
          >
            Forgot password?
          </button>
        )}

        {error && <p className={styles.bldError}>{error}</p>}

        <button type="submit" disabled={busy} className={styles.bldBtn} style={{ marginTop: 16 }}>
          {submitLabel}
        </button>
      </form>

      <p className={styles.bldFootnote}>
        {mode === "reset" ? (
          <button
            type="button"
            className={styles.bldFootLink}
            style={{ background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit" }}
            onClick={() => { setMode("signin"); setError(null); }}
          >
            ← Back to sign in
          </button>
        ) : (
          <>
            {mode === "signup" ? "Have an account? " : "New here? "}
            <button
              type="button"
              className={styles.bldFootLink}
              style={{ background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit" }}
              onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setError(null); }}
            >
              {mode === "signup" ? "Sign in" : "Create an account"}
            </button>
          </>
        )}
      </p>
    </div>
  );
};

export default SupabaseAuthPanel;
