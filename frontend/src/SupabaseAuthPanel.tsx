// Supabase auth surface: "Continue with Google" + email/password sign-in /
// sign-up. Establishing a session is all this does — the parent app picks the
// session up reactively (useSupabaseAccessToken) and switches its API calls to
// the Supabase bearer. Renders nothing when Supabase isn't configured, so the
// legacy login/signup screens are unaffected until the project is wired up.
//
// Styled with the app's bld* design system so it matches the legacy login form
// (the bld* button/input rules are scoped under .bldPage, which is the ancestor
// on the /loan and signup screens where this renders).

import React, { useState } from "react";
import { supabase, isSupabaseConfigured } from "./supabase";
import styles from "./App.module.css";

type Props = {
  // Where Google OAuth returns to after the redirect round-trip.
  redirectTo?: string;
  // Optional heading shown above the form.
  heading?: string;
};

const SupabaseAuthPanel: React.FC<Props> = ({ redirectTo, heading }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!isSupabaseConfigured || !supabase) return null;
  const sb = supabase; // non-null past the guard (narrowing doesn't reach closures)

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
    setNotice(null);
    try {
      if (mode === "signup") {
        const { error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        setNotice("Check your email to confirm your account, then sign in.");
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

  return (
    <div>
      {heading && <p className={styles.bldSectionLabel}>{heading}</p>}

      {/* Google — same pill shape as the primary button, white treatment. */}
      <button
        type="button"
        onClick={withGoogle}
        className={styles.bldBtn}
        style={{
          background: "#fff",
          color: "#111",
          textTransform: "none",
          letterSpacing: "-0.005em",
        }}
      >
        Continue with Google
      </button>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          margin: "18px 0",
          color: "var(--bld-muted, rgba(255,255,255,0.5))",
          fontSize: 13,
        }}
      >
        <span style={{ flex: 1, height: 1, background: "currentColor", opacity: 0.25 }} />
        or
        <span style={{ flex: 1, height: 1, background: "currentColor", opacity: 0.25 }} />
      </div>

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

        {error && <p className={styles.bldError}>{error}</p>}
        {notice && <p className={styles.bldFootnote}>{notice}</p>}

        <button type="submit" disabled={busy} className={styles.bldBtn} style={{ marginTop: 16 }}>
          {busy ? "…" : mode === "signup" ? <>Create account <span aria-hidden="true">→</span></> : <>Sign in <span aria-hidden="true">→</span></>}
        </button>
      </form>

      <p className={styles.bldFootnote}>
        {mode === "signup" ? "Have an account? " : "New here? "}
        <button
          type="button"
          className={styles.bldFootLink}
          style={{ background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit" }}
          onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setError(null); setNotice(null); }}
        >
          {mode === "signup" ? "Sign in" : "Create an account"}
        </button>
      </p>
    </div>
  );
};

export default SupabaseAuthPanel;
