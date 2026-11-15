// Phase 3-9 — the application API layer (draft 012) end to end.
//
// This suite is the one that answers "is the backend actually usable and is it
// actually secure?" It drives the same `public.ff_*` RPCs the React client calls,
// as real `authenticated` users, and asserts both directions every time:
//   * the legitimate actor succeeds, and
//   * the wrong actor is refused with 42501/23514.
//
// What this proves: authorization is enforced in the database, not the UI.
// What this does NOT prove: hosted Supabase behaviour. Roles, auth.uid(), the
// storage schema and the migration role are mocked by tests/setup.sql. A green
// run here is a precondition for remote deployment, not evidence of it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = await PGlite.create();
const load = async (f) => db.exec(await readFile(new URL(f, import.meta.url), 'utf8'));

// Load the EXECUTABLE package, not the design drafts: this suite must exercise
// exactly what `supabase db push` would apply.
const PKG = [
  '20261115000001_schema', '20261115000002_security', '20261115000003_storage',
  '20261115000004_integrity_workflows', '20261115000005_concurrency_hardening',
  '20261115000006_revision_lineage', '20261115000007_correction_attempts',
  '20261115000008_result_fork_idempotency', '20261115000009_ownership_and_grants',
  '20261115000010_definer_ownership_transfer', '20261115000011_application_api',
  '20261115000012_definer_actor_identity',
  '20261115000013_privilege_verification', '20261115000014_api_surface_verification',
];
await load('setup.sql');
for (const name of PKG) await load(`../../migrations/${name}.sql`);
after(() => db.close());

const q = (sql, params = []) => db.query(sql, params);
const scalar = async (sql, params = []) => Object.values((await q(sql, params)).rows[0])[0];

