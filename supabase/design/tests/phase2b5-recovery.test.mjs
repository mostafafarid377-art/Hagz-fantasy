// Phase 2B.5 — failure and recovery rehearsal.
//
// These tests exist to ground the recovery runbook in observed behaviour rather
// than assertion. Each one puts a real database into a specific broken state on
// a real server and records what recovery actually works.
//
// Native-only: it needs an independent cluster per case (roles are cluster-wide),
// which the PGlite harness cannot provide. Skipped when the env is absent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const socket = process.env.FF_PG_AUDIT_SOCKET;
const modulePath = process.env.FF_PG_AUDIT_DRIVER;
const enabled = Boolean(socket && modulePath);
const require = createRequire(import.meta.url);

let Client;
if (enabled) ({ Client } = require(modulePath));

const M = (f) => readFile(new URL(`../migrations/${f}.sql`, import.meta.url), 'utf8');
const FILES = ['001_schema', '002_security', '003_storage', '004_integrity_workflows',
  '005_concurrency_hardening', '006_revision_lineage', '007_correction_attempts',
  '008_result_fork_idempotency', '009_ownership_and_grants', '010_privilege_verification',
  '011_definer_ownership_transfer'];

// All cases share ONE database and reset the application schemas between them.
// That is equivalent for schema-state rehearsal and avoids the connection
// lifetime problems of creating and dropping a database per case.
const DB = 'rec_rehearsal';
async function freshDb() {
  const admin = new Client({ host: socket, port: 55432, user: 'audit', database: 'postgres' });
  await admin.connect();
  await admin.query(`drop database if exists ${DB} with (force)`).catch(() => {});
  await admin.query(`create database ${DB}`).catch(async (e) => {
    if (!/already exists/.test(e.message)) throw e;
  });
  await admin.end();
  const c = new Client({ host: socket, port: 55432, user: 'audit', database: DB });
  await c.connect();
  await c.query(`
    drop schema if exists public cascade; create schema public;
    drop schema if exists ff_private cascade;
    drop schema if exists auth cascade;
    drop schema if exists storage cascade;
    create schema auth;
    create table auth.users(id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean,
      file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),
      bucket_id text, name text);
    alter table storage.objects enable row level security;
  `);
  return c;
}

