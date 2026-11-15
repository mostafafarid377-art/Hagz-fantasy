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
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
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
// The security requirement is not "usually the same". It is that there is no
// input state in which the helper yields an identity that auth.uid() does not,
// because that would authenticate a caller the platform considers anonymous.
// An earlier revision fell back to `request.jwt.claims ->> 'sub'` and failed
// exactly that test; these cases are the regression guard for it.

const A = '11111111-2222-3333-4444-555555555555';
const B = '99999999-9999-9999-9999-999999999999';

const setClaims = async (sub, claims) => {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [sub]);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims]);
};
const both = async () => (await q(`select auth.uid() as a, ff_private.current_actor_id() as h`)).rows[0];

test('identity: individual claim present -> both return it', async () => {
  await setClaims(A, JSON.stringify({ sub: A }));
  assert.deepEqual(await both(), { a: A, h: A });
});

test('identity: individual claim empty -> both return null (no aggregate rescue)', async () => {
  // THE case the removed fallback got wrong: auth.uid() says unauthenticated.
  await setClaims('', JSON.stringify({ sub: A }));
  const r = await both();
  assert.equal(r.a, null);
  assert.equal(r.h, null, 'helper must not synthesise an identity from request.jwt.claims');
});

test('identity: individual claim absent -> both return null', async () => {
  // Simulate "never set" via a fresh session-level reset to empty, which is the
  // state auth.uid() treats identically (current_setting(..., true) -> NULL/'').
  await db.query(`reset request.jwt.claim.sub`);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: A })]);
  const r = await both();
  assert.equal(r.a, null);
  assert.equal(r.h, null, 'helper must not derive an identity when the sub GUC is unset');
});

test('identity: aggregate claim present only -> both return null', async () => {
  await setClaims('', JSON.stringify({ sub: A, role: 'authenticated' }));
  const r = await both();
  assert.equal(r.a, null);
  assert.equal(r.h, null);
});

test('identity: conflicting individual and aggregate claims -> both prefer the individual', async () => {
  await setClaims(A, JSON.stringify({ sub: B }));
  const r = await both();
  assert.deepEqual(r, { a: A, h: A }, 'the per-claim GUC is authoritative; the aggregate must not override it');
});

test('identity: malformed UUID -> both raise rather than returning an identity', async () => {
  await setClaims('not-a-uuid', '');
  await assert.rejects(q(`select auth.uid()`), (e) => e.code === '22P02');
  await assert.rejects(q(`select ff_private.current_actor_id()`), (e) => e.code === '22P02');
});

test('identity: malformed JSON in aggregate claims is irrelevant to both', async () => {
  // The helper must never parse request.jwt.claims. auth.uid() ignores it too,
  // so neither may fail or succeed because of its contents.
  await setClaims(A, '{not json');
  assert.deepEqual(await both(), { a: A, h: A });
  await setClaims('', '{not json');
  assert.deepEqual(await both(), { a: null, h: null });
});

test('identity: unauthenticated request -> null, never a bogus identity', async () => {
  await setClaims('', '');
  assert.deepEqual(await both(), { a: null, h: null });
  // An empty JSON object is equally unauthenticated.
  await setClaims('', '{}');
  assert.deepEqual(await both(), { a: null, h: null });
});

test('the helper body reads exactly one source and has no aggregate-claims fallback', async () => {
  // Structural guarantee, so a future edit cannot quietly reintroduce a second
  // identity source that the behavioural tests above might not enumerate.
  const src = await scalar(`select prosrc from pg_proc
    where oid = 'ff_private.current_actor_id()'::regprocedure`);
  assert.match(src, /request\.jwt\.claim\.sub/);
  assert.doesNotMatch(src, /request\.jwt\.claims/, 'must not read the aggregate claims GUC');
  assert.doesNotMatch(src, /->>|jsonb?/i, 'must not parse JSON');
  assert.doesNotMatch(src, /coalesce/i, 'no second branch may supply an identity');
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
