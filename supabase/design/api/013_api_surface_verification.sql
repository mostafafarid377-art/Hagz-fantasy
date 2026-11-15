-- Fantasy Friends — API surface verification (draft 013).
--
-- Runs LAST in the executable package. 010 proves the *base* privilege posture
-- (anon holds nothing, authenticated holds SELECT only, every definer is pinned
-- and owned correctly, storage policy present). This file proves the surface the
-- application actually calls, and fails the deployment if the API layer drifted.
--
-- Deliberately assertions only: it grants nothing and changes nothing.

do $$
declare offenders text; n int;
begin
  -- 1. The application API layer must be present. A missing RPC means migration
  --    012 silently did nothing, and every client action would fail at runtime.
  select string_agg(missing_name, ', ' order by missing_name) into offenders
  from unnest(array[
    'ff_bootstrap','ff_update_profile','ff_league_create','ff_league_code','ff_league_join',
    'ff_league_members','ff_league_set_member','ff_league_transfer_leadership',
    'ff_league_set_market','ff_league_set_organizer','ff_market_upsert_player','ff_market_players',
    'ff_suggestion_submit','ff_suggestions','ff_suggestion_review',
    'ff_squad','ff_squad_buy','ff_squad_sell','ff_squad_transfer',
    'ff_lineup_save','ff_lineup_confirm','ff_gameweeks','ff_season_create',
    'ff_fixture_create','ff_standings','ff_notifications','ff_notification_read',
    'ff_tournament_create','ff_real_teams','ff_match_create','ff_match_open_revision',
    'ff_match_set_lineup','ff_match_submit_lineup','ff_match_fork_result','ff_match_set_score',
    'ff_match_record_event','ff_match_submit_result','ff_match_review_submission',
    'ff_match_open_correction','ff_matches'
  ]) missing_name
  where not exists (
    select 1 from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
    where n2.nspname = 'public' and p.proname = missing_name
  );
  if offenders is not null then
    raise exception 'application API functions are missing: %', offenders using errcode = '42501';
  end if;

  -- 2. Every public ff_ function must be executable by authenticated, so the
  --    frontend can call it. A missing grant is a 404 at runtime, not an error
  --    anyone notices during deployment.
  select string_agg(p.proname, ', ' order by p.proname) into offenders
  from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
  where n2.nspname = 'public' and p.proname like 'ff\_%'
    and not has_function_privilege('authenticated', p.oid, 'execute');
  if offenders is not null then
    raise exception 'application API functions not granted to authenticated: %', offenders
      using errcode = '42501';
  end if;

  -- 3. anon must not be able to call any of them. This is the difference between
  --    "checks auth.uid() internally" and "cannot be reached at all".
  select string_agg(p.proname, ', ' order by p.proname) into offenders
  from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
  where n2.nspname = 'public' and p.proname like 'ff\_%'
    and has_function_privilege('anon', p.oid, 'execute');
  if offenders is not null then
    raise exception 'application API functions reachable by anon: %', offenders using errcode = '42501';
  end if;

  -- 4. No application RPC may be executable by PUBLIC either.
  select string_agg(p.proname, ', ' order by p.proname) into offenders
  from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
  where n2.nspname = 'public' and p.proname like 'ff\_%'
    and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE');
  if offenders is not null then
    raise exception 'application API functions executable by PUBLIC: %', offenders using errcode = '42501';
  end if;

  -- 5. Every application RPC must be SECURITY DEFINER with a pinned search_path.
  --    A SECURITY INVOKER RPC would run as `authenticated`, which holds no DML
  --    grant, so the write would fail; a definer without search_path is
  --    hijackable by a caller-controlled schema.
  select string_agg(p.proname, ', ' order by p.proname) into offenders
  from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
  where n2.nspname = 'public' and p.proname like 'ff\_%'
    and (not p.prosecdef
         or not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c
                        where c like 'search_path=%'));
  if offenders is not null then
    raise exception 'application API functions must be SECURITY DEFINER with pinned search_path: %',
      offenders using errcode = '42501';
  end if;

  -- 6. The API layer must be owned by the same least-privilege definer as the
  --    rest of the definers, not by the migration superuser.
  select string_agg(p.proname || ' (owner ' || pg_get_userbyid(p.proowner) || ')', ', ' order by p.proname)
    into offenders
  from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
  where n2.nspname = 'public' and p.proname like 'ff\_%'
    and pg_get_userbyid(p.proowner) <> 'ff_migration_owner';
  if offenders is not null then
    raise exception 'application API functions not owned by ff_migration_owner: %', offenders
      using errcode = '42501';
  end if;

  -- 7. authenticated must still hold NO write privilege on any public table. The
  --    whole point of the RPC layer is that writes are only reachable through
  --    checked functions; a stray INSERT grant would bypass every check.
  select string_agg(format('%I:%s', c.relname, a.privilege_type), ', ' order by c.relname)
    into offenders
  from pg_class c join pg_namespace n2 on n2.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, '{}'::aclitem[])) a
  where n2.nspname = 'public' and c.relkind in ('r','p')
    and a.grantee = (select oid from pg_roles where rolname = 'authenticated')
    and a.privilege_type <> 'SELECT';
  if offenders is not null then
    raise exception 'authenticated holds write privileges on public tables: %', offenders
      using errcode = '42501';
  end if;

  -- 8. No private helper may be callable by clients. The ten reviewed read
  --    helpers are the only ff_private surface, and that set must not grow
  --    silently as helpers are added for the API layer.
  select string_agg(p.proname, ', ' order by p.proname) into offenders
  from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
  where n2.nspname = 'ff_private'
    and has_function_privilege('authenticated', p.oid, 'execute')
    and p.proname not in ('is_member','is_leader','is_organizer','owns_team','can_read_lineup',
                          'can_read_revision','can_read_match','can_read_suggestion','can_read_image',
                          'is_match_organizer');
  if offenders is not null then
    raise exception 'private helpers executable by authenticated: %', offenders using errcode = '42501';
  end if;

  -- 9. The scoring engine must still be closed. Positional scoring values are not
  --    approved, so no client-callable RPC may generate fantasy points, and the
  --    guards that block invented score rows must still be installed.
  --
  --    `ff_match_set_score` is deliberately NOT caught here: it records the
  --    real-life match result (team A / team B goals), which is an organizer
  --    input, not a fantasy points calculation. Only RPCs that would produce
  --    fantasy scores or scoring runs are forbidden.
  select string_agg(p.proname, ', ' order by p.proname) into offenders
  from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
  where n2.nspname = 'public' and p.proname like 'ff\_%'
    and (p.proname like '%scoring%' or p.proname like '%fantasy\_score%'
         or p.proname like '%\_score\_run%' or p.proname in ('ff_score','ff_run_scoring','ff_publish_scores'));
  if offenders is not null then
    raise exception 'fantasy-scoring RPCs must not be exposed until positional values are approved: %',
      offenders using errcode = '42501';
  end if;

  -- The match-result path that IS approved must exist, or the organizer cannot
  -- record a result at all.
  if not exists (select 1 from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
                  where n2.nspname = 'public' and p.proname = 'ff_match_set_score') then
    raise exception 'ff_match_set_score is missing; organizers cannot record a result' using errcode = '42501';
  end if;
  select count(*) into n from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where c.relname in ('match_player_performances','fantasy_score_items','fantasy_scores')
     and t.tgname like 'block_%' and not t.tgisinternal;
  if n <> 3 then
    raise exception 'expected 3 scoring write-blockers, found %', n using errcode = '42501';
  end if;

  -- 10. No function in ff_private may remain owned by anyone but the definer role.
  --     A SECURITY DEFINER helper owned by a superuser-ish role is a privilege
  --     escalation surface, and the first version of this package left one behind
  --     (current_gameweek) because ownership was matched by name. This assertion
  --     is what makes that class of regression impossible to ship.
  select string_agg(format('%I (owner %s)', p.proname, pg_get_userbyid(p.proowner)), ', ' order by p.proname)
    into offenders
  from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
  where n2.nspname = 'ff_private' and pg_get_userbyid(p.proowner) <> 'ff_migration_owner';
  if offenders is not null then
    raise exception 'ff_private functions not owned by ff_migration_owner: %', offenders
      using errcode = '42501';
  end if;

  -- 11. Audit and notification integrity: the append-only trigger on audit_logs
  --     must still exist, because every RPC writes its own audit row in the same
  --     transaction and tampering must remain impossible for clients.
  if not exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                  where c.relname = 'audit_logs' and t.tgname = 'audit_append_only' and not t.tgisinternal) then
    raise exception 'audit_logs append-only trigger is missing' using errcode = '42501';
  end if;
end $$;
