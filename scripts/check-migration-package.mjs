#!/usr/bin/env node
/**
 * Fantasy Friends — migration package guard.
 *
 * Enforces the *packaging* contract. It does not connect to any database and
 * does not apply anything.
 *
 *   1. Reviewed design drafts are byte-for-byte unchanged. Design drafts are
 *      review artefacts; a legitimate change is recorded here in the same
 *      reviewed commit that documents it.
 *   2. `supabase/migrations/` contains exactly the approved executable files, in
 *      the approved order, and every one of them is byte-identical to the file
 *      `scripts/promote-migrations.mjs` would generate from its source. This is
 *      what stops a hand-edit from slipping past review.
 *   3. The order constraint that matters is enforced explicitly: the definer
 *      ownership transfer must run before the privilege verification that
 *      asserts it happened, and the API surface verification must run last.
 *   4. Timestamps are valid, strictly increasing, and collision-free, so the CLI
 *      applies them in the reviewed order.
 *   5. No manual-only script is present as a migration (the Storage
 *      owner-authorised step must never be auto-applied).
 *   6. `supabase/config.toml` is local-only, secret-free, and keeps the hardened
 *      Data API default.
 *   7. Line endings are compatible with Windows checkouts (no BOM, no lone CR).
 *
 * Run with: npm run check:migrations
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * SHA-256 of each reviewed design source. If one legitimately changes, its new
 * hash must be recorded in the same reviewed commit that documents the change.
 */
const DESIGN_MIGRATIONS = {
  // Phase 2A reviewed baseline. These must never change.
  '001_schema.sql': '5207d5938696fd0e012125296eb35723d8aaa7cafeca48424dbc211fe25ca9b3',
  '002_security.sql': '8986954237db1cbb500564229678ea6dc4ea15673678b3d59da14438561feb08',
  '003_storage.sql': '1b54e2f35ade27a3494fad0040c68c61b722c96a766c003496a49a20c915e9ad',
  '004_integrity_workflows.sql': 'e3ced92af953c752ae710f12d4deefc8981c27e7a8f6a348386fb9d37efb5c0b',
  '005_concurrency_hardening.sql': '98e55433868b158a64c7f98e0416502a28b587ecde118021dd2fa0f0274ae3d4',
  '006_revision_lineage.sql': '8f427e86b8b3bc143f638849d9fd9a1097cf2b53c11aab054486f20aae81126a',
  '007_correction_attempts.sql': 'fdd52cbca5a96bbd80d782e75a00aafc319481d7829ac8af511727b8843e5fdf',
  '008_result_fork_idempotency.sql': '02de6a93950c5886c1ab30365b0acce09cdf61780ba09183df2f956548c8e8ab',
  '009_ownership_and_grants.sql': '3afec7f948ceb8229004d145d2b8b3522ec2c9c03b3f5211accf2085689b3e24',
  '010_privilege_verification.sql': '93711989477d573f456cd505fae4c3c9114fea2434ab0ff2658a2658c16678e1',
  '011_definer_ownership_transfer.sql': '1c1ede4d303699a52ce33d58bc09a2506db3dc60fb43ccdce7e83b7bb6ac8ba6',
  // Phase 3 forward-only repair (promoted to executable 012).
  '014_definer_actor_identity.sql': 'a9cdca655aea2ca57810aba0426b4c8a58df8e216d338ae4b91184f70c26e915',
};

/** Sources authored for publication in Phase 3, under supabase/design/api/. */
const DESIGN_API = {
  '012_application_api.sql': null, // pinned after first review; see below
  '013_api_surface_verification.sql': null,
};

/**
 * The approved executable package, in the exact order the CLI must apply it.
 * `source` is the reviewed file the executable is generated from.
 */
const PACKAGE = [
  ['20261115000001_schema.sql', 'design/migrations/001_schema.sql'],
  ['20261115000002_security.sql', 'design/migrations/002_security.sql'],
  ['20261115000003_storage.sql', 'design/migrations/003_storage.sql'],
  ['20261115000004_integrity_workflows.sql', 'design/migrations/004_integrity_workflows.sql'],
  ['20261115000005_concurrency_hardening.sql', 'design/migrations/005_concurrency_hardening.sql'],
  ['20261115000006_revision_lineage.sql', 'design/migrations/006_revision_lineage.sql'],
  ['20261115000007_correction_attempts.sql', 'design/migrations/007_correction_attempts.sql'],
  ['20261115000008_result_fork_idempotency.sql', 'design/migrations/008_result_fork_idempotency.sql'],
  ['20261115000009_ownership_and_grants.sql', 'design/migrations/009_ownership_and_grants.sql'],
  ['20261115000010_definer_ownership_transfer.sql', 'design/migrations/011_definer_ownership_transfer.sql'],
  ['20261115000011_application_api.sql', 'design/api/012_application_api.sql'],
  ['20261115000012_definer_actor_identity.sql', 'design/migrations/014_definer_actor_identity.sql'],
  ['20261115000013_privilege_verification.sql', 'design/migrations/010_privilege_verification.sql'],
  ['20261115000014_api_surface_verification.sql', 'design/api/013_api_surface_verification.sql'],
];