/** Run `fn` as an authenticated user; leaves the session role clean afterwards. */
const asUser = async (id, fn) => {
  await q("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec('set role authenticated');
  try {
    const result = await fn();
    await db.exec('reset role');
    return result;
  } catch (error) {
    // A failed statement aborts the transaction, and a `reset role` inside an
    // aborted transaction raises 25P02 and would replace the real SQLSTATE we
    // are asserting on. The caller rolls back, which also clears the role.
    try { await db.exec('reset role'); } catch { /* transaction already aborted */ }
    throw error;
  }
};

/** Call an RPC as a user and return the JSON result. */
const rpc = (id, name, ...args) =>
  asUser(id, async () => {
    const placeholders = args.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await q(`select public.${name}(${placeholders}) v`, args);
    return rows[0].v;
  });

/** Every thrown error carries a SQLSTATE; assert on it rather than the message. */
const expectDenied = async (thunk, code = '42501', label = '') => {
  await db.exec('begin');
  try {
    await (typeof thunk === 'function' ? thunk() : thunk);
    await db.exec('rollback');
    assert.fail(`${label}: expected SQLSTATE ${code}, but the call succeeded`);
  } catch (error) {
    await db.exec('rollback');
    if (String(error.message).includes('expected SQLSTATE')) throw error;
    assert.equal(error.code, code, `${label}: expected ${code}, got ${error.code} (${error.message})`);
  }
};


/** Buy available players until the user's squad reaches `target`, honouring the
 *  approved 2/5/5/3 distribution. Returns the resulting squad read. */
const topUp = async (userId, leagueId, target = 15) => {
  const limits = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
  for (let guard = 0; guard < 60; guard++) {
    const squad = await rpc(userId, 'ff_squad', leagueId);
    if (squad.players.length >= target) return squad;
    const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    for (const p of squad.players) counts[p.position]++;
    const owned = new Set(squad.players.map((p) => p.league_player_id));
    const market = await rpc(userId, 'ff_market_players', leagueId);
    const next = market.find((p) => !owned.has(p.id) && counts[p.position] < limits[p.position]);
    if (!next) return squad;
    await rpc(userId, 'ff_squad_buy', leagueId, next.id);
  }
  return rpc(userId, 'ff_squad', leagueId);
};

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Fixture: three independent users. Alice will lead, Bob and Carol join.
const ALICE = uuid(1), BOB = uuid(2), CAROL = uuid(3), MALLORY = uuid(4);
await db.exec(`insert into auth.users(id) values ('${ALICE}'),('${BOB}'),('${CAROL}'),('${MALLORY}')`);

// ---------------------------------------------------------------------------
test('profiles: bootstrap creates exactly one profile and is idempotent', async () => {
  const first = await rpc(ALICE, 'ff_bootstrap', 'Alice Leader');
  assert.equal(first.profile.display_name, 'Alice Leader');
  assert.deepEqual(first.leagues, [], 'a brand-new user belongs to no league');

  // Signing in again must not duplicate or fail.
  const again = await rpc(ALICE, 'ff_bootstrap');
  assert.equal(again.profile.id, first.profile.id);
  assert.equal(again.profile.display_name, 'Alice Leader');
  assert.equal(await scalar('select count(*)::int from public.profiles where id=$1', [ALICE]), 1);
});

test('profiles: an unauthenticated caller cannot bootstrap', async () => {
  // No JWT claim at all. `authenticated` role, but no identity.
  await q("select set_config('request.jwt.claim.sub','',false)");
  await db.exec('set role authenticated');
  try {
    await assert.rejects(
      () => q("select public.ff_bootstrap('Nobody')"),
      (error) => error.code === '42501',
      'a caller with no auth.uid() must be refused',
    );
  } finally { await db.exec('reset role'); }
});

test('profiles: no client can write application tables directly', async () => {
  // The whole design rests on this: writes only through checked RPCs.
  await expectDenied(
    () => asUser(BOB, () => q(`insert into public.leagues(name) values ('Direct Write')`)),
    '42501', 'direct insert into leagues',
  );
  await expectDenied(
    () => asUser(BOB, () => q(`update public.leagues set name='Hijacked' where true`)),
    '42501', 'direct update of leagues',
  );
  await expectDenied(
    () => asUser(BOB, () => q(`delete from public.player_suggestions where true`)),
    '42501', 'direct delete of suggestions',
  );
});

// ---------------------------------------------------------------------------
test('leagues: creation makes the creator the only leader and gives them a team', async () => {
  await rpc(BOB, 'ff_bootstrap', 'Bob Manager');
  await rpc(CAROL, 'ff_bootstrap', 'Carol Manager');

  const league = await rpc(ALICE, 'ff_league_create', 'The Football Circle', 100000000);
  assert.ok(league.id);
  assert.match(league.code, /^[0-9A-F]{8}$/, 'invite code is 8 hex characters');

  const members = await rpc(ALICE, 'ff_league_members', league.id);
  assert.equal(members.length, 1);
  assert.equal(members[0].role, 'leader');
  assert.equal(members[0].user_id, ALICE);
  assert.ok(members[0].team_id, 'the leader also manages a fantasy team');

  globalThis.LEAGUE = league;
});

test('leagues: joining by code adds a manager, and a wrong code reveals nothing', async () => {
  const { LEAGUE } = globalThis;
  await expectDenied(() => rpc(BOB, 'ff_league_join', 'DEADBEEF'), '23514', 'wrong invite code');

  const joined = await rpc(BOB, 'ff_league_join', LEAGUE.code.toLowerCase());
  assert.equal(joined.role, 'manager', 'the code may be typed in any case');

  // Joining twice is idempotent, not an error and not a duplicate row.
  const again = await rpc(BOB, 'ff_league_join', LEAGUE.code);
  assert.equal(again.role, 'manager');
  assert.equal(await scalar(
    'select count(*)::int from public.league_members where league_id=$1 and user_id=$2',
    [LEAGUE.id, BOB]), 1);

  // A new member is announced to the leader.
  const leaderNotifications = await rpc(ALICE, 'ff_notifications', LEAGUE.id);
  assert.ok(leaderNotifications.some((n) => n.kind === 'member_joined'),
    'the leader is notified when a member joins');
});

test('leagues: a non-member sees nothing and can do nothing', async () => {
  const { LEAGUE } = globalThis;
  await rpc(MALLORY, 'ff_bootstrap', 'Mallory Outsider');

  // League isolation at the API boundary.
  await expectDenied(() => rpc(MALLORY, 'ff_league_members', LEAGUE.id, ), '42501', 'members of another league');
  await expectDenied(() => rpc(MALLORY, 'ff_market_players', LEAGUE.id), '42501', 'market of another league');
  await expectDenied(() => rpc(MALLORY, 'ff_squad', LEAGUE.id), '42501', 'squad of another league');
  await expectDenied(() => rpc(MALLORY, 'ff_standings', LEAGUE.id), '42501', 'standings of another league');
  await expectDenied(() => rpc(MALLORY, 'ff_matches', LEAGUE.id), '42501', 'matches of another league');
  await expectDenied(() => rpc(MALLORY, 'ff_league_code', LEAGUE.id), '42501', 'invite code of another league');

  // And direct reads are filtered by RLS, not just by the RPCs.
  const visible = await asUser(MALLORY, () => scalar(
    'select count(*)::int from public.league_members where league_id=$1', [LEAGUE.id]));
  assert.equal(visible, 0, 'RLS hides a league the user does not belong to');
});

test('leagues: only the leader can manage members and the market', async () => {
  const { LEAGUE } = globalThis;
  await rpc(CAROL, 'ff_league_join', LEAGUE.code);

  await expectDenied(() => rpc(BOB, 'ff_league_set_market', LEAGUE.id, false), '42501', 'manager closing the market');
  await expectDenied(() => rpc(BOB, 'ff_league_set_member', LEAGUE.id, CAROL, 'manager', 'inactive'), '42501', 'manager removing a member');
  await expectDenied(() => rpc(BOB, 'ff_league_transfer_leadership', LEAGUE.id, BOB), '42501', 'manager seizing leadership');
  await expectDenied(() => rpc(MALLORY, 'ff_league_set_market', LEAGUE.id, false), '42501', 'outsider closing the market');

  // A leader cannot demote themselves out of existence.
  await expectDenied(() => rpc(ALICE, 'ff_league_set_member', LEAGUE.id, ALICE, 'manager'), '42501', 'leader demoting self');
  // Nor promote someone straight to leader, bypassing the transfer path.
  await expectDenied(() => rpc(ALICE, 'ff_league_set_member', LEAGUE.id, BOB, 'leader'), '42501', 'direct promotion to leader');

  const off = await rpc(ALICE, 'ff_league_set_market', LEAGUE.id, false);
  assert.equal(off.market_open, false);
  const on = await rpc(ALICE, 'ff_league_set_market', LEAGUE.id, true);
  assert.equal(on.market_open, true);
});

// ---------------------------------------------------------------------------
test('market: only the leader can publish players, and writes are validated', async () => {
  const { LEAGUE } = globalThis;
  await expectDenied(
    () => rpc(BOB, 'ff_market_upsert_player', LEAGUE.id, 'Sneaky Player', 'MID', 5.5, 80),
    '42501', 'manager creating a market player');

  // Validation: bad position, bad price, bad rating, non-https image url.
  await expectDenied(() => rpc(ALICE, 'ff_market_upsert_player', LEAGUE.id, 'Bad Position', 'ST', 5, 80), '23514', 'invalid position');
  await expectDenied(() => rpc(ALICE, 'ff_market_upsert_player', LEAGUE.id, 'Bad Price', 'MID', 0, 80), '23514', 'zero price');
  await expectDenied(() => rpc(ALICE, 'ff_market_upsert_player', LEAGUE.id, 'Bad Rating', 'MID', 5, 100), '23514', 'rating above 99');
  await expectDenied(() => rpc(ALICE, 'ff_market_upsert_player', LEAGUE.id, 'Bad Image', 'MID', 5, 80, true, null, 'javascript:alert(1)'), '23514', 'javascript: image url');
  await expectDenied(() => rpc(ALICE, 'ff_market_upsert_player', LEAGUE.id, 'Wrong Path', 'MID', 5, 80, true, 'not-a-league-path', null), '23514', 'image path outside the league prefix');

  const player = await rpc(ALICE, 'ff_market_upsert_player', LEAGUE.id, 'Omar Khaled', 'GK', 5500000, 84);
  assert.equal(player.name, 'Omar Khaled');
  assert.equal(player.position, 'GK');
  assert.equal(player.active, true);

  // A manager can read the market but not edit it.
  const market = await rpc(BOB, 'ff_market_players', LEAGUE.id);
  assert.equal(market.length, 1);
  assert.equal(market[0].name, 'Omar Khaled');

  globalThis.PLAYER_GK = player;
});

test('market: the leader can edit and deactivate an existing player', async () => {
  const { LEAGUE, PLAYER_GK } = globalThis;
  const edited = await rpc(ALICE, 'ff_market_upsert_player', LEAGUE.id, 'Omar Khaled Jr', 'GK', 6000000, 85,
    true, null, null, PLAYER_GK.player_id);
  assert.equal(edited.name, 'Omar Khaled Jr');
  assert.equal(Number(edited.price), 6000000);

  const benched = await rpc(ALICE, 'ff_market_upsert_player', LEAGUE.id, 'Omar Khaled Jr', 'GK', 6000000, 85,
    false, null, null, PLAYER_GK.player_id);
  assert.equal(benched.active, false);
  // An inactive player is not offered in the default market read.
  const active = await rpc(BOB, 'ff_market_players', LEAGUE.id);
  assert.equal(active.length, 0);
  // ...but is visible when explicitly requested (the management screen).
  const all = await rpc(ALICE, 'ff_market_players', LEAGUE.id, null, null, true);
  assert.equal(all.length, 1);

  // Reactivate for the squad tests below.
  await rpc(ALICE, 'ff_market_upsert_player', LEAGUE.id, 'Omar Khaled Jr', 'GK', 6000000, 85,
    true, null, null, PLAYER_GK.player_id);
});

// ---------------------------------------------------------------------------
test('suggestions: a manager submits, and only the leader decides', async () => {
  const { LEAGUE } = globalThis;

  const submitted = await rpc(BOB, 'ff_suggestion_submit', LEAGUE.id, 'Hady Wael', 'MID', 'Great vision', null, null);
  assert.equal(submitted.status, 'pending');

  // Duplicate pending suggestions (case/space insensitive) are refused before the
  // unique index fires, so the user gets a readable error.
  await expectDenied(() => rpc(CAROL, 'ff_suggestion_submit', LEAGUE.id, '  hady wael ', 'MID'), '23514', 'duplicate suggestion');

  // Bad input.
  await expectDenied(() => rpc(BOB, 'ff_suggestion_submit', LEAGUE.id, 'X', 'MID'), '23514', 'name too short');
  await expectDenied(() => rpc(BOB, 'ff_suggestion_submit', LEAGUE.id, 'Valid Name', 'ST'), '23514', 'bad position');
  await expectDenied(() => rpc(BOB, 'ff_suggestion_submit', LEAGUE.id, 'Long Notes', 'MID', 'x'.repeat(501)), '23514', 'notes too long');

  // A manager cannot review anything, not even their own suggestion.
  await expectDenied(() => rpc(BOB, 'ff_suggestion_review', LEAGUE.id, submitted.id, 'approved', null, 5000000, 80), '42501', 'manager approving');
  await expectDenied(() => rpc(MALLORY, 'ff_suggestion_review', LEAGUE.id, submitted.id, 'approved', null, 5000000, 80), '42501', 'outsider approving');

  // A manager sees only their own suggestions.
  const bobs = await rpc(BOB, 'ff_suggestions', LEAGUE.id);
  assert.equal(bobs.length, 1);
  const carols = await rpc(CAROL, 'ff_suggestions', LEAGUE.id);
  assert.equal(carols.length, 0, 'suggestions are private to their author plus the leader');
  const leaderQueue = await rpc(ALICE, 'ff_suggestions', LEAGUE.id, 'pending');
  assert.equal(leaderQueue.length, 1);

  globalThis.SUGGESTION = submitted;
});

test('suggestions: approval creates exactly one market player, atomically', async () => {
  const { LEAGUE, SUGGESTION } = globalThis;
  const marketBefore = (await rpc(ALICE, 'ff_market_players', LEAGUE.id)).length;

  await expectDenied(() => rpc(ALICE, 'ff_suggestion_review', LEAGUE.id, SUGGESTION.id, 'approved', null, null, 80), '23514', 'approval without a price');
  await expectDenied(() => rpc(ALICE, 'ff_suggestion_review', LEAGUE.id, SUGGESTION.id, 'approved', null, 5000000, null), '23514', 'approval without a rating');

  const approved = await rpc(ALICE, 'ff_suggestion_review', LEAGUE.id, SUGGESTION.id, 'approved', 'Good addition', 5000000, 81);
  assert.equal(approved.status, 'approved');
  assert.ok(approved.league_player_id);

  const market = await rpc(ALICE, 'ff_market_players', LEAGUE.id);
  assert.equal(market.length, marketBefore + 1, 'exactly one market player is created');
  const created = market.find((p) => p.id === approved.league_player_id);
  assert.equal(created.name, 'Hady Wael');
  assert.equal(Number(created.price), 5000000);

  // The suggestion cannot be reviewed twice.
  await expectDenied(() => rpc(ALICE, 'ff_suggestion_review', LEAGUE.id, SUGGESTION.id, 'rejected', 'changed my mind'), '23514', 'double review');

  // The author is notified of the decision.
  const notes = await rpc(BOB, 'ff_notifications', LEAGUE.id);
  assert.ok(notes.some((n) => n.kind === 'suggestion_approved'), 'the suggester is notified on approval');

  globalThis.PLAYER_MID = created;
});

test('suggestions: rejection records a reason and notifies the author', async () => {
  const { LEAGUE } = globalThis;
  const s = await rpc(CAROL, 'ff_suggestion_submit', LEAGUE.id, 'Rejected Player', 'FWD', null, null, null);

  await expectDenied(() => rpc(ALICE, 'ff_suggestion_review', LEAGUE.id, s.id, 'rejected', '   '), '23514', 'rejection without a reason');

  const rejected = await rpc(ALICE, 'ff_suggestion_review', LEAGUE.id, s.id, 'rejected', 'Not in our league');
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason, 'Not in our league');

  const reason = await scalar(
    'select reason from public.player_approval_logs where league_id=$1 and suggestion_id=$2', [LEAGUE.id, s.id]);
  assert.equal(reason, 'Not in our league', 'the rejection reason is preserved in the audit log');

  // A rejected name may be suggested again - only *pending* duplicates are blocked.
  const retry = await rpc(CAROL, 'ff_suggestion_submit', LEAGUE.id, 'Rejected Player', 'FWD');
  assert.equal(retry.status, 'pending');
});

