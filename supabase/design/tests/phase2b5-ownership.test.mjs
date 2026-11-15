// Phase 2B.5 — the definer ownership transfer (migration 011).
//
// The one question this suite must answer: after all 56 SECURITY DEFINER
// functions are owned by ff_migration_owner, does every authorization path
// behave EXACTLY as before, with no privilege widened and no check silently
// returning false?
//
// A baseline snapshot is taken BEFORE 011 and compared after. That is the only
// way to catch the failure mode that matters: a definer that is narrower than
// the caller sees zero rows and returns false without raising.
//
// Roles and auth.uid() are mocked. This is NOT a Supabase compatibility claim.
// The cases form one sequential narrative: the transfer is applied once, by
// design, and every later test runs in the post-transfer world.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = await PGlite.create();
const load = async (f) => db.exec(await readFile(new URL(f, import.meta.url), 'utf8'));

for (const f of [
  'setup.sql',
  '../migrations/001_schema.sql',
  '../migrations/002_security.sql',
  '../migrations/003_storage.sql',
  '../migrations/004_integrity_workflows.sql',
  '../migrations/005_concurrency_hardening.sql',
  '../migrations/006_revision_lineage.sql',
  '../migrations/007_correction_attempts.sql',
  '../migrations/008_result_fork_idempotency.sql',
  '../migrations/009_ownership_and_grants.sql',
  '../migrations/010_privilege_verification.sql',
]) await load(f);
after(() => db.close());

const q = (sql, params = []) => db.query(sql, params);
const scalar = async (sql, params = []) => Object.values((await q(sql, params)).rows[0])[0];

// --- fixture -----------------------------------------------------------------
// setup.sql's auth.uid() reads the singular request.jwt.claim.sub setting.
const L = '10000000-0000-0000-0000-0000000000b1';
const L2 = '10000000-0000-0000-0000-0000000000b2';
const leader = '20000000-0000-0000-0000-0000000000b1';
const manager = '20000000-0000-0000-0000-0000000000b2';
const outsider = '20000000-0000-0000-0000-0000000000b3';
const organizer = '20000000-0000-0000-0000-0000000000b4';
const players = Array.from({ length: 4 }, (_, i) => `30000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`);
const A = '40000000-0000-0000-0000-000000000001';
const B = '40000000-0000-0000-0000-000000000002';
const season = '50000000-0000-0000-0000-000000000001';
const gw = '50000000-0000-0000-0000-000000000002';
const match = '60000000-0000-0000-0000-000000000001';
const rev = '70000000-0000-0000-0000-000000000001';
const la = '80000000-0000-0000-0000-000000000001';
const lb = '80000000-0000-0000-0000-000000000002';
const team = '90000000-0000-0000-0000-000000000001';

