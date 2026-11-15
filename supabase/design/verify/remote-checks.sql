-- Fantasy Friends — read-only post-deployment verification.
--
-- Run this in the Supabase SQL Editor after `supabase db push`. It is entirely
-- read-only: no INSERT, UPDATE, DELETE, DDL or GRANT. Safe to run repeatedly.
--
-- It re-checks the same post-conditions as migrations 012 and 013, but reports
-- every result as a row instead of aborting on the first failure - so one run
-- tells you the complete state of the deployment.
--
-- Every row should read PASS. A FAIL row names the drifted object.

with checks as (

  -- 1. The schema is present.
  select '01 tables exist' as check_name,
         case when count(*) = 40 then 'PASS' else 'FAIL' end as result,
         count(*)::text || ' public table(s), expected 40' as detail
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'

  union all
  -- 2. RLS on every application table.
  select '02 RLS enabled on every public table',
         case when count(*) = 0 then 'PASS' else 'FAIL' end,
         coalesce(string_agg(c.relname, ', '), 'all tables have RLS')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity

  union all
  -- 3. anon holds nothing at all.
  select '03 anon has no public table privilege',
         case when count(*) = 0 then 'PASS' else 'FAIL' end,
         coalesce(string_agg(format('%I:%s', c.relname, a.privilege_type), ', '), 'anon has zero privileges')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, '{}'::aclitem[])) a
  where n.nspname = 'public' and c.relkind in ('r','p')
    and a.grantee = (select oid from pg_roles where rolname = 'anon')

  union all
  -- 4. authenticated holds SELECT only (no direct writes).
  select '04 authenticated holds SELECT only',
         case when count(*) = 0 then 'PASS' else 'FAIL' end,
         coalesce(string_agg(format('%I:%s', c.relname, a.privilege_type), ', '), 'no write grants found')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, '{}'::aclitem[])) a
  where n.nspname = 'public' and c.relkind in ('r','p')
    and a.grantee = (select oid from pg_roles where rolname = 'authenticated')
    and a.privilege_type <> 'SELECT'

  union all
  -- 5. The definer role is correct.
  select '05 ff_migration_owner is NOLOGIN + BYPASSRLS',
         case when count(*) = 1 then 'PASS' else 'FAIL' end,
         coalesce(string_agg(format('login=%s bypassrls=%s', rolcanlogin, rolbypassrls), ', '), 'role missing')
  from pg_roles where rolname = 'ff_migration_owner' and rolcanlogin = false and rolbypassrls = true

  union all
  -- 6. The definer owns no application table.
  select '06 ff_migration_owner owns no public table',
         case when count(*) = 0 then 'PASS' else 'FAIL' end,
         coalesce(string_agg(c.relname, ', '), 'owns nothing')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','p','v','m')
    and pg_get_userbyid(c.relowner) = 'ff_migration_owner'

  union all
  -- 7. Every SECURITY DEFINER is owned by the definer role.
  select '07 all definers owned by ff_migration_owner',
         case when count(*) = 0 then 'PASS' else 'FAIL' end,
         coalesce(string_agg(format('%s.%I', n.nspname, p.proname), ', '), 'no outliers')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public','ff_private') and p.prosecdef
    and pg_get_userbyid(p.proowner) <> 'ff_migration_owner'

  union all
  -- 8. Every definer pins search_path.
  select '08 all definers pin search_path',
         case when count(*) = 0 then 'PASS' else 'FAIL' end,
         coalesce(string_agg(format('%s.%I', n.nspname, p.proname), ', '), 'all pinned')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public','ff_private') and p.prosecdef
    and not exists (select 1 from unnest(coalesce(p.proconfig,'{}'::text[])) cfg where cfg like 'search_path=%')

  union all
  -- 9. No definer reachable by anon or PUBLIC.
  select '09 no definer reachable by anon/PUBLIC',
         case when count(*) = 0 then 'PASS' else 'FAIL' end,
         coalesce(string_agg(format('%s.%I', n.nspname, p.proname), ', '), 'none reachable')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public','ff_private') and p.prosecdef
    and has_function_privilege('anon', p.oid, 'execute')

  union all
  -- 10. The application API exists and is callable.
  select '10 all 40 application RPCs granted to authenticated',
         case when count(*) = 40 and count(*) filter (where has_function_privilege('authenticated', p.oid, 'execute')) = 40
              then 'PASS' else 'FAIL' end,
         count(*)::text || ' ff_* function(s), ' ||
         count(*) filter (where has_function_privilege('authenticated', p.oid, 'execute'))::text || ' granted'
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'ff\_%'

  union all
  -- 11. Every ff_private helper is callable by the definer role.
  select '11 definer can execute every ff_private helper',
         case when count(*) = 0 then 'PASS' else 'FAIL' end,
         coalesce(string_agg(p.proname, ', '), 'all reachable')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'ff_private'
    and not has_function_privilege('ff_migration_owner', p.oid, 'execute')

  union all
  -- 12. Storage bucket exists, is private, and has the size/mime limits.
  select '12 player-images bucket is private with limits',
         case when count(*) = 1 then 'PASS' else 'FAIL' end,
         coalesce(string_agg(format('public=%s limit=%s mimes=%s', public, file_size_limit, allowed_mime_types), ', '),
                  'bucket missing')
  from storage.buckets
  where id = 'player-images' and public = false
    and file_size_limit = 5242880
    and allowed_mime_types @> array['image/jpeg','image/png','image/webp']::text[]

  union all
  -- 13. The storage read policy exists and is SELECT-only.
  select '13 storage read policy present and SELECT-only',
         case when count(*) = 1 then 'PASS' else 'FAIL' end,
         coalesce(string_agg(format('%s (cmd=%s)', policyname, cmd), ', '),
                  'policy missing - run supabase/design/storage/003b_storage_policy_owner_step.sql')
  from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and policyname = 'player_images_member_read' and cmd = 'SELECT'

  union all
  -- 14. No write policy on the bucket (upload stays closed by design).
  select '14 no write policy on player-images',
         case when count(*) = 0 then 'PASS' else 'FAIL' end,
         coalesce(string_agg(policyname, ', '), 'no write policy')
  from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and policyname like '%player%' and cmd <> 'SELECT'

  union all
  -- 15. RLS is enabled on storage.objects.
  select '15 RLS enabled on storage.objects',
         case when count(*) = 1 then 'PASS' else 'FAIL' end,
         coalesce(string_agg(relname || ' rls=' || relrowsecurity, ', '), 'storage.objects missing')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'storage' and c.relname = 'objects' and c.relrowsecurity

  union all
  -- 16. The scoring engine stays closed (no positional values approved yet).
  select '16 scoring write-blockers installed',
         case when count(*) = 3 then 'PASS' else 'FAIL' end,
         count(*)::text || ' blocker trigger(s) on performance/score tables'
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
  where c.relname in ('match_player_performances','fantasy_score_items','fantasy_scores')
    and t.tgname like 'block_%' and not t.tgisinternal

  union all
  -- 17. No client role inherits the definer.
  select '17 no API role inherits ff_migration_owner',
         case when count(*) = 0 then 'PASS' else 'FAIL' end,
         coalesce(string_agg(u.rolname, ', '), 'no inheritance')
  from pg_auth_members m
  join pg_roles g on g.oid = m.roleid join pg_roles u on u.oid = m.member
  where g.rolname = 'ff_migration_owner'
    and u.rolname in ('anon','authenticated','service_role','authenticator')

  union all
  -- 18. Functions with a required EXECUTE are not accidentally PUBLIC.
  select '18 no public ff_* executable by PUBLIC',
         case when count(*) = 0 then 'PASS' else 'FAIL' end,
         coalesce(string_agg(p.proname, ', '), 'none')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'ff\_%'
    and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE')
)
select check_name, result, detail from checks
order by check_name;
