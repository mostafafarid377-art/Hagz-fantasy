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

// ---------------------------------------------------------------------------
// --self-test: prove the guard itself, so it cannot silently stop guarding.
//
// The check only ever runs in the Pages workflow, where the real values are
// injected; that makes it exactly the kind of code that rots unnoticed. This mode
// re-runs the script as a child process with synthetic inputs and asserts the exit
// code for each case. It never reads or prints the real configuration.
//
// Wired into `npm run verify:all`, so `pull_request` CI exercises it on every PR.
// ---------------------------------------------------------------------------
if (process.argv.includes('--self-test')) {
  const { spawnSync } = await import('node:child_process');
  const FAKE_PUBLISHABLE = 'sb_publishable_' + 'x'.repeat(30);
  const FAKE_SERVICE_ROLE = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJl';
  const cases = [
    ['approved project ref', 'https://ddeojemjbhnxtrgsuicv.supabase.co', FAKE_PUBLISHABLE, 0],
    ['approved project ref with trailing slash', 'https://ddeojemjbhnxtrgsuicv.supabase.co/', FAKE_PUBLISHABLE, 0],
    ['a different (staging/clone) project', 'https://zkrfgdiujpagaddsxbcb.supabase.co', FAKE_PUBLISHABLE, 1],
    ['a non-Supabase host', 'https://example.com', FAKE_PUBLISHABLE, 1],
    ['an empty URL', '', FAKE_PUBLISHABLE, 1],
    ['a missing key', 'https://ddeojemjbhnxtrgsuicv.supabase.co', '', 1],
    ['a too-short key', 'https://ddeojemjbhnxtrgsuicv.supabase.co', 'short', 1],
    ['a service_role key', 'https://ddeojemjbhnxtrgsuicv.supabase.co', FAKE_SERVICE_ROLE, 1],
  ];
  let failed = 0;
  for (const [name, url, key, expected] of cases) {
    const run = spawnSync(process.execPath, [process.argv[1]], {
      env: { ...process.env, VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: key },
      encoding: 'utf8',
    });
    const actual = run.status;
    const ok = actual === expected;
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name} -> exit ${actual} (expected ${expected})`);
  }
  console.log(`\n[pages-env:self-test] ${cases.length - failed}/${cases.length} cases behaved as expected.`);
  process.exit(failed === 0 ? 0 : 1);
}

const url = (process.env.VITE_SUPABASE_URL ?? '').trim();
const anonKey = (process.env.VITE_SUPABASE_ANON_KEY ?? '').trim();

/**
 * G5: the one project this bundle is allowed to talk to.
 *
 * The project ref is not a secret (it is the public subdomain of the API URL, and
 * it already appears in the deployed bundle), so failing loudly with the ref in the
 * message is safe *and* is the whole point: a build that points at a different
 * project - a staging clone, a fork's own project, or a typo - publishes a site that
 * looks healthy while every write lands somewhere nobody is watching. That is the
 * same class of silent misconfiguration this script already guards against.
 *
 * Add a ref here deliberately, in a reviewed commit, if the deployment ever
 * legitimately moves.
 */
const APPROVED_PROJECT_REFS = ['ddeojemjbhnxtrgsuicv'];

const problems = [];

if (!url) {
  problems.push('VITE_SUPABASE_URL is not set');
} else if (!/^https?:\/\//.test(url)) {
  // Deliberately does not echo the value.
  problems.push('VITE_SUPABASE_URL is not an http(s) URL');
} else if (projectRefOf(url) === null) {
  problems.push('VITE_SUPABASE_URL is not a https://<project-ref>.supabase.co URL');
} else if (!APPROVED_PROJECT_REFS.includes(projectRefOf(url))) {
  problems.push(
    `VITE_SUPABASE_URL points at project "${projectRefOf(url)}", which is not the approved project. ` +
      `Approved: ${APPROVED_PROJECT_REFS.join(', ')}. Refusing to publish a bundle that would write to another project.`,
  );
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
/**
 * Extracts the project ref from a hosted Supabase API URL.
 * Returns null for anything that is not one (custom domains included: those need a
 * deliberate change to this check, not a silent pass).
 */
function projectRefOf(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    for (const suffix of ['.supabase.co', '.supabase.in']) {
      if (host.endsWith(suffix)) {
        const ref = host.slice(0, -suffix.length);
        return /^[a-z0-9]{20}$/.test(ref) ? ref : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

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
