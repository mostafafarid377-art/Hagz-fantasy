#!/usr/bin/env node
/**
 * Phase 2B.1 — migration package guard.
 *
 * This script enforces the *preparation* contract. It does not connect to any
 * database and does not apply anything.
 *
 *   1. The six Phase 2A design drafts are byte-for-byte unchanged, and the four
 *      Phase 2B.2 design additions (007-010) are unchanged since this commit.
 *   2. Nothing has been copied into the executable `supabase/migrations/`
 *      directory yet, so `supabase db push` can never apply an unreviewed draft.
 *   3. `supabase/config.toml` exists, is local-only, and holds no secrets or
 *      hosted-project reference.
 *   4. The project has not been linked to a hosted Supabase project.
 *
 * Run with: npm run check:migrations
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * SHA-256 of each reviewed Phase 2A design draft at the start of Phase 2B.1.
 * If a design file legitimately changes, its new hash must be recorded in the
 * same reviewed commit that documents the change in the migration package.
 */
const DESIGN_MIGRATIONS = {
  // Phase 2A reviewed baseline. These must never change.
  '001_schema.sql': '5207d5938696fd0e012125296eb35723d8aaa7cafeca48424dbc211fe25ca9b3',
  '002_security.sql': '8986954237db1cbb500564229678ea6dc4ea15673678b3d59da14438561feb08',
  '003_storage.sql': '1b54e2f35ade27a3494fad0040c68c61b722c96a766c003496a49a20c915e9ad',
  '004_integrity_workflows.sql': 'e3ced92af953c752ae710f12d4deefc8981c27e7a8f6a348386fb9d37efb5c0b',
  '005_concurrency_hardening.sql': '98e55433868b158a64c7f98e0416502a28b587ecde118021dd2fa0f0274ae3d4',
  '006_revision_lineage.sql': '8f427e86b8b3bc143f638849d9fd9a1097cf2b53c11aab054486f20aae81126a',
  // Phase 2B.2 design additions: correction attempts, fork idempotency,
  // ownership/grants and privilege assertions.
  '007_correction_attempts.sql': 'fdd52cbca5a96bbd80d782e75a00aafc319481d7829ac8af511727b8843e5fdf',
  '008_result_fork_idempotency.sql': '02de6a93950c5886c1ab30365b0acce09cdf61780ba09183df2f956548c8e8ab',
  '009_ownership_and_grants.sql': '3afec7f948ceb8229004d145d2b8b3522ec2c9c03b3f5211accf2085689b3e24',
  '010_privilege_verification.sql': 'e1ac306c09e64c664254ef8402a90be62ee41e6076a81e00ee30dfcae2209968',
  // Phase 2B.5: transfer of all 56 SECURITY DEFINER functions to the dedicated
  // least-privilege definer role. Separate from the grant work on purpose.
  '011_definer_ownership_transfer.sql': '0947d828e1da37628a0566f6e4065d7b64f12991af00a8a8692213b83de0f156',
};

/** Files that must never appear in the executable migration directory. */
const EXECUTABLE_DIR = path.join(root, 'supabase', 'migrations');

const failures = [];
const passed = [];

function ok(name, detail = '') {
  passed.push(detail ? `${name} — ${detail}` : name);
}