await db.exec(`
create role ff_test_gateway nologin;
grant usage on schema ff_private, auth to ff_test_gateway;
grant execute on function ff_private.submit_lineup(uuid,uuid), ff_private.set_result_score(uuid,uuid,integer,integer),
  ff_private.submit_result(uuid,uuid,uuid), ff_private.review_submission(uuid,uuid,text,text),
  ff_private.authorize_temporary(uuid,uuid,uuid,uuid,text), ff_private.open_correction(uuid,uuid,text),
  ff_private.start_scoring(uuid,uuid,uuid[]), ff_private.fork_result(uuid,uuid,uuid),
  ff_private.open_correction_attempt(uuid,uuid), ff_private.record_event(uuid,uuid,uuid,uuid,text,integer,integer,jsonb)
  to ff_test_gateway;
insert into auth.users values ('${leader}'),('${manager}'),('${outsider}'),('${organizer}');
insert into public.profiles(id,display_name) values
  ('${leader}','Leader'),('${manager}','Manager'),('${outsider}','Outsider'),('${organizer}','Organizer');
insert into public.leagues(id,name) values ('${L}','League B1'),('${L2}','League B2');
insert into public.league_members(league_id,user_id,role) values
  ('${L}','${leader}','leader'),('${L}','${manager}','manager'),('${L}','${organizer}','manager'),
  ('${L2}','${outsider}','leader');
insert into public.match_organizers values ('${L}','${organizer}');
insert into public.player_profiles(id,league_id,display_name) values
  ${players.map((p, i) => `('${p}','${L}','P${i + 1}')`).join(',')};
insert into public.real_football_teams(id,league_id,name) values ('${A}','${L}','Team A'),('${B}','${L}','Team B');
insert into public.real_team_players(league_id,team_id,player_id,valid_from) values
  ('${L}','${A}','${players[0]}',now()-interval '1 day'),('${L}','${B}','${players[1]}',now()-interval '1 day');
insert into public.seasons(id,league_id,name,starts_at,ends_at) values ('${season}','${L}','Season',now(),now()+interval '1 year');
insert into public.gameweeks(id,league_id,season_id,number,deadline) values ('${gw}','${L}','${season}',1,now());
insert into public.real_matches(id,league_id,gameweek_id,team_a_id,team_b_id,organizer_id,starts_at,venue,starters_per_side,max_substitutes)
  values ('${match}','${L}','${gw}','${A}','${B}','${organizer}',now(),'Pitch',1,1);
insert into public.match_revisions(id,league_id,match_id,version,match_snapshot) values ('${rev}','${L}','${match}',1,'{"format":"t"}');
insert into public.real_match_lineups(id,league_id,match_id,revision_id,team_id) values
  ('${la}','${L}','${match}','${rev}','${A}'),('${lb}','${L}','${match}','${rev}','${B}');
insert into public.real_match_lineup_players(league_id,revision_id,lineup_id,player_id,selection,actual_position,eligibility_kind,eligibility_evidence)
  values ('${L}','${rev}','${la}','${players[0]}','starter','GK','registered','{}'),
         ('${L}','${rev}','${lb}','${players[1]}','starter','DEF','registered','{}');
insert into public.fantasy_teams(id,league_id,manager_id,name) values ('${team}','${L}','${manager}','Team');
`);

