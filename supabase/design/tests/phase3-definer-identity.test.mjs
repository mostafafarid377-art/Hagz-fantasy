// Phase 3-10 — the definer's caller identity must not need USAGE on `auth`.
//
// REGRESSION GUARD for the hosted deployment failure. The privilege verification
// — executable 012 at the time, now executable 013 — aborted with
//     'ff_migration_owner needs USAGE on schema auth to call auth.uid()'
//
// The first version of the package assumed 009's
//     grant usage on schema auth to ff_migration_owner;
// worked. It does not on hosted Supabase: the auth schema is owned by
// supabase_admin, `postgres` holds USAGE without the grant option, and PostgreSQL
// lets a role grant only what it holds WITH GRANT OPTION. The statement therefore
// succeeds and changes nothing — Postgres only logs
//     WARNING: no privileges were granted for "auth".
//
// The harness below models that faithfully: `deployer` is a CREATEROLE +
// BYPASSRLS NON-superuser holding USAGE (no grant option) on auth/storage, and it
// does NOT own auth. That one detail is what makes the no-op observable; an
// earlier harness granted `deployer` the grant option on auth and hid the bug.
//
// What this proves: on a hosted-shaped database, all migrations apply and the
// API is callable without any privilege on the auth schema.
// What it does NOT prove: the live project. auth.uid() and the storage owner are
// stand-ins.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = new URL('../../migrations/', import.meta.url);
const STORAGE_POLICY = `create policy player_images_member_read on storage.objects
  for select to authenticated
  using(bucket_id='player-images' and ff_private.can_read_image(name))`;

const db = await PGlite.create();

// Hosted-Supabase shape: internal schemas owned by the Supabase admin roles, and
// the migrating role holding USAGE only — never the grant option.
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role supabase_admin nologin bypassrls;
  create role supabase_auth_admin nologin;
  create role supabase_storage_admin nologin;
  create role deployer login password 'x' createrole createdb bypassrls;

  grant create on database postgres to deployer;
  grant create on schema public to deployer with grant option;

  create schema auth authorization supabase_admin;
  create table auth.users(id uuid primary key);
  -- The HOSTED definition, verbatim (supabase/auth migration
  -- 20211202183645_update_auth_uid.up.sql). The local/CLI auth.uid() is the shorter
  -- per-claim-only form; using that one here would hide the exact production bug
  -- this suite exists to catch, because the two disagree whenever PostgREST has set
  -- only the aggregate request.jwt.claims GUC.
  --
  -- The outer nullif is load-bearing: per-claim '' + aggregate sub -> NULL.
  create function auth.uid() returns uuid language sql stable
    as $$
      select
        nullif(
          coalesce(
            current_setting('request.jwt.claim.sub', true),
            (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')
          ),
          ''
        )::uuid
    $$;
  alter function auth.uid() owner to supabase_auth_admin;
  grant usage on schema auth to authenticated, anon, deployer;   -- NO grant option
  grant execute on function auth.uid() to authenticated, anon, deployer;
  grant references on auth.users to deployer;

  create schema storage authorization supabase_storage_admin;
  create table storage.buckets(id text primary key, name text, public boolean,
                               file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects(id uuid primary key default gen_random_uuid(),
                               bucket_id text, name text);
  alter table storage.objects enable row level security;
  grant usage on schema storage to authenticated, deployer;
  grant select on storage.objects to authenticated;
  grant insert, update, delete on storage.buckets to deployer;
`);

const applied = [];
let abort = null;
const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
for (const f of files) {
  await db.exec('set role deployer');
  try {
    await db.exec('begin');
    await db.exec(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await db.exec('commit');
    applied.push(f);
  } catch (e) {
    await db.exec('rollback');
    await db.exec('reset role');
    abort = { file: f, code: e.code, message: (e.message || '').split('\n')[0] };
    break;
  }
  await db.exec('reset role');
  // Runbook §7c: the storage policy is created by the storage owner after the
  // push and before the assertion that checks it.
  if (f.includes('definer_actor_identity')) await db.exec(STORAGE_POLICY);
}

after(() => db.close());

const q = (sql, params = []) => db.query(sql, params);
const scalar = async (sql, params = []) => Object.values((await q(sql, params)).rows[0])[0];

test('the whole package applies as a non-superuser that does not own auth', () => {
  assert.equal(abort, null, abort ? `${abort.file}: ${abort.code} ${abort.message}` : '');
  assert.equal(applied.length, files.length, 'every migration must apply');
});

test('009-style grant on auth is a no-op as this role, which is why it cannot be relied on', async () => {
  // Prove the mechanism the repair works around, so this suite fails loudly if a
  // future change reintroduces a dependency on it.
  assert.equal(await scalar(`select has_schema_privilege('ff_migration_owner', 'auth', 'USAGE')`), false);
  // The statement the old 009 relied on: runs without error, changes nothing.
  await db.exec('set role deployer');
  await db.exec('grant usage on schema auth to ff_migration_owner');
  await db.exec('reset role');
  assert.equal(
    await scalar(`select has_schema_privilege('ff_migration_owner', 'auth', 'USAGE')`),
    false,
    'grant must remain ineffective: the migrating role holds no grant option on auth',
  );
});

test('no SECURITY DEFINER function owned by the definer references auth.uid()', async () => {
  assert.equal(
    await scalar(`
      select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','ff_private') and p.prosecdef
        and position('auth.uid()' in p.prosrc) > 0`),
    0,
  );
});

test('every SECURITY DEFINER function is still owned by ff_migration_owner', async () => {
  const total = await scalar(`
    select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','ff_private') and p.prosecdef`);
  const owned = await scalar(`
    select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','ff_private') and p.prosecdef
      and pg_get_userbyid(p.proowner) = 'ff_migration_owner'`);
  assert.ok(total > 0, 'expected SECURITY DEFINER functions to exist');
  assert.equal(owned, total, 'ownership must not drift during the rewrite');
});