function fail(name, detail) {
  failures.push(detail ? `${name} — ${detail}` : name);
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function sha256(p) {
  return createHash('sha256').update(await readFile(p)).digest('hex');
}

// 1. Design drafts are pristine.
const designDir = path.join(root, 'supabase', 'design', 'migrations');
for (const [file, expected] of Object.entries(DESIGN_MIGRATIONS)) {
  const full = path.join(designDir, file);
  if (!(await exists(full))) {
    fail(`design draft ${file}`, 'file is missing');
    continue;
  }
  const actual = await sha256(full);
  if (actual !== expected) {
    fail(
      `design draft ${file}`,
      `checksum changed (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…). ` +
        'Design drafts are review artefacts; produce the change as a reviewed executable migration instead.',
    );
  } else {
    ok(`design draft ${file} unchanged`, actual.slice(0, 12) + '…');
  }
}

// 2. No design draft has been promoted to an executable migration.
if (!(await exists(EXECUTABLE_DIR))) {
  ok('supabase/migrations/ absent', 'no executable migration exists yet');
} else {
  const entries = await readdir(EXECUTABLE_DIR);
  const sql = entries.filter((name) => name.toLowerCase().endsWith('.sql'));
  if (sql.length > 0) {
    fail(
      'supabase/migrations/',
      `contains ${sql.length} SQL file(s): ${sql.join(', ')}. ` +
        'Phase 2B.1 is preparation only; executable migrations require the Phase 2B.2 review.',
    );
  } else {
    ok('supabase/migrations/ contains no SQL', 'gate intact');
  }
  const allowed = new Set(['README.md', '.gitkeep']);
  const unexpected = entries.filter((name) => !allowed.has(name));
  if (unexpected.length > 0) {
    fail('supabase/migrations/', `unexpected entries: ${unexpected.join(', ')}`);
  }
}

// 3. config.toml exists, is local-only and secret-free.
const configPath = path.join(root, 'supabase', 'config.toml');
if (!(await exists(configPath))) {
  fail('supabase/config.toml', 'missing');
} else {
  const config = await readFile(configPath, 'utf8');

  if (!/^project_id\s*=\s*"[^"]+"/m.test(config)) {
    fail('supabase/config.toml', 'project_id is not set');
  } else {
    const projectId = config.match(/^project_id\s*=\s*"([^"]+)"/m)[1];
    ok('supabase/config.toml project_id', projectId);
  }

  // A hosted project reference is a 20-character lowercase alphanumeric slug.
  // project_ref is only written by `supabase link`, which must not have happened.
  if (/^\s*project_ref\s*=/m.test(config)) {
    fail('supabase/config.toml', 'contains project_ref; the repository must not be linked to a hosted project');
  } else {
    ok('supabase/config.toml not linked', 'no project_ref');
  }

  // No literal credential-looking values. env(NAME) indirection is fine.
  const secrets = [
    [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, 'a JWT'],
    [/sb_secret_[A-Za-z0-9_-]+/, 'a secret key'],
    [/sb_publishable_[A-Za-z0-9_-]+/, 'a publishable key'],
    [/postgres(?:ql)?:\/\/[^\s"']*:[^\s"'@]+@/, 'a database URL with a password'],
  ];
  const leaked = secrets.filter(([re]) => re.test(config)).map(([, label]) => label);
  if (leaked.length > 0) {
    fail('supabase/config.toml', `contains ${leaked.join(', ')}; use the env(NAME) form instead`);
  } else {
    ok('supabase/config.toml secret-free', 'no literal keys or connection strings');
  }

  // New public tables must not be auto-granted to the Data API roles. Every
  // privilege this project needs is granted explicitly by the reviewed
  // migrations, so the permissive historical default must not come back silently.
  if (!/^\s*auto_expose_new_tables\s*=\s*false\s*$/m.test(config)) {
    fail(
      'supabase/config.toml',
      'api.auto_expose_new_tables must be explicitly false; the permissive default would re-expose new public tables',
    );
  } else {
    ok('supabase/config.toml auto_expose_new_tables false', 'new public tables are not auto-granted');
  }

  // Seeding stays off until reviewed seed data exists.
  const seedBlock = config.match(/\[db\.seed\]([\s\S]*?)(?=\n\[|\s*$)/);
  if (!seedBlock) {
    fail('supabase/config.toml', '[db.seed] section missing');
  } else if (!/^\s*enabled\s*=\s*false\s*$/m.test(seedBlock[1])) {
    fail('supabase/config.toml', 'db.seed must stay disabled until reviewed seed data exists');
  } else {
    ok('supabase/config.toml seeding disabled', 'no unreviewed seed data is applied');
  }
}

// 4. No link state was recorded by the CLI.
for (const marker of ['.temp/project-ref', '.branches']) {
  if (await exists(path.join(root, 'supabase', marker))) {
    fail(`supabase/${marker}`, 'link/branch state present; the project must stay unlinked');
  }
}
ok('no hosted-project link state', 'supabase/.temp/project-ref and .branches are absent');

// Report.
console.log('Migration package guard (Phase 2B.1)\n');
for (const line of passed) console.log(`  ok    ${line}`);
for (const line of failures) console.log(`  FAIL  ${line}`);
console.log(
  `\n${passed.length} check(s) passed, ${failures.length} failed. ` +
    'This guard inspects files only: it does not prove Supabase compatibility.',
);
process.exit(failures.length === 0 ? 0 : 1);
