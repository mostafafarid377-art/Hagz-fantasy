// Supabase client for the browser.
//
// Only the ANON (publishable) key is ever used here. It is designed to be public:
// it grants no privilege on its own because every table is RLS-protected and the
// only client-callable surface is the reviewed ff_* RPC set. A service-role key
// must never appear in browser code - that is why this module reads exactly two
// VITE_ variables and nothing else.
//
// When the environment is not configured, `isSupabaseConfigured` is false and the
// app keeps running in Demo mode (see src/hooks/useApp.tsx). That keeps the
// existing demo fully usable without any backend, which is a hard requirement.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();

/** True only when both values are present and look like a Supabase project. */
export const isSupabaseConfigured = Boolean(
  url && anonKey && /^https?:\/\//.test(url) && anonKey.length > 20,
);

/**
 * A deliberate guard against the most common and most dangerous mistake in this
 * kind of app: pasting the service-role secret into a VITE_ variable. It would be
 * inlined into the public bundle and hand every visitor full database access.
 */
export const looksLikeServiceRoleKey = (value: string | undefined): boolean => {
  if (!value) return false;
  if (value.startsWith('sb_secret_')) return true;
  // A legacy service_role JWT carries {"role":"service_role"} in its payload.
  const parts = value.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload?.role === 'service_role';
    } catch { return false; }
  }
  return false;
};

let client: SupabaseClient | null = null;

/**
 * The singleton client, or null when the backend is not configured.
 *
 * Session persistence is explicit rather than default so the behaviour is the
 * same on every browser: the session lives in localStorage and is refreshed in
 * the background, which is what makes "stay signed in" work across reloads.
 */
export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  if (looksLikeServiceRoleKey(anonKey)) {
    // Fail loudly in the console instead of silently shipping a fatal leak.
    console.error(
      '[fantasy-friends] VITE_SUPABASE_ANON_KEY looks like a service_role key. ' +
      'Refusing to create a client. Use the anon/publishable key: the service_role ' +
      'key must never reach the browser.',
    );
    return null;
  }
  if (!client) {
    client = createClient(url!, anonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true, // required for email confirmation / recovery links
        flowType: 'pkce',
      },
      global: { headers: { 'x-application-name': 'fantasy-friends' } },
    });
  }
  return client;
}

/** Supabase Storage bucket for player images. Private; see migration 003. */
export const PLAYER_IMAGES_BUCKET = 'player-images';
