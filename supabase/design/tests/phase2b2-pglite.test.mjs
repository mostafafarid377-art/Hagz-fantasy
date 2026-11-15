// Phase 2B.2 offline PGlite tests for the correction-attempt (007), result-fork
// idempotency (008) and privilege (009/010) additions.
//
// Claims and the privileged function gateway are mocked. This does NOT model a
// verified Supabase JWT, real roles, PostgREST, Storage, or concurrency. A green
// run is design evidence only, never a Supabase compatibility claim.
//
// The cases form one sequential narrative because result-fork attempt numbers are
// derived from persisted state for a single match: each test continues the
// previous one rather than pretending to start from an empty database.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = await PGlite.create();
for (const file of [
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
]) await db.exec(await readFile(new URL(file, import.meta.url), 'utf8'));
after(() => db.close());

const q = (sql, params = []) => db.query(sql, params);
const L = '10000000-0000-0000-0000-000000000001';
const leader = '20000000-0000-0000-0000-000000000001';
const organizer = '20000000-0000-0000-0000-000000000002';
const manager = '20000000-0000-0000-0000-000000000003';
const players = Array.from({ length: 4 }, (_, i) => `30000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`);
const A = '40000000-0000-0000-0000-000000000001';
const B = '40000000-0000-0000-0000-000000000002';
const season = '50000000-0000-0000-0000-000000000001';
const gw = '50000000-0000-0000-0000-000000000002';
const match = '60000000-0000-0000-0000-000000000001';
const rev = '70000000-0000-0000-0000-000000000001';
const la = '80000000-0000-0000-0000-000000000001';
const lb = '80000000-0000-0000-0000-000000000002';