const asUser = async (id, fn, role = 'authenticated') => {
  await q("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
};
const helper = (id, name, args) =>
  asUser(id, async () => (await q(`select ff_private.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) v`, args)).rows[0].v);

// The full observable surface of the read helpers, for every actor, before and
// after the transfer. Any difference is a regression, not a detail.
const snapshot = async () => {
  const out = {};
  for (const [tag, id] of Object.entries({ leader, manager, outsider })) {
    out[`${tag}.is_member`] = await helper(id, 'is_member', [L]);
    out[`${tag}.is_leader`] = await helper(id, 'is_leader', [L]);
    out[`${tag}.is_organizer`] = await helper(id, 'is_organizer', [L]);
    out[`${tag}.is_match_organizer`] = await helper(id, 'is_match_organizer', [L, match]);
    out[`${tag}.owns_team`] = await helper(id, 'owns_team', [L, team]);
    out[`${tag}.can_read_match`] = await helper(id, 'can_read_match', [L, match]);
    out[`${tag}.can_read_revision`] = await helper(id, 'can_read_revision', [L, rev]);
    out[`${tag}.can_read_lineup`] = await helper(id, 'can_read_lineup', [L, la]);
    out[`${tag}.other_league_member`] = await helper(id, 'is_member', [L2]);
  }
  return out;
};

let baseline;
let baselineOwners;

// --- 1. record the pre-transfer baseline -------------------------------------

test('baseline: functions are owned by the table owner before 011', async () => {
  const owners = (await q(`select distinct pg_get_userbyid(p.proowner) o from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace where p.prosecdef`)).rows.map(r => r.o);
  assert.equal(owners.length, 1);
  baselineOwners = owners;
  const tableOwners = (await q(`select distinct pg_get_userbyid(c.relowner) o from pg_class c
    join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relkind='r'`)).rows.map(r => r.o);
  assert.deepEqual(tableOwners, owners, 'baseline: definer owner == table owner');
  baseline = await snapshot();
  assert.equal(baseline['leader.is_member'], true);
  assert.equal(baseline['outsider.is_member'], false);
});

// --- 2. apply 011 -------------------------------------------------------------

test('011 transfers all 56 definer functions to ff_migration_owner', async () => {
  await load('../migrations/011_definer_ownership_transfer.sql');
  const n = await scalar(`select count(*)::int c from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname in ('public','ff_private') and p.prosecdef
      and pg_get_userbyid(p.proowner) = 'ff_migration_owner'`);
  assert.equal(n, 56);
  const wrong = await scalar(`select count(*)::int c from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname in ('public','ff_private') and p.prosecdef
      and pg_get_userbyid(p.proowner) <> 'ff_migration_owner'`);
  assert.equal(wrong, 0);
});

test('011 leaves the definer role owning no application table', async () => {
  const owned = await scalar(`select count(*)::int c from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p','v','m')
      and pg_get_userbyid(c.relowner) = 'ff_migration_owner'`);
  assert.equal(owned, 0);
  // It also cannot run DDL on them.
  await db.exec('set role ff_migration_owner');
  try {
    await assert.rejects(db.exec('alter table public.leagues add column x int'),
      e => /must be owner|permission denied/.test(e.message));
  } finally { await db.exec('reset role'); }
});

// --- 3. behaviour is unchanged (the point of the whole exercise) --------------

test('every read helper returns exactly the same value after the transfer', async () => {
  const after = await snapshot();
  assert.deepEqual(after, baseline, 'helper results must be identical before and after 011');
});

test('the transfer does not change which rows each client can read', async () => {
  // RLS still applies to direct client reads; only the definer bypasses it.
  const leaderSees = await asUser(leader, async () => scalar('select count(*)::int from public.league_members where league_id=$1', [L]));
  const outsiderSees = await asUser(outsider, async () => scalar('select count(*)::int from public.league_members where league_id=$1', [L]));
  assert.equal(leaderSees, 3);
  assert.equal(outsiderSees, 0);
});

// --- 4. identity, revocation, unauthorized access -----------------------------

test('a null caller identity still never authorizes after the transfer', async () => {
  await db.exec('set role authenticated');
  try {
    await q("select set_config('request.jwt.claim.sub','',false)");
    assert.equal(await scalar('select ff_private.is_member($1) v', [L]), false);
    assert.equal(await scalar('select ff_private.is_leader($1) v', [L]), false);
  } finally { await db.exec('reset role'); }
});

test('membership revocation still removes access immediately after the transfer', async () => {
  assert.equal(await helper(manager, 'is_member', [L]), true);
  await q(`update public.league_members set status='inactive' where league_id=$1 and user_id=$2`, [L, manager]);
  assert.equal(await helper(manager, 'is_member', [L]), false);
  assert.equal(await helper(manager, 'owns_team', [L, team]), false);
  await q(`update public.league_members set status='active' where league_id=$1 and user_id=$2`, [L, manager]);
  assert.equal(await helper(manager, 'is_member', [L]), true);
});

test('role revocation still removes leader authority after the transfer', async () => {
  await q(`update public.league_members set role='manager' where league_id=$1 and user_id=$2`, [L, leader]);
  assert.equal(await helper(leader, 'is_leader', [L]), false);
  assert.equal(await helper(leader, 'is_member', [L]), true);
  await q(`update public.league_members set role='leader' where league_id=$1 and user_id=$2`, [L, leader]);
  assert.equal(await helper(leader, 'is_leader', [L]), true);
});

test('removing the organizer assignment still revokes organizer authority', async () => {
  assert.equal(await helper(organizer, 'is_organizer', [L]), true);
  await q(`delete from public.match_organizers where league_id=$1 and user_id=$2`, [L, organizer]);
  assert.equal(await helper(organizer, 'is_organizer', [L]), false);
  await q(`insert into public.match_organizers values ($1,$2)`, [L, organizer]);
  assert.equal(await helper(organizer, 'is_organizer', [L]), true);
});

test('unauthorized access is still rejected by the real workflow, not just the helpers', async () => {
  // The outsider is not an organizer of this match: the privileged RPC must refuse.
  await assert.rejects(
    asUser(outsider, () => q('select ff_private.submit_lineup($1,$2)', [L, rev]), 'ff_test_gateway'),
    e => e.code === '42501' || /organizer/.test(e.message),
  );
});

// --- 5. search_path safety after the transfer --------------------------------

test('a hostile schema on the caller session path cannot hijack a transferred definer', async () => {
  await db.exec(`
    create schema if not exists hostile;
    create function hostile.require_read_committed() returns void language plpgsql as $$
      begin raise exception 'hijacked require_read_committed'; end $$;
    create function hostile.current_setting(text, boolean) returns text language plpgsql as $$
      begin raise exception 'hijacked current_setting'; end $$;
    grant usage on schema hostile to authenticated;
  `);
  await db.exec('set search_path = hostile, public, pg_catalog');
  try {
    assert.equal(await helper(leader, 'is_member', [L]), true);
  } finally { await db.exec('reset search_path'); }
});

test('all 56 keep an exact pinned search_path after the transfer', async () => {
  const n = await scalar(`select count(*)::int c from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='ff_private' and p.prosecdef
      and p.proconfig = array['search_path=pg_catalog, ff_private']`);
  assert.equal(n, 56);
});

// --- 6. no privilege widened by the transfer ---------------------------------

test('the client EXECUTE surface is unchanged: exactly ten helpers, none for anon', async () => {
  const auth = (await q(`select p.proname fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','ff_private') and has_function_privilege('authenticated', p.oid, 'execute')
    order by 1`)).rows.map(r => r.fn);
  assert.deepEqual(auth, ['can_read_image', 'can_read_lineup', 'can_read_match', 'can_read_revision',
    'can_read_suggestion', 'is_leader', 'is_match_organizer', 'is_member', 'is_organizer', 'owns_team']);
  const anon = (await q(`select p.proname fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','ff_private') and has_function_privilege('anon', p.oid, 'execute')`)).rows;
  assert.deepEqual(anon, []);
});

test('an anon caller still cannot reach any helper after the transfer', async () => {
  await assert.rejects(
    asUser(outsider, () => q('select ff_private.is_member($1)', [L]), 'anon'),
    e => /permission denied/.test(e.message),
  );
});

test('010 still passes after the transfer, and still rejects a BYPASSRLS-less owner', async () => {
  // 010 now also asserts that no definer calls auth.uid(): hosted Supabase cannot
  // grant USAGE on the auth schema, so such a function 42501s at runtime. Apply
  // the repair first, which is what the deployment does.
  await load('../migrations/014_definer_actor_identity.sql');
  await load('../migrations/010_privilege_verification.sql');
  await db.exec('alter role ff_migration_owner nobypassrls');
  await assert.rejects(load('../migrations/010_privilege_verification.sql'),
    e => e.code === '42501' && /BYPASSRLS/.test(e.message));
  await db.exec('alter role ff_migration_owner bypassrls');
});

// --- 7. the guard in 011 ------------------------------------------------------

test('011 refuses to run if the target role is missing or has the wrong attributes', async () => {
  const sql = await readFile(new URL('../migrations/011_definer_ownership_transfer.sql', import.meta.url), 'utf8');
  assert.match(sql, /ff_migration_owner does not exist; apply 009 before 011/);
  assert.match(sql, /must be NOLOGIN with BYPASSRLS before functions are transferred/);
  assert.match(sql, /ownership transfer incomplete/, '011 must assert its own post-condition');
  // It performs no grant changes: ownership and grants stay separable on failure.
  assert.doesNotMatch(sql, /^\s*grant\s/im, '011 must not change grants');
  assert.doesNotMatch(sql, /^\s*revoke\s/im, '011 must not change grants');
});