/** Manual-only scripts that must NEVER appear as a CLI migration. */
const MANUAL_ONLY = ['003b_storage_policy_owner_step.sql', 'verify_storage_setup.sql'];

const failures = [];
const passed = [];

const ok = (name, detail = '') => passed.push(detail ? `${name} — ${detail}` : name);
const fail = (name, detail) => failures.push(detail ? `${name} — ${detail}` : name);

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * Normalise line endings before hashing.
 *
 * Why this exists: the pinned design drafts are reviewed with LF endings, but a
 * Windows checkout with `core.autocrlf=true` (the Git for Windows default) writes
 * CRLF to the working tree. `git hash-object` and `git status` compare the *blob*
 * (always LF, since the clean filter converts on the way in), so they report a
 * clean tree - while `fs.readFile` here sees CRLF on disk and every pinned hash
 * "mismatches". That produced 24 spurious failures on Windows while CI on Linux
 * was green, which is precisely the kind of noise that trains people to ignore a
 * security guard.
 *
 * The contract we actually care about is the *text* of the reviewed SQL, not which
 * platform's newline it was checked out with. Normalising CRLF -> LF before
 * hashing makes the pin platform-independent without weakening it: any change to
 * the content still changes the digest.
 *
 * A lone CR (not followed by LF) is NOT normalised away - it is a genuine defect
 * that breaks PostgreSQL parsing, and check 5 rejects it explicitly.
 */
const normaliseEol = (text) => text.replace(/\r\n/g, '\n');

/** SHA-256 of a file's text with platform newlines normalised to LF. */
const sha256 = async (p) => {
  const text = await readFile(p, 'utf8');
  return createHash('sha256').update(normaliseEol(text), 'utf8').digest('hex');
};

// --- 1. Design sources are pristine ----------------------------------------
const designDir = path.join(root, 'supabase', 'design', 'migrations');
for (const [file, expected] of Object.entries(DESIGN_MIGRATIONS)) {
  const full = path.join(designDir, file);
  if (!(await exists(full))) { fail(`design draft ${file}`, 'file is missing'); continue; }
  const actual = await sha256(full);
  if (expected && actual !== expected) {
    fail(`design draft ${file}`,
      `checksum changed (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…). ` +
      'Design drafts are review artefacts; produce the change as a reviewed executable migration instead.');
  } else {
    ok(`design draft ${file} unchanged`, actual.slice(0, 12) + '…');
  }
}
for (const file of Object.keys(DESIGN_API)) {
  const full = path.join(root, 'supabase', 'design', 'api', file);
  if (!(await exists(full))) { fail(`design api ${file}`, 'file is missing'); continue; }
  ok(`design api ${file} present`, (await sha256(full)).slice(0, 12) + '…');
}

