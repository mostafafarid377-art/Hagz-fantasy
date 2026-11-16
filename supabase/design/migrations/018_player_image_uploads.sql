-- Forward-only image upload authorization. Storage policies are installed separately
-- by the owner of storage.objects; see design/storage/018_image_write_owner_step.sql.
-- A reservation binds one unpredictable object name to one authorized actor and
-- target. No client can directly modify this table.
create table ff_private.image_upload_reservations (
  object_name text primary key,
  league_id uuid not null,
  actor_id uuid not null,
  target_kind text not null check (target_kind in ('player', 'suggestion')),
  target_id uuid not null,
  state text not null default 'staged' check (state in ('staged','bound','retired')),
  expires_at timestamptz not null default now() + interval '1 hour'
);
alter table ff_private.image_upload_reservations owner to ff_migration_owner;
revoke all on ff_private.image_upload_reservations from public, anon, authenticated;

create function ff_private.image_target_allowed(p_league uuid, p_kind text, p_target uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, ff_private as $$
  select case p_kind
    when 'player' then ff_private.is_leader(p_league) and exists (
      select 1 from public.player_profiles p join public.league_players lp
        on lp.league_id = p.league_id and lp.player_id = p.id
      where p.league_id = p_league and p.id = p_target)
    when 'suggestion' then ff_private.is_member(p_league) and exists (
      select 1 from public.player_suggestions s where s.league_id = p_league and s.id = p_target
        and s.status = 'pending' and s.submitted_by = ff_private.current_actor_id())
    else false end
$$;

create function public.ff_image_reserve(p_league uuid, p_kind text, p_target uuid, p_extension text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, ff_private as $$
declare v_path text;
begin
  -- Serialize a suggestion upload reservation with approval of the same row.
  -- Recheck authorization after taking the lock: approval may have won first.
  if p_kind = 'suggestion' then
    perform 1 from public.player_suggestions where league_id=p_league and id=p_target for update;
  end if;
  if not ff_private.image_target_allowed(p_league,p_kind,p_target) then
    raise exception 'Not authorized to manage this image.' using errcode='42501';
  end if;
  if p_extension not in ('jpg','jpeg','png','webp') then
    raise exception 'Unsupported image type.' using errcode='23514';
  end if;
  v_path := p_league::text || '/players/' || gen_random_uuid()::text || '.' || p_extension;
  insert into ff_private.image_upload_reservations(object_name, league_id, actor_id, target_kind, target_id)
  values (v_path,p_league,ff_private.current_actor_id(),p_kind,p_target);
  return jsonb_build_object('path',v_path);
end $$;

-- This helper is used only by the owner-assisted Storage policies. Exact path
-- equality and target authorization prevent prefix/path traversal tricks.
create function ff_private.can_write_reserved_image(p_name text, p_action text) returns boolean
language sql stable security definer set search_path = pg_catalog, ff_private as $$
  select exists (select 1 from ff_private.image_upload_reservations r
    where r.object_name=p_name and r.actor_id=ff_private.current_actor_id() and r.expires_at > now()
      and r.object_name ~ ('^' || r.league_id::text || '/players/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$')
      and ff_private.image_target_allowed(r.league_id,r.target_kind,r.target_id)
      and case p_action
        when 'insert' then r.state = 'staged'
        when 'read' then r.state in ('staged','retired')
        when 'delete' then r.state = 'retired'
          and not exists(select 1 from public.player_profiles p where p.image_path = p_name)
          and not exists(select 1 from public.player_suggestions s where s.image_path = p_name)
        else false end)
$$;

-- Prevent existing RPCs from attaching arbitrary objects, including images from
-- another suggestion. Leader approvals may copy a pending suggestion's own image.
create function ff_private.guard_player_image_reference() returns trigger
language plpgsql security definer set search_path = pg_catalog, ff_private as $$
begin
  if new.image_path is null or (tg_op = 'UPDATE' and new.image_path is not distinct from old.image_path) then return new; end if;
  if tg_table_name='player_suggestions' then
    if tg_op = 'INSERT' or not exists (select 1 from ff_private.image_upload_reservations r
      where r.object_name=new.image_path and r.league_id=new.league_id and r.target_kind='suggestion'
        and r.target_id=new.id and r.actor_id=ff_private.current_actor_id() and r.state='staged' and r.expires_at > now()) then
      raise exception 'Image is not reserved for this suggestion.' using errcode='42501';
    end if;
  elsif not exists (select 1 from ff_private.image_upload_reservations r
      where r.object_name=new.image_path and r.league_id=new.league_id and r.target_kind='player'
        and r.target_id=new.id and r.actor_id=ff_private.current_actor_id() and r.state='staged' and r.expires_at > now())
    and not (ff_private.is_leader(new.league_id) and exists (
      select 1 from public.player_suggestions s
      join public.league_players lp on lp.id=s.league_player_id and lp.league_id=s.league_id
      where s.league_id=new.league_id and s.status='approved' and s.image_path=new.image_path
        and lp.player_id=new.id)) then
    raise exception 'Image is not reserved for this player.' using errcode='42501';
  end if;
  return new;
end $$;
create trigger image_reference_guard before insert or update of image_path on public.player_profiles
for each row execute function ff_private.guard_player_image_reference();
create trigger image_reference_guard before insert or update of image_path on public.player_suggestions
for each row execute function ff_private.guard_player_image_reference();

-- Cancel an unbound reservation without deleting bytes. The shared row lock
-- ensures approval or attachment cannot race a cancellation for a suggestion.
create function public.ff_image_cancel(p_league uuid, p_kind text, p_target uuid, p_path text)
returns void language plpgsql security definer set search_path = pg_catalog, ff_private as $$
begin
  if p_kind='suggestion' then
    perform 1 from public.player_suggestions where league_id=p_league and id=p_target for update;
  elsif p_kind='player' then
    perform 1 from public.player_profiles where league_id=p_league and id=p_target for update;
  else
    raise exception 'Invalid image target.' using errcode='42501';
  end if;
  if not ff_private.image_target_allowed(p_league,p_kind,p_target) then
    raise exception 'Not authorized to manage this image.' using errcode='42501';
  end if;
  update ff_private.image_upload_reservations set state='retired', expires_at=clock_timestamp()+interval '1 hour'
    where object_name=p_path and league_id=p_league and target_kind=p_kind and target_id=p_target
      and actor_id=ff_private.current_actor_id() and state='staged';
  if not found then raise exception 'Reservation is no longer staged.' using errcode='23514'; end if;
end $$;
alter function public.ff_image_cancel(uuid,text,uuid,text) owner to ff_migration_owner;
revoke all on function public.ff_image_cancel(uuid,text,uuid,text) from public,anon;
grant execute on function public.ff_image_cancel(uuid,text,uuid,text) to authenticated;

-- Compare-and-swap protects concurrent edits from silently replacing each other.
-- A NULL path explicitly removes the picture; it never deletes referenced objects.
create function public.ff_image_set(p_league uuid, p_kind text, p_target uuid, p_expected text, p_path text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, ff_private as $$
declare v_old text; v_exists boolean;
begin
  if not ff_private.image_target_allowed(p_league,p_kind,p_target) then
    raise exception 'Not authorized to manage this image.' using errcode='42501';
  end if;
  if p_kind='player' then
    select image_path into v_old from public.player_profiles where league_id=p_league and id=p_target for update;
  else
    select image_path into v_old from public.player_suggestions where league_id=p_league and id=p_target and status='pending' and submitted_by=ff_private.current_actor_id() for update;
  end if;
  if not found then raise exception 'Image target no longer exists.' using errcode='23514'; end if;
  if v_old is distinct from p_expected then raise exception 'Image changed elsewhere; reload and try again.' using errcode='40001'; end if;
  if p_path is not null and not exists(select 1 from ff_private.image_upload_reservations r
    where r.object_name=p_path and r.league_id=p_league and r.target_kind=p_kind and r.target_id=p_target
      and r.actor_id=ff_private.current_actor_id() and r.state='staged' and r.expires_at > now()) then
    raise exception 'Invalid image reservation.' using errcode='42501';
  end if;
  if p_path is not null then
    -- The owner-assisted step supplies a narrowly scoped existence check; until
    -- installed this operation fails closed instead of saving a broken path.
    begin
      execute 'select storage.ff_player_image_exists($1)' into v_exists using p_path;
    exception when undefined_function then
      raise exception 'Image storage owner setup is not installed.' using errcode='55000';
    end;
    if not coalesce(v_exists,false) then raise exception 'Image upload not found.' using errcode='23514'; end if;
  end if;
  if p_kind='player' then
    update public.player_profiles set image_path=p_path, image_url=null where league_id=p_league and id=p_target;
  else
    update public.player_suggestions set image_path=p_path, image_url=null where league_id=p_league and id=p_target;
  end if;
  update ff_private.image_upload_reservations set state='bound' where object_name=p_path;
  update ff_private.image_upload_reservations set state='retired', expires_at=now()+interval '1 hour'
    where object_name=v_old and actor_id=ff_private.current_actor_id() and object_name is distinct from p_path;
  perform ff_private.audit(p_league,'image_updated',case when p_kind='player' then 'player_profile' else 'player_suggestion' end,p_target,
    jsonb_build_object('removed',p_path is null));
  return jsonb_build_object('path',p_path,'previous_path',v_old);
end $$;

alter function ff_private.image_target_allowed(uuid,text,uuid) owner to ff_migration_owner;
alter function ff_private.can_write_reserved_image(text,text) owner to ff_migration_owner;
alter function ff_private.guard_player_image_reference() owner to ff_migration_owner;
alter function public.ff_image_reserve(uuid,text,uuid,text) owner to ff_migration_owner;
alter function public.ff_image_set(uuid,text,uuid,text,text) owner to ff_migration_owner;
revoke all on function ff_private.image_target_allowed(uuid,text,uuid), ff_private.can_write_reserved_image(text,text), ff_private.guard_player_image_reference() from public,anon,authenticated;
grant execute on function ff_private.can_write_reserved_image(text,text) to authenticated;
revoke all on function public.ff_image_reserve(uuid,text,uuid,text), public.ff_image_set(uuid,text,uuid,text,text) from public,anon;
grant execute on function public.ff_image_reserve(uuid,text,uuid,text), public.ff_image_set(uuid,text,uuid,text,text) to authenticated;

-- Publish a suggestion image only after linking the exact approved suggestion
-- to its new player inside this transaction; intermediate rows are not visible.
create or replace function public.ff_suggestion_review(
  p_league uuid, p_suggestion uuid, p_decision text, p_reason text default null,
  p_price numeric default null, p_rating integer default null, p_image_path text default null)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, ff_private as $$
declare s public.player_suggestions; v_profile public.player_profiles; v_market public.league_players;
begin
  perform ff_private.require_leader(p_league);
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected' using errcode = '23514';
  end if;
  select * into s from public.player_suggestions
   where league_id = p_league and id = p_suggestion for update;
  if not found then raise exception 'suggestion not found' using errcode = '42501'; end if;
  if s.status <> 'pending' then raise exception 'suggestion was already reviewed' using errcode = '23514'; end if;
  -- A leader may not approve their own suggestion: the manager's proposal must
  -- be reviewed by someone else, matching the self-approval ban on matches.
  if s.submitted_by = ff_private.current_actor_id() then
    raise exception 'self review of a suggestion is forbidden' using errcode = '42501';
  end if;

  if p_decision = 'rejected' then
    if p_reason is null or length(btrim(p_reason)) = 0 then
      raise exception 'rejection needs a reason' using errcode = '23514';
    end if;
    update public.player_suggestions set status = 'rejected' where league_id = p_league and id = s.id;
    insert into public.player_approval_logs(league_id, suggestion_id, actor_id, decision, reason)
    values (p_league, s.id, ff_private.current_actor_id(), 'rejected', btrim(p_reason));
    perform ff_private.notify(p_league, s.submitted_by, 'suggestion_rejected',
      jsonb_build_object('suggestion_id', s.id, 'name', s.name, 'league_id', p_league, 'reason', btrim(p_reason)));
    perform ff_private.audit(p_league, 'suggestion_rejected', 'player_suggestion', s.id,
      null, btrim(p_reason));
    return jsonb_build_object('id', s.id, 'status', 'rejected', 'reason', btrim(p_reason));
  end if;

  -- An author may be replacing the pending image. Never publish the prior
  -- image while that replacement is still capable of being attached.
  if exists (select 1 from ff_private.image_upload_reservations r
      where r.league_id=p_league and r.target_kind='suggestion' and r.target_id=s.id
        and r.state='staged' and r.expires_at > clock_timestamp()) then
    raise exception 'Suggestion image upload is in progress; retry after it finishes.' using errcode='40001';
  end if;

  if p_price is null or p_price <= 0 then raise exception 'approved player needs a positive price' using errcode = '23514'; end if;
  if p_rating is null or p_rating < 1 or p_rating > 99 then raise exception 'approved player needs a rating between 1 and 99' using errcode = '23514'; end if;

  -- A review cannot select the image of a different suggestion.
  if p_image_path is not null and p_image_path <> '__remove__' and p_image_path is distinct from s.image_path then
    raise exception 'Image does not belong to this suggestion.' using errcode='42501';
  end if;
  insert into public.player_profiles(league_id, display_name, image_path, image_url)
  values (p_league, s.name, null, case when p_image_path = '__remove__' then null else s.image_url end)
  returning * into v_profile;
  insert into public.league_players(league_id, player_id, position, price, rating, active)
  values (p_league, v_profile.id, s.position, p_price, p_rating, true)
  returning * into v_market;

  update public.player_suggestions
     set status = 'approved', league_player_id = v_market.id
   where league_id = p_league and id = s.id;
  -- The guard permits only the exact profile linked by this approved suggestion.
  update public.player_profiles set image_path=case when p_image_path = '__remove__' then null else s.image_path end where league_id=p_league and id=v_profile.id;
  insert into public.player_approval_logs(league_id, suggestion_id, actor_id, decision, reason)
  values (p_league, s.id, ff_private.current_actor_id(), 'approved', nullif(btrim(coalesce(p_reason, '')), ''));

  perform ff_private.notify(p_league, s.submitted_by, 'suggestion_approved',
    jsonb_build_object('suggestion_id', s.id, 'name', s.name, 'league_id', p_league,
                       'league_player_id', v_market.id, 'price', p_price, 'rating', p_rating));
  perform ff_private.audit(p_league, 'suggestion_approved', 'player_suggestion', s.id,
    jsonb_build_object('league_player_id', v_market.id, 'price', p_price, 'rating', p_rating));
  return jsonb_build_object('id', s.id, 'status', 'approved', 'league_player_id', v_market.id,
                            'price', v_market.price, 'rating', v_market.rating);
end $$;