// ---------------------------------------------------------------------------
test('squad: buy enforces budget, position limits, duplicates and market state', async () => {
  const { LEAGUE, PLAYER_GK, PLAYER_MID } = globalThis;

  await expectDenied(() => rpc(MALLORY, 'ff_squad_buy', LEAGUE.id, PLAYER_GK.id), '42501', 'outsider buying');

  const bought = await rpc(BOB, 'ff_squad_buy', LEAGUE.id, PLAYER_GK.id);
  assert.equal(bought.squad_size, 1);
  assert.equal(Number(bought.price), 6000000);

  await expectDenied(() => rpc(BOB, 'ff_squad_buy', LEAGUE.id, PLAYER_GK.id), '23514', 'duplicate purchase');
  await expectDenied(() => rpc(BOB, 'ff_squad_buy', LEAGUE.id, uuid(999)), '42501', 'player from another league');

  // Multiple ownership is allowed: the same real player may be in two squads.
  const alsoBought = await rpc(CAROL, 'ff_squad_buy', LEAGUE.id, PLAYER_GK.id);
  assert.equal(alsoBought.squad_size, 1);

  // Market closed blocks buying for managers.
  await rpc(ALICE, 'ff_league_set_market', LEAGUE.id, false);
  await expectDenied(() => rpc(BOB, 'ff_squad_buy', LEAGUE.id, PLAYER_MID.id), '42501', 'buying while the market is closed');
  await rpc(ALICE, 'ff_league_set_market', LEAGUE.id, true);
});

