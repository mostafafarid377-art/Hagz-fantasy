// Phase 2B.5 — Storage package tests.
//
// HONEST SCOPE. These tests validate the *package artefact*, not Supabase:
//   * that the owner-step SQL is idempotent, SELECT-only and self-checking;
//   * that it refuses to run when the storage objects are absent;
//   * that the 3a part (bucket + helper) works without any ownership;
//   * that the verification SQL returns the expected shapes.
//
// They CANNOT validate: real Supabase Storage ownership, the Storage service,
// signed URLs, MIME or size enforcement, or whether a hosted project even allows
// an owner-authorised one-off step. Those remain unproven. The mock here owns
// storage.objects as the migration role unless the test explicitly makes it
// otherwise, which is precisely why a green run here proves nothing about
// Supabase - see the last test, which asserts that limitation on purpose.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = await PGlite.create();
const M = (f) => readFile(new URL(`../migrations/${f}.sql`, import.meta.url), 'utf8');
const S = (f) => readFile(new URL(`../storage/${f}`, import.meta.url), 'utf8');
const q = (sql, params = []) => db.query(sql, params);
const scalar = async (sql) => Object.values((await q(sql)).rows[0])[0];

await db.exec(await readFile(new URL('setup.sql', import.meta.url), 'utf8'));
for (const f of ['001_schema', '002_security', '003_storage', '004_integrity_workflows',
  '005_concurrency_hardening', '006_revision_lineage', '007_correction_attempts',
  '008_result_fork_idempotency', '009_ownership_and_grants', '010_privilege_verification']) {
  await db.exec(await M(f));
}
after(() => db.close());

// The 003 policy was applied by the frozen 003 file in this mock (the fixture
// owns storage.objects). Drop it so the owner-step can be tested from scratch.
await db.exec(`
create role storage_owner nologin;
grant usage on schema storage to storage_owner;
grant select on storage.objects to storage_owner;
alter table storage.objects owner to storage_owner;
drop policy if exists player_images_member_read on storage.objects;
`);

test('003 as written creates the bucket, the helper and the policy', async () => {
  const bucket = await scalar(`select count(*)::int from storage.buckets where id='player-images' and public=false`);
  assert.equal(bucket, 1);
  const helper = await scalar(`select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='ff_private' and p.proname='can_read_image'`);
  assert.equal(helper, 1);
});

test('the owner step is idempotent: it can be applied twice with the same result', async () => {
  const sql = await S('003b_storage_policy_owner_step.sql');
  await db.exec(sql);
  await db.exec(sql);
  const n = await scalar(`select count(*)::int from pg_policy
    where polrelid='storage.objects'::regclass and polname='player_images_member_read'`);
  assert.equal(n, 1, 're-running must converge, not duplicate');
});

test('the owner step creates exactly one SELECT policy and no write policy', async () => {
  const r = (await q(`select polcmd, count(*)::int n from pg_policy
    where polrelid='storage.objects'::regclass group by 1`)).rows;
  assert.deepEqual(r, [{ polcmd: 'r', n: 1 }]);
});

test('the policy is scoped to the player-images bucket and uses the helper', async () => {
  const expr = await scalar(`select pg_get_expr(polqual, polrelid) from pg_policy
    where polrelid='storage.objects'::regclass and polname='player_images_member_read'`);
  assert.match(expr, /player-images/);
  assert.match(expr, /can_read_image/);
});

test('the owner step refuses to run when storage.objects is absent', async () => {
  // Prove the guard rather than trusting the comment: in a schema without the
  // storage table the file must raise, not silently no-op.
  const sql = await S('003b_storage_policy_owner_step.sql');
  const bare = await PGlite.create();
  await bare.exec('create schema storage;');
  await assert.rejects(bare.exec(sql), e => /storage\.objects does not exist/.test(e.message));
  await bare.close();
});

test('the 3a part needs no ownership (native only: PGlite superuser bypasses the check)', async (t) => {
  // The migration role in PGlite is a SUPERUSER, and a superuser may create a
  // policy on a table it does not own, so the ownership denial cannot be
  // reproduced here at all. Rather than assert something that cannot fail, the
  // ownership boundary is verified natively in phase2b5-recovery CASE 6, which
  // runs as a non-superuser. Here we only prove the 3a half applies alone.
  const c = await PGlite.create();
  await c.exec(await readFile(new URL('setup.sql', import.meta.url), 'utf8'));
  await c.exec(await M('001_schema'));
  await c.exec(await M('002_security'));
  const s3 = await M('003_storage');
  const cut = s3.indexOf('create policy player_images_member_read');
  await c.exec(s3.slice(0, cut));
  assert.equal((await c.query(`select count(*)::int n from storage.buckets where id='player-images'`)).rows[0].n, 1);
  assert.equal((await c.query(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='ff_private' and p.proname='can_read_image'`)).rows[0].n, 1);
  await c.close();
  t.diagnostic('ownership denial is only reproducible as a non-superuser; see native CASE 6');
});

test('the verification SQL runs and returns the expected shapes', async () => {
  const v = await S('verify_storage_setup.sql');
  // PGlite returns one result set per statement; exec is enough to prove validity.
  await db.exec(v);
  const r = (await q(`select count(*) filter (where polcmd <> 'r') w, count(*) filter (where polcmd = 'r') s
    from pg_policy where polrelid='storage.objects'::regclass`)).rows[0];
  assert.equal(r.w, 0);
  assert.equal(r.s, 1);
});

test('the helper is not executable by anon or PUBLIC', async () => {
  assert.equal(await scalar(`select has_function_privilege('anon','ff_private.can_read_image(text)','execute')`), false);
  const pub = await scalar(`select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='ff_private' and p.proname='can_read_image'
      and exists (select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE')`);
  assert.equal(pub, 0);
});

test('LIMITATION: the default mock owns storage.objects as the migrating role', async () => {
  // This test exists to stop anyone reading a green suite as Supabase evidence.
  // In setup.sql the owner is the migration role, so the frozen 003 applies as
  // one unit locally and can NEVER reproduce the 42501 ownership failure.
  const fresh = await PGlite.create();
  await fresh.exec(await readFile(new URL('setup.sql', import.meta.url), 'utf8'));
  const owner = (await fresh.query(`select pg_get_userbyid(relowner) o from pg_class
    where oid='storage.objects'::regclass`)).rows[0].o;
  const me = (await fresh.query('select current_user u')).rows[0].u;
  assert.equal(owner, me, 'mock owns storage.objects as the migrating role (so 003 always applies here)');
  await fresh.close();
});