test('ff_migration_owner keeps its reviewed attributes', async () => {
  const r = (await q(`select rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
                      from pg_roles where rolname = 'ff_migration_owner'`)).rows[0];
  assert.deepEqual(r, {
    rolcanlogin: false, rolinherit: false, rolsuper: false,
    rolcreatedb: false, rolcreaterole: false, rolbypassrls: true,
  });
});

test('the actor helper is reachable by the definer only, never by a client role', async () => {
  assert.equal(await scalar(`select has_function_privilege('ff_migration_owner','ff_private.current_actor_id()','execute')`), true);
  assert.equal(await scalar(`select has_function_privilege('authenticated','ff_private.current_actor_id()','execute')`), false);
  assert.equal(await scalar(`select has_function_privilege('anon','ff_private.current_actor_id()','execute')`), false);
});

// --- Caller identity: the helper must agree with auth.uid() in EVERY state ---
//
// The security requirement is not "usually the same". It is that there is no input
// state in which the helper yields an identity that auth.uid() does not, because
// that would authenticate a caller the platform considers anonymous -- and,
// symmetrically, no state in which the platform considers a caller authenticated
// while the helper says NULL, because that is a live outage. It was: executable
// 012 shipped the per-claim-only helper, hosted PostgREST populates only the
// aggregate request.jwt.claims GUC, every repointed definer saw NULL, and
// ff_bootstrap answered 42501 "authentication required" to signed-in users.
//
// Two distinctions this suite must keep apart, because conflating them is what hid
// the bug:
//   * UNSET vs EMPTY. current_setting(guc, true) returns NULL only when the
//     setting was never touched. `set_config(guc, '', false)` stores an EMPTY
//     STRING, which is present, so coalesce() stops there and the outer nullif()
//     yields NULL. PostgREST never sets request.jwt.claim.sub at all, which is the
//     UNSET case -- the one the runtime takes, and the one that needs a fresh
//     backend to reproduce.
//   * hosted vs local/CLI auth.uid(). Only the local one is per-claim-only. The
//     harness above now models the hosted definition.
//
// HISTORY of these assertions: they previously required the helper to return NULL
// whenever the per-claim GUC was empty or absent, and required the body never to
// read request.jwt.claims. Both encoded the wrong platform. They are inverted here
// against the real definition in supabase/auth migration
// 20211202183645_update_auth_uid.up.sql.

const A = '11111111-2222-3333-4444-555555555555';
const B = '99999999-9999-9999-9999-999999999999';

