-- Local transition migration: receipt-backed operations are additive.
-- Legacy RPCs intentionally remain callable until a separately approved cutover.
-- This migration does not make different operation IDs denote the same intent.
begin;

create table ff_private.operation_receipts (
  actor_id uuid not null,
  operation_id uuid not null,
  kind text,
  payload jsonb,
  state text not null check (state in ('registered', 'committed', 'cancelled')),
  result jsonb,
  created_at timestamptz not null default now(),
  primary key (actor_id, operation_id),
  check ((state = 'cancelled') or (kind is not null and payload is not null)),
  check ((state = 'committed') = (result is not null))
);
revoke all on ff_private.operation_receipts from public, anon, authenticated;
grant select, insert, update on ff_private.operation_receipts to ff_migration_owner;

-- Register commits independently of execution. A cancellation tombstone wins
-- against a late registration and prevents an abandoned request from executing.
create function public.ff_operation_register(p_operation uuid, p_kind text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare actor uuid := ff_private.current_actor_id(); r ff_private.operation_receipts;
begin
  if actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  if p_operation is null or p_kind is null or p_kind not in
    ('league_create','league_create_format','squad_buy','squad_sell','squad_transfer','squad_captains','squad_substitute','squad_assignments','lineup_save','lineup_confirm')
    or p_payload is null or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text)>16384 then
    raise exception 'invalid operation' using errcode='23514';
  end if;
  if p_kind not in ('league_create','league_create_format') then
    perform ff_private.require_member((p_payload->>'league')::uuid);
  end if;
  insert into ff_private.operation_receipts(actor_id,operation_id,kind,payload,state)
    values(actor,p_operation,p_kind,p_payload,'registered') on conflict do nothing;
  select * into r from ff_private.operation_receipts where actor_id=actor and operation_id=p_operation for update;
  if r.state='cancelled' then return jsonb_build_object('state','cancelled'); end if;
  if r.kind is distinct from p_kind or r.payload is distinct from p_payload then
    raise exception 'operation ID was already used with different arguments' using errcode='23514';
  end if;
  return jsonb_build_object('state',case when r.state='committed' then 'committed' else 'pending' end);
end $$;

