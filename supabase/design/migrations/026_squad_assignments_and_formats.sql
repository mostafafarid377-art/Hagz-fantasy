-- Fantasy Friends design migration 026: durable squad slots and immutable league formats.
--
-- Forward-only: existing leagues default to 11-a-side and existing lineup history is
-- untouched. Recoverable current assignments are copied from their latest lineup;
-- players without a recoverable slot remain explicitly unassigned rather than being
-- silently ordered by a name, market response, or inferred formation.

begin;

alter table public.leagues
  add column match_format text not null default '11-a-side'
    check (match_format in ('11-a-side','7-a-side','5-a-side'));

alter table public.fantasy_teams
  add column squad_revision integer not null default 0 check (squad_revision >= 0);

-- This is the manager's durable roster assignment, independent of a particular
-- gameweek lineup snapshot. `slot` 1..starters means Starting XI; subsequent slots
-- are ordered bench places. NULL means the manager must explicitly assign the player.
create table public.fantasy_squad_assignments (
  league_id uuid not null,
  fantasy_team_id uuid not null,
  league_player_id uuid not null,
  slot smallint check (slot between 1 and 15),
  updated_at timestamptz not null default now(),
  primary key (fantasy_team_id, league_player_id),
  unique (fantasy_team_id, slot),
  foreign key (league_id, fantasy_team_id)
    references public.fantasy_teams(league_id, id) on delete restrict,
  foreign key (league_id, league_player_id)
    references public.league_players(league_id, id) on delete restrict,
  foreign key (fantasy_team_id, league_player_id)
    references public.fantasy_squad_players(fantasy_team_id, league_player_id) on delete cascade
);
create index fantasy_squad_assignment_order_idx
  on public.fantasy_squad_assignments(league_id, fantasy_team_id, slot);
alter table public.fantasy_squad_assignments enable row level security;
revoke all on public.fantasy_squad_assignments from public, anon, authenticated;

-- The trusted definer role alone receives table access; clients still use checked
-- RPCs, and RLS remains enabled for direct client sessions.
do $$begin
  if not exists(select 1 from pg_roles where rolname='ff_migration_owner') then
    raise exception 'ff_migration_owner does not exist; apply the reviewed ownership migration first';
  end if;
end$$;
grant select,insert,update,delete on table public.fantasy_squad_assignments to ff_migration_owner;

-- Recover only slots that were actually saved. Any current roster player absent from
-- the latest saved lineup stays NULL and must be explicitly assigned by its manager.
with latest as (
  select distinct on (league_id, fantasy_team_id) league_id, fantasy_team_id, id
    from public.fantasy_lineups
   where status in ('draft','confirmed','superseded')
   order by league_id, fantasy_team_id, created_at desc, version desc
)
insert into public.fantasy_squad_assignments(league_id,fantasy_team_id,league_player_id,slot)
select s.league_id, s.fantasy_team_id, s.league_player_id, x.slot
  from latest li
  join public.fantasy_lineup_players x on x.league_id=li.league_id and x.lineup_id=li.id
  join public.fantasy_squad_players s on s.league_id=x.league_id
    and s.fantasy_team_id=li.fantasy_team_id and s.league_player_id=x.league_player_id
on conflict do nothing;

-- Every currently rostered player gets an explicit row. Only recoverable saved
-- lineup slots remain assigned; everyone else is visibly unassigned.
insert into public.fantasy_squad_assignments(league_id,fantasy_team_id,league_player_id,slot)
select s.league_id,s.fantasy_team_id,s.league_player_id,null
  from public.fantasy_squad_players s
  left join public.fantasy_squad_assignments a
    on a.league_id=s.league_id and a.fantasy_team_id=s.fantasy_team_id and a.league_player_id=s.league_player_id
 where a.league_player_id is null
on conflict (fantasy_team_id,league_player_id) do nothing;

create or replace function ff_private.squad_format_rules(p_format text)
returns jsonb
language sql immutable security definer set search_path = pg_catalog, ff_private as $$
  select case p_format
    when '7-a-side' then '{"total":10,"starters":7,"bench":3,"limits":{"GK":2,"DEF":3,"MID":3,"FWD":2},"formations":["3-2-1","2-3-1","2-2-2"],"minimums":{"GK":1,"DEF":2,"MID":1,"FWD":1}}'::jsonb
    when '5-a-side' then '{"total":7,"starters":5,"bench":2,"limits":{"GK":2,"DEF":2,"MID":2,"FWD":1},"formations":["2-1-1","1-2-1"],"minimums":{"GK":1,"DEF":1,"MID":1,"FWD":1}}'::jsonb
    else '{"total":15,"starters":11,"bench":4,"limits":{"GK":2,"DEF":5,"MID":5,"FWD":3},"formations":["4-3-3","4-4-2","3-5-2","3-4-3","4-5-1","5-3-2","5-4-1"],"minimums":{"GK":1,"DEF":3,"MID":3,"FWD":1}}'::jsonb
  end
$$;

create or replace function ff_private.derived_formation(p_format text, p_gk integer, p_def integer, p_mid integer, p_fwd integer)
returns text
language sql immutable security definer set search_path = pg_catalog, ff_private as $$
  select case
    when p_gk <> 1 then null
    when (ff_private.squad_format_rules(p_format)->'formations') ? (p_def::text || '-' || p_mid::text || '-' || p_fwd::text)
      then p_def::text || '-' || p_mid::text || '-' || p_fwd::text
    else null
  end