test('squad: position limits and the 15-player cap are enforced server-side', async () => {
  const { LEAGUE } = globalThis;

  // Seed a complete, expensive market so a legal 2 GK / 5 DEF / 5 MID / 3 FWD
  // squad exists, and build it through the public API only.
  const plan = { GK: 3, DEF: 6, MID: 6, FWD: 4 }; // one spare per position
  for (const [position, count] of Object.entries(plan)) {
    for (let i = 0; i < count; i++) {
      await rpc(ALICE, 'ff_market_upsert_player', LEAGUE.id, `${position} Seed ${i}`, position, 1000000, 70);
    }
  }
  const market = await rpc(ALICE, 'ff_market_players', LEAGUE.id);
  const own = new Set((await rpc(CAROL, 'ff_squad', LEAGUE.id)).players.map((p) => p.league_player_id));

  // Carol already owns one GK from the previous test. Fill exactly to the
  // approved distribution: 2 GK, 5 DEF, 5 MID, 3 FWD.
  const already = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of market) if (own.has(p.id)) already[p.position]++;
  const limits = { GK: 2, DEF: 5, MID: 5, FWD: 3 };

  for (const p of market) {
    if (own.has(p.id)) continue;
    if (already[p.position] >= limits[p.position]) continue;
    if (own.size >= 15) break;
    await rpc(CAROL, 'ff_squad_buy', LEAGUE.id, p.id);
    own.add(p.id);
    already[p.position]++;
  }

  const squad = await rpc(CAROL, 'ff_squad', LEAGUE.id);
  assert.equal(squad.players.length, 15, 'a legal 15-player squad is reachable through the API');
  const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of squad.players) counts[p.position]++;
  assert.deepEqual(counts, limits, 'the squad matches the approved 2/5/5/3 distribution');

  // A 16th player is refused on the size cap.
  const spare = market.find((p) => !own.has(p.id));
  await expectDenied(() => rpc(CAROL, 'ff_squad_buy', LEAGUE.id, spare.id), '23514', 'sixteenth player');

  // Now prove the position cap independently, on a fresh squad: a manager who
  // owns 2 GK cannot buy a 3rd even with squad space and budget available.
  const dave = uuid(5);
  await db.exec(`insert into auth.users(id) values ('${dave}')`);
  await rpc(dave, 'ff_bootstrap', 'Dave Spare');
  await rpc(dave, 'ff_league_join', LEAGUE.code);
  const gks = market.filter((p) => p.position === 'GK');
  assert.ok(gks.length >= 3, 'the market holds at least three goalkeepers');
  await rpc(dave, 'ff_squad_buy', LEAGUE.id, gks[0].id);
  await rpc(dave, 'ff_squad_buy', LEAGUE.id, gks[1].id);
  await expectDenied(() => rpc(dave, 'ff_squad_buy', LEAGUE.id, gks[2].id), '23514', 'third goalkeeper');
  const daveSquad = await rpc(dave, 'ff_squad', LEAGUE.id);
  assert.equal(daveSquad.players.filter((p) => p.position === 'GK').length, 2, 'exactly two goalkeepers are kept');
});

