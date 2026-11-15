-- PHASE 2B.2 DESIGN DRAFT. NOT A DEPLOYABLE MIGRATION. Do not place under
-- supabase/migrations or apply to a Supabase project.
--
-- Explicit privilege model and least-privilege migration owner.
--
-- Why this file exists:
--   * Supabase no longer grants new public tables to the Data API by default
--     (2026-05-30 for new projects, 2026-10-30 enforced on existing projects).
--     Grants are now an explicit, reviewed decision.
--   * 001-008 rely on the historical default privileges in two places: the
--     deny-by-default posture for anon/authenticated, and any table that no
--     migration names. Neither is safe to assume on a fresh project.
--   * SECURITY DEFINER functions must be owned by a non-login role that is not
--     reachable by clients, so the definer's privileges cannot be borrowed.
--
-- This migration is deliberately written to be safe under BOTH behaviours:
-- it revokes first, then grants exactly what the reviewed policies need. It
-- does not grant anything in order to "make the error go away".

-- 1. Stop future objects in public from being granted to API roles implicitly.
--    These mirror the statements Supabase documents for projects that still
--    carry the historical defaults. They are idempotent: revoking what was never
--    granted is a no-op. The grantee list is filtered to roles that exist so the
--    file also loads in a mock environment that only defines anon/authenticated.
do $$
declare grantees text;
begin
  select string_agg(quote_ident(r.rolname), ', ') into grantees
  from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role');
  -- Two independent preconditions, both measured in Phase 2B.5:
  --   * `postgres` must EXIST. Naming a missing role in ALTER DEFAULT PRIVILEGES
  --     raises "role \"postgres\" does not exist", and pg_has_role() on a missing
  --     role raises 42704. A self-hosted or CI cluster may have neither.
  --   * the deploying role must be a MEMBER of postgres, otherwise
  --     "permission denied to change default privileges".
  -- Skipping is correct: these defaults are defence in depth, and the
  -- authoritative control is the explicit function-level REVOKE in section 5.
  if grantees is not null
     and exists (select 1 from pg_roles where rolname = 'postgres')
     and pg_has_role(current_user, 'postgres', 'member') then
    execute format('alter default privileges for role postgres in schema public
      revoke select, insert, update, delete on tables from %s', grantees);
    execute format('alter default privileges for role postgres in schema public
      revoke usage, select on sequences from %s', grantees);
  end if;
end $$;
-- Functions created by postgres must not be executable by PUBLIC. A per-schema
-- default cannot revoke a global (database-wide) default, so the explicit
-- function-level revoke below is the control that actually holds.
--
-- Guarded deliberately. ALTER DEFAULT PRIVILEGES ... FOR ROLE postgres requires
-- membership in postgres, which the deploying role has on Supabase but which is
-- NOT guaranteed (a self-hosted or CI role may lack it). Phase 2B.4 measured
-- that an unguarded statement here aborts the whole migration with
-- 'permission denied to change default privileges'. The default is a
-- defence-in-depth extra; the authoritative control is the explicit
-- function-level revoke in section 5 below, which does not need membership.
do $$
begin
  -- pg_has_role() RAISES 42704 rather than returning false when the named role
  -- does not exist (measured), so the existence check has to come first: a
  -- self-hosted or CI cluster with no `postgres` role must skip this, not abort.
  if exists (select 1 from pg_roles where rolname = 'postgres')
     and pg_has_role(current_user, 'postgres', 'member') then
    alter default privileges for role postgres in schema public
      revoke execute on functions from public;
  end if;
end $$;

-- 2. Least-privilege owner for the SECURITY DEFINER helpers. NOLOGIN so it can
--    never authenticate, and not a member of any client role.
--
--    BYPASSRLS is REQUIRED, and this is measured, not assumed (Phase 2B.3).
--    Every policy in this design is `to authenticated`, so under a definer that
--    is not `authenticated` no policy applies. The ten read helpers are all of
--    the shape `exists(select 1 from public.x where user_id = auth.uid())`, so
--    an RLS-filtered inner select returns zero rows and the helper returns
--    FALSE. That is a silent, total authorization failure for every legitimate
--    user, not an error anyone would notice. The other two options were tested
--    and rejected:
--      * keep the functions owned by the table owner  -> works, but the definer
--        is a superuser-ish role and the ownership is implicit;
--      * make ff_migration_owner own the public tables -> works, but hands the
--        definer durable DDL authority over application data, which is worse.
--    BYPASSRLS here is NOT a client-facing bypass: the role is NOLOGIN, holds
--    no membership in any client role, and is only reachable as a definer. RLS
--    still filters every direct client read, which 010 asserts independently.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'ff_migration_owner') then
    create role ff_migration_owner nologin noinherit nosuperuser nocreatedb nocreaterole bypassrls;
  end if;
end $$;
grant usage, create on schema public to ff_migration_owner;
grant usage on schema ff_private to ff_migration_owner;
-- USAGE on schema auth is separate from EXECUTE on auth.uid(). Without it every
-- helper that validates auth.uid() fails with 'permission denied for schema auth'.
grant usage on schema auth to ff_migration_owner;
grant usage on schema storage to ff_migration_owner;
grant execute on function auth.uid() to ff_migration_owner;
-- The definer reads and writes public tables on behalf of the caller, and those
-- privileges are re-checked against the definer, so grant them explicitly. These
-- are table privileges, not ownership: ff_migration_owner cannot alter, drop or
-- truncate them, and 010 asserts it owns none of them.
grant select, insert, update, delete on all tables in schema public to ff_migration_owner;
grant usage, select on all sequences in schema public to ff_migration_owner;

-- 3. Re-assert the intended client privilege model table by table, so it does
--    not depend on whether the project predates the default-grant change.
--    anon gets nothing. authenticated gets SELECT only. service_role is not
--    granted here: it bypasses RLS and must stay server-side and explicit.
do $$
declare tbl text;
begin
  foreach tbl in array array[
    'profiles','leagues','league_members','match_organizers','player_profiles','real_football_teams',
    'real_team_players','league_players','player_suggestions','player_approval_logs','seasons','gameweeks',
    'fantasy_teams','fantasy_squad_players','fantasy_lineups','fantasy_lineup_players','transfers',
    'real_matches','match_revisions','real_match_lineups','real_match_lineup_players',
    'temporary_participant_authorizations','match_events','match_submissions','match_approvals',
    'scoring_rule_sets','scoring_rule_values','official_match_results','match_player_performances',
    'scoring_runs','fantasy_score_items','fantasy_scores','head_to_head_fixtures','league_standings',
    'notifications','audit_logs','scoring_run_sources','match_corrections','match_correction_attempts',
    'match_result_forks'] loop
    execute format('revoke all on public.%I from public, anon, authenticated', tbl);
    execute format('revoke truncate, references, trigger on public.%I from public, anon, authenticated', tbl);
  end loop;
  -- Re-grant the single reviewed client privilege.
  foreach tbl in array array[
    'profiles','leagues','league_members','match_organizers','player_profiles','real_football_teams',
    'real_team_players','league_players','player_suggestions','player_approval_logs','seasons','gameweeks',
    'fantasy_teams','fantasy_squad_players','fantasy_lineups','fantasy_lineup_players','transfers',
    'real_matches','match_revisions','real_match_lineups','real_match_lineup_players',
    'temporary_participant_authorizations','match_events','match_submissions','match_approvals',
    'scoring_rule_sets','scoring_rule_values','official_match_results','match_player_performances',
    'scoring_runs','fantasy_score_items','fantasy_scores','head_to_head_fixtures','league_standings',
    'notifications','audit_logs','scoring_run_sources','match_corrections','match_correction_attempts',
    'match_result_forks'] loop
    execute format('grant select on public.%I to authenticated', tbl);
  end loop;
end $$;

-- 4. Function EXECUTE is closed for PUBLIC/anon and open only for the reviewed
--    read helpers. Postgres grants EXECUTE on new functions to PUBLIC by
--    default, and Supabase's own bootstrap grants ALL on new public functions to
--    anon/authenticated/service_role, so this must be asserted explicitly.
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema ff_private from public, anon, authenticated;
grant execute on function ff_private.is_member(uuid),ff_private.is_leader(uuid),ff_private.is_organizer(uuid),ff_private.owns_team(uuid,uuid),
 ff_private.can_read_lineup(uuid,uuid),ff_private.can_read_revision(uuid,uuid),ff_private.can_read_match(uuid,uuid),
 ff_private.can_read_suggestion(uuid,uuid),ff_private.can_read_image(text),ff_private.is_match_organizer(uuid,uuid) to authenticated;

-- 5. No client may act as the definer role: it must not be granted to PUBLIC or
--    to any API role, and it must not be a member of one either.
revoke ff_migration_owner from anon, authenticated;
do $$ begin
  if exists (select 1 from pg_auth_members m
             join pg_roles g on g.oid = m.roleid join pg_roles u on u.oid = m.member
             where g.rolname = 'ff_migration_owner'
               and u.rolname in ('anon','authenticated','service_role','authenticator')) then
    raise exception 'ff_migration_owner must not be granted to an API role' using errcode = '42501';
  end if;
end $$;

-- 6. Storage is handled in 003 and, where the deployment role does not own
--    storage.objects, by the owner-authorized procedure recorded in
--    docs/phase-2b2-storage-ownership.md. No ownership is granted here, and no
--    broad privilege is taken on the storage schema.
