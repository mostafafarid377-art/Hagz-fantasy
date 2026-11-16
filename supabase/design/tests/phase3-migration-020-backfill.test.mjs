// Regression for migration 020 on a database that already has official results.
// This is an offline PGlite migration test, not hosted Supabase coverage.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = await PGlite.create();
const load = async (path) => db.exec(await readFile(new URL(path, import.meta.url), 'utf8'));
const previous = [
  '20261115000001_schema', '20261115000002_security', '20261115000003_storage',
  '20261115000004_integrity_workflows', '20261115000005_concurrency_hardening',
  '20261115000006_revision_lineage', '20261115000007_correction_attempts',
  '20261115000008_result_fork_idempotency', '20261115000009_ownership_and_grants',
  '20261115000010_definer_ownership_transfer', '20261115000011_application_api',
  '20261115000012_definer_actor_identity', '20261115000013_privilege_verification',
  '20261115000014_api_surface_verification', '20261115000015_actor_identity_claim_fallback',
  '20261115000016_league_archive', '20261115000017_squad_captaincy',
  '20261115000018_live_match_market_workflow', '20261115000019_optional_match_gameweek',
];
await load('setup.sql');
for (const name of previous) await load(`../../migrations/${name}.sql`);
after(() => db.close());

test('migration 020 backfills existing official results without invoking the old Leader-only guard', async () => {
  const league = '10000000-0000-4000-8000-000000000001';
  const match = '20000000-0000-4000-8000-000000000001';
  const revision = '30000000-0000-4000-8000-000000000001';
  const approval = '40000000-0000-4000-8000-000000000001';
  const actor = '50000000-0000-4000-8000-000000000001';
  const result = '60000000-0000-4000-8000-000000000001';
  const reviewedAt = '2026-11-10T12:34:56Z';

  // Seed a historical approved pointer as if it existed before this migration.
  // Replica mode is limited to this disposable PGlite test so the fixture can
  // represent persisted data without invoking the runtime workflow triggers.
  await db.exec('set session_replication_role = replica');
  await db.query(`insert into public.league_members(league_id,user_id,role,status)
    values ($1,$2,'manager','active')`, [league, actor]);
  await db.query(`insert into public.match_approvals
    (id,league_id,match_id,submission_id,revision_id,kind,decision,reviewed_by,reviewed_at)
    values ($1,$2,$3,$4,$5,'result','approved',$6,$7)`,
    [approval, league, match, '70000000-0000-4000-8000-000000000001', revision, actor, reviewedAt]);
  await db.query(`insert into public.official_match_results
    (id,league_id,match_id,revision_id,approval_id,is_current)
    values ($1,$2,$3,$4,$5,true)`, [result, league, match, revision, approval]);
  await db.exec('set session_replication_role = origin');

  await load('../../migrations/20261115000020_leader_match_result_finalization.sql');

  const backfilled = (await db.query(`select finalized_by,finalized_at
    from public.official_match_results where id=$1`, [result])).rows[0];
  assert.equal(backfilled.finalized_by, actor);
  assert.equal(new Date(backfilled.finalized_at).toISOString(), new Date(reviewedAt).toISOString());
});
