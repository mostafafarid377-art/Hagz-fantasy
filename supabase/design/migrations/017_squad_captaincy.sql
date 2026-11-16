-- Fantasy Friends design draft 017: persistent captaincy for incomplete squads.
--
-- Captain and vice-captain are team choices, not lineup-save prerequisites. The
-- original ff_lineup_save RPC correctly requires a complete 15-player lineup, but
-- captaincy was routed through that RPC, so choosing either role early failed.
-- Store the choices on the manager's fantasy team and expose a small checked RPC
-- that works for any roster size. Full lineup saves continue to snapshot those
-- choices into the lineup-player rows.

begin;

alter table public.fantasy_teams
  add column captain_player_id uuid,
  add column vice_captain_player_id uuid,
  add constraint fantasy_teams_captaincy_distinct
    check (captain_player_id is null or vice_captain_player_id is null or captain_player_id <> vice_captain_player_id),
  add constraint fantasy_teams_captain_player_fk
    foreign key (league_id, captain_player_id) references public.league_players(league_id, id) on delete restrict,
  add constraint fantasy_teams_vice_player_fk
    foreign key (league_id, vice_captain_player_id) references public.league_players(league_id, id) on delete restrict;

-- Preserve captaincy already stored in the latest active lineup.
update public.fantasy_teams t
set captain_player_id = (
      select x.league_player_id
      from public.fantasy_lineups li
      join public.fantasy_lineup_players x on x.league_id = li.league_id and x.lineup_id = li.id
      where li.league_id = t.league_id and li.fantasy_team_id = t.id
        and li.status in ('draft', 'confirmed') and x.captain
      order by li.created_at desc limit 1
    ),
    vice_captain_player_id = (
      select x.league_player_id
      from public.fantasy_lineups li
      join public.fantasy_lineup_players x on x.league_id = li.league_id and x.lineup_id = li.id
      where li.league_id = t.league_id and li.fantasy_team_id = t.id
        and li.status in ('draft', 'confirmed') and x.vice_captain
      order by li.created_at desc limit 1
    );

-- Selling a player clears that player's captain/vice selection. Transfers also
-- pass through this trigger; the lineup-player trigger below restores the role on
-- the replacement when the saved draft is updated.
create or replace function ff_private.clear_team_captaincy_on_squad_delete()
returns trigger
language plpgsql security definer set search_path = pg_catalog, ff_private as $$
begin
  update public.fantasy_teams
     set captain_player_id = case when captain_player_id = old.league_player_id then null else captain_player_id end,
         vice_captain_player_id = case when vice_captain_player_id = old.league_player_id then null else vice_captain_player_id end
   where id = old.fantasy_team_id and league_id = old.league_id;
  return old;
end $$;
create trigger fantasy_squad_player_captaincy_cleanup
  after delete on public.fantasy_squad_players
  for each row execute function ff_private.clear_team_captaincy_on_squad_delete();

-- Keep the team-level choices synchronized when complete lineup saves or player
-- transfers update the lineup snapshot.
create or replace function ff_private.sync_team_captaincy_from_lineup()
returns trigger
language plpgsql security definer set search_path = pg_catalog, ff_private as $$
declare v_league uuid; v_team uuid;
begin
  if tg_op <> 'INSERT' then
    select league_id, fantasy_team_id into v_league, v_team
      from public.fantasy_lineups where id = old.lineup_id;
    if found then
      update public.fantasy_teams
         set captain_player_id = case when captain_player_id = old.league_player_id
                                      and (tg_op = 'DELETE' or not new.captain) then null else captain_player_id end,
             vice_captain_player_id = case when vice_captain_player_id = old.league_player_id
                                           and (tg_op = 'DELETE' or not new.vice_captain) then null else vice_captain_player_id end
       where id = v_team and league_id = v_league;
    end if;
  end if;
  if tg_op <> 'DELETE' then
    select league_id, fantasy_team_id into v_league, v_team
      from public.fantasy_lineups where id = new.lineup_id;
    if found then
      update public.fantasy_teams
         set captain_player_id = case when new.captain then new.league_player_id else captain_player_id end,
             vice_captain_player_id = case when new.vice_captain then new.league_player_id else vice_captain_player_id end
       where id = v_team and league_id = v_league;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger fantasy_lineup_player_captaincy_sync
  after insert or update or delete on public.fantasy_lineup_players
  for each row execute function ff_private.sync_team_captaincy_from_lineup();

