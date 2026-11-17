// Offline integration tests for draft migration 026. PGlite is an isolated local
// PostgreSQL engine; this suite never connects to or mutates a hosted project.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = await PGlite.create();
const load = async (path) => db.exec(await readFile(new URL(path, import.meta.url), 'utf8'));
const packageNames = [
  '20261115000001_schema', '20261115000002_security', '20261115000003_storage',
  '20261115000004_integrity_workflows', '20261115000005_concurrency_hardening',
  '20261115000006_revision_lineage', '20261115000007_correction_attempts',
  '20261115000008_result_fork_idempotency', '20261115000009_ownership_and_grants',
  '20261115000010_definer_ownership_transfer', '20261115000011_application_api',
  '20261115000012_definer_actor_identity', '20261115000013_privilege_verification',
  '20261115000014_api_surface_verification', '20261115000015_actor_identity_claim_fallback',
  '20261115000016_league_archive', '20261115000017_squad_captaincy',
  '20261115000018_live_match_market_workflow', '20261115000019_optional_match_gameweek',
  '20261115000020_leader_match_result_finalization', '20261116210000_phase4_market_and_transfer_gaps',
  '20261116220000_restore_real_team_name_uniqueness', '20261116230000_match_cancellation_and_atomic_lineup_save',
  '20261116235900_idempotent_match_lineup_submission', '20261117000000_match_result_lineup_source_read_model',
];
await load('setup.sql');
for (const name of packageNames) await load(`../../migrations/${name}.sql`);
await load('../migrations/026_squad_assignments_and_formats.sql');
after(() => db.close());

const q = (sql, params = []) => db.query(sql, params);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ALICE = uuid(1), BOB = uuid(2), MALLORY = uuid(3);
await db.exec(`insert into auth.users(id) values ('${ALICE}'),('${BOB}'),('${MALLORY}')`);

