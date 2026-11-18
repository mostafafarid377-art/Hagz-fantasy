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
  // Forward-only captaincy persistence and partial-squad selection support.
  '017_squad_captaincy.sql': 'd260c92899e425eccec8a501ab63e554c0588276c3539e464b5ba1ec7ca515fa',
  '018_live_match_market_workflow.sql': '1fc188f00962a3ea2fd8dd70357133d75c9c9907f94792f54eb062c13d5edc76',
  '019_optional_match_gameweek.sql': 'c3021373a0028be016a88522c8905e53b815b14e2a0749c4ee51d4d12c7bbf15',
  '020_leader_match_result_finalization.sql': '8dd3a1756902e995c84bf5a65d16c592988b5e468b331f5d68581a78aef19e4d',
  // Phase 4 duplicate-name identity, batch suggestions and transfer history.
  '021_phase4_market_and_transfer_gaps.sql': 'a269f86b4f5ae0244dd033f204b61fc015a7ffb0d1e2b57b2383481f5b473594',
  // Forward-only correction: restore real-team name uniqueness accidentally
  // removed by 021; player-profile names remain non-unique.
  '022_restore_real_team_name_uniqueness.sql': 'eba5ffdd2c7362658912b94f6f4d97f1387f42cab4cf54e5db4620b1e49fc73a',
  '023_match_cancellation_and_atomic_lineup_save.sql': 'f2345df49b182424255ab577e483279c08f1b71c9217e0eecf156c24974957e9',
  // Retry-safe replay for the existing lineup submission RPC; validation and ACL stay intact.
  '024_idempotent_match_lineup_submission.sql': 'efffb36e1d5b0eadc5f186c06b77b7a983735841a54064e5315c1933029bd410',
  // Exposes the existing result-fork lineup source in the member-scoped read model.
  '025_match_result_lineup_source_read_model.sql': 'dbf699caabf7d66fd04583b4fc2e0741c89d98055792206d2837725481411cc7',
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
  // Phase 3 forward-only repair #2 (promoted to executable 015). Supersedes the
  // helper BODY installed by 014; 014 itself stays byte-for-byte unchanged because
  // it is an applied migration and its review hash is history.
  '015_actor_identity_claim_fallback.sql': '491ab3157c285ebdec7d33a3d18af8194cb815e413021c9ae89d486c23413605',
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
  ['20261115000015_actor_identity_claim_fallback.sql', 'design/migrations/015_actor_identity_claim_fallback.sql'],
  ['20261115000016_league_archive.sql', 'design/migrations/016_league_archive.sql'],
  ['20261115000017_squad_captaincy.sql', 'design/migrations/017_squad_captaincy.sql'],
  ['20261115000018_live_match_market_workflow.sql', 'design/migrations/018_live_match_market_workflow.sql'],
  ['20261115000019_optional_match_gameweek.sql', 'design/migrations/019_optional_match_gameweek.sql'],
  ['20261115000020_leader_match_result_finalization.sql', 'design/migrations/020_leader_match_result_finalization.sql'],
  ['20261116210000_phase4_market_and_transfer_gaps.sql', 'design/migrations/021_phase4_market_and_transfer_gaps.sql'],
  ['20261116220000_restore_real_team_name_uniqueness.sql', 'design/migrations/022_restore_real_team_name_uniqueness.sql'],
  ['20261116230000_match_cancellation_and_atomic_lineup_save.sql', 'design/migrations/023_match_cancellation_and_atomic_lineup_save.sql'],
  ['20261116235900_idempotent_match_lineup_submission.sql', 'design/migrations/024_idempotent_match_lineup_submission.sql'],
  ['20261117000000_match_result_lineup_source_read_model.sql', 'design/migrations/025_match_result_lineup_source_read_model.sql'],
  ['20261118000000_operation_receipts.sql', 'design/migrations/027_operation_receipts.sql'],
];