$$;

-- Every legacy/current acquisition gets an explicit unassigned row unless a
-- server-side purchase RPC supplies a slot. Roster mutations increment an optimistic
-- revision token used to reject stale edits and make retries safe.
create or replace function ff_private.track_squad_roster_change()
returns trigger
language plpgsql security definer set search_path = pg_catalog, ff_private as $$
begin
  if tg_op = 'INSERT' then
    insert into public.fantasy_squad_assignments(league_id, fantasy_team_id, league_player_id, slot)
    values (new.league_id, new.fantasy_team_id, new.league_player_id, null)
    on conflict (fantasy_team_id, league_player_id) do nothing;
    update public.fantasy_teams set squad_revision=squad_revision+1
     where league_id=new.league_id and id=new.fantasy_team_id;
    return new;
  end if;
  update public.fantasy_teams set squad_revision=squad_revision+1
   where league_id=old.league_id and id=old.fantasy_team_id;
  return old;
end $$;
create trigger track_fantasy_squad_roster_change
  after insert or delete on public.fantasy_squad_players
  for each row execute function ff_private.track_squad_roster_change();

-- Existing immutable gameweek snapshots keep their labels; new snapshots can store
-- only formations in the approved catalog for at least one format.
alter table public.fantasy_lineups drop constraint if exists fantasy_lineups_formation_check;
alter table public.fantasy_lineups add constraint fantasy_lineups_formation_check
  check (formation in (
    '4-3-3','4-4-2','3-5-2','3-4-3','4-5-1','5-3-2','5-4-1',
    '3-2-1','2-3-1','2-2-2','2-1-1','1-2-1'));

-- Explicit-format league creation; the old signature remains compatible and
-- continues to create the default 11-a-side format.
create or replace function public.ff_league_create(p_name text, p_budget numeric, p_format text)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, ff_private as $$
declare v_uid uuid:=ff_private.current_actor_id(); v_league public.leagues; v_code text;
begin
  if v_uid is null then raise exception 'authentication required' using errcode='42501'; end if;
  if not exists(select 1 from public.profiles where id=v_uid) then
    raise exception 'profile required; call ff_bootstrap first' using errcode='42501';
  end if;
  if p_budget is null or p_budget<=0 then raise exception 'budget must be positive' using errcode='23514'; end if;
  if p_format not in ('11-a-side','7-a-side','5-a-side') then
    raise exception 'unsupported match format' using errcode='23514';
  end if;
  insert into public.leagues(name,budget,match_format)
  values(ff_private.clean_name(p_name),p_budget,p_format) returning * into v_league;
  insert into public.league_members(league_id,user_id,role,status)
  values(v_league.id,v_uid,'leader','active');
  perform ff_private.ensure_team(v_league.id,(select display_name from public.profiles where id=v_uid));
  perform ff_private.audit(v_league.id,'league_created','league',v_league.id,to_jsonb(v_league));
  v_code:=ff_private.league_code(v_league.id);
  return jsonb_build_object('id',v_league.id,'name',v_league.name,'budget',v_league.budget,
    'market_open',v_league.market_open,'match_format',v_league.match_format,'code',v_code);
end $$;

-- Include the immutable format in the server-authoritative league list.
create or replace function public.ff_bootstrap(p_display_name text default null)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, ff_private as $$
declare v_uid uuid:=ff_private.current_actor_id(); v_profile public.profiles; v_name text; v_leagues jsonb;
begin
  if v_uid is null then raise exception 'authentication required' using errcode='42501'; end if;
  v_name:=nullif(btrim(coalesce(p_display_name,'')),'');
  select * into v_profile from public.profiles where id=v_uid;
  if not found then
    v_name:=coalesce(v_name,split_part(nullif(current_setting('request.jwt.claims',true),''),'@',1));
    if v_name is null or length(btrim(v_name))<2 then v_name:='Player'; end if;
    v_name:=left(btrim(v_name),100);
    insert into public.profiles(id,display_name) values(v_uid,v_name) returning * into v_profile;
  elsif v_name is not null and v_name is distinct from v_profile.display_name then
    update public.profiles set display_name=ff_private.clean_name(v_name) where id=v_uid returning * into v_profile;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'league_id',m.league_id,'name',l.name,'role',m.role,'status',m.status,'budget',l.budget,
    'market_open',l.market_open,'match_format',l.match_format,'archived',l.archived_at is not null,
    'is_leader',m.role='leader','is_organizer',exists(select 1 from public.match_organizers o
      where o.league_id=m.league_id and o.user_id=m.user_id)) order by l.created_at),'[]'::jsonb)
  into v_leagues from public.league_members m join public.leagues l on l.id=m.league_id
  where m.user_id=v_uid and m.status='active';
  return jsonb_build_object('profile',jsonb_build_object('id',v_profile.id,'display_name',v_profile.display_name),'leagues',v_leagues);
end $$;

-- Read the durable assignment table, never a name-sorted or client-order roster.
create or replace function public.ff_squad(p_league uuid)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, ff_private as $$
declare t public.fantasy_teams; v_lineup public.fantasy_lineups; v_squad jsonb;
  v_format text; v_formation text; v_rules jsonb; v_gk integer; v_def integer; v_mid integer; v_fwd integer; v_assigned integer;