const fail = async (p, code) => assert.rejects(p, e => { assert.equal(e.code, code, e.message); return true; });
async function actor(id, fn, role = 'ff_test_gateway') {
  await q("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const value = async (sql, params = []) => (await q(sql, params)).rows[0].id;
const rid = () => crypto.randomUUID();

await db.exec(`
create role ff_test_gateway nologin;
grant usage on schema ff_private, auth to ff_test_gateway;
grant execute on function ff_private.submit_lineup(uuid,uuid), ff_private.set_result_score(uuid,uuid,integer,integer),
  ff_private.submit_result(uuid,uuid,uuid), ff_private.review_submission(uuid,uuid,text,text),
  ff_private.authorize_temporary(uuid,uuid,uuid,uuid,text), ff_private.open_correction(uuid,uuid,text),
  ff_private.start_scoring(uuid,uuid,uuid[]), ff_private.fork_result(uuid,uuid,uuid),
  ff_private.open_correction_attempt(uuid,uuid) to ff_test_gateway;
insert into auth.users values ('${leader}'),('${organizer}'),('${manager}');
insert into public.profiles(id,display_name) values ('${leader}','Leader'),
  ('${organizer}','Organizer'),('${manager}','Manager');
insert into public.leagues(id,name) values ('${L}','League A');
insert into public.league_members(league_id,user_id,role) values ('${L}','${leader}','leader'),
  ('${L}','${organizer}','manager'),('${L}','${manager}','manager');
insert into public.match_organizers values ('${L}','${organizer}');
insert into public.player_profiles(id,league_id,display_name) values ${players.map((p, i) => `('${p}','${L}','Player ${i + 1}')`).join(',')};
insert into public.real_football_teams(id,league_id,name) values ('${A}','${L}','Team A'),('${B}','${L}','Team B');
insert into public.real_team_players(league_id,team_id,player_id,valid_from) values
  ('${L}','${A}','${players[0]}',now()-interval '1 day'),('${L}','${B}','${players[1]}',now()-interval '1 day');
insert into public.seasons(id,league_id,name,starts_at,ends_at) values ('${season}','${L}','Season',now(),now()+interval '1 year');
insert into public.gameweeks(id,league_id,season_id,number,deadline) values ('${gw}','${L}','${season}',1,now());
insert into public.real_matches(id,league_id,gameweek_id,team_a_id,team_b_id,organizer_id,starts_at,venue,starters_per_side,max_substitutes)
  values ('${match}','${L}','${gw}','${A}','${B}','${organizer}',now(),'Pitch',1,1);
insert into public.match_revisions(id,league_id,match_id,version,match_snapshot) values ('${rev}','${L}','${match}',1,'{"format":"test"}');
insert into public.real_match_lineups(id,league_id,match_id,revision_id,team_id) values
  ('${la}','${L}','${match}','${rev}','${A}'),('${lb}','${L}','${match}','${rev}','${B}');
insert into public.real_match_lineup_players(league_id,revision_id,lineup_id,player_id,selection,actual_position,eligibility_kind,eligibility_evidence)
  values ('${L}','${rev}','${la}','${players[0]}','starter','GK','registered','{}'),
         ('${L}','${rev}','${lb}','${players[1]}','starter','DEF','registered','{}');
`);

let lineupApproval, resultAttemptOne, firstRequest;

test('an approved lineup provides an eligible result-fork source', async () => {
  const sub = await actor(organizer, () => value('select ff_private.submit_lineup($1,$2) as id', [L, rev]));
  lineupApproval = await actor(leader, () => value('select ff_private.review_submission($1,$2,$3,$4) as id', [L, sub, 'approved', null]));
  assert.ok(lineupApproval);
});

test('a stable request key makes a result fork idempotent', async () => {
  firstRequest = rid();
  resultAttemptOne = await actor(organizer, () => value('select ff_private.fork_result($1,$2,$3) as id', [L, lineupApproval, firstRequest]));
  assert.ok(resultAttemptOne);
  const replay = await actor(organizer, () => value('select ff_private.fork_result($1,$2,$3) as id', [L, lineupApproval, firstRequest]));
  assert.equal(replay, resultAttemptOne, 'a replay must return the stored revision, not a second draft');
  assert.equal((await q('select count(*)::int n from public.match_result_forks where league_id=$1', [L])).rows[0].n, 1);
  assert.equal((await q('select count(*)::int n from public.match_revisions where league_id=$1 and match_id=$2', [L, match])).rows[0].n, 2);
  const fork = (await q('select workflow_case_id, lineup_approval_id, result_attempt_no, lineup_revision_id from public.match_result_forks where request_id=$1', [firstRequest])).rows[0];
  assert.equal(fork.result_attempt_no, 1);
  assert.equal(fork.lineup_approval_id, lineupApproval);
  assert.equal(fork.lineup_revision_id, rev);
  assert.ok(fork.workflow_case_id, 'the initial-result case id must be persisted');
});

test('a fork without a request key is refused', async () => {
  await fail(actor(organizer, () => q('select ff_private.fork_result($1,$2,$3)', [L, lineupApproval, null])), '23514');
});

test('a new attempt key is refused while the previous attempt is not rejected', async () => {
  await fail(actor(organizer, () => q('select ff_private.fork_result($1,$2,$3)', [L, lineupApproval, rid()])), '23514');
  assert.equal((await q('select count(*)::int n from public.match_result_forks where league_id=$1', [L])).rows[0].n, 1);
});

test('the old two-argument fork_result signature is gone', async () => {
  const n = (await q(`select count(*)::int n from pg_proc p join pg_namespace s on s.oid=p.pronamespace
    where s.nspname='ff_private' and p.proname='fork_result' and p.pronargs=2`)).rows[0].n;
  assert.equal(n, 0, 'an idempotent fork cannot keep a signature with no request key');
});

test('a rejected result attempt permits explicitly numbered retry', async () => {
  await actor(organizer, () => q('select ff_private.set_result_score($1,$2,$3,$4)', [L, resultAttemptOne, 1, 0]));
  const sub = await actor(organizer, () => value('select ff_private.submit_result($1,$2,$3) as id', [L, resultAttemptOne, lineupApproval]));
  await fail(actor(leader, () => q('select ff_private.review_submission($1,$2,$3,$4)', [L, sub, 'rejected', null])), '23514');
  await actor(leader, () => q('select ff_private.review_submission($1,$2,$3,$4)', [L, sub, 'rejected', 'Wrong score']));
  const retry = await actor(organizer, () => value('select ff_private.fork_result($1,$2,$3) as id', [L, lineupApproval, rid()]));
  assert.ok(retry);
  const rows = (await q('select result_attempt_no, prior_fork_id from public.match_result_forks where league_id=$1 order by result_attempt_no', [L])).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[1].result_attempt_no, 2);
  assert.ok(rows[1].prior_fork_id, 'the retry must link to its prior attempt');
  // Replaying the original key still returns the original revision.
  assert.equal(await actor(organizer, () => value('select ff_private.fork_result($1,$2,$3) as id', [L, lineupApproval, firstRequest])), resultAttemptOne);
});

test('client roles hold no workflow EXECUTE and no DML on the new tables', async () => {
  const rows = (await q(`select p.proname from pg_proc p join pg_namespace s on s.oid=p.pronamespace
    where s.nspname='ff_private' and has_function_privilege('authenticated',p.oid,'execute') order by 1`)).rows.map(r => r.proname);
  assert.deepEqual(rows, ['can_read_image', 'can_read_lineup', 'can_read_match', 'can_read_revision',
    'can_read_suggestion', 'is_leader', 'is_match_organizer', 'is_member', 'is_organizer', 'owns_team']);
  assert.equal((await q(`select count(*)::int n from pg_proc p join pg_namespace s on s.oid=p.pronamespace
    where s.nspname='ff_private' and has_function_privilege('anon',p.oid,'execute')`)).rows[0].n, 0);
  for (const fn of ['fork_result', 'open_correction_attempt', 'open_correction', 'review_submission', 'start_scoring']) {
    assert.equal((await q(`select count(*)::int n from pg_proc p join pg_namespace s on s.oid=p.pronamespace
      where s.nspname='ff_private' and p.proname=$1 and has_function_privilege('anon',p.oid,'execute')`, [fn])).rows[0].n, 0, fn);
  }
  await fail(actor(manager, () => q('select ff_private.fork_result($1,$2,$3)', [L, lineupApproval, rid()]), 'authenticated'), '42501');
  await fail(actor(manager, () => q('select ff_private.open_correction_attempt($1,$2)', [L, match]), 'authenticated'), '42501');
  await fail(actor(manager, () => q('delete from public.match_result_forks where league_id=$1', [L]), 'authenticated'), '42501');
  await fail(actor(manager, () => q('delete from public.match_correction_attempts where league_id=$1', [L]), 'authenticated'), '42501');
});

let correctionId, attemptOneRevision;

test('opening a correction records immutable attempt 1', async () => {
  const retry = (await q("select result_revision_id from public.match_result_forks where result_attempt_no=2")).rows[0].result_revision_id;
  await actor(organizer, () => q('select ff_private.set_result_score($1,$2,$3,$4)', [L, retry, 2, 1]));
  const sub = await actor(organizer, () => value('select ff_private.submit_result($1,$2,$3) as id', [L, retry, lineupApproval]));
  await actor(leader, () => q('select ff_private.review_submission($1,$2,$3,$4)', [L, sub, 'approved', null]));
  assert.equal((await q('select count(*)::int n from public.official_match_results where match_id=$1 and is_current', [match])).rows[0].n, 1);

  const draft = await actor(leader, () => value('select ff_private.open_correction($1,$2,$3) as id', [L, match, 'Wrong score']));
  attemptOneRevision = draft;
  correctionId = (await q('select id from public.match_corrections where draft_revision_id=$1', [draft])).rows[0].id;
  const a1 = (await q('select attempt_no, draft_revision_id, prior_attempt_id from public.match_correction_attempts where correction_id=$1', [correctionId])).rows[0];
  assert.equal(a1.attempt_no, 1);
  assert.equal(a1.draft_revision_id, draft);
  assert.equal(a1.prior_attempt_id, null);
  await fail(q('update public.match_correction_attempts set attempt_no=9 where correction_id=$1', [correctionId]), '23514');
  await fail(q('delete from public.match_correction_attempts where correction_id=$1', [correctionId]), '23514');
});

test('a rejected correction lineup opens a numbered attempt that preserves lineage', async () => {
  // No new attempt while attempt 1 is still pending approval.
  const pending = await actor(organizer, () => value('select ff_private.submit_lineup($1,$2) as id', [L, attemptOneRevision]));
  await fail(actor(leader, () => q('select ff_private.open_correction_attempt($1,$2)', [L, correctionId])), '23514');
  await actor(leader, () => q('select ff_private.review_submission($1,$2,$3,$4)', [L, pending, 'rejected', 'Incomplete']));
  const draft2 = await actor(leader, () => value('select ff_private.open_correction_attempt($1,$2) as id', [L, correctionId]));
  const rows = (await q('select attempt_no, draft_revision_id, prior_attempt_id from public.match_correction_attempts where correction_id=$1 order by attempt_no', [correctionId])).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[1].attempt_no, 2);
  assert.equal(rows[1].draft_revision_id, draft2);
  assert.ok(rows[1].prior_attempt_id);
  // Lineage is preserved: the new draft corrects the same revision as attempt 1.
  const lineage = (await q('select corrects_revision_id from public.match_revisions where id=$1', [draft2])).rows[0].corrects_revision_id;
  const original = (await q('select corrects_revision_id from public.match_revisions where id=$1', [attemptOneRevision])).rows[0].corrects_revision_id;
  assert.equal(lineage, original);
  // The superseded attempt cannot be submitted again.
  await fail(actor(organizer, () => q('select ff_private.submit_lineup($1,$2)', [L, attemptOneRevision])), '23514');
});

