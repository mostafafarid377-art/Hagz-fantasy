-- Fantasy Friends — 027: anon EXECUTE hardening (prepared, re-runnable)
--
-- STATUS: PREPARED AND REHEARSED ON THE CLONE. NOT APPLIED TO PRODUCTION.
--   Rehearsal transcript: docs/security/ff-league-archive-anon-execute.md §5.
--   This file lives under docs/ until the rollback window closes: supabase/migrations/
--   is a pinned, hashed package (scripts/check-migration-package.mjs), and promoting a
--   new file into it is a reviewed step with its own hash, not something to slip in.
--
-- WHAT
--   1. public.ff_league_archive(uuid) is SECURITY DEFINER and executable by `anon`.
--      It is fail-closed today (its first statement authorises, verified on the clone:
--      anon → 42501, archived_at unchanged), but the grant is unnecessary: nothing in
--      the app calls this RPC signed out.
--   2. The defect is a CLASS, not one row: Supabase's default privileges hand `anon`
--      EXECUTE on every new function in `public`, and migration 016 revoked only from
--      `PUBLIC`, which is not the same grantee. Step 2 turns that class into a failed
--      migration instead of a silent grant.
--
-- WHY THERE IS NO `alter default privileges` HERE — measured, not assumed
--   Revoking EXECUTE from `anon` in the default privileges does take effect (a grant
--   added the same way shows up on the next function created), but it does not stop
--   this leak: a function created after
--     alter default privileges for role postgres in schema public
--       revoke execute on functions from public;
--   still came out as {=X/postgres, postgres=X/postgres, authenticated=X/postgres,
--   service_role=X/postgres} — PostgreSQL re-adds the built-in PUBLIC EXECUTE on
--   functions — and `anon` inherits PUBLIC. Default-privilege surgery therefore looks
--   like a fix and is not one. The assertion is the fix that works.
--
-- SAFE
--   No table, column, policy, ownership or `authenticated`/`service_role` grant is
--   touched. Step 1 is idempotent; the whole file can be re-run as a post-deploy check.

-- 1. close the known grant
revoke execute on function public.ff_league_archive(uuid) from anon;

-- 2. the invariant: nothing callable by an anonymous request, anywhere.
--    `has_function_privilege` accounts for both a direct grant and inheritance through
--    PUBLIC, which is the part the original revoke missed.
do $$
declare
  v_bad text;
begin
  select string_agg(
           n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
           ', ' order by n.nspname, p.proname)
    into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'ff_private')
     and has_function_privilege('anon', p.oid, 'execute');

  if v_bad is not null then
    raise exception '027: anon can execute % — revoke it explicitly in the migration that created it',
      v_bad using errcode = '42501';
  end if;

  -- The guard against over-revoking while chasing `anon`: the API surface the app
  -- actually uses must still be there.
  if not has_function_privilege('authenticated', 'public.ff_league_archive(uuid)', 'execute') then
    raise exception '027: authenticated lost EXECUTE on ff_league_archive' using errcode = '42501';
  end if;
end $$;