begin
  perform ff_private.require_member(p_league);
  select match_format into v_format from public.leagues where id=p_league;
  select * into t from public.fantasy_teams where league_id=p_league and manager_id=ff_private.current_actor_id();
  if not found then
    return jsonb_build_object('team',null,'players','[]'::jsonb,'formation',null,'status','empty',
      'captain_id',null,'vice_captain_id',null,'budget',(select budget from public.leagues where id=p_league),
      'spent',0,'match_format',v_format,'assignment_revision',0);
  end if;
  v_rules:=ff_private.squad_format_rules(v_format);
  select * into v_lineup from public.fantasy_lineups where league_id=p_league and fantasy_team_id=t.id
    and status in ('draft','confirmed') order by created_at desc,version desc limit 1;

  select count(*) filter(where a.slot<= (v_rules->>'starters')::int),
         count(*) filter(where lp.position='GK' and a.slot<= (v_rules->>'starters')::int),
         count(*) filter(where lp.position='DEF' and a.slot<= (v_rules->>'starters')::int),
         count(*) filter(where lp.position='MID' and a.slot<= (v_rules->>'starters')::int),
         count(*) filter(where lp.position='FWD' and a.slot<= (v_rules->>'starters')::int)
    into v_assigned,v_gk,v_def,v_mid,v_fwd
    from public.fantasy_squad_assignments a join public.league_players lp
      on lp.league_id=a.league_id and lp.id=a.league_player_id
   where a.league_id=p_league and a.fantasy_team_id=t.id;
  if v_assigned=(v_rules->>'starters')::int then
    v_formation:=ff_private.derived_formation(v_format,v_gk,v_def,v_mid,v_fwd);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'league_player_id',s.league_player_id,'name',p.display_name,'position',lp.position,
    'price',s.acquired_price,'rating',lp.rating,'image_path',p.image_path,'image_url',p.image_url,
    'active',lp.active,'slot',a.slot,'captain',s.league_player_id=t.captain_player_id,
    'vice_captain',s.league_player_id=t.vice_captain_player_id)
    order by a.slot nulls last,s.league_player_id),'[]'::jsonb)
    into v_squad
  from public.fantasy_squad_players s
  join public.league_players lp on lp.league_id=s.league_id and lp.id=s.league_player_id
  join public.player_profiles p on p.league_id=lp.league_id and p.id=lp.player_id
  left join public.fantasy_squad_assignments a on a.league_id=s.league_id
    and a.fantasy_team_id=s.fantasy_team_id and a.league_player_id=s.league_player_id
  where s.league_id=p_league and s.fantasy_team_id=t.id;

  return jsonb_build_object('team',jsonb_build_object('id',t.id,'name',t.name),
    'lineup_id',v_lineup.id,'formation',v_formation,'status',coalesce(v_lineup.status,
      case when v_assigned>0 then 'draft' else 'empty' end),'version',v_lineup.version,'gameweek_id',v_lineup.gameweek_id,
    'captain_id',t.captain_player_id,'vice_captain_id',t.vice_captain_player_id,'players',v_squad,
    'budget',(select budget from public.leagues where id=p_league),
    'spent',(select coalesce(sum(acquired_price),0) from public.fantasy_squad_players where league_id=p_league and fantasy_team_id=t.id),
    'match_format',v_format,'assignment_revision',t.squad_revision);
end $$;

-- Gameweek snapshot helper; called inside the assignment transaction. It derives
-- formation from starters and writes the unchanged historic lineup schema in slot order.
create or replace function ff_private.persist_gameweek_lineup(
  p_league uuid,p_team uuid,p_gameweek uuid,p_format text,p_player_ids uuid[],p_captain uuid,p_vice uuid)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare v_lineup public.fantasy_lineups; v_version integer; v_starters integer;
  v_gk integer; v_def integer; v_mid integer; v_fwd integer; v_formation text; i integer; v_id uuid; rec record;
begin
  if not exists(select 1 from public.gameweeks where league_id=p_league and id=p_gameweek) then
    raise exception 'gameweek not found in this league' using errcode='23514';
  end if;
  v_starters:=(ff_private.squad_format_rules(p_format)->>'starters')::int;
  select count(*) filter(where position='GK'),count(*) filter(where position='DEF'),
         count(*) filter(where position='MID'),count(*) filter(where position='FWD')
    into v_gk,v_def,v_mid,v_fwd
    from unnest(p_player_ids[1:v_starters]) u(id)
    join public.league_players lp on lp.league_id=p_league and lp.id=u.id;
  v_formation:=ff_private.derived_formation(p_format,v_gk,v_def,v_mid,v_fwd);
  if v_formation is null then raise exception 'starting lineup does not match a legal % formation' ,p_format using errcode='23514'; end if;
  select * into v_lineup from public.fantasy_lineups where league_id=p_league and fantasy_team_id=p_team
    and gameweek_id=p_gameweek and status='draft' order by version desc limit 1;
  if not found then
    select coalesce(max(version),0)+1 into v_version from public.fantasy_lineups
      where league_id=p_league and fantasy_team_id=p_team and gameweek_id=p_gameweek;
    insert into public.fantasy_lineups(league_id,fantasy_team_id,gameweek_id,version,status,formation)
      values(p_league,p_team,p_gameweek,v_version,'draft',v_formation) returning * into v_lineup;
  else
    if exists(select 1 from public.fantasy_score_items i where i.league_id=p_league and i.fantasy_lineup_id=v_lineup.id) then
      raise exception 'lineup has been scored and can no longer change' using errcode='23514';
    end if;
    update public.fantasy_lineups set formation=v_formation where league_id=p_league and id=v_lineup.id;
    delete from public.fantasy_lineup_players where league_id=p_league and lineup_id=v_lineup.id;
  end if;
  for i in 1..cardinality(p_player_ids) loop
    v_id:=p_player_ids[i];
    select position,price into rec from public.league_players where league_id=p_league and id=v_id;
    insert into public.fantasy_lineup_players(league_id,lineup_id,league_player_id,position_snapshot,price_snapshot,slot,captain,vice_captain)
    values(p_league,v_lineup.id,v_id,rec.position,rec.price,i,v_id=p_captain,v_id=p_vice);
  end loop;
  perform ff_private.audit(p_league,'lineup_saved','fantasy_lineup',v_lineup.id,
    jsonb_build_object('formation',v_formation,'version',v_lineup.version,'match_format',p_format));
  return jsonb_build_object('lineup_id',v_lineup.id,'version',v_lineup.version,'formation',v_formation,'status','draft');