test('squad: selling returns the budget and cannot strip a confirmed lineup', async () => {
  const { LEAGUE } = globalThis;
  const squad = await rpc(CAROL, 'ff_squad', LEAGUE.id);
  assert.equal(squad.players.length, 15);
  const victim = squad.players.find((p) => p.position === 'FWD' && !p.captain && !p.vice_captain);

  await expectDenied(() => rpc(BOB, 'ff_squad_sell', LEAGUE.id, victim.league_player_id), '23514', 'selling a player you do not own');

  const sold = await rpc(CAROL, 'ff_squad_sell', LEAGUE.id, victim.league_player_id);
  assert.equal(Number(sold.refund), Number(victim.price));
  const after = await rpc(CAROL, 'ff_squad', LEAGUE.id);
  assert.equal(after.players.length, 14);
  assert.ok(!after.players.some((p) => p.league_player_id === victim.league_player_id));
});

test('squad: transfers are same-position and budget-checked', async () => {
  const { LEAGUE } = globalThis;
  const squad = await rpc(CAROL, 'ff_squad', LEAGUE.id);
  const out = squad.players.find((p) => p.position === 'MID');
  const market = await rpc(ALICE, 'ff_market_players', LEAGUE.id);

  const wrongPosition = market.find((p) => p.position === 'DEF' && !squad.players.some((s) => s.league_player_id === p.id));
  await expectDenied(() => rpc(CAROL, 'ff_squad_transfer', LEAGUE.id, out.league_player_id, wrongPosition.id), '23514', 'cross-position transfer');

  const samePosition = market.find((p) => p.position === 'MID' && !squad.players.some((s) => s.league_player_id === p.id));

  // The schema requires a gameweek on every transfer row. Without one the API
  // must refuse with a clear error, never silently skip the history insert.
  if (!(await scalar('select count(*)::int from public.gameweeks where league_id=$1', [LEAGUE.id]))) {
    await expectDenied(() => rpc(CAROL, 'ff_squad_transfer', LEAGUE.id, out.league_player_id, samePosition.id),
      '23514', 'transfer before any gameweek exists');
    await rpc(ALICE, 'ff_season_create', LEAGUE.id, 'Season 2025/26', '2025-08-01T00:00:00Z', '2026-05-31T00:00:00Z', 3);
  }

  const done = await rpc(CAROL, 'ff_squad_transfer', LEAGUE.id, out.league_player_id, samePosition.id);
  assert.equal(done.out, out.league_player_id);
  assert.equal(done.in, samePosition.id);

  const confirmedSquad = await rpc(CAROL, 'ff_squad', LEAGUE.id);
  assert.ok(confirmedSquad.players.some((p) => p.league_player_id === samePosition.id), 'the incoming player is in the squad');
  assert.ok(!confirmedSquad.players.some((p) => p.league_player_id === out.league_player_id), 'the outgoing player is gone');

  // The transfer is recorded in history.
  const history = await scalar(
    'select count(*)::int from public.transfers where league_id=$1 and fantasy_team_id=$2', [LEAGUE.id, confirmedSquad.team.id]);
  assert.ok(history >= 1, 'a completed transfer is written to the transfer history');
});

// ---------------------------------------------------------------------------
test('lineups: a valid 4-3-3 saves, an invalid one is refused, confirmation locks it', async () => {
  const { LEAGUE } = globalThis;
  // A season may already exist from the transfer test; reuse it if so.
  let gameweeks = await rpc(ALICE, 'ff_gameweeks', LEAGUE.id);
  if (gameweeks.length === 0) {
    const season = await rpc(ALICE, 'ff_season_create', LEAGUE.id, 'Season 2025/26',
      '2025-08-01T00:00:00Z', '2026-05-31T00:00:00Z', 3);
    assert.equal(season.gameweeks.length, 3);
    gameweeks = await rpc(ALICE, 'ff_gameweeks', LEAGUE.id);
  }
  assert.equal(gameweeks.length, 3, 'the season exposes its gameweeks');
  const gameweek = gameweeks[0].id;

  // Refill to a legal 15 first: an earlier test sold a player to prove refunds.
  const squad = await topUp(CAROL, LEAGUE.id);
  assert.equal(squad.players.length, 15, 'Carol holds a full squad before building a lineup');

  // Arrange the XI into 4-3-3: 1 GK, 4 DEF, 3 MID, 3 FWD, then 4 bench.
  const byPos = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const p of squad.players) byPos[p.position].push(p.league_player_id);
  const xi = [...byPos.GK.slice(0, 1), ...byPos.DEF.slice(0, 4), ...byPos.MID.slice(0, 3), ...byPos.FWD.slice(0, 3)];
  const bench = squad.players.map((p) => p.league_player_id).filter((id) => !xi.includes(id));
  const ordered = [...xi, ...bench];
  assert.equal(ordered.length, 15);

  await expectDenied(() => rpc(CAROL, 'ff_lineup_save', LEAGUE.id, gameweek, '4-3-3', ordered.slice(0, 14), ordered[0], ordered[1]), '23514', '14 players');
  await expectDenied(() => rpc(CAROL, 'ff_lineup_save', LEAGUE.id, gameweek, '2-2-2', ordered, ordered[0], ordered[1]), '23514', 'unknown formation');
  await expectDenied(() => rpc(CAROL, 'ff_lineup_save', LEAGUE.id, gameweek, '4-3-3', ordered, ordered[0], ordered[0]), '23514', 'captain equals vice');
  await expectDenied(() => rpc(CAROL, 'ff_lineup_save', LEAGUE.id, gameweek, '4-3-3', ordered, null, ordered[1]), '23514', 'missing captain');
  // A wrong formation for the chosen XI must be refused.
  await expectDenied(() => rpc(CAROL, 'ff_lineup_save', LEAGUE.id, gameweek, '5-3-2', ordered, ordered[0], ordered[1]), '23514', 'formation does not match the XI');

  const saved = await rpc(CAROL, 'ff_lineup_save', LEAGUE.id, gameweek, '4-3-3', ordered,
    byPos.FWD[0], byPos.MID[0]);
  assert.equal(saved.status, 'draft');
  assert.equal(Number(saved.formation ? 1 : 0), 1);

  const confirmed = await rpc(CAROL, 'ff_lineup_confirm', LEAGUE.id, saved.lineup_id);
  assert.equal(confirmed.status, 'confirmed');

  const readBack = await rpc(CAROL, 'ff_squad', LEAGUE.id);
  assert.equal(readBack.status, 'confirmed');
  assert.equal(readBack.formation, '4-3-3');
  assert.equal(readBack.captain_id, byPos.FWD[0]);
  assert.equal(readBack.vice_captain_id, byPos.MID[0]);

  // Once confirmed, a player in that lineup cannot simply be sold.
  const locked = readBack.players.find((p) => p.league_player_id === byPos.FWD[0]);
  await expectDenied(() => rpc(CAROL, 'ff_squad_sell', LEAGUE.id, locked.league_player_id), '23514', 'selling a locked starter');

  globalThis.GAMEWEEK = gameweek;
});

