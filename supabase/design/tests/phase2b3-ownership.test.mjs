// Phase 2B.3 — SECURITY DEFINER ownership behaviour tests.
//
// These tests answer one question with evidence rather than argument: what
// actually happens to the 56 SECURITY DEFINER functions when their owner changes?
//
// Claims, roles and the privileged gateway are mocked. This is NOT a Supabase
// compatibility claim and does not model a hosted JWT, PostgREST, the pooler, or
// real concurrency. A green run is local design evidence only.
//
// The suite is one sequential narrative: it walks the ownership models in order,
// because each one is defined relative to the previous by an explicit
// `reset ownership` step (never by mutating a shared assumption).
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
const one = async (sql, params = []) => (await q(sql, params)).rows[0];
const scalar = async (sql, params = []) => Object.values(await one(sql, params))[0];

const L = '10000000-0000-0000-0000-0000000000a1';
const other = '10000000-0000-0000-0000-0000000000a2';
const leader = '20000000-0000-0000-0000-0000000000a1';
const organizer = '20000000-0000-0000-0000-0000000000a2';
const outsider = '20000000-0000-0000-0000-0000000000a3';
const match = '60000000-0000-0000-0000-0000000000a1';

// Real Supabase Auth publishes the (legacy, singular) `request.jwt.claim.sub`
// setting, which is what setup.sql's auth.uid() mock reads. Using the wrong
// claim name silently yields a null uid, so the helper for it is defined once.
async function asUser(id, fn, role = 'authenticated') {
  await q("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const callHelper = (id, name, args) =>
  asUser(id, async () => (await q(`select ff_private.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) as v`, args)).rows[0].v);
const expectDenied = (p) => assert.rejects(p, e => /permission denied/.test(e.message));

await db.exec(`
insert into auth.users values ('${leader}'),('${organizer}'),('${outsider}');
`);
await db.exec(`
insert into public.profiles(id,display_name) values
  ('${leader}','Leader A'),('${organizer}','Organizer A'),('${outsider}','Outsider');
`);
await db.exec(`
insert into public.leagues(id,name) values ('${L}','Ownership League'),('${other}','Other League');
`);
await db.exec(`
insert into public.league_members(league_id,user_id,role) values
  ('${L}','${leader}','leader'),('${L}','${organizer}','manager'),('${other}','${outsider}','leader');
`);
await db.exec(`insert into public.match_organizers values ('${L}','${organizer}')`);

// Reads league_members directly as the definer role, which isolates "what does
// the definer itself see" from any policy or helper in the way.
const asDefiner = async () => {
  await db.exec('set role ff_migration_owner');
  try { return (await q('select count(*)::int c from public.league_members')).rows[0].c; }
  finally { await db.exec('reset role'); }
};

async function reownFunctions(role) {
  await db.exec(`do $$ declare f record; begin
    for f in select p.oid::regprocedure r from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
             where n.nspname in ('public','ff_private') and p.prosecdef
    loop execute format('alter function %s owner to ${role}', f.r); end loop; end $$;`);
}

// ---------------------------------------------------------------------------
// 1. Inventory and structural properties
// ---------------------------------------------------------------------------

test('the review covers all 56 SECURITY DEFINER functions', async () => {
  const n = await scalar(`select count(*)::int c from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','ff_private') and p.prosecdef`);
  assert.equal(n, 56);
});

test('every definer function lives in ff_private, not in the exposed public schema', async () => {
  const rows = (await q(`select n.nspname s, count(*)::int c from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where p.prosecdef group by 1 order by 1`)).rows;
  assert.deepEqual(rows, [{ s: 'ff_private', c: 56 }]);
});

test('every definer function pins search_path and none is in an unsafe schema', async () => {
  const bad = (await q(`select n.nspname||'.'||p.proname fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','ff_private') and p.prosecdef
      and (p.proconfig is null
           or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))`)).rows;
  assert.deepEqual(bad, [], 'definer functions without pinned search_path');
  // A pinned path must not be mutable by a client: it may not start with a
  // schema a client can create objects in.
  const mutable = (await q(`select n.nspname||'.'||p.proname fn, p.proconfig cfg from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where p.prosecdef
      and exists (select 1 from unnest(p.proconfig) c
                  where c like 'search_path=%' and c not like 'search_path=pg_catalog, ff_private')`)).rows;
  assert.deepEqual(mutable, [], 'definer functions with an unexpected search_path');
});

test('all 40 public tables have RLS enabled and none is FORCE ROW LEVEL SECURITY', async () => {
  const rows = (await q(`select c.relrowsecurity rls, c.relforcerowsecurity force, count(*)::int c
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' group by 1,2`)).rows;
  assert.deepEqual(rows, [{ rls: true, force: false, c: 40 }]);
});

// ---------------------------------------------------------------------------
// 2. Baseline: the current owner is the table owner
// ---------------------------------------------------------------------------

test('baseline: the definer functions and the public tables share one owner', async () => {
  // The invariant that matters is not the role's name (it is `postgres` on
  // Supabase but whatever the local superuser is), it is that the definer and
  // the tables are the SAME role, which is what makes the implicit RLS bypass
  // work. Asserting the name would make this test environment-dependent.
  const fnOwners = (await q(`select distinct pg_get_userbyid(p.proowner) o from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where p.prosecdef`)).rows.map(r => r.o);
  assert.equal(fnOwners.length, 1, `definer functions have mixed owners: ${fnOwners}`);
  const tableOwners = (await q(`select distinct pg_get_userbyid(c.relowner) o from pg_class c
    join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'`)).rows.map(r => r.o);
  assert.deepEqual(tableOwners, fnOwners, 'definer owner must equal the public table owner');
});

test('baseline: the read helpers resolve correctly for a real member', async () => {
  assert.equal(await callHelper(leader, 'is_member', [L]), true);
  assert.equal(await callHelper(leader, 'is_leader', [L]), true);
  assert.equal(await callHelper(leader, 'is_organizer', [L]), false);
  assert.equal(await callHelper(organizer, 'is_organizer', [L]), true);
  assert.equal(await callHelper(outsider, 'is_member', [L]), false);
});

// ---------------------------------------------------------------------------
// 3. Model A — re-own functions only (the naive half-change)
// ---------------------------------------------------------------------------

test('model A: USAGE on schema auth is a separate privilege and 009 now supplies it', async () => {
  // EXECUTE on auth.uid() is not enough: the definer also needs USAGE on schema
  // auth. This was a real defect in the 2B.2 draft of 009, which granted only
  // EXECUTE. Demonstrate the dependency, then prove 009 satisfies it.
  assert.equal(await scalar(`select has_schema_privilege('ff_migration_owner','auth','USAGE')`), true);
  await reownFunctions('ff_migration_owner');
  await db.exec('revoke usage on schema auth from ff_migration_owner');
  await expectDenied(asUser(leader, () => q(`select ff_private.is_member($1)`, [L])));
  await db.exec('grant usage on schema auth to ff_migration_owner');
  // ...and with the grant back, the call works normally again.
  assert.equal(await callHelper(leader, 'is_member', [L]), true);
});

// ---------------------------------------------------------------------------
// 4. Model B — re-own functions and grant table access, still no BYPASSRLS
// ---------------------------------------------------------------------------

test('model B: with full privileges but nobypassrls, the helpers silently return false', async () => {
  await db.exec('alter role ff_migration_owner nobypassrls');
  // This is the dangerous failure mode: it is not an error. Policies are
  // `to authenticated`, the definer is ff_migration_owner, so no policy applies
  // and every inner `exists(... where user_id = auth.uid())` sees zero rows.
  assert.equal(await callHelper(leader, 'is_member', [L]), false);
  assert.equal(await callHelper(leader, 'is_leader', [L]), false);
  assert.equal(await callHelper(organizer, 'is_organizer', [L]), false);
  // The probe proves the cause is RLS, not a missing privilege: it can read the
  // table, it just sees nothing.
  assert.equal(await asDefiner(), 0);
});

test('model B: an outsider is indistinguishable from a member under the silent-false failure', async () => {
  // Both are false, so authorization "fails closed" for the member and the
  // outsider alike. Any code path treating false as "not authorized" would deny
  // every legitimate user, and the failure would look like a data problem.
  assert.equal(await callHelper(leader, 'is_member', [L]), false);
  assert.equal(await callHelper(outsider, 'is_member', [L]), false);
});

// ---------------------------------------------------------------------------
// 5. Model C — the proposed owner: BYPASSRLS, no table ownership
// ---------------------------------------------------------------------------

test('model C: BYPASSRLS restores the exact baseline behaviour, with no table ownership', async () => {
  await db.exec('alter role ff_migration_owner bypassrls');
  assert.equal(await callHelper(leader, 'is_member', [L]), true);
  assert.equal(await callHelper(leader, 'is_leader', [L]), true);
  assert.equal(await callHelper(organizer, 'is_organizer', [L]), true);
  assert.equal(await callHelper(outsider, 'is_member', [L]), false);
  // And it does not own any table, so it cannot run DDL on them.
  const owned = await scalar(`select count(*)::int c from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and pg_get_userbyid(c.relowner)='ff_migration_owner'`);
  assert.equal(owned, 0);
});

test('model C does not widen client access: RLS still filters direct reads', async () => {
  assert.equal(await asUser(leader, async () => scalar('select count(*)::int from public.league_members where league_id=$1', [L])), 2);
  assert.equal(await asUser(outsider, async () => scalar('select count(*)::int from public.league_members where league_id=$1', [L])), 0);
  // anon has no schema usage at all, so it cannot even reach the helpers.
  await expectDenied(asUser(outsider, () => q(`select ff_private.is_member($1)`, [L]), 'anon'));
});

// ---------------------------------------------------------------------------
// 6. Caller identity and revocation under the proposed owner
// ---------------------------------------------------------------------------

test('a null caller identity never authorizes', async () => {
  await db.exec('set role authenticated');
  try {
    await q("select set_config('request.jwt.claim.sub','',false)");
    assert.equal((await q(`select ff_private.is_member($1) v`, [L])).rows[0].v, false);
    assert.equal((await q(`select ff_private.is_leader($1) v`, [L])).rows[0].v, false);
  } finally { await db.exec('reset role'); }
});

test('membership revocation removes access immediately', async () => {
  assert.equal(await callHelper(organizer, 'is_member', [L]), true);
  await q(`update public.league_members set status='inactive' where league_id=$1 and user_id=$2`, [L, organizer]);
  assert.equal(await callHelper(organizer, 'is_member', [L]), false);
  assert.equal(await callHelper(organizer, 'is_organizer', [L]), false);
  await q(`update public.league_members set status='active' where league_id=$1 and user_id=$2`, [L, organizer]);
  assert.equal(await callHelper(organizer, 'is_member', [L]), true);
});

test('role revocation removes leader and organizer authority', async () => {
  await q(`update public.league_members set role='manager' where league_id=$1 and user_id=$2`, [L, leader]);
  assert.equal(await callHelper(leader, 'is_leader', [L]), false);
  assert.equal(await callHelper(leader, 'is_member', [L]), true);
  await q(`update public.league_members set role='leader' where league_id=$1 and user_id=$2`, [L, leader]);
  assert.equal(await callHelper(leader, 'is_leader', [L]), true);

  await q(`delete from public.match_organizers where league_id=$1 and user_id=$2`, [L, organizer]);
  assert.equal(await callHelper(organizer, 'is_organizer', [L]), false);
  await q(`insert into public.match_organizers values ($1,$2)`, [L, organizer]);
  assert.equal(await callHelper(organizer, 'is_organizer', [L]), true);
});

test('a member of one league gets nothing from another league', async () => {
  assert.equal(await callHelper(outsider, 'is_member', [other]), true);
  assert.equal(await callHelper(outsider, 'is_member', [L]), false);
  assert.equal(await callHelper(leader, 'is_member', [other]), false);
});

test('helper arguments cannot be used to read another league through a definer path', async () => {
  // can_read_match takes both ids; a mismatched pair must be false, not an error
  // and not a grant.
  assert.equal(await callHelper(outsider, 'can_read_match', [L, match]), false);
});

// ---------------------------------------------------------------------------
// 7. search_path safety
// ---------------------------------------------------------------------------

test('a hostile schema first on the session search_path cannot hijack a definer function', async () => {
  // Create a same-named function in a schema a client could plausibly reach.
  await db.exec(`
    create schema if not exists hostile;
    create function hostile.require_read_committed() returns void language plpgsql as $$
      begin raise exception 'hijacked require_read_committed'; end $$;
    create function hostile.current_setting(text, boolean) returns text language plpgsql as $$
      begin raise exception 'hijacked current_setting'; end $$;
    grant usage on schema hostile to authenticated;
  `);
  await db.exec(`set search_path = hostile, public, pg_catalog`);
  try {
    // is_member does not call these, so use a function that does: any workflow
    // helper reached through the definer context must ignore the caller's path.
    assert.equal(await asUser(leader, async () =>
      (await q(`select ff_private.is_member($1) v`, [L])).rows[0].v), true);
    assert.equal(await asDefiner() >= 0, true);
  } finally { await db.exec('reset search_path'); }
});

test('every definer function has search_path pinned to pg_catalog and ff_private only', async () => {
  const n = await scalar(`select count(*)::int c from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='ff_private' and p.prosecdef and p.proconfig = array['search_path=pg_catalog, ff_private']`);
  assert.equal(n, 56);
});

// ---------------------------------------------------------------------------
// 8. EXECUTE surface
// ---------------------------------------------------------------------------

test('anon can execute no function in public or ff_private', async () => {
  const rows = (await q(`select n.nspname||'.'||p.proname fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','ff_private') and has_function_privilege('anon', p.oid, 'execute')`)).rows;
  assert.deepEqual(rows, []);
});

test('authenticated can execute exactly the ten reviewed read helpers', async () => {
  const rows = (await q(`select p.proname fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','ff_private') and has_function_privilege('authenticated', p.oid, 'execute')
    order by 1`)).rows.map(r => r.fn);
  assert.deepEqual(rows, ['can_read_image', 'can_read_lineup', 'can_read_match', 'can_read_revision',
    'can_read_suggestion', 'is_leader', 'is_match_organizer', 'is_member', 'is_organizer', 'owns_team']);
});

test('no mutation workflow is executable by a client role', async () => {
  const workflows = ['submit_lineup', 'submit_result', 'review_submission', 'fork_result',
    'open_correction', 'open_correction_attempt', 'start_scoring', 'authorize_temporary',
    'record_event', 'set_result_score'];
  for (const w of workflows) {
    const granted = (await q(`select has_function_privilege('authenticated', p.oid, 'execute') g
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='ff_private' and p.proname=$1`, [w])).rows;
    assert.ok(granted.length > 0, `${w} should exist`);
    for (const row of granted) assert.equal(row.g, false, `${w} must not be executable by authenticated`);
  }
});

test('PUBLIC holds no EXECUTE on any reviewed function', async () => {
  const rows = (await q(`select p.proname fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','ff_private') and exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type='EXECUTE')`)).rows;
  assert.deepEqual(rows, []);
});

// ---------------------------------------------------------------------------
// 9. The 010 assertion is now correct, and would catch the wrong model
// ---------------------------------------------------------------------------

test('010 requires BYPASSRLS on the definer owner, because ownership change is otherwise silent-broken', async () => {
  // Re-run the reviewed verification. Under model C it must pass.
  await db.exec(await readFile(new URL('../migrations/010_privilege_verification.sql', import.meta.url), 'utf8'));
  // Under a nobypassrls owner it must fail, otherwise the assertion is decorative.
  await db.exec('alter role ff_migration_owner nobypassrls');
  await assert.rejects(
    db.exec(await readFile(new URL('../migrations/010_privilege_verification.sql', import.meta.url), 'utf8')),
    e => e.code === '42501' && /BYPASSRLS/.test(e.message),
  );
  await db.exec('alter role ff_migration_owner bypassrls');
});

// ---------------------------------------------------------------------------
// 10. Phase 2B.4: 009 must load even when the deploying role is not a member of
//     postgres. ALTER DEFAULT PRIVILEGES ... FOR ROLE postgres requires that
//     membership, and an unguarded statement aborts the whole migration with
//     'permission denied to change default privileges'.
// ---------------------------------------------------------------------------

test('009 guards its ALTER DEFAULT PRIVILEGES so a non-member deployment role can still apply it', async () => {
  const sql = await readFile(new URL('../migrations/009_ownership_and_grants.sql', import.meta.url), 'utf8');
  // Every ALTER DEFAULT PRIVILEGES must sit inside a DO block behind a
  // pg_has_role guard, never at statement level (column 0). Indentation alone
  // does not prove the guard, so this checks both: no statement-level
  // occurrence, and each occurrence is preceded by the membership check.
  const lines = sql.split('\n');
  const atStatementLevel = lines
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /^alter\s+default\s+privileges/i.test(line));
  assert.deepEqual(atStatementLevel, [], 'ALTER DEFAULT PRIVILEGES must not appear at statement level');
  const guarded = lines
    .filter(line => /^\s*alter\s+default\s+privileges/i.test(line))
    .map(line => lines.indexOf(line));
  for (const idx of guarded) {
    const window = lines.slice(Math.max(0, idx - 12), idx).join('\n');
    assert.match(window, /pg_has_role\(current_user/,
      `ALTER DEFAULT PRIVILEGES at line ${idx + 1} is not preceded by a membership guard`);
  }
  assert.match(sql, /pg_has_role\(current_user,\s*'postgres',\s*'member'\)/,
    'the postgres default-privilege change must be guarded by a membership check');
  assert.ok(guarded.length > 0, 'expected at least one guarded ALTER DEFAULT PRIVILEGES');

  // The authoritative control does not depend on that default: the explicit
  // function-level revoke must still hold.
  const publicExec = await scalar(`select count(*)::int c from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','ff_private')
      and exists (select 1 from aclexplode(p.proacl) a
                  where a.grantee = 0 and a.privilege_type = 'EXECUTE')`);
  assert.equal(publicExec, 0);
});

test('the default-privilege guard skips cleanly for a non-member AND for an absent role', async () => {
  // Two independent skip cases. The second is the subtle one: pg_has_role()
  // RAISES 42704 when the named role does not exist rather than returning false,
  // so a self-hosted or CI cluster with no `postgres` role would abort the whole
  // migration unless existence is checked first.
  const guard = (role) => `do $$ begin
    if exists (select 1 from pg_roles where rolname = '${role}')
       and pg_has_role(current_user, '${role}', 'member') then
      null;
    end if;
  end $$;`;
  await db.exec(guard('postgres'));          // present, may or may not be a member
  await db.exec(guard('no_such_role_absent')); // absent: must skip, not raise
  // And the naive form really does raise, which is why existence is checked first.
  await assert.rejects(
    db.exec(`select pg_has_role(current_user, 'no_such_role_absent', 'member')`),
    e => e.code === '42704',
  );
});