end $$;

-- Atomic exact assignment save. Arrays carry stable IDs; array order is the explicit
-- slot/bench order, not an identity key. Unassigned players remain visible as such.
create or replace function public.ff_squad_save_assignments(
  p_league uuid,p_starters uuid[],p_bench uuid[],p_unassigned uuid[],
  p_captain uuid default null,p_vice uuid default null,p_gameweek uuid default null,p_expected_revision integer default null)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare t public.fantasy_teams; l public.leagues; rules jsonb; v_all uuid[]; v_count integer; v_roster integer;
  v_gk integer; v_def integer; v_mid integer; v_fwd integer; v_formation text;
  v_captain uuid; v_vice uuid; v_id uuid; i integer; v_lineup jsonb; v_revision integer;
begin
  perform ff_private.require_member(p_league);
  select * into l from public.leagues where id=p_league;
  rules:=ff_private.squad_format_rules(l.match_format);
  t:=ff_private.ensure_team(p_league);
  perform pg_advisory_xact_lock(hashtextextended('ff-squad:'||t.id::text,0));
  select * into t from public.fantasy_teams where id=t.id and league_id=p_league for update;
  if p_expected_revision is not null and t.squad_revision<>p_expected_revision then
    raise exception 'squad changed elsewhere; reload before saving' using errcode='40001';
  end if;
  if p_starters is null or p_bench is null or p_unassigned is null then
    raise exception 'starter, bench, and unassigned selections must be arrays' using errcode='23514';
  end if;
  if cardinality(p_starters)>(rules->>'starters')::int or cardinality(p_bench)>(rules->>'bench')::int then
    raise exception 'assignment exceeds this league format capacity' using errcode='23514';
  end if;
  v_all:=coalesce(p_starters,'{}'::uuid[])||coalesce(p_bench,'{}'::uuid[])||coalesce(p_unassigned,'{}'::uuid[]);
  select count(*),count(distinct x) into v_count,v_roster from unnest(v_all) x;
  if v_count<>v_roster then raise exception 'a player cannot appear twice in squad assignments' using errcode='23514'; end if;
  if v_count<>(select count(*) from public.fantasy_squad_players where league_id=p_league and fantasy_team_id=t.id) then
    raise exception 'assignments must include every player in your squad exactly once' using errcode='23514';
  end if;
  if exists(select 1 from unnest(v_all) x where not exists(select 1 from public.fantasy_squad_players s
    where s.league_id=p_league and s.fantasy_team_id=t.id and s.league_player_id=x)) then
    raise exception 'assignment contains a player outside your squad and league' using errcode='42501';
  end if;
  select count(*) filter(where position='GK'),count(*) filter(where position='DEF'),
         count(*) filter(where position='MID'),count(*) filter(where position='FWD')
    into v_gk,v_def,v_mid,v_fwd from unnest(v_all) u(id)
    join public.league_players lp on lp.league_id=p_league and lp.id=u.id;
  if v_gk>(rules->'limits'->>'GK')::int or v_def>(rules->'limits'->>'DEF')::int
     or v_mid>(rules->'limits'->>'MID')::int or v_fwd>(rules->'limits'->>'FWD')::int then
    raise exception 'squad exceeds a position limit for %',l.match_format using errcode='23514';
  end if;
  if v_count=(rules->>'total')::int and (v_gk<>(rules->'limits'->>'GK')::int
    or v_def<>(rules->'limits'->>'DEF')::int or v_mid<>(rules->'limits'->>'MID')::int
    or v_fwd<>(rules->'limits'->>'FWD')::int) then
    raise exception 'full squad must meet the % position distribution',l.match_format using errcode='23514';
  end if;
  if cardinality(p_starters)=(rules->>'starters')::int then
    select count(*) filter(where position='GK'),count(*) filter(where position='DEF'),
           count(*) filter(where position='MID'),count(*) filter(where position='FWD')
      into v_gk,v_def,v_mid,v_fwd from unnest(p_starters) u(id)
      join public.league_players lp on lp.league_id=p_league and lp.id=u.id;
    v_formation:=ff_private.derived_formation(l.match_format,v_gk,v_def,v_mid,v_fwd);
    if v_formation is null then
      raise exception 'starting lineup is not legal for %: GK %, DEF %, MID %, FWD %',l.match_format,v_gk,v_def,v_mid,v_fwd using errcode='23514';
    end if;
    if p_gameweek is not null and
       (cardinality(p_bench)<>(rules->>'bench')::int or cardinality(p_unassigned)<>0) then
      raise exception 'a gameweek lineup must assign every remaining squad player to the ordered bench' using errcode='23514';
    end if;
    -- Captaincy is recovered below from the requested choices, existing choices,
    -- or deterministic starter order. A missing/stale captain field must never
    -- block an otherwise valid squad substitution or lineup assignment.
  end if;
  if p_captain is not null and p_vice is not null and p_captain=p_vice then
    raise exception 'captain and vice-captain must differ' using errcode='23514';
  end if;

  -- Deterministic captaincy recovery: keep eligible requested/current choices;
  -- promote the old vice if the captain left the XI; otherwise use starter order.
  v_captain:=case when p_captain=any(p_starters) then p_captain
                  when t.captain_player_id=any(p_starters) then t.captain_player_id
                  when t.vice_captain_player_id=any(p_starters) then t.vice_captain_player_id
                  else p_starters[1] end;
  v_vice:=case when p_vice=any(p_starters) and p_vice is distinct from v_captain then p_vice
               when t.vice_captain_player_id=any(p_starters) and t.vice_captain_player_id is distinct from v_captain then t.vice_captain_player_id
               else (select x from unnest(p_starters) with ordinality u(x,n) where x is distinct from v_captain order by n limit 1) end;
  if cardinality(p_starters)<2 then v_vice:=null; end if;

  delete from public.fantasy_squad_assignments where league_id=p_league and fantasy_team_id=t.id;
  for i in 1..cardinality(p_starters) loop
    insert into public.fantasy_squad_assignments(league_id,fantasy_team_id,league_player_id,slot)
    values(p_league,t.id,p_starters[i],i);
  end loop;
  for i in 1..cardinality(p_bench) loop
    insert into public.fantasy_squad_assignments(league_id,fantasy_team_id,league_player_id,slot)
    values(p_league,t.id,p_bench[i],(rules->>'starters')::int+i);
  end loop;
  foreach v_id in array p_unassigned loop
    insert into public.fantasy_squad_assignments(league_id,fantasy_team_id,league_player_id,slot)
    values(p_league,t.id,v_id,null);
  end loop;
  update public.fantasy_teams set captain_player_id=v_captain,vice_captain_player_id=v_vice,
    squad_revision=squad_revision+1 where id=t.id and league_id=p_league returning squad_revision into v_revision;

  if cardinality(p_starters)=(rules->>'starters')::int and p_gameweek is not null then
    v_lineup:=ff_private.persist_gameweek_lineup(p_league,t.id,p_gameweek,l.match_format,v_all,v_captain,v_vice);
  else
    v_lineup:=null;
  end if;
  perform ff_private.audit(p_league,'squad_assignments_saved','fantasy_team',t.id,
    jsonb_build_object('starters',cardinality(p_starters),'bench',cardinality(p_bench),
      'unassigned',cardinality(p_unassigned),'captain',v_captain,'vice_captain',v_vice,'revision',v_revision));
  return jsonb_build_object('squad',public.ff_squad(p_league),'lineup',v_lineup,'assignment_revision',v_revision);