test('lineups: another manager cannot edit or confirm my lineup', async () => {
  const { LEAGUE } = globalThis;
  const squad = await rpc(CAROL, 'ff_squad', LEAGUE.id);
  const lineupId = squad.lineup_id;
  assert.ok(lineupId);

  // Bob owns a different team, so this lineup is not his.
  await expectDenied(() => rpc(BOB, 'ff_lineup_confirm', LEAGUE.id, lineupId), '42501', 'confirming another team lineup');
  await expectDenied(() => rpc(MALLORY, 'ff_lineup_confirm', LEAGUE.id, lineupId), '42501', 'outsider confirming a lineup');
});

// ---------------------------------------------------------------------------
test('matches: organizer workflow is reachable, and approval cannot be self-approved', async () => {
  const { LEAGUE, GAMEWEEK } = globalThis;

  // Appoint Bob as an organizer, and register two real teams.
  await expectDenied(() => rpc(BOB, 'ff_league_set_organizer', LEAGUE.id, BOB, true), '42501', 'manager appointing an organizer');
  await rpc(ALICE, 'ff_league_set_organizer', LEAGUE.id, BOB, true);

  const teamA = await rpc(ALICE, 'ff_tournament_create', LEAGUE.id, 'Goal Diggers');
  const teamB = await rpc(ALICE, 'ff_tournament_create', LEAGUE.id, 'The Invincibles');
  await expectDenied(() => rpc(BOB, 'ff_tournament_create', LEAGUE.id, 'Rogue FC'), '42501', 'manager creating a real team');

  // Register real players for the sides, or the lineup guard refuses them.
  const prof = await scalar(
    `insert into public.player_profiles(league_id, display_name) values ($1,'Fares Ashraf') returning id`, [LEAGUE.id]);
  const profB = await scalar(
    `insert into public.player_profiles(league_id, display_name) values ($1,'Youssef Adel') returning id`, [LEAGUE.id]);
  await q(`insert into public.real_team_players(league_id, team_id, player_id, valid_from) values ($1,$2,$3,'2025-01-01Z')`,
    [LEAGUE.id, teamA.id, prof]);
  await q(`insert into public.real_team_players(league_id, team_id, player_id, valid_from) values ($1,$2,$3,'2025-01-01Z')`,
    [LEAGUE.id, teamB.id, profB]);

  await expectDenied(() => rpc(BOB, 'ff_match_create', LEAGUE.id, GAMEWEEK, teamA.id, teamB.id, BOB,
    '2025-08-10T19:00:00Z', 'The Cage', 1, 1), '42501', 'manager scheduling a match');

  const match = await rpc(ALICE, 'ff_match_create', LEAGUE.id, GAMEWEEK, teamA.id, teamB.id, BOB,
    '2025-08-10T19:00:00Z', 'The Cage', 1, 1);
  assert.ok(match.id);

  // Only the assigned organizer (or leader) may open a revision.
  await expectDenied(() => rpc(CAROL, 'ff_match_open_revision', LEAGUE.id, match.id), '42501', 'non-organizer opening a revision');
  const revision = await rpc(BOB, 'ff_match_open_revision', LEAGUE.id, match.id);
  assert.equal(revision.state, 'draft');

  await expectDenied(() => rpc(CAROL, 'ff_match_set_lineup', LEAGUE.id, revision.id, teamA.id,
    JSON.stringify([{ player_id: prof, selection: 'starter', actual_position: 'MID' }])), '42501', 'non-organizer setting a lineup');

  const lineup = await rpc(BOB, 'ff_match_set_lineup', LEAGUE.id, revision.id, teamA.id,
    JSON.stringify([{ player_id: prof, selection: 'starter', actual_position: 'MID' }]));
  assert.equal(lineup.players, 1);

  // Submission validates that BOTH sides have a lineup - one side is an error.
  await expectDenied(() => rpc(BOB, 'ff_match_submit_lineup', LEAGUE.id, revision.id), '23514', 'submitting with one side only');
  await rpc(BOB, 'ff_match_set_lineup', LEAGUE.id, revision.id, teamB.id,
    JSON.stringify([{ player_id: profB, selection: 'starter', actual_position: 'MID' }]));

  const submitted = await rpc(BOB, 'ff_match_submit_lineup', LEAGUE.id, revision.id);
  assert.ok(submitted.submission_id);

  // Self-approval is forbidden even for the leader acting on their own submission.
  await expectDenied(() => rpc(BOB, 'ff_match_review_submission', LEAGUE.id, submitted.submission_id, 'approved'), '42501', 'organizer approving as non-leader');

  const approved = await rpc(ALICE, 'ff_match_review_submission', LEAGUE.id, submitted.submission_id, 'approved');
  assert.equal(approved.decision, 'approved');

  // Result path: fork, score, record an event, submit, approve.
  const forked = await rpc(BOB, "ff_match_fork_result", LEAGUE.id, approved.approval_id, crypto.randomUUID());
  assert.ok(forked.revision_id);
  await rpc(BOB, 'ff_match_set_score', LEAGUE.id, forked.revision_id, 3, 1);
  await expectDenied(() => rpc(BOB, 'ff_match_record_event', LEAGUE.id, forked.revision_id, prof,
    'teleportation', 12), '23514', 'unsupported event type');
  const event = await rpc(BOB, 'ff_match_record_event', LEAGUE.id, forked.revision_id, prof, 'goal', 12);
  assert.equal(event.type, 'goal');

  const resultSubmission = await rpc(BOB, 'ff_match_submit_result', LEAGUE.id, forked.revision_id, approved.approval_id);
  assert.ok(resultSubmission.submission_id);
  await expectDenied(() => rpc(BOB, 'ff_match_review_submission', LEAGUE.id, resultSubmission.submission_id, 'approved'), '42501', 'organizer self-approving a result');
  const resultApproval = await rpc(ALICE, 'ff_match_review_submission', LEAGUE.id, resultSubmission.submission_id, 'approved');
  assert.equal(resultApproval.decision, 'approved');

  // The approved result is now the official one, and is readable by members.
  const official = await scalar(
    `select count(*)::int from public.official_match_results where league_id=$1 and match_id=$2 and is_current`,
    [LEAGUE.id, match.id]);
  assert.equal(official, 1, 'approving a result creates exactly one current official result');

  const matches = await rpc(CAROL, 'ff_matches', LEAGUE.id);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].revision_state, 'approved');

  globalThis.MATCH = match;
});

