-- Phase 4: preserve person identity by immutable IDs, allow duplicate display names,
-- batch suggestion submission atomically, and expose a member-scoped transfer history.

-- Names are labels, not identities. Distinct people (and real clubs) may share one.
alter table public.real_football_teams
  drop constraint if exists real_football_teams_league_id_name_key;
drop index if exists public.one_pending_name_per_league;

-- Keep the existing single-suggestion API for backwards compatibility, but stop
-- treating a matching display name as a duplicate person or pending proposal.
create or replace function public.ff_suggestion_submit(
  p_league uuid, p_name text, p_position text, p_notes text default null,
  p_image_path text default null, p_image_url text default null)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, ff_private as $$
declare v public.player_suggestions;
begin
  perform ff_private.require_member(p_league);
  if p_position not in ('GK', 'DEF', 'MID', 'FWD') then
    raise exception 'position must be GK, DEF, MID or FWD' using errcode = '23514';
  end if;
  if p_notes is not null and length(p_notes) > 500 then
    raise exception 'notes must be 500 characters or fewer' using errcode = '23514';
  end if;
  if p_image_url is not null and p_image_url !~* '^https?://' then
    raise exception 'image url must be http(s)' using errcode = '23514';
  end if;
  insert into public.player_suggestions(league_id, submitted_by, name, position, notes, image_path, image_url)
  values (p_league, ff_private.current_actor_id(), ff_private.clean_name(p_name), p_position,
          nullif(btrim(coalesce(p_notes, '')), ''), p_image_path, p_image_url)
  returning * into v;
  perform ff_private.notify_leader(p_league, 'suggestion_submitted',
    jsonb_build_object('suggestion_id', v.id, 'name', v.name, 'league_id', p_league));
  perform ff_private.audit(p_league, 'suggestion_submitted', 'player_suggestion', v.id,
    jsonb_build_object('name', v.name, 'position', v.position));
  return jsonb_build_object('id', v.id, 'status', v.status, 'name', v.name,
                            'position', v.position, 'notes', v.notes, 'created_at', v.created_at);
end $$;

-- A JSON array is one database transaction: invalid row rejects the batch rather
-- than leaving the manager with a misleading partial submit. Existing per-item
-- review remains independent through ff_suggestion_review.
create or replace function public.ff_suggestion_submit_batch(p_league uuid, p_items jsonb)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, ff_private as $$
declare v_item jsonb; v_result jsonb; v_results jsonb := '[]'::jsonb;
begin
  perform ff_private.require_member(p_league);
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 50 then
    raise exception 'batch must contain between 1 and 50 suggestions' using errcode = '23514';
  end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_result := public.ff_suggestion_submit(
      p_league,
      v_item->>'name',
      v_item->>'position',
      v_item->>'notes',
      v_item->>'image_path',
      v_item->>'image_url');
    v_results := v_results || jsonb_build_array(v_result);
  end loop;
  return v_results;
end $$;

-- Managers see their own history; leaders see the league's history. All joins are
-- by immutable row IDs and are explicitly scoped to the requested league.
create or replace function public.ff_transfers(p_league uuid, p_limit integer default 100)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, ff_private as $$
begin
  perform ff_private.require_member(p_league);
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'limit must be between 1 and 500' using errcode = '23514';
  end if;
  return coalesce((
    select jsonb_agg(x order by (x->>'created_at')::timestamptz desc)
    from (
      select jsonb_build_object(
        'id', tr.id, 'team_id', tr.fantasy_team_id, 'team_name', ft.name,
        'manager_id', ft.manager_id, 'manager_name', pr.display_name,
        'gameweek_id', tr.gameweek_id, 'gameweek_number', gw.number,
        'out_player_id', tr.out_player_id, 'out_name', out_profile.display_name,
        'in_player_id', tr.in_player_id, 'in_name', in_profile.display_name,
        'out_price', tr.out_price, 'in_price', tr.in_price,
        'created_at', tr.created_at
      ) x
      from public.transfers tr
      join public.fantasy_teams ft on ft.league_id = tr.league_id and ft.id = tr.fantasy_team_id
      join public.profiles pr on pr.id = ft.manager_id
      join public.gameweeks gw on gw.league_id = tr.league_id and gw.id = tr.gameweek_id
      left join public.league_players out_lp on out_lp.league_id = tr.league_id and out_lp.id = tr.out_player_id
      left join public.player_profiles out_profile on out_profile.league_id = out_lp.league_id and out_profile.id = out_lp.player_id
      join public.league_players in_lp on in_lp.league_id = tr.league_id and in_lp.id = tr.in_player_id
      join public.player_profiles in_profile on in_profile.league_id = in_lp.league_id and in_profile.id = in_lp.player_id
      where tr.league_id = p_league
        and (ff_private.is_leader(p_league) or ft.manager_id = ff_private.current_actor_id())
      order by tr.created_at desc
      limit p_limit
    ) q
  ), '[]'::jsonb);
end $$;

-- New definer ownership and least-privilege grants; existing ff_suggestion_submit
-- retains its owner and grants because CREATE OR REPLACE does not alter either.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'ff_migration_owner') then
    alter function public.ff_suggestion_submit_batch(uuid, jsonb) owner to ff_migration_owner;
    alter function public.ff_transfers(uuid, integer) owner to ff_migration_owner;
  end if;
end $$;
revoke all on function public.ff_suggestion_submit_batch(uuid, jsonb) from public, anon;
revoke all on function public.ff_transfers(uuid, integer) from public, anon;
grant execute on function public.ff_suggestion_submit_batch(uuid, jsonb) to authenticated;
grant execute on function public.ff_transfers(uuid, integer) to authenticated;
