// Supabase auth surface: "Continue with Google" + email/password sign-in /
// sign-up. Establishing a session is all this does — the parent app picks the
// session up reactively (useSupabaseAccessToken) and switches its API calls to
// the Supabase bearer. Renders nothing when Supabase isn't configured, so the
// legacy login/signup screens are unaffected until the project is wired up.

import React, { useState } from "react";
import { supabase, isSupabaseConfigured } from "./supabase";

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
    <div style={{ display: "flex", flexDirection: "column", gap: "0.8rem" }}>
      {heading && <h2 style={{ margin: 0 }}>{heading}</h2>}

      <button
        type="button"
        onClick={withGoogle}
        style={{
          padding: "0.7rem 1rem",
          fontSize: "1.3rem",
          fontWeight: 600,
          border: "1.5px solid var(--border)",
          borderRadius: "var(--r-sm)",
          background: "var(--white)",
          color: "var(--ink)",
          cursor: "pointer",
        }}
      >
        Continue with Google
      </button>

      <div style={{ textAlign: "center", color: "var(--muted)", fontSize: "1.1rem" }}>or</div>

      <form onSubmit={withEmail} style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
        <input
          type="email"
          required
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
        <input
          type="password"
          required
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
        />
        <button type="submit" disabled={busy}>
          {busy ? "…" : mode === "signup" ? "Create account" : "Sign in"}
        </button>
      </form>

      <button
        type="button"
        onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setError(null); setNotice(null); }}
        style={{ background: "none", border: "none", color: "var(--brand)", cursor: "pointer", fontSize: "1.1rem" }}
      >
        {mode === "signup" ? "Have an account? Sign in" : "New here? Create an account"}
      </button>

      {error && <p style={{ color: "var(--danger, #c00)", fontSize: "1.1rem", margin: 0 }}>{error}</p>}
      {notice && <p style={{ color: "var(--muted)", fontSize: "1.1rem", margin: 0 }}>{notice}</p>}
    </div>
  );
};

export default SupabaseAuthPanel;