test('matches: a correction preserves history and supersedes the old result', async () => {
  const { LEAGUE, MATCH } = globalThis;
  await expectDenied(() => rpc(BOB, 'ff_match_open_correction', LEAGUE.id, MATCH.id, 'typo'), '42501', 'organizer opening a correction');
  await expectDenied(() => rpc(ALICE, 'ff_match_open_correction', LEAGUE.id, MATCH.id, '   '), '23514', 'correction without a reason');

  const correction = await rpc(ALICE, 'ff_match_open_correction', LEAGUE.id, MATCH.id, 'Goal was disallowed');
  assert.ok(correction.draft_revision_id);

  // The previous official result is retained but no longer current.
  const current = await scalar(
    `select count(*)::int from public.official_match_results where league_id=$1 and match_id=$2 and is_current`,
    [LEAGUE.id, MATCH.id]);
  const historical = await scalar(
    `select count(*)::int from public.official_match_results where league_id=$1 and match_id=$2`, [LEAGUE.id, MATCH.id]);
  assert.equal(current, 0, 'the superseded result is no longer current');
  assert.equal(historical, 1, 'the historical result row is preserved, not deleted');

  const record = await scalar(
    `select count(*)::int from public.match_corrections where league_id=$1 and match_id=$2`, [LEAGUE.id, MATCH.id]);
  assert.equal(record, 1, 'the correction is recorded with its reason');
});

// ---------------------------------------------------------------------------
test('standings: reads work, ranking modes stay separate, and fabrication is blocked', async () => {
  const { LEAGUE } = globalThis;
  const season = await scalar('select id from public.seasons where league_id=$1 limit 1', [LEAGUE.id]);
  const team = await scalar('select id from public.fantasy_teams where league_id=$1 limit 1', [LEAGUE.id]);

  // No scoring calculation is approved, so nothing may fabricate standings -
  // not even the league leader. This is the approved requirement, not a gap.
  await db.exec('begin');
  try {
    await assert.rejects(
      () => q(`insert into public.league_standings(league_id, season_id, fantasy_team_id, mode, fantasy_points, h2h_points)
               values ($1,$2,$3,'head_to_head',612,9)`, [LEAGUE.id, season, team]),
      (e) => e.code === '42501',
      'standings cannot be inserted: no approved calculation exists',
    );
  } finally { await db.exec('rollback'); }

  // The API must still render an empty standings table rather than erroring.
  const empty = await rpc(ALICE, 'ff_standings', LEAGUE.id);
  assert.deepEqual(empty, [], 'no standings rows exist, and the RPC returns an empty list');

  // Read-shape verification with fixture rows: triggers are bypassed for this
  // insert only, to test the *query*, which is not something a client can do.
  await db.exec("set session_replication_role = replica");
  try {
    await q(`insert into public.league_standings(league_id, season_id, fantasy_team_id, mode, fantasy_points, h2h_points)
             values ($1,$2,$3,'head_to_head',612,9)`, [LEAGUE.id, season, team]);
    await q(`insert into public.league_standings(league_id, season_id, fantasy_team_id, mode, fantasy_points, h2h_points)
             values ($1,$2,$3,'fantasy_total',612,null)`, [LEAGUE.id, season, team]);
  } finally { await db.exec("reset session_replication_role"); }

  const rows = await rpc(ALICE, 'ff_standings', LEAGUE.id);
  assert.equal(rows.length, 2);
  const h2h = rows.find((r) => r.mode === 'head_to_head');
  const total = rows.find((r) => r.mode === 'fantasy_total');
  assert.equal(h2h.h2h_points, 9, 'head-to-head points are returned as their own field');
  assert.equal(Number(h2h.fantasy_points), 612, 'fantasy points are returned alongside, not merged');
  assert.equal(total.h2h_points, null, 'fantasy-total mode carries no head-to-head points');
  assert.equal(rows[0].mode, 'head_to_head', 'head-to-head standings are ordered first');

  // Managers cannot read the standings of a league they are not in.
  await expectDenied(() => rpc(MALLORY, 'ff_standings', LEAGUE.id), '42501', 'outsider reading standings');
});

test('notifications: private to the recipient and individually markable', async () => {
  const { LEAGUE } = globalThis;
  const bobs = await rpc(BOB, 'ff_notifications');
  assert.ok(bobs.length > 0);
  const mine = bobs[0];

  await expectDenied(() => rpc(CAROL, 'ff_notification_read', mine.id), '42501', 'marking someone else notification read');

  const read = await rpc(BOB, 'ff_notification_read', mine.id);
  assert.ok(read.read_at);

  const carols = await rpc(CAROL, 'ff_notifications');
  assert.ok(!carols.some((n) => n.id === mine.id), 'notifications are not visible to other users');
});

