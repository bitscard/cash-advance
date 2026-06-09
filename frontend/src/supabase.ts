// Supabase Auth client (customer + admin login). The browser uses the public
// anon key; the project URL + key come from Vite env. When they're absent the
// client is null and `isSupabaseConfigured` is false — the app then falls back
// entirely to the legacy email+password / token flow, so nothing breaks until
// the project is wired up.

import { useEffect, useState } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url as string, anonKey as string, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null;

// Tracks the current Supabase access token reactively (initial session +
// onAuthStateChange). Returns null when Supabase isn't configured or there's
// no session. Callers prefer this token over the legacy one when present.
export function useSupabaseAccessToken(): string | null {
  const [accessToken, setAccessToken] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (active) setAccessToken(data.session?.access_token ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setAccessToken(session?.access_token ?? null);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return accessToken;
}

export async function signOutSupabase(): Promise<void> {
  if (supabase) await supabase.auth.signOut();
}
