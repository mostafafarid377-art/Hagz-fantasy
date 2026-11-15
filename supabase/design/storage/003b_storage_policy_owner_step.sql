-- PHASE 2B.5 STORAGE PACKAGE. NOT A CLI MIGRATION.
--
-- This file must NEVER be placed under supabase/migrations/. It is the
-- owner-authorised step of the 3a/3b split (see the storage runbook), and it is
-- the ONLY statement in the package that requires the Storage owner.
--
-- 003_storage.sql is frozen and says:
--     create policy player_images_member_read on storage.objects ...
-- On Supabase, storage.objects is owned by supabase_storage_admin, not by the
-- role that runs migrations, so CREATE POLICY fails with
--     42501: must be owner of table objects
-- Reproduced on PostgreSQL 17.6 in Phase 2B.5 (CASE 6 of the recovery suite):
-- a non-owner is denied, and the bucket is left present with ZERO policies,
-- which is fail-closed: no policy = no access. It is never "open by accident".
--
-- HOW TO RUN
--   Execute this file as the role that owns storage.objects (normally
--   supabase_storage_admin), e.g. in the SQL editor under an owner-capable role.
--   Confirm the owner first:
--       select pg_get_userbyid(relowner) from pg_class
--        where oid = 'storage.objects'::regclass;
--
--   It is idempotent: DROP POLICY IF EXISTS then CREATE, so a re-run converges
--   instead of failing on a duplicate name.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
--   * does NOT alter the owner of storage.objects (forbidden);
--   * does NOT grant any privilege on any storage object (forbidden);
--   * does NOT grant supabase_storage_admin membership (forbidden);
--   * does NOT run ALTER TABLE ... ENABLE ROW LEVEL SECURITY (Supabase already
--     enables RLS on storage.objects; the statement is owner-only DDL that adds
--     nothing, and 010 asserts relrowsecurity instead of setting it);
--   * creates NO insert/update/delete policy. Upload remains closed by design.
--
-- VERIFICATION is in Phase C of the runbook and is also asserted by migration
-- 010, which fails the deployment if this step was skipped.

begin;

-- Fail loudly rather than silently doing nothing if the object is missing.
do $$
begin
  if to_regclass('storage.objects') is null then
    raise exception 'storage.objects does not exist; this is not a Supabase Storage database'
      using errcode = '42P01';
  end if;
end $$;

-- Idempotent: converge on the intended state without a duplicate-name error.
drop policy if exists player_images_member_read on storage.objects;

create policy player_images_member_read on storage.objects
  for select
  to authenticated
  using (bucket_id = 'player-images' and ff_private.can_read_image(name));

-- Post-condition: exactly one SELECT policy on the bucket, and no write policy.
do $$
declare n_select int; n_write int;
begin
  select count(*) filter (where polcmd = 'r'),
         count(*) filter (where polcmd <> 'r')
    into n_select, n_write
  from pg_policy
  where polrelid = 'storage.objects'::regclass
    and polname = 'player_images_member_read';

  if n_select <> 1 then
    raise exception 'expected exactly one SELECT policy for player-images, found %', n_select
      using errcode = '42501';
  end if;
  if n_write <> 0 then
    raise exception 'write policy present on storage.objects; upload must stay closed'
      using errcode = '42501';
  end if;
  if not exists (select 1 from pg_class where oid = 'storage.objects'::regclass and relrowsecurity) then
    raise exception 'ROW LEVEL SECURITY is not enabled on storage.objects; refuse to continue'
      using errcode = '42501';
  end if;
end $$;

commit;
