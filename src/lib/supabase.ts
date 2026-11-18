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
import { createBootstrapDiagnosticFetch } from '../services/bootstrapDiagnostics';

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

/**
 * The one Supabase project a production build is allowed to talk to.
 *
 * The build-time guard (scripts/check-pages-env.mjs) refuses to produce a Pages
 * bundle for any other project, but a bundle that was built elsewhere, or with a
 * stale variable, could still be served. This is the runtime half: the constant
 * is committed, so the check does not derive its expectation from the same
 * variable it is checking.
 *
 * The ref is a project's public subdomain, never a secret.
 */
export const APPROVED_PROJECT_REF = 'ddeojemjbhnxtrgsuicv';

/** `https://<ref>.supabase.co` → `<ref>`; anything else → null. */
export function projectRefOf(rawUrl: string | undefined | null): string | null {
  if (!rawUrl) return null;
  try {
    const host = new URL(rawUrl.trim()).hostname.toLowerCase();
    const match = /^([a-z0-9]{20})\.supabase\.(?:co|in)$/.exec(host);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export type ProjectRefMismatch = { configured: string | null; expected: string };

/**
 * Pure decision function, so the rule is testable without a build.
 *
 * Returns null when there is nothing to complain about:
 *   * a development/test build — `.env.local` legitimately points at a scratch
 *     project there, and blocking it would break local work;
 *   * Demo mode (no backend configured) — nothing can be written anywhere;
 *   * the configured ref is the approved one.
 */
export function evaluateProjectRef(input: {
  url?: string | null;
  prod: boolean;
  configured?: boolean;
  expected?: string;
}): ProjectRefMismatch | null {
  const expected = input.expected ?? APPROVED_PROJECT_REF;
  if (!input.prod) return null;
  if (input.configured === false) return null;
  const configuredUrl = input.url?.trim();
  if (!configuredUrl) return null;
  const configured = projectRefOf(configuredUrl);
  return configured === expected ? null : { configured, expected };
}

/** Non-null in a production build that is wired to the wrong project. */
export const projectRefMismatch: ProjectRefMismatch | null = evaluateProjectRef({
  url,
  prod: Boolean(import.meta.env.PROD),
  configured: isSupabaseConfigured,
});

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
  if (projectRefMismatch) {
    // Fail closed, exactly like the service_role refusal above: refuse to create a
    // client, so nothing is written into a project nobody is watching. The visible
    // banner (src/components/ProjectRefNotice.tsx) explains it to a human.
    console.error(
      '[fantasy-friends] This build is wired to Supabase project ' +
        `"${projectRefMismatch.configured ?? 'unrecognised'}" but is only approved to talk to ` +
        `"${projectRefMismatch.expected}". Refusing to create a client; live data is disabled. ` +
        'Fix VITE_SUPABASE_URL in the deployment, not in the browser.',
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
      global: {
        headers: { 'x-application-name': 'fantasy-friends' },
        fetch: createBootstrapDiagnosticFetch(url!),
      },
    });
  }
  return client;
}

/** Supabase Storage bucket for player images. Private; see migration 003. */
export const PLAYER_IMAGES_BUCKET = 'player-images';