test('only the latest correction attempt can be approved and source a result', async () => {
  const latest = (await q('select draft_revision_id from public.match_correction_attempts where correction_id=$1 order by attempt_no desc limit 1', [correctionId])).rows[0].draft_revision_id;
  const sub = await actor(organizer, () => value('select ff_private.submit_lineup($1,$2) as id', [L, latest]));
  const approval = await actor(leader, () => value('select ff_private.review_submission($1,$2,$3,$4) as id', [L, sub, 'approved', null]));
  assert.ok(approval);
  // The fork source must be the latest attempt's approval.
  const fork = await actor(organizer, () => value('select ff_private.fork_result($1,$2,$3) as id', [L, approval, rid()]));
  assert.ok(fork);
  // Attempt 1's approval, if it existed, is no longer a valid source; asserting
  // the corrective fork belongs to the newest approval is the positive check.
  const f = (await q('select lineup_approval_id from public.match_result_forks where result_revision_id=$1', [fork])).rows[0];
  assert.equal(f.lineup_approval_id, approval);
  // No further attempt may be opened while the latest one is approved.
  await fail(actor(leader, () => q('select ff_private.open_correction_attempt($1,$2)', [L, correctionId])), '23514');
});

test('the privilege verification migration asserts the reviewed model', async () => {
  // 010 already ran as part of the chain above and must not have raised. Assert
  // the observable end state it checks.
  assert.equal((await q(`select count(*)::int n from pg_class c join pg_namespace s on s.oid=c.relnamespace
    where s.nspname='public' and c.relkind='r' and not c.relrowsecurity`)).rows[0].n, 0, 'every public table has RLS');
  assert.equal((await q(`select count(*)::int n from pg_proc p join pg_namespace s on s.oid=p.pronamespace
    where s.nspname in ('public','ff_private') and p.prosecdef
      and not exists (select 1 from unnest(coalesce(p.proconfig,'{}'::text[])) c where c like 'search_path=%')`)).rows[0].n, 0,
    'every SECURITY DEFINER function pins search_path');
});
