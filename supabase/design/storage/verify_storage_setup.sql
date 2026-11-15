-- Phase 2B.5 — Storage verification (Phase C of the runbook).
--
-- Read-only. Safe to run as any role with catalog visibility, at any time,
-- including immediately after a `db reset`. Every query returns a boolean or a
-- small row set, so the output can be eyeballed or diffed between environments.
--
-- Run this AFTER the owner-authorised policy step (003b) and AFTER migration
-- 010. Migration 010 asserts the critical subset of this automatically; this
-- file is the manual, fully-explained counterpart.

-- C1. The bucket exists, is PRIVATE, and carries the intended limits.
--     Expect: public = false, file_size_limit = 5242880, 3 MIME types.
select
  id,
  public                as is_public,
  file_size_limit,
  allowed_mime_types
from storage.buckets
where id = 'player-images';

-- C2. RLS is enabled on storage.objects.
--     Expect: t. Do NOT "fix" this by running ALTER TABLE as the migration role.
select relrowsecurity as rls_enabled
from pg_class
where oid = 'storage.objects'::regclass;

-- C3. Exactly one policy, SELECT-only, on the right bucket, using the helper.
--     Expect: one row; polcmd = 'r'; the USING expression mentions
--     bucket_id = 'player-images' and ff_private.can_read_image(name).
select
  polname,
  polcmd,
  polpermissive,
  pg_get_expr(polqual, polrelid)     as using_expression,
  pg_get_expr(polwithcheck, polrelid) as check_expression
from pg_policy
where polrelid = 'storage.objects'::regclass;

-- C4. No write policy exists anywhere on storage.objects.
--     Expect: write_policies = 0. Upload is closed by design.
select count(*) filter (where polcmd <> 'r') as write_policies
from pg_policy
where polrelid = 'storage.objects'::regclass;

-- C5. The helper's EXECUTE surface: anon must NOT be able to call it.
--     Expect: anon_can = f, authenticated_can = t, public_can = f.
select
  has_function_privilege('anon', 'ff_private.can_read_image(text)', 'execute')          as anon_can,
  has_function_privilege('authenticated', 'ff_private.can_read_image(text)', 'execute') as authenticated_can
;

-- C6. PUBLIC holds no EXECUTE on the helper.
--     Expect: 0 rows.
select p.proname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'ff_private'
  and p.proname = 'can_read_image'
  and exists (
    select 1 from aclexplode(p.proacl) a
    where a.grantee = 0 and a.privilege_type = 'EXECUTE'
  );

-- C7. Who owns storage.objects (informational; proves no ownership was taken).
--     Expect: supabase_storage_admin on Supabase. It must NOT be the migration role.
select pg_get_userbyid(relowner) as storage_objects_owner
from pg_class
where oid = 'storage.objects'::regclass;