-- Executions for a given actor/ID serialize on its receipt. The underlying
-- domain function and the completed receipt commit in one transaction. An SQL
-- error aborts the whole execution transaction and leaves the registration.
create function public.ff_operation_execute(p_operation uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare actor uuid := ff_private.current_actor_id(); r ff_private.operation_receipts; v_result jsonb; league uuid;
begin
  if actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  select * into r from ff_private.operation_receipts where actor_id=actor and operation_id=p_operation for update;
  if not found then return jsonb_build_object('state','unknown'); end if;
  if r.state='cancelled' then return jsonb_build_object('state','cancelled'); end if;
  if r.kind not in ('league_create','league_create_format') then
    league := (r.payload->>'league')::uuid;
    perform ff_private.require_member(league);
  elsif r.state='committed' then
    perform ff_private.require_member((r.result->>'id')::uuid);
  end if;
  if r.state='committed' then return jsonb_build_object('state','committed','result',r.result); end if;
  case r.kind
    when 'league_create' then v_result := public.ff_league_create(r.payload->>'name',(r.payload->>'budget')::numeric);
    when 'league_create_format' then v_result := public.ff_league_create(r.payload->>'name',(r.payload->>'budget')::numeric,r.payload->>'format');
    when 'squad_buy' then v_result := public.ff_squad_buy(league,(r.payload->>'player')::uuid);
    when 'squad_sell' then v_result := public.ff_squad_sell(league,(r.payload->>'player')::uuid);
    when 'squad_transfer' then v_result := public.ff_squad_transfer(league,(r.payload->>'out')::uuid,(r.payload->>'in')::uuid);
    when 'squad_captains' then v_result := public.ff_squad_set_captains(league,(r.payload->>'captain')::uuid,(r.payload->>'vice')::uuid);
    when 'squad_substitute' then v_result := public.ff_squad_substitute(league,(r.payload->>'out')::uuid,(r.payload->>'in')::uuid,(r.payload->>'expected_revision')::integer);
    when 'squad_assignments' then v_result := public.ff_squad_save_assignments(league,
      array(select jsonb_array_elements_text(r.payload->'starters')::uuid),
      array(select jsonb_array_elements_text(r.payload->'bench')::uuid),
      array(select jsonb_array_elements_text(r.payload->'unassigned')::uuid),
      (r.payload->>'captain')::uuid,(r.payload->>'vice')::uuid,(r.payload->>'gameweek')::uuid,(r.payload->>'expected_revision')::integer);
    when 'lineup_save' then v_result := public.ff_lineup_save(league,(r.payload->>'gameweek')::uuid,r.payload->>'formation',
      array(select jsonb_array_elements_text(r.payload->'players')::uuid),(r.payload->>'captain')::uuid,(r.payload->>'vice')::uuid);
    when 'lineup_confirm' then v_result := public.ff_lineup_confirm(league,(r.payload->>'lineup')::uuid);
    else raise exception 'invalid operation' using errcode='23514';
  end case;
  update ff_private.operation_receipts set state='committed',result=v_result
    where actor_id=actor and operation_id=p_operation;
  return jsonb_build_object('state','committed','result',v_result);
end $$;

-- An absent receipt is UNKNOWN, never proof of rollback or non-arrival.
-- A plain status read deliberately returns pending even if execution is in
-- progress, because an uncommitted receipt update is invisible to this snapshot.
create function public.ff_operation_status(p_operation uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare actor uuid := ff_private.current_actor_id(); r ff_private.operation_receipts;
begin
  if actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  select * into r from ff_private.operation_receipts where actor_id=actor and operation_id=p_operation;
  if not found then return jsonb_build_object('state','unknown'); end if;
  if r.state='cancelled' then return jsonb_build_object('state','cancelled'); end if;
  if r.kind not in ('league_create','league_create_format') then perform ff_private.require_member((r.payload->>'league')::uuid);
  elsif r.state='committed' then perform ff_private.require_member((r.result->>'id')::uuid); end if;
  if r.state='committed' then return jsonb_build_object('state','committed','result',r.result); end if;
  return jsonb_build_object('state','pending');
end $$;

-- Cancellation is serialized with registration/execution, including the missing
-- row case. A delayed registration cannot overwrite this permanent tombstone.
create function public.ff_operation_cancel(p_operation uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare actor uuid := ff_private.current_actor_id(); r ff_private.operation_receipts;
begin
  if actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  if p_operation is null then raise exception 'invalid operation' using errcode='23514'; end if;
  insert into ff_private.operation_receipts(actor_id,operation_id,state)
    values(actor,p_operation,'cancelled') on conflict do nothing;
  select * into r from ff_private.operation_receipts where actor_id=actor and operation_id=p_operation for update;
  if r.state='committed' then
    if r.kind in ('league_create','league_create_format') then perform ff_private.require_member((r.result->>'id')::uuid);
    else perform ff_private.require_member((r.payload->>'league')::uuid); end if;
    return jsonb_build_object('state','committed','result',r.result);
  end if;
  update ff_private.operation_receipts set state='cancelled' where actor_id=actor and operation_id=p_operation;
  return jsonb_build_object('state','cancelled');
end $$;

-- Bind a multi-request browser operation to the account that initiated it.
-- The supplied ID is NOT an authorization identity: it must equal the actor
-- derived from the request JWT at the instant the database receives the call.
create function public.ff_operation_for_actor(p_actor uuid, p_action text, p_operation uuid,
  p_kind text default null, p_payload jsonb default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,ff_private as $$
begin
  if p_actor is null or ff_private.current_actor_id() is distinct from p_actor then
    raise exception 'account changed' using errcode='42501';
  end if;
  case p_action
    when 'register' then return public.ff_operation_register(p_operation,p_kind,p_payload);
    when 'execute' then return public.ff_operation_execute(p_operation);
    when 'status' then return public.ff_operation_status(p_operation);
    when 'cancel' then return public.ff_operation_cancel(p_operation);
    else raise exception 'invalid operation action' using errcode='23514';
  end case;
end $$;
revoke all on function public.ff_operation_for_actor(uuid,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.ff_operation_for_actor(uuid,text,uuid,text,jsonb) to authenticated;
alter function public.ff_operation_for_actor(uuid,text,uuid,text,jsonb) owner to ff_migration_owner;

revoke all on function public.ff_operation_register(uuid,text,jsonb), public.ff_operation_execute(uuid),
  public.ff_operation_status(uuid), public.ff_operation_cancel(uuid) from public,anon,authenticated;
grant execute on function public.ff_operation_register(uuid,text,jsonb), public.ff_operation_execute(uuid),
  public.ff_operation_status(uuid), public.ff_operation_cancel(uuid) to authenticated;
alter function public.ff_operation_register(uuid,text,jsonb) owner to ff_migration_owner;
alter function public.ff_operation_execute(uuid) owner to ff_migration_owner;
alter function public.ff_operation_status(uuid) owner to ff_migration_owner;
alter function public.ff_operation_cancel(uuid) owner to ff_migration_owner;
commit;
