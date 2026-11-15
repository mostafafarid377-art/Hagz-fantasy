#!/usr/bin/env node
/**
 * Pre-build check for the GitHub Pages deployment.
 *
 * Why this exists: the Pages workflow used to build WITHOUT any Supabase
 * configuration, so the published site was a Demo-only bundle. `isSupabaseConfigured`
 * was false, `/login` said "The backend is not configured", and signing in was
 * impossible - while `main` looked perfectly healthy. That is a silent
 * misconfiguration that no unit test could catch, because both a configured and an
 * unconfigured build are "valid" applications.
 *
 * What it checks, mirroring `src/lib/supabase.ts` exactly rather than inventing a
 * second definition of "configured":
 *   * both values are present,
 *   * the URL looks like a URL,
 *   * the key is long enough to be a real key (the app requires > 20 chars),
 *   * and, mirroring the app's own safety guard, the key is NOT a service_role
 *     secret. Vite inlines these values into a public bundle, so a service_role key
 *     here would hand every visitor full database access. Failing the build is the
 *     only safe response to that.
 *
 * SECURITY: this script never prints, logs or echoes either value - not on success,
 * not on failure, not in an error message. It reports only which variable is wrong
 * and in what way. Exit code 1 fails the build.
 *
 * Run: node scripts/check-pages-env.mjs
 */

const url = (process.env.VITE_SUPABASE_URL ?? '').trim();
const anonKey = (process.env.VITE_SUPABASE_ANON_KEY ?? '').trim();

const problems = [];

if (!url) {
  problems.push('VITE_SUPABASE_URL is not set');
} else if (!/^https?:\/\//.test(url)) {
  // Deliberately does not echo the value.
  problems.push('VITE_SUPABASE_URL is not an http(s) URL');
}

if (!anonKey) {
  problems.push('VITE_SUPABASE_ANON_KEY is not set');
} else if (anonKey.length <= 20) {
  problems.push('VITE_SUPABASE_ANON_KEY is too short to be a real key (needs > 20 characters)');
} else if (looksLikeServiceRoleKey(anonKey)) {
  problems.push(
    'VITE_SUPABASE_ANON_KEY is a service_role key, not an anon/publishable key. ' +
    'Vite inlines it into the public bundle, which would expose the database. Refusing to build.',
  );
}

if (problems.length) {
  console.error('[pages-env] Refusing to build the Pages bundle:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '\n[pages-env] Set the repository variables VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY ' +
    '(Settings -> Secrets and variables -> Actions -> Variables), then re-run the workflow. ' +
    'Use the anon/publishable key only. Values are never printed by this check.',
  );
  process.exit(1);
}

// Deliberately value-free: a fixed message plus nothing derived from the secrets.
console.log('[pages-env] Supabase configuration present and shape-valid; proceeding to build.');

/**
 * Mirrors `looksLikeServiceRoleKey` in src/lib/supabase.ts.
 *
 * Duplicated rather than imported because the source is TypeScript and this is a
 * dependency-free pre-build script; `scripts/check-pages-build.mjs` sets the same
 * precedent. The app still refuses to create a client if this check is ever
 * bypassed, so the two are belt-and-braces rather than the only defence.
 */
function looksLikeServiceRoleKey(value) {
  if (!value) return false;
  if (value.startsWith('sb_secret_')) return true;
  const parts = value.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload?.role === 'service_role';
    } catch { return false; }
  }
  return false;
}