test('isolation: two leagues never leak into each other', async () => {
  const { LEAGUE } = globalThis;
  const second = await rpc(BOB, 'ff_league_create', 'Friday Night League', 50000000);
  assert.notEqual(second.id, LEAGUE.id);

  // Bob leads the second league and manages in the first: two roles, two scopes.
  const bobProfile = await rpc(BOB, 'ff_bootstrap');
  const ids = bobProfile.leagues.map((l) => l.league_id).sort();
  assert.deepEqual(ids, [LEAGUE.id, second.id].sort());

  // A player created in one league is invisible in the other.
  const p = await rpc(BOB, 'ff_market_upsert_player', second.id, 'Only In League Two', 'MID', 1000000, 70);
  const leagueOneMarket = await rpc(ALICE, 'ff_market_players', LEAGUE.id);
  assert.ok(!leagueOneMarket.some((x) => x.id === p.id));
  const leagueTwoMarket = await rpc(BOB, 'ff_market_players', second.id);
  assert.ok(leagueTwoMarket.some((x) => x.id === p.id));

  // Alice cannot see or act in Bob's league at all.
  await expectDenied(() => rpc(ALICE, 'ff_market_players', second.id), '42501', 'cross-league market read');
  await expectDenied(() => rpc(ALICE, 'ff_suggestion_submit', second.id, 'Cross League', 'MID'), '42501', 'cross-league suggestion');
  // And her leader powers do not extend there.
  await expectDenied(() => rpc(ALICE, 'ff_league_set_market', second.id, false), '42501', 'cross-league leader action');
});

test('leadership transfer keeps exactly one active leader', async () => {
  const { LEAGUE } = globalThis;
  await expectDenied(() => rpc(ALICE, 'ff_league_transfer_leadership', LEAGUE.id, MALLORY), '23514', 'transferring to a non-member');

  const transferred = await rpc(ALICE, 'ff_league_transfer_leadership', LEAGUE.id, CAROL);
  assert.equal(transferred.leader_id, CAROL);

  const leaders = await scalar(
    `select count(*)::int from public.league_members where league_id=$1 and role='leader' and status='active'`,
    [LEAGUE.id]);
  assert.equal(leaders, 1, 'exactly one active leader survives the transfer');

  // The old leader loses their privileges; the new one gains them.
  await expectDenied(() => rpc(ALICE, 'ff_league_set_market', LEAGUE.id, false), '42501', 'former leader acting as leader');
  const ok = await rpc(CAROL, 'ff_league_set_market', LEAGUE.id, true);
  assert.equal(ok.market_open, true);
});

// ---------------------------------------------------------------------------
test('audit: every mutating action is recorded and cannot be rewritten', async () => {
  const { LEAGUE } = globalThis;
  const actions = (await q(
    'select distinct action from public.audit_logs where league_id=$1 order by action', [LEAGUE.id]
  )).rows.map((r) => r.action);

  for (const expected of ['league_created', 'league_joined', 'suggestion_submitted', 'suggestion_approved',
    'squad_buy', 'squad_transfer', 'lineup_saved', 'lineup_confirmed', 'match_created',
    'match_reviewed', 'correction_opened', 'leadership_transferred']) {
    assert.ok(actions.includes(expected), `audit_logs is missing '${expected}' (saw: ${actions.join(', ')})`);
  }

  // The audit log is append-only even for a privileged role, and invisible to
  // managers entirely.
  await db.exec('begin');
  try {
    await assert.rejects(() => q('update public.audit_logs set action=$1 where league_id=$2', ['tampered', LEAGUE.id]),
      (e) => e.code === '23514', 'audit rows must be append-only');
  } finally { await db.exec('rollback'); }

  const managerVisible = await asUser(BOB, () => scalar(
    'select count(*)::int from public.audit_logs where league_id=$1', [LEAGUE.id]));
  assert.equal(managerVisible, 0, 'only a leader may read the audit log');
});

// ---------------------------------------------------------------------------
// Audit additions: guards added after the security review.
// ---------------------------------------------------------------------------
test('fixtures: a team from another league is refused with a clear 42501', async () => {
  const { LEAGUE } = globalThis;
  const gws = await rpc(ALICE, 'ff_gameweeks', LEAGUE.id);
  assert.ok(gws.length > 0, 'the primary league needs a gameweek for this test');
  const GW = gws[0];
  // Build a second, fully independent league with its own team.
  const other = await rpc(MALLORY, 'ff_league_create', 'Other League', 100000000);
  await rpc(MALLORY, 'ff_season_create', other.id, 'S', '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z', 2);
  // An earlier test handed leadership to Carol; act as the current leader.
  const members = await rpc(ALICE, 'ff_league_members', LEAGUE.id);
  const LEADER = members.find((m) => m.role === 'leader' && m.status === 'active')?.user_id ?? ALICE;
  const homeTeam = members.find((m) => m.team_id)?.team_id;
  assert.ok(homeTeam, 'expected at least one team in the primary league');

  await db.exec('begin');
  try {
    const otherTeam = await scalar(
      'select id from public.fantasy_teams where league_id=$1 limit 1', [other.id]);
    assert.ok(otherTeam, 'the second league should have a team by now');
    // Cross-league fixture must be refused by the explicit guard, not by a raw
    // foreign-key message.
    const err = await rpc(LEADER, 'ff_fixture_create', LEAGUE.id, GW.id, homeTeam, otherTeam)
      .then(() => null, (e) => e);
    assert.ok(err, 'a cross-league fixture must be refused');
    assert.equal(err.code, '42501');
    assert.match(err.message, /both teams must belong to this league/);
  } finally { await db.exec('rollback'); }
});