const asUser = async (id, action) => {
  await q("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec('set role authenticated');
  try { const result = await action(); await db.exec('reset role'); return result; }
  catch (error) { try { await db.exec('reset role'); } catch { /* aborted */ } throw error; }
};
const rpc = (id, name, ...args) => asUser(id, async () => {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(',');
  return (await q(`select public.${name}(${placeholders}) value`, args)).rows[0].value;
});

const createLeagueWithSquad = async (format, positionCounts) => {
  const name = `${format} League`;
  const league = await rpc(ALICE, 'ff_league_create', name, 100000000, format);
  await rpc(BOB, 'ff_league_join', league.code);
  const market = [];
  for (const [position, count] of positionCounts) {
    for (let i = 0; i < count; i++) {
      market.push(await rpc(ALICE, 'ff_market_upsert_player', league.id,
        `${format} ${position} ${i + 1}`, position, 1000000, 70 + i));
    }
  }
  for (const player of market) await rpc(BOB, 'ff_squad_buy', league.id, player.id);
  return { league, market };
};

test('7-a-side durable assignments, bench order, substitutions, captain recovery, transfers, and isolation', async () => {
  await rpc(ALICE, 'ff_bootstrap', 'Alice');
  await rpc(BOB, 'ff_bootstrap', 'Bob');
  await rpc(MALLORY, 'ff_bootstrap', 'Mallory');
  const { league, market } = await createLeagueWithSquad('7-a-side', [['GK', 2], ['DEF', 3], ['MID', 3], ['FWD', 2]]);
  const boot = await rpc(BOB, 'ff_bootstrap');
  assert.equal(boot.leagues.find((item) => item.league_id === league.id).match_format, '7-a-side');
  assert.equal((await rpc(BOB, 'ff_squad', league.id)).match_format, '7-a-side');

  const by = (pos, i) => market.filter((p) => p.position === pos)[i].id;
  const starters = [by('GK', 0), by('DEF', 0), by('DEF', 1), by('DEF', 2), by('MID', 0), by('MID', 1), by('FWD', 0)];
  const bench = [by('GK', 1), by('MID', 2)];
  const unassigned = [by('FWD', 1)];
  const before = await rpc(BOB, 'ff_squad', league.id);
  const captain = starters[1], vice = starters[4];
  await rpc(BOB, 'ff_squad_save_assignments', league.id, starters, bench, unassigned, captain, vice, null, before.assignment_revision);

  const saved = await rpc(BOB, 'ff_squad', league.id);
  assert.equal(saved.formation, '3-2-1');
  assert.deepEqual(saved.players.filter((p) => p.slot !== null).sort((a, b) => a.slot - b.slot).map((p) => p.league_player_id), [...starters, ...bench]);
  assert.equal(saved.players.find((p) => p.league_player_id === unassigned[0]).slot, null);
  assert.equal(saved.captain_id, captain);
  assert.equal(saved.vice_captain_id, vice);

  // Replacing one defender with the second midfielder changes the shape to 2-3-1,
  // which remains legal. The unrelated unassigned forward is preserved.
  const replaced = await rpc(BOB, 'ff_squad_substitute', league.id, captain, bench[1], saved.assignment_revision);
  assert.equal(replaced.squad.formation, '2-3-1');
  assert.equal(replaced.squad.players.find((p) => p.league_player_id === unassigned[0]).slot, null);
  assert.equal(replaced.squad.captain_id, vice, 'eligible vice becomes captain when the previous captain is benched');
  assert.equal(replaced.squad.players.find((p) => p.league_player_id === captain).slot, 9);

  const replay = await rpc(BOB, 'ff_squad_substitute', league.id, captain, bench[1], saved.assignment_revision);
  assert.equal(replay.replayed, true);
  assert.equal(replay.squad.formation, '2-3-1', 'retry does not reverse the substitution');

  const replacementKeeper = await rpc(ALICE, 'ff_market_upsert_player', league.id, 'Backup Keeper', 'GK', 1000000, 75);
  const starts = new Date(Date.now() + 60000).toISOString();
  const ends = new Date(Date.now() + 60 * 86400000).toISOString();
  await rpc(ALICE, 'ff_season_create', league.id, 'Season', starts, ends, 1);
  const transfer = await rpc(BOB, 'ff_squad_transfer', league.id, bench[0], replacementKeeper.id);
  assert.equal(transfer.slot, 8);
  const afterTransfer = await rpc(BOB, 'ff_squad', league.id);
  assert.equal(afterTransfer.players.find((p) => p.league_player_id === replacementKeeper.id).slot, 8,
    'same-position transfer keeps the exact starter/bench slot');
  assert.equal(afterTransfer.captain_id, replay.squad.captain_id);
  assert.equal((await rpc(BOB, 'ff_transfers', league.id)).length, 1, 'history remains recorded');

  await assert.rejects(() => rpc(MALLORY, 'ff_squad', league.id), (error) => error.code === '42501');
  await assert.rejects(() => rpc(MALLORY, 'ff_squad_save_assignments', league.id, starters, bench, unassigned, captain, vice, null, saved.assignment_revision), (error) => error.code === '42501');
});

test('5-a-side exact roster and formation validation; deterministic captaincy permits empty caller fields', async () => {
  const { league, market } = await createLeagueWithSquad('5-a-side', [['GK', 2], ['DEF', 2], ['MID', 2], ['FWD', 1]]);
  const by = (pos, i) => market.filter((p) => p.position === pos)[i].id;
  const starters = [by('GK', 0), by('DEF', 0), by('DEF', 1), by('MID', 0), by('FWD', 0)];
  const bench = [by('GK', 1), by('MID', 1)];
  const before = await rpc(BOB, 'ff_squad', league.id);
  await rpc(BOB, 'ff_squad_save_assignments', league.id, starters, bench, [], null, null, null, before.assignment_revision);
  const assigned = await rpc(BOB, 'ff_squad', league.id);
  assert.equal(assigned.match_format, '5-a-side');
  assert.equal(assigned.formation, '2-1-1');
  assert.ok(assigned.captain_id && assigned.vice_captain_id, 'server selects deterministic captaincy when omitted');

  await assert.rejects(
    () => rpc(BOB, 'ff_squad_save_assignments', league.id,
      [by('GK', 0), by('DEF', 0), by('DEF', 1), by('MID', 0), by('MID', 1)],
      [by('GK', 1), by('FWD', 0)], [], assigned.captain_id, assigned.vice_captain_id, null, assigned.assignment_revision),
    (error) => error.code === '23514',
  );
});

test('7-a-side legal shape validation rejects non-catalog lineups', async () => {
  const { league, market } = await createLeagueWithSquad('7-a-side', [['GK', 2], ['DEF', 3], ['MID', 3], ['FWD', 2]]);
  const by = (pos, i) => market.filter((p) => p.position === pos)[i].id;
  const before = await rpc(BOB, 'ff_squad', league.id);
  await assert.rejects(
    () => rpc(BOB, 'ff_squad_save_assignments', league.id,
      [by('GK', 0), by('DEF', 0), by('MID', 0), by('MID', 1), by('MID', 2), by('FWD', 0), by('FWD', 1)],
      [by('GK', 1), by('DEF', 1), by('DEF', 2)], [], null, null, null, before.assignment_revision),
    (error) => error.code === '23514',
  );
});