-- Read team-level captaincy even when there is no saved 15-player lineup yet.
create or replace function public.ff_squad(p_league uuid)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, ff_private as $$
declare t public.fantasy_teams; v_lineup public.fantasy_lineups; v_squad jsonb;
begin
  perform ff_private.require_member(p_league);
  select * into t from public.fantasy_teams where league_id = p_league and manager_id = ff_private.current_actor_id();
  if not found then
    return jsonb_build_object('team', null, 'players', '[]'::jsonb,
                              'formation', null, 'status', 'empty', 'captain_id', null,
                              'vice_captain_id', null, 'budget', (select budget from public.leagues where id = p_league),
                              'spent', 0);
  end if;

  select * into v_lineup from public.fantasy_lineups
   where league_id = p_league and fantasy_team_id = t.id and status in ('draft','confirmed')
   order by created_at desc limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'league_player_id', s.league_player_id, 'name', p.display_name,
           'position', lp.position, 'price', s.acquired_price, 'rating', lp.rating,
           'image_path', p.image_path, 'image_url', p.image_url, 'active', lp.active,
           'slot', x.slot, 'captain', s.league_player_id = t.captain_player_id,
           'vice_captain', s.league_player_id = t.vice_captain_player_id
         ) order by coalesce(x.slot, 99), p.display_name), '[]'::jsonb)
    into v_squad
  from public.fantasy_squad_players s
  join public.league_players lp on lp.league_id = s.league_id and lp.id = s.league_player_id
  join public.player_profiles p on p.league_id = lp.league_id and p.id = lp.player_id
  left join public.fantasy_lineup_players x
    on x.league_id = s.league_id and x.lineup_id = v_lineup.id and x.league_player_id = s.league_player_id
  where s.league_id = p_league and s.fantasy_team_id = t.id;

  return jsonb_build_object(
    'team', jsonb_build_object('id', t.id, 'name', t.name),
    'lineup_id', v_lineup.id,
    'formation', v_lineup.formation,
    'status', coalesce(v_lineup.status, 'empty'),
    'version', v_lineup.version,
    'gameweek_id', v_lineup.gameweek_id,
    'captain_id', t.captain_player_id,
    'vice_captain_id', t.vice_captain_player_id,
    'players', v_squad,
    'budget', (select budget from public.leagues where id = p_league),
    'spent', (select coalesce(sum(acquired_price), 0) from public.fantasy_squad_players
               where league_id = p_league and fantasy_team_id = t.id)
  );
end $$;

-- Set either captaincy role independently. A manager may have fewer than 15
-- players while building a squad, but the selected player must belong to their
-- own team and the two roles may never point at the same player.
create or replace function public.ff_squad_set_captains(
  p_league uuid, p_captain uuid default null, p_vice uuid default null)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, ff_private as $$
declare t public.fantasy_teams;
begin
  perform ff_private.require_member(p_league);
  t := ff_private.ensure_team(p_league);
  perform pg_advisory_xact_lock(hashtextextended('ff-squad:' || t.id::text, 0));
  select * into t from public.fantasy_teams where id = t.id for update;

  if p_captain is not null and not exists (
    select 1 from public.fantasy_squad_players s
    where s.league_id = p_league and s.fantasy_team_id = t.id and s.league_player_id = p_captain
  ) then raise exception 'captain must be in your squad' using errcode = '23514'; end if;
  if p_vice is not null and not exists (
    select 1 from public.fantasy_squad_players s
    where s.league_id = p_league and s.fantasy_team_id = t.id and s.league_player_id = p_vice
  ) then raise exception 'vice captain must be in your squad' using errcode = '23514'; end if;
  if p_captain is not null and p_captain = p_vice then
    raise exception 'captain and vice captain must be different players' using errcode = '23514';
  end if;

  update public.fantasy_teams
     set captain_player_id = p_captain, vice_captain_player_id = p_vice
   where id = t.id and league_id = p_league;
  perform ff_private.audit(p_league, 'squad_captaincy_updated', 'fantasy_team', t.id,
    jsonb_build_object('captain', p_captain, 'vice_captain', p_vice));
  return jsonb_build_object('captain_id', p_captain, 'vice_captain_id', p_vice);
end $$;

-- Transfer the new RPC and trigger functions to the reviewed least-privilege
-- owner. No table DML grant is added to authenticated.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'ff_migration_owner') then
    alter function public.ff_squad_set_captains(uuid, uuid, uuid) owner to ff_migration_owner;
    alter function ff_private.clear_team_captaincy_on_squad_delete() owner to ff_migration_owner;
    alter function ff_private.sync_team_captaincy_from_lineup() owner to ff_migration_owner;
  end if;
end $$;
revoke all on function public.ff_squad_set_captains(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.ff_squad_set_captains(uuid, uuid, uuid) to authenticated;
revoke all on function ff_private.clear_team_captaincy_on_squad_delete() from public, anon, authenticated;
revoke all on function ff_private.sync_team_captaincy_from_lineup() from public, anon, authenticated;

commit;