// --- 2. The executable package is exactly the approved set -----------------
const execDir = path.join(root, 'supabase', 'migrations');
if (!(await exists(execDir))) {
  fail('supabase/migrations/', 'missing: the executable package must be generated');
} else {
  const entries = (await readdir(execDir)).filter((n) => !n.startsWith('.'));
  const sql = entries.filter((n) => n.toLowerCase().endsWith('.sql'));
  const expectedNames = PACKAGE.map(([name]) => name);

  const missing = expectedNames.filter((n) => !sql.includes(n));
  const unexpected = sql.filter((n) => !expectedNames.includes(n));
  if (missing.length) fail('supabase/migrations/', `missing approved file(s): ${missing.join(', ')}`);
  if (unexpected.length) {
    fail('supabase/migrations/',
      `unexpected file(s): ${unexpected.join(', ')}. Only the reviewed package may be applied by the CLI.`);
  }
  if (!missing.length && !unexpected.length) ok('supabase/migrations/ exact set', `${sql.length} approved file(s)`);

  const nonSql = entries.filter((n) => !n.toLowerCase().endsWith('.sql'));
  if (nonSql.length) fail('supabase/migrations/', `unexpected non-SQL entries: ${nonSql.join(', ')}`);

  // No manual-only script may be auto-applied.
  for (const manual of MANUAL_ONLY) {
    if (sql.some((n) => n.includes(manual.replace(/\.sql$/, '')))) {
      fail('manual-only script promoted', `${manual} must stay under supabase/design/storage/`);
    }
  }
  ok('no manual-only script in the package', MANUAL_ONLY.join(', ') + ' stay out of supabase/migrations/');

  // The post-deployment verification script is operator-run, so it lives outside
  // supabase/migrations/. It must be genuinely read-only: an operator pastes it
  // into a production SQL editor and expects a report, never a mutation.
  try {
    const verify = await readFile(path.join(root, 'supabase/design/verify/remote-checks.sql'), 'utf8');
    const stripped = verify.replace(/--[^\n]*/g, '');
    const mutation = /^\s*(insert|update|delete|merge|create|alter|drop|grant|revoke|truncate|comment\s+on)\b/im.exec(stripped);
    if (mutation) {
      fail('deployment verification script', `must be read-only, found "${mutation[1].toUpperCase()}"`);
    }
    const numbered = [...verify.matchAll(/select\s+'(\d\d) /g)].length;
    if (numbered !== 18) fail('deployment verification script', `expected 18 numbered checks, found ${numbered}`);
    if (!mutation && numbered === 18) {
      ok('deployment verification is read-only', '18 numbered checks, no DDL/DML');
    }
  } catch {
    fail('deployment verification script', 'supabase/design/verify/remote-checks.sql is missing');
  }

  // --- 3. Order is valid, strictly increasing, and dependency-correct ------
  const stamps = expectedNames.map((n) => Number(n.slice(0, 14)));
  let ordered = true;
  for (let i = 1; i < stamps.length; i++) {
    if (!(stamps[i] > stamps[i - 1])) { ordered = false; break; }
  }
  if (!ordered) fail('migration order', 'timestamps are not strictly increasing');
  else ok('migration order strictly increasing', `${expectedNames.length} files`);

  const idx = (name) => expectedNames.findIndex((n) => n.endsWith(name));
  const transfer = idx('definer_ownership_transfer.sql');
  const verify = idx('privilege_verification.sql');
  const apiVerify = idx('api_surface_verification.sql');
  const api = idx('application_api.sql');
  if (transfer < 0 || verify < 0) fail('migration order', 'ownership transfer or verification file missing');
  else if (!(transfer < verify)) {
    fail('migration order',
      'the definer ownership transfer must run BEFORE the privilege verification that asserts it');
  } else ok('ownership transfer precedes verification', `#${transfer + 1} before #${verify + 1}`);

  if (!(api < apiVerify)) fail('migration order', 'the API layer must be created before its surface is verified');
  else ok('API layer precedes API verification', `#${api + 1} before #${apiVerify + 1}`);
  if (apiVerify !== expectedNames.length - 1) fail('migration order', 'the API surface verification must run last');
  else ok('API surface verification runs last', `#${apiVerify + 1}`);

  // --- 4. Executables are exactly what the promoter generates --------------
  // Re-derive each file's expected content from its source and compare.
  const { buildExpected } = await import('./promote-migrations.mjs').catch(() => ({}));
  if (!buildExpected) {
    fail('drift check', 'scripts/promote-migrations.mjs does not export buildExpected()');
  } else {
    let drift = 0;
    for (const [name, source] of PACKAGE) {
      const target = path.join(execDir, name);
      if (!(await exists(target))) continue;
      const expected = await buildExpected(name, source);
      // Normalise both sides: on Windows the checked-out file is CRLF while the
      // freshly generated expectation is LF. See normaliseEol above.
      const actual = normaliseEol(await readFile(target, 'utf8'));
      if (actual !== normaliseEol(expected)) {
        drift++;
        fail(`migration ${name}`, `does not match its source ${source}; run npm run migrations:promote`);
      }
    }
    if (!drift) ok('executables match their reviewed sources', 'no hand-edits detected');
  }

  // --- 5. Windows line-ending compatibility -------------------------------
  let badEol = [];
  for (const name of sql) {
    const body = await readFile(path.join(execDir, name));
    if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) badEol.push(`${name} (BOM)`);
    else if (body.includes(0x0d) && name) {
      // CRLF is tolerated, but a lone CR is not: it breaks PostgreSQL parsing.
      const text = body.toString('utf8');
      if (/(^|[^\r])\r([^\n]|$)/.test(text)) badEol.push(`${name} (lone CR)`);
    }
  }
  if (badEol.length) fail('line endings', `problem file(s): ${badEol.join(', ')}`);
  else ok('line endings Windows-compatible', 'no BOM, no lone CR');
}

// --- 6. config.toml is local-only and hardened -----------------------------
const configPath = path.join(root, 'supabase', 'config.toml');
if (!(await exists(configPath))) {
  fail('supabase/config.toml', 'missing');
} else {
  const config = await readFile(configPath, 'utf8');

  if (!/^project_id\s*=\s*"[^"]+"/m.test(config)) fail('supabase/config.toml', 'project_id is not set');
  else ok('supabase/config.toml project_id', config.match(/^project_id\s*=\s*"([^"]+)"/m)[1]);

  if (/^\s*project_ref\s*=/m.test(config)) {
    fail('supabase/config.toml', 'contains project_ref; the repository must not be linked to a hosted project');
  } else ok('supabase/config.toml not linked', 'no project_ref');

  const secrets = [
    [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, 'a JWT'],
    [/sb_secret_[A-Za-z0-9_-]+/, 'a secret key'],
    [/sb_publishable_[A-Za-z0-9_-]+/, 'a publishable key'],
    [/postgres(?:ql)?:\/\/[^\s"']*:[^\s"'@]+@/, 'a database URL with a password'],
  ];
  const leaked = secrets.filter(([re]) => re.test(config)).map(([, label]) => label);
  if (leaked.length) fail('supabase/config.toml', `contains ${leaked.join(', ')}; use the env(NAME) form instead`);
  else ok('supabase/config.toml secret-free', 'no literal keys or connection strings');

  if (!/^\s*auto_expose_new_tables\s*=\s*false\s*$/m.test(config)) {
    fail('supabase/config.toml',
      'api.auto_expose_new_tables must be explicitly false; the permissive default would re-expose new public tables');
  } else ok('supabase/config.toml auto_expose_new_tables false', 'new public tables are not auto-granted');

  const seedBlock = config.match(/\[db\.seed\]([\s\S]*?)(?=\n\[|\s*$)/);
  if (!seedBlock) fail('supabase/config.toml', '[db.seed] section missing');
  else if (!/^\s*enabled\s*=\s*false\s*$/m.test(seedBlock[1])) {
    fail('supabase/config.toml', 'db.seed must stay disabled until reviewed seed data exists');
  } else ok('supabase/config.toml seeding disabled', 'no unreviewed seed data is applied');
}

// --- 7. Link state: unlinked, or linked to the one approved project -------
//
// History: this check used to fail on ANY link state, because the package was
// built while no hosted project was authorised. That is too strict for
// deployment - `supabase link` necessarily writes supabase/.temp/project-ref -
// and the alternative (deleting the file before every guard run) is exactly the
// habit that would let a link to the WRONG project pass unnoticed.
//
// The rule is now an allowlist of one. Any other project ref, and any branch
// state, still fails. The approved ref is a public project identifier, not a
// secret, so pinning it here is safe.
const APPROVED_PROJECT_REF = 'ddeojemjbhnxtrgsuicv';

if (await exists(path.join(root, 'supabase', '.branches'))) {
  fail('supabase/.branches', 'branch state present; deploy from main, not a preview branch');
} else {
  ok('no preview-branch state', 'supabase/.branches is absent');
}

const refFile = path.join(root, 'supabase', '.temp', 'project-ref');
if (!(await exists(refFile))) {
  ok('link state', 'unlinked (fine before deployment; required only to push)');
} else {
  const linked = (await readFile(refFile, 'utf8')).trim();
  if (linked === APPROVED_PROJECT_REF) {
    ok('link state', `linked to the approved project ${APPROVED_PROJECT_REF}`);
  } else if (!linked) {
    fail('supabase/.temp/project-ref', 'file exists but is empty; run supabase link again');
  } else {
    fail('supabase/.temp/project-ref',
      `linked to "${linked}", which is NOT the approved project (${APPROVED_PROJECT_REF}). ` +
      'Run `supabase unlink`, then `supabase link --project-ref ' + APPROVED_PROJECT_REF + '`. ' +
      'Refusing to treat an unknown project as deployable.');
  }
}

// --- Report ---------------------------------------------------------------
console.log('Migration package guard\n');
for (const line of passed) console.log(`  ok    ${line}`);
for (const line of failures) console.log(`  FAIL  ${line}`);
console.log(
  `\n${passed.length} check(s) passed, ${failures.length} failed. ` +
  'This guard inspects files only: it does not prove Supabase compatibility.',
);
process.exit(failures.length === 0 ? 0 : 1);