end $$;

-- A direct player-to-slot purchase lets a market pick assign into the selected
-- starter/bench place in the same transaction. Purchases from the general market
-- remain explicitly unassigned until the manager places the player.
create or replace function public.ff_squad_purchase(p_league uuid,p_league_player uuid,p_slot smallint default null)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare t public.fantasy_teams; l public.leagues; lp public.league_players; rules jsonb;
  v_count integer; v_spent numeric; v_pos_count integer;
begin
  perform ff_private.require_member(p_league);
  select * into l from public.leagues where id=p_league;
  if not found or not l.market_open or l.archived_at is not null then raise exception 'market is closed or league is unavailable' using errcode='42501'; end if;
  rules:=ff_private.squad_format_rules(l.match_format);
  select * into lp from public.league_players where league_id=p_league and id=p_league_player;
  if not found or not lp.active then raise exception 'player is not active in this league market' using errcode='42501'; end if;
  t:=ff_private.ensure_team(p_league);
  perform pg_advisory_xact_lock(hashtextextended('ff-squad:'||t.id::text,0));
  if exists(select 1 from public.fantasy_squad_players where league_id=p_league and fantasy_team_id=t.id and league_player_id=lp.id) then
    raise exception 'player is already in your squad' using errcode='23514';
  end if;
  select count(*),coalesce(sum(acquired_price),0) into v_count,v_spent from public.fantasy_squad_players
    where league_id=p_league and fantasy_team_id=t.id;
  if v_count>=(rules->>'total')::int then raise exception 'squad is full' using errcode='23514'; end if;
  if v_spent+lp.price>l.budget then raise exception 'not enough budget' using errcode='23514'; end if;
  select count(*) into v_pos_count from public.fantasy_squad_players s join public.league_players x
    on x.league_id=s.league_id and x.id=s.league_player_id
    where s.league_id=p_league and s.fantasy_team_id=t.id and x.position=lp.position;
  if v_pos_count>=(rules->'limits'->>lp.position)::int then raise exception 'position limit reached for %',lp.position using errcode='23514'; end if;
  if p_slot is not null and (p_slot<1 or p_slot>(rules->>'total')::int) then raise exception 'slot is outside this format squad' using errcode='23514'; end if;
  if p_slot is not null and exists(select 1 from public.fantasy_squad_assignments where fantasy_team_id=t.id and slot=p_slot) then
    raise exception 'that squad place is already occupied' using errcode='23514';
  end if;
  insert into public.fantasy_squad_players(league_id,fantasy_team_id,league_player_id,acquired_price)
    values(p_league,t.id,lp.id,lp.price);
  if p_slot is not null then update public.fantasy_squad_assignments set slot=p_slot,updated_at=now()
    where league_id=p_league and fantasy_team_id=t.id and league_player_id=lp.id; end if;
  update public.fantasy_lineups set status='superseded' where league_id=p_league and fantasy_team_id=t.id and status='draft';
  perform ff_private.audit(p_league,'squad_buy','league_player',lp.id,
    jsonb_build_object('price',lp.price,'team_id',t.id,'slot',p_slot,'match_format',l.match_format));
  return jsonb_build_object('league_player_id',lp.id,'price',lp.price,'squad_size',v_count+1,'spent',v_spent+lp.price,'slot',p_slot);