/** Set both claim GUCs. `undefined` leaves the current value alone. */
const setClaims = async (sub, claims) => {
  if (sub !== undefined) await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [sub]);
  if (claims !== undefined) await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims]);
};
const both = async () => (await q(`select auth.uid() as a, ff_private.current_actor_id() as h`)).rows[0];

/**
 * The four states reachable in THIS session, where both settings are always
 * present once touched. Each is asserted as strict parity with auth.uid().
 */
const CLAIM_STATES = [
  { name: 'both settings empty (no token)',        sub: '', claims: '',                              expect: null },
  { name: 'both settings present and identical',   sub: A,  claims: JSON.stringify({ sub: A, role: 'authenticated' }), expect: A },
  { name: 'per-claim empty, aggregate has a sub',  sub: '', claims: JSON.stringify({ sub: A }),      expect: null },
  { name: 'conflicting per-claim and aggregate',   sub: A,  claims: JSON.stringify({ sub: B }),      expect: A },
  { name: 'aggregate present without a sub key',   sub: '', claims: JSON.stringify({ role: 'anon' }), expect: null },
];

for (const state of CLAIM_STATES) {
  test(`identity parity: ${state.name}`, async () => {
    await setClaims(state.sub, state.claims);
    const r = await both();
    assert.deepEqual({ a: r.a, h: r.h }, { a: state.expect, h: state.expect },
      `helper and auth.uid() must both resolve to ${state.expect}`);
  });
}

test('identity: per-claim empty must NOT be rescued by the aggregate claims (widening guard)', async () => {
  // The binding security property behind state 3. The inner-nullif variant
  //   coalesce(nullif(sub,''), nullif(claims,'')::jsonb ->> 'sub')
  // returns A here, authenticating a caller the platform treats as anonymous.
  // The outer-nullif form -- what 015 installs -- returns NULL. This is the one
  // behavioural difference between the two circulating definitions, so it is
  // asserted on its own rather than buried in the table.
  await setClaims('', JSON.stringify({ sub: A }));
  const r = await both();
  assert.equal(r.a, null, 'hosted auth.uid() refuses to fall back past an empty setting');
  assert.equal(r.h, null, 'the helper must refuse too; otherwise it widens access relative to the platform');
});

test('identity: per-claim GUC genuinely unset -> both fall back to the aggregate claims', async () => {
  // THE production state, and the only way to exercise the coalesce branch.
  // PostgREST sets request.jwt.claims only, so request.jwt.claim.sub is NULL, not
  // ''. That cannot be produced in this session (RESET and set_config(...,'') both
  // leave a present empty string), so it is reproduced in a fresh backend that
  // loads the deployed helper definition verbatim via pg_get_functiondef.
  const helperDef = await scalar(
    `select pg_get_functiondef('ff_private.current_actor_id()'::regprocedure)`);

  const fresh = await PGlite.create();
  try {
    // The hosted auth.uid(), same expression as the harness above.
    await fresh.exec(`
      create schema if not exists auth;
      create function auth.uid() returns uuid language sql stable as $$
        select
          nullif(
            coalesce(
              current_setting('request.jwt.claim.sub', true),
              (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')
            ),
            ''
          )::uuid
      $$;
      create schema if not exists ff_private;
    `);
    // Exactly the function the migrations deployed -- not a hand-copied restatement.
    await fresh.exec(helperDef);

    // PostgREST request: only the aggregate claim set; per-claim never touched.
    await fresh.query(`select set_config('request.jwt.claims', $1, false)`,
      [JSON.stringify({ sub: A, role: 'authenticated' })]);

    const r = (await fresh.query(
      `select auth.uid() as a, ff_private.current_actor_id() as h`)).rows[0];
    assert.equal(r.a, A, 'hosted auth.uid() resolves the user from the aggregate claims');
    assert.equal(r.h, A,
      'the helper must resolve the same identity from the aggregate claims (executable 015); '
      + 'returning NULL here is the 42501 regression');
  } finally {
    await fresh.close();
  }
});

test('identity: malformed UUID in the per-claim setting raises, it does not fall back', async () => {
  await setClaims('not-a-uuid', '');
  await assert.rejects(q(`select auth.uid()`), (e) => e.code === '22P02');
  await assert.rejects(q(`select ff_private.current_actor_id()`), (e) => e.code === '22P02');
});