/**
 * Repairs sanctioned to run AFTER the final verification.
 *
 * The rule "the API surface verification runs last" protects the certified
 * privilege posture. Explicit forward-only migrations may follow it: 015 repairs
 * a function body, 016 adds one checked RPC, and 017 adds team-level captaincy
 * columns plus one separately checked RPC. Migration 024 only replaces the
 * existing lineup-submit body, keeps its signature/owner/ACL, and delegates the
 * first submission to the existing validation trigger. Migration 025 only
 * replaces the member-scoped match read-model body and adds an existing lineage
 * value to its JSON output. They are individually reviewed and must remain
 * explicitly allowlisted here rather than relying on a "skip the last file" rule.
 */
const POST_VERIFICATION_REPAIRS = [
  '20261115000015_actor_identity_claim_fallback.sql',
  // 016 is additive: it CREATES one new leader-only function and modifies no
  // existing table, policy, grant, owner or function body, so it cannot
  // invalidate what 013/014 certified. It runs last because it is the newest
  // migration, not because it needs to escape the assertions.
  '20261115000016_league_archive.sql',
  '20261115000017_squad_captaincy.sql',
  '20261115000018_live_match_market_workflow.sql',
  '20261115000019_optional_match_gameweek.sql',
  '20261115000020_leader_match_result_finalization.sql',
  '20261116210000_phase4_market_and_transfer_gaps.sql',
  '20261116220000_restore_real_team_name_uniqueness.sql',
  '20261116230000_match_cancellation_and_atomic_lineup_save.sql',
  '20261116235900_idempotent_match_lineup_submission.sql',
  '20261117000000_match_result_lineup_source_read_model.sql',
  '20261118000000_operation_receipts.sql',
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
  const trailing = expectedNames.slice(apiVerify + 1);
  const unlisted = trailing.filter((n) => !POST_VERIFICATION_REPAIRS.includes(n));
  if (unlisted.length) {
    fail('migration order',
      `the API surface verification must run last, except for reviewed post-verification repairs; unlisted: ${unlisted.join(', ')}`);
  } else {
    ok('API surface verification precedes only sanctioned repairs',
      trailing.length ? `#${apiVerify + 1}, then ${trailing.join(', ')}` : `#${apiVerify + 1} (last)`);
  }

  // A post-verification repair must not touch the surface it runs after. That is a
  // source-level property: 015 may only replace a function body.
  for (const repair of POST_VERIFICATION_REPAIRS) {
    const i = expectedNames.indexOf(repair);
    if (i < 0) { fail('post-verification repair list', `${repair} is not in the package`); continue; }
    if (i <= apiVerify) { fail('post-verification repair list', `${repair} is not after the API verification`); continue; }
    const [, source] = PACKAGE.find(([n]) => n === repair);
    const body = await readFile(path.join(root, 'supabase', source), 'utf8');
    const stripped = body.replace(/--[^\n]*/g, '');
    if (repair === '20261115000017_squad_captaincy.sql') {
      const forbidden = /^\s*(drop\s+(function|policy|table)|create\s+policy|grant\s+.*\bon\s+(table|schema)|revoke\s+.*\bon\s+(table|schema))/im.exec(stripped);
      const hasScopedColumns = /alter\s+table\s+public\.fantasy_teams\s+add\s+column\s+captain_player_id\s+uuid,\s*add\s+column\s+vice_captain_player_id\s+uuid/is.test(stripped);
      const hasAuthenticatedOnlyRpc = /revoke\s+all\s+on\s+function\s+public\.ff_squad_set_captains\(uuid,\s*uuid,\s*uuid\)\s+from\s+public,\s*anon,\s*authenticated\s*;\s*grant\s+execute\s+on\s+function\s+public\.ff_squad_set_captains\(uuid,\s*uuid,\s*uuid\)\s+to\s+authenticated/is.test(stripped);
      if (forbidden) fail(`post-verification migration ${repair}`, `forbidden privilege or destructive DDL: ${forbidden[0].trim().split(/\s+/).slice(0, 3).join(' ')}`);
      else if (!hasScopedColumns) fail(`post-verification migration ${repair}`, 'captaincy columns must be added only to public.fantasy_teams');
      else if (!hasAuthenticatedOnlyRpc) fail(`post-verification migration ${repair}`, 'captaincy RPC must be revoked from PUBLIC/anon/authenticated then granted only to authenticated');
      else ok(`post-verification migration ${repair} is scoped`, 'team columns + authenticated-only RPC; no table grants or policy changes');
    } else if (repair === '20261115000018_live_match_market_workflow.sql') {
      const hasMarketEligibility = /eligibility_kind\s+in\s*\('registered',\s*'temporary',\s*'market'\)/i.test(stripped);
      const validatesMarketLeagueAndActive = /p\.league_id=l and p\.player_id=new\.player_id and p\.active/i.test(stripped);
      const validatesOnSubmit = /mp\.league_id=p\.league_id and mp\.player_id=p\.player_id and mp\.active/i.test(stripped);
      const validatesActiveOrganizer = /lm\.status='active'/i.test(stripped);
      const validatesVenue = /p_venue is null or length\(btrim\(p_venue\)\)=0/i.test(stripped);
      const clientAssignmentPathIsMarketOnly = /new lineup assignments must come from this league market/i.test(stripped);
      const deletesOnlyDraftLineup = /delete from public\.real_match_lineup_players where league_id=p_league and revision_id=p_revision and lineup_id=v_lineup\.id/i.test(stripped);
      const alterStatements = stripped.match(/^\s*alter\s+table[^;]+;/gim) ?? [];
      const scopedEligibilityAlter = alterStatements.length === 1 && /alter table public\.real_match_lineup_players\s+drop constraint real_match_lineup_players_eligibility_kind_check,\s*add constraint real_match_lineup_players_eligibility_kind_check/i.test(alterStatements[0]);
      const forbidden = /^\s*(drop\s+(function|policy|table)|create\s+policy|grant\s+.*\bon\s+(table|schema)|revoke\s+.*\bon\s+(table|schema)|truncate)/im.exec(stripped);
      if (forbidden) fail(`post-verification migration ${repair}`, `forbidden destructive or privilege DDL: ${forbidden[0].trim()}`);
      else if (!hasMarketEligibility || !validatesMarketLeagueAndActive || !validatesOnSubmit) fail(`post-verification migration ${repair}`, 'Market eligibility must be same-league and active at lineup write and submission');
      else if (!validatesActiveOrganizer || !validatesVenue) fail(`post-verification migration ${repair}`, 'Match scheduling must reject inactive organizers and blank venues');
      else if (!clientAssignmentPathIsMarketOnly) fail(`post-verification migration ${repair}`, 'The client lineup RPC must not accept legacy non-Market eligibility modes');
      else if (!deletesOnlyDraftLineup) fail(`post-verification migration ${repair}`, 'Lineup replacement may delete only the editable draft side rows');
      else if (!scopedEligibilityAlter) fail(`post-verification migration ${repair}`, 'Only the lineup eligibility-kind constraint may be expanded');
      else ok(`post-verification migration ${repair} is scoped`, 'same-league Market eligibility; existing authenticated RPC surface and grants retained');
    } else if (repair === '20261115000019_optional_match_gameweek.sql') {
      const alterStatements = stripped.match(/^\s*alter\s+table[^;]+;/gim) ?? [];
      const optionalColumn = alterStatements.length === 1 && /alter\s+table\s+public\.real_matches\s+alter\s+column\s+gameweek_id\s+drop\s+not\s+null/i.test(alterStatements[0]);
      const keepsFk = !/drop\s+constraint[^;]*gameweek/i.test(stripped);
      const retainsRpc = /create\s+or\s+replace\s+function\s+public\.ff_match_create/i.test(stripped);
      const conditionalValidation = /p_gameweek\s+is\s+not\s+null\s+and\s+not\s+exists/i.test(stripped);
      if (!optionalColumn || !keepsFk || !retainsRpc || !conditionalValidation) fail(`post-verification migration ${repair}`, 'must make only the match Gameweek link nullable, retain its FK, and keep the existing create RPC with conditional validation');
      else ok(`post-verification migration ${repair} is scoped`, 'nullable optional link; FK and RPC grants retained');
    } else if (repair === '20261115000020_leader_match_result_finalization.sql') {
      const alterations = stripped.match(/^\s*alter\s+table[^;]+;/gim) ?? [];
      const scopedAlterations = alterations.length === 3 && alterations.every(s => /alter\s+table\s+public\.official_match_results\b/i.test(s));
      const addsFinalizationAudit = /add\s+column\s+finalized_by\s+uuid,\s*add\s+column\s+finalized_at\s+timestamptz/i.test(stripped);
      const autoFinalizes = /insert\s+into\s+public\.match_approvals[\s\S]*?'result','approved',ff_private\.current_actor_id\(\)/i.test(stripped);
      const retainsOfficialAudit = /finalized_by=a\.reviewed_by\s+and\s+new\.finalized_at=a\.reviewed_at/i.test(stripped);
      const removesReviewGate = /result submissions finalize immediately and cannot be reviewed/i.test(stripped);
      const broadOrDestructive = /^\s*(drop\s+(function|policy|table)|create\s+policy|truncate|grant\s+.*\bon\s+(table|schema)|revoke\s+.*\bon\s+(table|schema))/im.exec(stripped);
      if (broadOrDestructive) fail(`post-verification migration ${repair}`, `forbidden destructive or broad privilege change: ${broadOrDestructive[0].trim()}`);
      else if (!scopedAlterations || !addsFinalizationAudit) fail(`post-verification migration ${repair}`, 'schema changes must be limited to finalizer identity/time on official results');
      else if (!autoFinalizes || !retainsOfficialAudit || !removesReviewGate) fail(`post-verification migration ${repair}`, 'result submission must create an audited official result and disable manual result review');
      else ok(`post-verification migration ${repair} is scoped`, 'match-manager authorization, atomic result finalization, immutable correction history');
    } else if (repair === '20261116210000_phase4_market_and_transfer_gaps.sql') {
      const dropsOnlyNameKeys = /alter\s+table\s+public\.real_football_teams\s+drop\s+constraint\s+if\s+exists\s+real_football_teams_league_id_name_key/i.test(stripped)
        && /drop\s+index\s+if\s+exists\s+public\.one_pending_name_per_league/i.test(stripped);
      const batchAuth = /perform\s+ff_private\.require_member\(p_league\)/i.test(stripped);
      const batchLimit = /jsonb_array_length\(p_items\)\s+not\s+between\s+1\s+and\s+50/i.test(stripped);
      const limitedReads = /ff_private\.is_leader\(p_league\)\s+or\s+ft\.manager_id\s*=\s*ff_private\.current_actor_id\(\)/i.test(stripped);
      const grantedOnly = /revoke\s+all\s+on\s+function\s+public\.ff_suggestion_submit_batch\(uuid,\s*jsonb\)\s+from\s+public,\s*anon/i.test(stripped)
        && /revoke\s+all\s+on\s+function\s+public\.ff_transfers\(uuid,\s*integer\)\s+from\s+public,\s*anon/i.test(stripped)
        && /grant\s+execute\s+on\s+function\s+public\.ff_suggestion_submit_batch\(uuid,\s*jsonb\)\s+to\s+authenticated/i.test(stripped)
        && /grant\s+execute\s+on\s+function\s+public\.ff_transfers\(uuid,\s*integer\)\s+to\s+authenticated/i.test(stripped);
      const broadDdl = /^\s*(drop\s+(function|policy|table)|create\s+policy|truncate|grant\s+.*\bon\s+(table|schema)|revoke\s+.*\bon\s+(table|schema))/im.exec(stripped);
      if (broadDdl) fail(`post-verification migration ${repair}`, `forbidden destructive or broad privilege change: ${broadDdl[0].trim()}`);
      else if (!dropsOnlyNameKeys) fail(`post-verification migration ${repair}`, 'must match the historically reviewed Phase 4 DDL; correction 022 separately restores real-team name uniqueness');
      else if (!batchAuth || !batchLimit || !limitedReads || !grantedOnly) fail(`post-verification migration ${repair}`, 'new RPCs must enforce membership, bounded inputs, owner-scoped transfer reads and authenticated-only execute grants');
      else ok(`post-verification migration ${repair} is scoped`, 'adds bounded member-scoped batch/history RPCs; migration 022 restores real-team name uniqueness');
    } else if (repair === '20261116220000_restore_real_team_name_uniqueness.sql') {
      const restoresOriginalKey = /add\s+constraint\s+real_football_teams_league_id_name_key\s+unique\s*\(\s*league_id\s*,\s*name\s*\)/i.test(stripped);
      const refusesAmbiguousDuplicates = /group\s+by\s+league_id\s*,\s*name\s+having\s+count\(\*\)\s*>\s*1/i.test(stripped)
        && /resolve them by ID before retrying/i.test(body);
      const validatesExistingDefinition = /v_constraint\.contype\s*<>\s*'u'/i.test(stripped)
        && /v_columns\s+is\s+distinct\s+from\s+array\s*\[\s*'league_id'\s*,\s*'name'\s*\]/i.test(stripped);
      const noPrivilegeOrDestructiveDdl = !/^\s*(drop\s+(function|policy|table|index)|create\s+policy|grant\b|revoke\b|truncate\b)/im.test(stripped);
      if (!restoresOriginalKey || !refusesAmbiguousDuplicates || !validatesExistingDefinition) fail(`post-verification migration ${repair}`, 'must safely and idempotently restore the exact original real-team name key, refusing ambiguous duplicates');
      else if (!noPrivilegeOrDestructiveDdl) fail(`post-verification migration ${repair}`, 'must not alter privileges or perform destructive DDL');
      else ok(`post-verification migration ${repair} is scoped`, 'restores only real-team name uniqueness; leaves same-name player identities unchanged');
    } else if (repair === '20261116230000_match_cancellation_and_atomic_lineup_save.sql') {
      const atomicRpc = /create\s+or\s+replace\s+function\s+public\.ff_match_save_lineups\s*\([^)]*\)\s*returns\s+jsonb/i.test(stripped)
        && /public\.ff_match_set_lineup\(p_league,p_revision,m\.team_a_id,p_team_a_players\)[\s\S]*public\.ff_match_set_lineup\(p_league,p_revision,m\.team_b_id,p_team_b_players\)/i.test(stripped);
      const cancelRpc = /create\s+or\s+replace\s+function\s+public\.ff_match_cancel\s*\([^)]*\)\s*returns\s+jsonb/i.test(stripped)
        && /ff_private\.is_match_organizer\(p_league,p_match\)/i.test(stripped)
        && /match_cancelled/i.test(stripped);
      const boundedReason = /length\(btrim\(p_reason\)\)\s+not\s+between\s+1\s+and\s+500/i.test(stripped);
      const readModel = /'is_cancelled',\s*\(m\.cancelled_at\s+is\s+not\s+null\)/i.test(stripped);
      const scopedColumns = /alter\s+table\s+public\.real_matches[\s\S]*?add\s+column\s+cancelled_at[\s\S]*?add\s+column\s+cancelled_by[\s\S]*?add\s+column\s+cancel_reason/i.test(stripped);
      const authenticatedOnly = /revoke\s+all\s+on\s+function\s+public\.ff_match_save_lineups\(uuid,\s*uuid,\s*jsonb,\s*jsonb\)\s+from\s+public,\s*anon,\s*authenticated/i.test(stripped)
        && /grant\s+execute\s+on\s+function\s+public\.ff_match_save_lineups\(uuid,\s*uuid,\s*jsonb,\s*jsonb\)\s+to\s+authenticated/i.test(stripped)
        && /grant\s+execute\s+on\s+function\s+public\.ff_match_cancel\(uuid,\s*uuid,\s*text\)\s+to\s+authenticated/i.test(stripped);
      if (!atomicRpc || !cancelRpc || !boundedReason || !readModel || !scopedColumns || !authenticatedOnly) fail(`post-verification migration ${repair}`, 'must provide atomic two-team saves and authorized, audited cancellation with bounded reason and authenticated-only RPCs');
      else ok(`post-verification migration ${repair} is scoped`, 'adds cancellation metadata and two authenticated workflow RPCs; no destructive or broad privilege DDL');
    } else if (repair === '20261117000000_match_result_lineup_source_read_model.sql') {
      const replacesOnlyReadRpc = (stripped.match(/^\s*create\s+or\s+replace\s+function\s+/gim) ?? []).length === 1
        && /create\s+or\s+replace\s+function\s+public\.ff_matches\(p_league\s+uuid\)\s+returns\s+jsonb[\s\S]*?security\s+definer\s+set\s+search_path\s*=\s*pg_catalog\s*,\s*ff_private/i.test(stripped);
      const memberCheck = /perform\s+ff_private\.require_member\(p_league\)/i.test(stripped);
      const exposesExistingLineage = /'based_on_lineup_revision_id'\s*,\s*v\.based_on_lineup_revision_id/i.test(stripped);
      const noSurfaceChanges = !/^\s*(drop\s+|alter\s+table|create\s+policy|grant\s+|revoke\s+|insert\s+into|update\s+|delete\s+from)/im.test(stripped);
      if (!replacesOnlyReadRpc || !memberCheck || !exposesExistingLineage || !noSurfaceChanges) fail(`post-verification migration ${repair}`, 'must replace only the existing member-scoped ff_matches read-model body and expose result-lineup source lineage without privilege/schema changes');
      else ok(`post-verification migration ${repair} is scoped`, 'adds existing result-lineup source ID to the ff_matches JSON read model; owner and ACL preserved');
    } else if (repair === '20261118000000_operation_receipts.sql') {
      const bounded = /create\s+table\s+ff_private\.operation_receipts/i.test(stripped)
        && /revoke\s+all\s+on\s+ff_private\.operation_receipts\s+from\s+public,\s*anon,\s*authenticated/i.test(stripped)
        && /primary\s+key\s*\(actor_id,\s*operation_id\)/i.test(stripped)
        && /grant\s+execute\s+on\s+function\s+public\.ff_operation_register/i.test(stripped);
      if (!bounded) fail(`post-verification migration ${repair}`, 'missing receipt isolation or bounded RPC grants');
      else ok(`post-verification migration ${repair} is scoped`, 'adds actor-scoped operation receipts');
    } else {
      const surfaceDdl = /^\s*(drop\s+function|drop\s+policy|create\s+policy|drop\s+table|alter\s+table|grant\s+.*\bon\s+(table|schema)|revoke\s+.*\bon\s+(table|schema))/im.exec(stripped);
      if (surfaceDdl) {
        fail(`post-verification repair ${repair}`,
          `must not change the certified surface, found "${surfaceDdl[0].trim().split(/\s+/).slice(0, 3).join(' ')}"`);
      } else {
        ok(`post-verification repair ${repair} is body-only`, path.basename(source));
      }
    }
  }

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
