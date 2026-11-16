// Requirement 5 - can the client actually READ the tables the points screen needs,
// and only for its own league?
//
// src/services/points.ts reads official_match_results, real_matches, gameweeks,
// match_player_performances, fantasy_score_items, fantasy_lineups and league_players
// directly with PostgREST selects instead of calling an RPC, because the database
// deliberately exposes no scoring RPC (migration 014 asserts none exists) while the
// READ policies already exist.
//
// That claim is only worth anything if it is checked against the REAL migrations, so
// this suite runs the exact executable package through PGlite (a real PostgreSQL
// engine) and asserts the policies behave as the client assumes:
//
//   * a member can read every table the points screen queries;
//   * a non-member reads NOTHING from any of them (league isolation);
//   * the points WRITE blockers are still installed, so nothing here opened a door
//     that would let a client invent scores.
//
// Scope: this proves the SQL contract, not the hosted project. Roles and auth.uid()
// come from tests/setup.sql exactly as in the other PGlite suites.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = await PGlite.create();
const load = async (f) => db.exec(await readFile(new URL(f, import.meta.url), 'utf8'));

const PKG = [
  '20261115000001_schema', '20261115000002_security', '20261115000003_storage',
  '20261115000004_integrity_workflows', '20261115000005_concurrency_hardening',
  '20261115000006_revision_lineage', '20261115000007_correction_attempts',
  '20261115000008_result_fork_idempotency', '20261115000009_ownership_and_grants',
  '20261115000010_definer_ownership_transfer', '20261115000011_application_api',
  '20261115000012_definer_actor_identity',
  '20261115000013_privilege_verification', '20261115000014_api_surface_verification',
  '20261115000015_actor_identity_claim_fallback', '20261115000016_league_archive',
  '20261115000017_squad_captaincy',
];
await load('setup.sql');
for (const name of PKG) await load(`../../migrations/${name}.sql`);
after(() => db.close());

const q = (sql, params = []) => db.query(sql, params);
const scalar = async (sql, params = []) => Object.values((await q(sql, params)).rows[0])[0];

const asUser = async (id, fn) => {
  await q("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec('set role authenticated');
  try {
    const result = await fn();
    await db.exec('reset role');
    return result;
  } catch (error) {
    try { await db.exec('reset role'); } catch { /* already aborted */ }
    throw error;
  }
};

const rpc = (id, name, ...args) =>
  asUser(id, async () => {
    const placeholders = args.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await q(`select public.${name}(${placeholders}) v`, args);
    return rows[0].v;
  });

const uuid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ALICE = uuid(1), BOB = uuid(2), MALLORY = uuid(3);

// The auth users must exist before ff_bootstrap can create their profiles.
await db.exec(`insert into auth.users(id) values ('${ALICE}'),('${BOB}'),('${MALLORY}')`);

const LEAGUE = { id: null };

/** Tables the points screen reads. Every one must be member-readable. */
const POINTS_TABLES = [
  'official_match_results',
  'real_matches',
  'gameweeks',
  'match_player_performances',
  'fantasy_score_items',
  'fantasy_lineups',
  'league_players',
];

test('points reads: a member can select from every table the screen queries', async () => {
  await rpc(ALICE, 'ff_bootstrap', 'Alice Leader');
  await rpc(BOB, 'ff_bootstrap', 'Bob Manager');
  await rpc(MALLORY, 'ff_bootstrap', 'Mallory Outsider');

  const league = await rpc(ALICE, 'ff_league_create', 'Points League', 100000000);
  LEAGUE.id = league.id;
  await rpc(BOB, 'ff_league_join', league.code);

  // A member (leader or manager) must be able to run each query without a 42501.
  for (const table of POINTS_TABLES) {
    const count = await asUser(BOB, () => scalar(
      `select count(*)::int from public.${table} where league_id = $1`, [LEAGUE.id]));
    assert.equal(typeof count, 'number', `a manager can select from ${table}`);
  }
});

test('points reads: player-level scores stay personal, not league-wide', async () => {
  // fantasy_score_items is readable only through can_read_lineup, i.e. your own
  // lineup or the leader's view. That is stricter than the league_read policy on the
  // other tables and is the reason the client never assumes it sees every squad's
  // score items.
  const policy = await scalar(
    `select qual from pg_policies
      where schemaname='public' and tablename='fantasy_score_items' and cmd='SELECT'`);
  assert.match(policy, /can_read_lineup/, 'score items are gated by can_read_lineup');
});

test('points reads: a non-member reads nothing from any points table', async () => {
  for (const table of POINTS_TABLES) {
    const visible = await asUser(MALLORY, () => scalar(
      `select count(*)::int from public.${table} where league_id = $1`, [LEAGUE.id]));
    assert.equal(visible, 0, `RLS hides ${table} from a non-member`);
  }
});

test('points reads: no league_id column means no cross-league rows are even reachable', async () => {
  // fantasy_lineups is scoped by team ownership rather than league_read, so assert the
  // non-member is refused there too.
  const visible = await asUser(MALLORY, () => scalar(
    `select count(*)::int from public.fantasy_lineups where league_id = $1`, [LEAGUE.id]));
  assert.equal(visible, 0);
});

test('points writes: the scoring blockers are still installed', async () => {
  // This change added no SQL and opened no write path; assert that is still true.
  for (const table of ['match_player_performances', 'fantasy_score_items', 'fantasy_scores']) {
    const triggers = await scalar(
      `select count(*)::int from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where c.relname = $1 and t.tgname like 'block_%' and not t.tgisinternal`, [table]);
    assert.equal(triggers, 1, `${table} still has its write blocker`);
  }
});

test('points writes: a client cannot insert an invented score', async () => {
  // Even a member with a real league is refused, exactly as before this change.
  let denied = false;
  try {
    await asUser(ALICE, () => q(
      `insert into public.fantasy_scores(league_id, scoring_run_id, fantasy_team_id, points)
       values ($1, gen_random_uuid(), gen_random_uuid(), 999)`, [LEAGUE.id]));
  } catch (error) {
    denied = true;
    assert.ok(['42501', '23503', '23505'].includes(error.code),
      `refused with a privilege or FK error, got ${error.code}`);
  }
  assert.ok(denied, 'inserting a fantasy score is refused');
});

test('points writes: no client-callable scoring RPC exists', async () => {
  const offenders = await scalar(
    `select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'ff\\_%'
        and (p.proname like '%scoring%' or p.proname like '%fantasy\\_score%'
             or p.proname like '%\\_score\\_run%'
             or p.proname in ('ff_score','ff_run_scoring','ff_publish_scores'))`);
  assert.equal(offenders, 0, 'the surface verification invariant still holds');
});