end $$;

-- Keep the legacy purchase RPC safe: the trigger creates an explicit unassigned
-- roster row, never a guessed Starter or Bench slot.
create or replace function public.ff_squad_buy(p_league uuid,p_league_player uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,ff_private as $$
begin return public.ff_squad_purchase(p_league,p_league_player,null); end $$;

-- Transfer is one transaction. Preserve the outgoing player's exact durable slot,
-- captaincy/vice-captaincy and existing draft snapshot when replacing the stable ID.
create or replace function public.ff_squad_transfer(p_league uuid,p_out uuid,p_in uuid)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare t public.fantasy_teams; l public.leagues; out_lp public.league_players; in_lp public.league_players;
  v_out_price numeric; v_spent numeric; v_count integer; gw uuid; v_slot smallint;
  v_was_captain boolean; v_was_vice boolean;
begin
  perform ff_private.require_member(p_league);
  select * into l from public.leagues where id=p_league;
  if not l.market_open or l.archived_at is not null then raise exception 'the transfer market is closed' using errcode='42501'; end if;
  if p_out=p_in then raise exception 'outgoing and incoming players are the same' using errcode='23514'; end if;
  select * into t from public.fantasy_teams where league_id=p_league and manager_id=ff_private.current_actor_id();
  if not found then raise exception 'you have no team in this league' using errcode='23514'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ff-squad:'||t.id::text,0));
  select * into t from public.fantasy_teams where league_id=p_league and id=t.id for update;
  select * into out_lp from public.league_players where league_id=p_league and id=p_out;
  if not found then raise exception 'outgoing player is not in this league market' using errcode='42501'; end if;
  select * into in_lp from public.league_players where league_id=p_league and id=p_in;
  if not found then raise exception 'incoming player is not in this league market' using errcode='42501'; end if;
  if not in_lp.active then raise exception 'incoming player is not active' using errcode='23514'; end if;
  if in_lp.position<>out_lp.position then raise exception 'a replacement must play in the same position' using errcode='23514'; end if;
  select acquired_price into v_out_price from public.fantasy_squad_players
   where league_id=p_league and fantasy_team_id=t.id and league_player_id=p_out;
  if not found then raise exception 'outgoing player is not in your squad' using errcode='23514'; end if;
  if exists(select 1 from public.fantasy_squad_players where league_id=p_league and fantasy_team_id=t.id and league_player_id=p_in) then
    raise exception 'incoming player is already in your squad' using errcode='23514';
  end if;
  if exists(select 1 from public.fantasy_lineup_players x join public.fantasy_lineups li
    on li.league_id=x.league_id and li.id=x.lineup_id where x.league_id=p_league and x.league_player_id=p_out
    and li.fantasy_team_id=t.id and li.status='confirmed') then
    raise exception 'outgoing player is locked in a confirmed lineup' using errcode='23514';
  end if;
  select slot into v_slot from public.fantasy_squad_assignments
   where league_id=p_league and fantasy_team_id=t.id and league_player_id=p_out;
  v_was_captain:=t.captain_player_id=p_out;
  v_was_vice:=t.vice_captain_player_id=p_out;
  select count(*),coalesce(sum(acquired_price),0) into v_count,v_spent from public.fantasy_squad_players
   where league_id=p_league and fantasy_team_id=t.id;
  if v_spent-v_out_price+in_lp.price>l.budget then raise exception 'not enough budget for this transfer' using errcode='23514'; end if;
  delete from public.fantasy_squad_players where league_id=p_league and fantasy_team_id=t.id and league_player_id=p_out;
  insert into public.fantasy_squad_players(league_id,fantasy_team_id,league_player_id,acquired_price)
    values(p_league,t.id,in_lp.id,in_lp.price);
  update public.fantasy_squad_assignments set slot=v_slot,updated_at=now()
    where league_id=p_league and fantasy_team_id=t.id and league_player_id=in_lp.id;
  update public.fantasy_lineup_players x set league_player_id=in_lp.id,position_snapshot=in_lp.position,price_snapshot=in_lp.price
   where x.league_id=p_league and x.league_player_id=p_out and exists(
     select 1 from public.fantasy_lineups li where li.league_id=x.league_id and li.id=x.lineup_id
       and li.fantasy_team_id=t.id and li.status='draft');
  update public.fantasy_teams set
    captain_player_id=case when v_was_captain then in_lp.id else captain_player_id end,
    vice_captain_player_id=case when v_was_vice then in_lp.id else vice_captain_player_id end
   where league_id=p_league and id=t.id;
  gw:=ff_private.current_gameweek(p_league);
  if gw is null then raise exception 'create a season with at least one gameweek before making transfers' using errcode='23514'; end if;
  insert into public.transfers(league_id,fantasy_team_id,gameweek_id,out_player_id,in_player_id,out_price,in_price,actor_id)
  values(p_league,t.id,gw,p_out,p_in,v_out_price,in_lp.price,ff_private.current_actor_id());
  perform ff_private.audit(p_league,'squad_transfer','league_player',p_in,
    jsonb_build_object('out',p_out,'in',p_in,'out_price',v_out_price,'in_price',in_lp.price,'slot',v_slot));
  return jsonb_build_object('out',p_out,'in',p_in,'spent',v_spent-v_out_price+in_lp.price,'slot',v_slot);
end $$;

-- Idempotent explicit substitution: a retry after success observes the players in
-- their intended new roles and returns the persisted state without swapping back.
create or replace function public.ff_squad_substitute(p_league uuid,p_out uuid,p_in uuid,p_expected_revision integer default null)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare t public.fantasy_teams; l public.leagues; rules jsonb; v_out_slot smallint; v_in_slot smallint;
  v_starters uuid[]; v_bench uuid[]; v_unassigned uuid[]; result jsonb;
begin
  perform ff_private.require_member(p_league);
  select * into l from public.leagues where id=p_league;
  rules:=ff_private.squad_format_rules(l.match_format);
  select * into t from public.fantasy_teams where league_id=p_league and manager_id=ff_private.current_actor_id();
  if not found then raise exception 'you have no squad in this league' using errcode='23514'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ff-squad:'||t.id::text,0));
  select * into t from public.fantasy_teams where id=t.id for update;
  select min(slot) filter(where league_player_id=p_out),min(slot) filter(where league_player_id=p_in)
    into v_out_slot,v_in_slot from public.fantasy_squad_assignments
    where league_id=p_league and fantasy_team_id=t.id;
  -- A network retry after commit must be a no-op rather than reverse the swap.
  if v_out_slot>(rules->>'starters')::int and v_in_slot<=(rules->>'starters')::int then
    if p_expected_revision is not null and t.squad_revision<>p_expected_revision+1 then
      raise exception 'squad changed after the previous substitution; reload before retrying' using errcode='40001';
    end if;
    return jsonb_build_object('squad',public.ff_squad(p_league),'assignment_revision',t.squad_revision,'replayed',true);
  end if;
  if v_out_slot is null or v_in_slot is null then
    raise exception 'choose an assigned Starting XI player and an assigned Bench player' using errcode='23514';
  end if;
  if v_out_slot>(rules->>'starters')::int or v_in_slot<=(rules->>'starters')::int then
    raise exception 'choose one Starting XI player and one Bench player' using errcode='23514';
  end if;
  if p_expected_revision is not null and t.squad_revision<>p_expected_revision then
    raise exception 'squad changed elsewhere; reload before substituting' using errcode='40001';
  end if;
  select array_agg(case when slot=v_out_slot then p_in else league_player_id end order by slot)
    filter(where slot<=(rules->>'starters')::int) into v_starters
    from public.fantasy_squad_assignments where league_id=p_league and fantasy_team_id=t.id;
  select array_agg(case when slot=v_in_slot then p_out else league_player_id end order by slot)
    filter(where slot>(rules->>'starters')::int) into v_bench
    from public.fantasy_squad_assignments where league_id=p_league and fantasy_team_id=t.id;
  select coalesce(array_agg(league_player_id order by league_player_id),'{}'::uuid[])
    into v_unassigned from public.fantasy_squad_assignments
    where league_id=p_league and fantasy_team_id=t.id and slot is null;
  result:=public.ff_squad_save_assignments(p_league,v_starters,v_bench,v_unassigned,
    t.captain_player_id,t.vice_captain_player_id,null,t.squad_revision);
  return result;
end $$;

-- Keep captaincy on eligible starters. If a caller has a partial roster, only
-- already-assigned starters are selectable; complete lineups always have both.
create or replace function public.ff_squad_set_captains(p_league uuid,p_captain uuid default null,p_vice uuid default null)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare t public.fantasy_teams; l public.leagues; rules jsonb;
begin
  perform ff_private.require_member(p_league);
  select * into l from public.leagues where id=p_league;
  rules:=ff_private.squad_format_rules(l.match_format);
  t:=ff_private.ensure_team(p_league);
  perform pg_advisory_xact_lock(hashtextextended('ff-squad:'||t.id::text,0));
  select * into t from public.fantasy_teams where id=t.id for update;
  if p_captain is not null and not exists(select 1 from public.fantasy_squad_assignments a
    where a.league_id=p_league and a.fantasy_team_id=t.id and a.league_player_id=p_captain and a.slot<=(rules->>'starters')::int) then
    raise exception 'captain must be in the assigned Starting XI' using errcode='23514'; end if;
  if p_vice is not null and not exists(select 1 from public.fantasy_squad_assignments a
    where a.league_id=p_league and a.fantasy_team_id=t.id and a.league_player_id=p_vice and a.slot<=(rules->>'starters')::int) then
    raise exception 'vice-captain must be in the assigned Starting XI' using errcode='23514'; end if;
  if p_captain is not null and p_captain=p_vice then raise exception 'captain and vice-captain must differ' using errcode='23514'; end if;
  update public.fantasy_teams set captain_player_id=p_captain,vice_captain_player_id=p_vice,
    squad_revision=squad_revision+1 where id=t.id and league_id=p_league;
  update public.fantasy_lineup_players x set captain=(x.league_player_id=p_captain),vice_captain=(x.league_player_id=p_vice)
    where x.league_id=p_league and exists(select 1 from public.fantasy_lineups li
      where li.league_id=x.league_id and li.id=x.lineup_id and li.fantasy_team_id=t.id and li.status='draft');
  perform ff_private.audit(p_league,'squad_captaincy_updated','fantasy_team',t.id,
    jsonb_build_object('captain',p_captain,'vice_captain',p_vice));
  return jsonb_build_object('captain_id',p_captain,'vice_captain_id',p_vice,'assignment_revision',t.squad_revision+1);
end $$;

-- Backwards-compatible wrapper: ignore the obsolete manual formation parameter and
-- use the league's immutable format plus explicit ordered IDs.
create or replace function public.ff_lineup_save(
  p_league uuid,p_gameweek uuid,p_formation text,p_player_ids uuid[],p_captain uuid default null,p_vice uuid default null)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare n integer; v jsonb;
begin
  n:=(ff_private.squad_format_rules((select match_format from public.leagues where id=p_league))->>'starters')::int;
  if p_player_ids is null then raise exception 'player assignments are required' using errcode='23514'; end if;
  v:=public.ff_squad_save_assignments(p_league,p_player_ids[1:n],p_player_ids[n+1:],'{}'::uuid[],p_captain,p_vice,p_gameweek,null);
  return jsonb_build_object('lineup_id',v->'lineup'->'lineup_id','version',v->'lineup'->'version',
    'formation',v->'lineup'->'formation','status',coalesce(v->'lineup'->>'status','draft'),
    'squad',v->'squad','assignment_revision',v->'assignment_revision');
end $$;

-- League match schedule format and substitutes follow its immutable match format.
create or replace function ff_private.enforce_league_match_format()
returns trigger
language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare v_format text; rules jsonb;
begin
  select match_format into v_format from public.leagues where id=new.league_id;
  rules:=ff_private.squad_format_rules(v_format);
  if new.starters_per_side<>(rules->>'starters')::int then
    raise exception 'match must use the league format: % starters per side for %',rules->>'starters',v_format using errcode='23514';
  end if;
  if new.max_substitutes>(rules->>'bench')::int then
    raise exception 'match substitute limit cannot exceed the league bench size of %',rules->>'bench' using errcode='23514';
  end if;
  return new;
end $$;
create trigger enforce_real_match_league_format before insert or update of league_id,starters_per_side,max_substitutes
  on public.real_matches for each row execute function ff_private.enforce_league_match_format();

-- Least-privilege ownership and client-callable surface. No direct table DML is granted.
do $$begin
  if exists(select 1 from pg_roles where rolname='ff_migration_owner') then
    alter function ff_private.squad_format_rules(text) owner to ff_migration_owner;
    alter function ff_private.derived_formation(text,integer,integer,integer,integer) owner to ff_migration_owner;
    alter function ff_private.track_squad_roster_change() owner to ff_migration_owner;
    alter function ff_private.persist_gameweek_lineup(uuid,uuid,uuid,text,uuid[],uuid,uuid) owner to ff_migration_owner;
    alter function ff_private.enforce_league_match_format() owner to ff_migration_owner;
    alter function public.ff_league_create(text,numeric,text) owner to ff_migration_owner;
    alter function public.ff_bootstrap(text) owner to ff_migration_owner;
    alter function public.ff_squad(uuid) owner to ff_migration_owner;
    alter function public.ff_squad_purchase(uuid,uuid,smallint) owner to ff_migration_owner;
    alter function public.ff_squad_buy(uuid,uuid) owner to ff_migration_owner;
    alter function public.ff_squad_save_assignments(uuid,uuid[],uuid[],uuid[],uuid,uuid,uuid,integer) owner to ff_migration_owner;
    alter function public.ff_squad_substitute(uuid,uuid,uuid,integer) owner to ff_migration_owner;
    alter function public.ff_squad_set_captains(uuid,uuid,uuid) owner to ff_migration_owner;
    alter function public.ff_lineup_save(uuid,uuid,text,uuid[],uuid,uuid) owner to ff_migration_owner;
  end if;
end$$;
revoke all on function ff_private.squad_format_rules(text) from public,anon,authenticated;
revoke all on function ff_private.derived_formation(text,integer,integer,integer,integer) from public,anon,authenticated;
revoke all on function ff_private.track_squad_roster_change() from public,anon,authenticated;
revoke all on function ff_private.persist_gameweek_lineup(uuid,uuid,uuid,text,uuid[],uuid,uuid) from public,anon,authenticated;
revoke all on function ff_private.enforce_league_match_format() from public,anon,authenticated;
revoke all on function public.ff_league_create(text,numeric,text) from public,anon,authenticated;
revoke all on function public.ff_squad_purchase(uuid,uuid,smallint) from public,anon,authenticated;
revoke all on function public.ff_squad_save_assignments(uuid,uuid[],uuid[],uuid[],uuid,uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.ff_squad_substitute(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.ff_league_create(text,numeric,text) to authenticated;
grant execute on function public.ff_squad_purchase(uuid,uuid,smallint) to authenticated;
grant execute on function public.ff_squad_save_assignments(uuid,uuid[],uuid[],uuid[],uuid,uuid,uuid,integer) to authenticated;
grant execute on function public.ff_squad_substitute(uuid,uuid,uuid,integer) to authenticated;

commit;