test('identity: malformed aggregate JSON only matters when it is actually parsed', async () => {
  // Per-claim present: the aggregate JSON is never consulted, so garbage is inert.
  await setClaims(A, '{not json');
  assert.deepEqual(await both(), { a: A, h: A });
  // Per-claim empty: still inert -- the outer nullif rejects '' before any parse.
  await setClaims('', '{not json');
  assert.deepEqual(await both(), { a: null, h: null });
});

test('identity: unauthenticated request -> null, never a bogus identity', async () => {
  await setClaims('', '');
  assert.deepEqual(await both(), { a: null, h: null });
  await setClaims('', '{}');
  assert.deepEqual(await both(), { a: null, h: null });
  await setClaims('', JSON.stringify({ role: 'anon' }));
  assert.deepEqual(await both(), { a: null, h: null });
});

test('the helper body reads both claim sources, per-claim first (structural)', async () => {
  // Structural guarantee, so a future edit cannot quietly drop the aggregate
  // fallback again. Behavioural tests alone did not catch it, because the harness
  // modelled the wrong platform.
  const src = await scalar(`select prosrc from pg_proc
    where oid = 'ff_private.current_actor_id()'::regprocedure`);
  assert.match(src, /request\.jwt\.claim\.sub/, 'must read the per-claim setting');
  assert.match(src, /request\.jwt\.claims/, 'must fall back to the aggregate claims GUC');
  assert.match(src, /coalesce/i, 'the fallback must be a coalesce');
  assert.ok(src.indexOf('request.jwt.claim.sub') < src.indexOf('request.jwt.claims'),
    'the per-claim setting must be consulted before the aggregate claims, so it always shadows them');
});

test('the helper expression is identical in semantics to the hosted auth.uid()', async () => {
  // Strongest form of the parity claim: normalise both bodies and require an exact
  // match. Guards against reintroducing the shorter local/CLI definition.
  const helper = await scalar(`select prosrc from pg_proc
    where oid = 'ff_private.current_actor_id()'::regprocedure`);
  const hosted = await scalar(`select prosrc from pg_proc where oid = 'auth.uid()'::regprocedure`);
  const norm = (t) => t.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  assert.equal(norm(helper), norm(hosted),
    'the helper must be the hosted auth.uid() expression, not the per-claim-only local one');
});

test('the helper keeps SECURITY INVOKER, ff_migration_owner ownership and a pinned search_path', async () => {
  const r = (await q(`
    select p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig
    from pg_proc p where p.oid = 'ff_private.current_actor_id()'::regprocedure`)).rows[0];
  assert.equal(r.prosecdef, false, 'must stay SECURITY INVOKER');
  assert.equal(r.owner, 'ff_migration_owner', 'ownership must not change in the body repair');
  assert.ok((r.proconfig || []).some((c) => c.startsWith('search_path=')
      && /pg_catalog/.test(c) && /pg_temp/.test(c)),
    `search_path must stay pinned to pg_catalog, pg_temp; got ${JSON.stringify(r.proconfig)}`);
});

test('the deployed API is callable by authenticated with no USAGE on auth', async () => {
  const uid = (await q(`select gen_random_uuid() u`)).rows[0].u;
  await db.exec(`insert into auth.users(id) values ('${uid}')`);
  await db.exec(`select set_config('request.jwt.claim.sub', '${uid}', false)`);

  const rpcs = (await q(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'ff\\_%'
      and has_function_privilege('authenticated', p.oid, 'execute')
    order by 1`)).rows;

  await db.exec('set role authenticated');
  const authFailures = [];
  for (const { proname } of rpcs) {
    try {
      await db.exec(`select public.${proname}()`);
    } catch (e) {
      // Argument-required and guard refusals are expected. A schema-auth denial
      // is the exact regression this suite exists to catch.
      if (/permission denied for schema auth/.test(e.message)) authFailures.push(proname);
    }
  }
  await db.exec('reset role');

  assert.ok(rpcs.length > 0, 'expected client-executable RPCs to exist');
  assert.deepEqual(authFailures, [], `RPCs denied by schema auth: ${authFailures.join(', ')}`);
});