before(async () => {
  if (!enabled) return;
  const c = new Client({ host: socket, port: 55432, user: 'audit', database: 'postgres' });
  await c.connect();
  // Include the rename shadow used by CASE 4: a leftover would make its rename
  // fail with "already exists" and silently skip the precondition.
  for (const r of ['anon', 'authenticated', 'service_role', 'ff_migration_owner', 'ff_owner_hidden']) {
    await c.query(`drop role if exists ${r}`).catch(() => {});
  }
  // Cluster roles may already exist if another suite ran first; create only the
  // ones that are missing so this suite is independent of run order.
  for (const [role, attrs] of [['anon', 'nologin noinherit'],
    ['authenticated', 'nologin noinherit'],
    ['service_role', 'nologin noinherit bypassrls']]) {
    await c.query(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = '${role}') then
          execute 'create role ${role} ${attrs}';
        end if;
      end $$;
    `);
  }
  await c.end();
});
after(async () => {
  if (!enabled) return;
  const c = new Client({ host: socket, port: 55432, user: 'audit', database: 'postgres' });
  await c.connect();
  for (const r of ['anon', 'authenticated', 'service_role', 'ff_migration_owner']) {
    await c.query(`drop role if exists ${r}`).catch(() => {});
  }
  await c.end();
});

const apply = async (c, name) => { await c.query('begin'); await c.query(await M(name)); await c.query('commit'); };

test('CASE 1: a migration failing inside one transaction leaves nothing behind', { skip: !enabled }, async () => {
  const c = await freshDb();
  for (const f of FILES.slice(0, 4)) await apply(c, f);   // 001..004
  const before = (await c.query(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='ff_private'`)).rows[0].n;

  // Apply 005 and force a failure at the end of the same transaction.
  await c.query('begin');
  await c.query(await M('005_concurrency_hardening'));
  await assert.rejects(c.query('select 1/0'), /division by zero/);
  await c.query('rollback');

  const after = (await c.query(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='ff_private'`)).rows[0].n;
  assert.equal(after, before, 'a transactional failure must not leave partial objects');

  // And the clean state means 005 applies normally on the retry.
  await apply(c, '005_concurrency_hardening');
  console.log('  CASE 1: transactional failure is atomic; plain retry succeeds');
  await c.end();
});

test('CASE 2: a partial (committed-batch) application blocks a blind retry', { skip: !enabled }, async () => {
  const c = await freshDb();
  for (const f of FILES.slice(0, 4)) await apply(c, f);

  // Commit only the first half of 005, plus the head of the rest: this is what a
  // client that commits per batch leaves behind.
  const s5 = await M('005_concurrency_hardening');
  const cut = s5.indexOf('create or replace function ff_private.require_leader');
  await c.query('begin'); await c.query(s5.slice(0, cut)); await c.query('commit');

  // A blind retry must fail - this is exactly why the runbook forbids it.
  await assert.rejects(
    (async () => { await c.query('begin'); await c.query(s5); await c.query('commit'); })(),
    e => /already exists/.test(e.message),
  );
  console.log('  CASE 2: partial commit makes a blind retry fail with "already exists"');
  await c.end();
});

test('CASE 3: 009 and 010 are genuinely re-runnable, unlike 001-008', { skip: !enabled }, async () => {
  const c = await freshDb();
  for (const f of FILES.slice(0, 9)) await apply(c, f);   // through 009
  // Re-running 009 is the sanctioned recovery for any grant failure.
  await apply(c, '009_ownership_and_grants');
  await apply(c, '009_ownership_and_grants');
  await apply(c, '010_privilege_verification');
  await apply(c, '010_privilege_verification');
  console.log('  CASE 3: 009 x3 and 010 x2 applied cleanly');

  // 011 is a deliberate exception: it is NOT idempotent-safe to re-run after a
  // transfer, but it IS re-runnable because ALTER ... OWNER is absolute.
  await apply(c, '011_definer_ownership_transfer');
  await apply(c, '011_definer_ownership_transfer');
  const n = (await c.query(`select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname in ('public','ff_private') and p.prosecdef
      and pg_get_userbyid(p.proowner)='ff_migration_owner'`)).rows[0].n;
  assert.equal(n, 56);
  console.log('  CASE 3: 011 is re-runnable (ALTER OWNER is absolute, not additive)');
  await c.end();
});

test('CASE 4: 011 refuses to run before 009, leaving the database untouched', { skip: !enabled }, async () => {
  const c = await freshDb();
  // Roles are cluster-wide and an earlier case already created the owner via
  // 009, so it cannot be DROPPed (functions depend on it). Rename it instead:
  // the guard's existence check then fails exactly as it would on a database
  // where 009 has not run, and the rename is reversible.
  const adm = new Client({ host: socket, port: 55432, user: 'audit', database: 'postgres' });
  await adm.connect();
  const renamed = await adm.query('alter role ff_migration_owner rename to ff_owner_hidden')
    .then(() => true).catch((e) => { console.log('   (rename skipped:', e.message.slice(0, 50), ')'); return false; });
  // The guard only proves anything if the role really is absent.
  const still = (await adm.query(`select count(*)::int n from pg_roles where rolname='ff_migration_owner'`)).rows[0].n;
  console.log(`   role renamed=${renamed} still_present=${still}`);
  assert.equal(still, 0, 'precondition: ff_migration_owner must be absent for this case');
  await adm.end();
  for (const f of FILES.slice(0, 8)) await apply(c, f);  // 001..008, no 009
  await assert.rejects(
    (async () => { await c.query('begin'); await c.query(await M('011_definer_ownership_transfer')); await c.query('commit'); })(),
    e => e.code === '42501' && /apply 009 before 011/.test(e.message),
  );
  // The failed transaction must be rolled back before the connection is usable
  // again; leaving it open makes every later query fail with 25P02.
  await c.query('rollback').catch(() => {});
  // No function was moved: the guard aborts before any ALTER runs.
  const moved = (await c.query(`select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname in ('public','ff_private') and p.prosecdef
      and pg_get_userbyid(p.proowner)='ff_migration_owner'`)).rows[0].n;
  assert.equal(moved, 0);
  console.log('  CASE 4: 011 refused before 009 and moved 0 functions');
  const adm2 = new Client({ host: socket, port: 55432, user: 'audit', database: 'postgres' });
  await adm2.connect();
  await adm2.query('alter role ff_owner_hidden rename to ff_migration_owner').catch(() => {});
  await adm2.end();
  await c.end();
});

test('CASE 5: an ownership failure is repaired by re-running 011, not by re-running 001-010', { skip: !enabled }, async () => {
  const c = await freshDb();
  for (const f of FILES) await apply(c, f);
  // Simulate a half-applied transfer: move exactly one function back.
  await c.query('alter function ff_private.is_member(uuid) owner to audit');
  const split = (await c.query(`select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname in ('public','ff_private') and p.prosecdef
      and pg_get_userbyid(p.proowner) <> 'ff_migration_owner'`)).rows[0].n;
  assert.equal(split, 1, 'setup: expect exactly one function off the target owner');

  // Re-running 011 fixes it, because its post-condition asserts completeness.
  await apply(c, '011_definer_ownership_transfer');
  const fixed = (await c.query(`select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname in ('public','ff_private') and p.prosecdef
      and pg_get_userbyid(p.proowner)='ff_migration_owner'`)).rows[0].n;
  assert.equal(fixed, 56);
  console.log('  CASE 5: re-running 011 repaired a split ownership state');
  await c.end();
});

test('CASE 6: a Storage policy failure leaves the bucket present and fail-closed', { skip: !enabled }, async () => {
  const c = await freshDb();
  // 003 applied WITHOUT the policy statement (the 3a part), as the runbook does.
  await apply(c, '001_schema');
  await apply(c, '002_security');
  const s3 = await M('003_storage');
  const cut = s3.indexOf('create policy player_images_member_read');
  await c.query('begin'); await c.query(s3.slice(0, cut)); await c.query('commit');

  // Bucket exists; no policy exists yet.
  const bucket = (await c.query(`select count(*)::int n from storage.buckets where id='player-images'`)).rows[0].n;
  assert.equal(bucket, 1);
  const pol = (await c.query(`select count(*)::int n from pg_policy where polrelid='storage.objects'::regclass`)).rows[0].n;
  assert.equal(pol, 0, 'no policy yet: the bucket is fail-closed, not open');

  // A non-owner cannot create the policy - the failure the runbook documents.
  const nonOwner = new Client({ host: socket, port: 55432, user: 'audit', database: DB });
  await nonOwner.connect();
  await nonOwner.query('create role storage_nonowner nologin');
  await nonOwner.query('grant usage on schema storage to storage_nonowner');
  await nonOwner.query('set role storage_nonowner');
  await assert.rejects(
    nonOwner.query(`create policy p on storage.objects for select to authenticated using(true)`),
    e => /must be owner of table objects/.test(e.message),
  );
  await nonOwner.query('reset role');
  await nonOwner.query('drop owned by storage_nonowner');
  await nonOwner.query('drop role storage_nonowner');
  await nonOwner.end();
  console.log('  CASE 6: bucket present, zero policies (fail-closed), non-owner denied');
  await c.end();
});

test('CASE 7: 009 skips default-privilege changes cleanly when postgres is absent', { skip: !enabled }, async () => {
  // The disposable cluster has no `postgres` role (superuser is `audit`), which
  // is exactly the self-hosted/CI case that used to abort the migration.
  const hasPostgres = (await (async () => {
    const c = new Client({ host: socket, port: 55432, user: 'audit', database: 'postgres' });
    await c.connect();
    const r = (await c.query(`select count(*)::int n from pg_roles where rolname='postgres'`)).rows[0].n;
    await c.end();
    return r > 0;
  })());
  const c = await freshDb();
  for (const f of FILES.slice(0, 9)) await apply(c, f);  // through 009
  console.log(`  CASE 7: 009 applied with postgres role ${hasPostgres ? 'present' : 'ABSENT'} (guard exercised)`);
  await c.end();
});
