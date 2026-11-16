-- Phase 4 forward-only match workflow repair.
-- The assigned active Organizer and the active League Leader can manage the
-- same match. Lineup review remains available for Organizer submissions, while
-- Leader-authored lineups self-approve. Result submissions by either authorized
-- actor finalize immediately; immutable submission/approval facts are retained
-- as the audit provenance expected by the existing official-result/points path.

begin;

-- Persist explicit finalizer identity/time on the official pointer. Existing
-- official results are backfilled from their immutable approval facts.
alter table public.official_match_results
  add column finalized_by uuid,
  add column finalized_at timestamptz;
update public.official_match_results o
   set finalized_by = a.reviewed_by,
       finalized_at = a.reviewed_at
  from public.match_approvals a
 where a.league_id = o.league_id and a.id = o.approval_id;
alter table public.official_match_results
  alter column finalized_by set not null,
  alter column finalized_at set not null;
alter table public.official_match_results
  add constraint official_result_finalizer_fk
  foreign key (league_id, finalized_by)
  references public.league_members(league_id, user_id) on delete restrict;

-- Keep the established match-first lock order, and allow either the assigned
-- active Organizer or an active Leader in this exact league/match scope.
create or replace function ff_private.require_organizer(p_league uuid, p_match uuid) returns void
language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare assigned_organizer uuid;
begin
  perform ff_private.require_read_committed();
  if ff_private.current_actor_id() is null then
    raise exception 'not an active match manager' using errcode='42501';
  end if;
  select m.organizer_id into assigned_organizer
    from public.real_matches m
   where m.league_id=p_league and m.id=p_match
   for update;
  if not found then
    raise exception 'not an active match manager' using errcode='42501';
  end if;

  if ff_private.is_leader(p_league) then
    perform 1 from public.league_members lm
     where lm.league_id=p_league and lm.user_id=ff_private.current_actor_id()
       and lm.role='leader' and lm.status='active'
     for share;
    if found then return; end if;
  end if;

  if assigned_organizer=ff_private.current_actor_id() then
    perform 1 from public.league_members lm
     where lm.league_id=p_league and lm.user_id=ff_private.current_actor_id() and lm.status='active'
     for share;
    if found then
      perform 1 from public.match_organizers o
       where o.league_id=p_league and o.user_id=ff_private.current_actor_id()
       for share;
      if found then return; end if;
    end if;
  end if;
  raise exception 'not an active Organizer assigned to this match or League Leader'
    using errcode='42501';
end $$;

-- A correction is an editable draft, not a replacement of the official pointer.
-- Keep the existing result and any derived scoring current until the corrected
-- result is submitted and finalized in one transaction.
create or replace function ff_private.after_correction() returns trigger
language plpgsql security definer set search_path=pg_catalog,ff_private as $$
begin
  insert into public.audit_logs(league_id,actor_id,action,entity_type,entity_id,reason,before_data,after_data)
  values(new.league_id,new.actor_id,'correction_opened','match',new.match_id,new.reason,
    jsonb_build_object('official_result',new.official_result_id,'revision',new.previous_revision_id),
    jsonb_build_object('correction',new.id,'draft_revision',new.draft_revision_id,
                       'official_result_remains_current_until_finalization',true));
  return new;
end $$;

create or replace function ff_private.validate_correction() returns trigger
language plpgsql security definer set search_path=pg_catalog,ff_private as $$
begin
  perform ff_private.require_read_committed();
  perform ff_private.require_organizer(new.league_id,new.match_id);
  if new.actor_id is distinct from ff_private.current_actor_id() then
    raise exception 'invalid correction actor' using errcode='42501';
  end if;
  if new.reason is null or length(btrim(new.reason))=0 then
    raise exception 'correction requires a reason' using errcode='23514';
  end if;
  if not exists(
    select 1 from public.official_match_results o
    join public.match_revisions v on v.league_id=o.league_id and v.match_id=o.match_id and v.id=new.draft_revision_id
    where o.league_id=new.league_id and o.match_id=new.match_id
      and o.id=new.official_result_id and o.revision_id=new.previous_revision_id and o.is_current
      and v.corrects_revision_id=o.revision_id and v.state='draft'
  ) then
    raise exception 'correction requires a draft of the current official result' using errcode='23514';
  end if;
  return new;
end $$;

create or replace function ff_private.open_correction(p_league uuid,p_match uuid,p_reason text) returns uuid
language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare official public.official_match_results%rowtype; next_rev uuid; next_ver integer; old_lineup record; next_lineup uuid;
begin
  if p_reason is null or length(btrim(p_reason))=0 then
    raise exception 'correction requires a reason' using errcode='23514';
  end if;
  perform 1 from public.real_matches where league_id=p_league and id=p_match for update;
  perform ff_private.require_organizer(p_league,p_match);
  select * into official from public.official_match_results
   where league_id=p_league and match_id=p_match and is_current for update;
  if not found then raise exception 'current official result required' using errcode='23514'; end if;
  select coalesce(max(version),0)+1 into next_ver from public.match_revisions
   where league_id=p_league and match_id=p_match;
  insert into public.match_revisions(league_id,match_id,version,match_snapshot,corrects_revision_id)
  select p_league,p_match,next_ver,match_snapshot,id
    from public.match_revisions where league_id=p_league and id=official.revision_id
  returning id into next_rev;
  for old_lineup in select * from public.real_match_lineups
    where league_id=p_league and revision_id=official.revision_id loop
    insert into public.real_match_lineups(league_id,match_id,revision_id,team_id)
    values(p_league,p_match,next_rev,old_lineup.team_id) returning id into next_lineup;
    insert into public.real_match_lineup_players(league_id,revision_id,lineup_id,player_id,selection,
      actual_position,eligibility_kind,eligibility_evidence)
    select league_id,next_rev,next_lineup,player_id,selection,actual_position,eligibility_kind,eligibility_evidence
      from public.real_match_lineup_players where league_id=p_league and lineup_id=old_lineup.id;
  end loop;
  insert into public.match_corrections(league_id,match_id,official_result_id,previous_revision_id,
    draft_revision_id,actor_id,reason)
  values(p_league,p_match,official.id,official.revision_id,next_rev,ff_private.current_actor_id(),btrim(p_reason));
  return next_rev;
end $$;

-- Let correction lineups be submitted while the previous official pointer stays
-- current. Only the latest persisted correction attempt can proceed.
create or replace function ff_private.guard_submission_generation() returns trigger
language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare corrected uuid; source_revision uuid;
begin
  perform ff_private.require_read_committed();
  if new.kind='lineup' then
    select a.draft_revision_id into corrected
      from public.match_correction_attempts a
      join public.match_revisions v on v.league_id=a.league_id and v.id=a.draft_revision_id
     where a.league_id=new.league_id and a.match_id=new.match_id
     order by v.version desc limit 1;
    if exists(select 1 from public.official_match_results o
       where o.league_id=new.league_id and o.match_id=new.match_id and o.is_current)
       and corrected is null then
      raise exception 'official result requires a correction before a new lineup' using errcode='23514';
    end if;
    if corrected is not null and corrected<>new.revision_id then
      raise exception 'stale lineup submission after correction' using errcode='23514';
    end if;
  else
    select a.revision_id into source_revision from public.match_approvals a
     where a.league_id=new.league_id and a.match_id=new.match_id
       and a.id=new.approved_lineup_approval_id and a.kind='lineup' and a.decision='approved';
    perform ff_private.require_current_lineup(new.league_id,new.match_id,source_revision);
  end if;
  return new;
end $$;

-- Lineups remain Leader-reviewable when submitted by an Organizer. A Leader's
-- own lineup is approved atomically by ff_match_submit_lineup. Results may only
-- be approved as part of their own authorized submission, never by a later
-- Leader-review RPC.
create or replace function ff_private.validate_approval() returns trigger
language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare sub public.match_submissions%rowtype; source_revision uuid; corrected uuid;
begin
  perform ff_private.require_read_committed();
  perform 1 from public.real_matches where league_id=new.league_id and id=new.match_id for update;
  if not found then raise exception 'match not found' using errcode='23514'; end if;
  if new.reviewed_by is distinct from ff_private.current_actor_id() then raise exception 'invalid reviewer' using errcode='42501'; end if;
  select * into sub from public.match_submissions
   where league_id=new.league_id and id=new.submission_id and match_id=new.match_id
     and revision_id=new.revision_id and kind=new.kind;
  if not found or not exists(select 1 from public.match_revisions
    where league_id=new.league_id and match_id=new.match_id and id=new.revision_id and state='submitted') then
    raise exception 'submission is not awaiting processing' using errcode='23514';
  end if;

  if new.kind='result' then
    if new.decision<>'approved' then
      raise exception 'results may only be finalized, never reviewed or rejected' using errcode='42501';
    end if;
    if sub.submitted_by is distinct from ff_private.current_actor_id() then
      perform ff_private.require_leader(new.league_id);
    else
      perform ff_private.require_organizer(new.league_id,new.match_id);
    end if;
    select a.revision_id into source_revision from public.match_approvals a
      join public.match_revisions r on r.league_id=a.league_id and r.match_id=a.match_id and r.id=a.revision_id
     where a.league_id=new.league_id and a.match_id=new.match_id
       and a.id=sub.approved_lineup_approval_id and a.kind='lineup'
       and a.decision='approved' and r.state='approved';
    if source_revision is null then raise exception 'approved lineup lineage required' using errcode='23514'; end if;
    perform ff_private.require_current_lineup(new.league_id,new.match_id,source_revision);
    return new;
  end if;

  if sub.submitted_by=ff_private.current_actor_id() then
    if new.decision<>'approved' or not ff_private.is_leader(new.league_id) then
      raise exception 'only a Leader may self-approve their own lineup submission' using errcode='42501';
    end if;
    perform ff_private.require_organizer(new.league_id,new.match_id);
  else
    perform ff_private.require_leader(new.league_id);
  end if;
  if exists(select 1 from public.match_submissions newer
    join public.match_revisions nr on nr.league_id=newer.league_id and nr.match_id=newer.match_id and nr.id=newer.revision_id
    join public.match_revisions cur on cur.league_id=sub.league_id and cur.match_id=sub.match_id and cur.id=sub.revision_id
    where newer.league_id=sub.league_id and newer.match_id=sub.match_id and newer.kind=sub.kind and nr.version>cur.version) then
    raise exception 'submission superseded by newer revision' using errcode='23514';
  end if;
  select a.draft_revision_id into corrected
    from public.match_correction_attempts a
    join public.match_revisions r on r.league_id=a.league_id and r.id=a.draft_revision_id
   where a.league_id=new.league_id and a.match_id=new.match_id
   order by r.version desc limit 1;
  if exists(select 1 from public.official_match_results o
      where o.league_id=new.league_id and o.match_id=new.match_id and o.is_current)
      and (corrected is null or corrected<>new.revision_id) then
    raise exception 'an official result can only be changed through its latest correction' using errcode='23514';
  end if;
  if new.decision='rejected' and (new.reason is null or length(btrim(new.reason))=0) then
    raise exception 'rejection needs a reason' using errcode='23514';
  end if;
  return new;
end $$;

-- Defense in depth for official publication. The approval row is generated by
-- the submitter's RPC, and the official row carries the same actor/time as its
-- finalization audit metadata.
create or replace function ff_private.guard_official_result() returns trigger
language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare lineup_rev uuid;
begin
  perform ff_private.require_read_committed();
  if tg_op='DELETE' then raise exception 'official result is historical' using errcode='23514'; end if;
  if tg_op='INSERT' then
    perform 1 from public.real_matches where league_id=new.league_id and id=new.match_id for update;
    select la.revision_id into lineup_rev
      from public.match_approvals a
      join public.match_revisions r on r.league_id=a.league_id and r.match_id=a.match_id and r.id=a.revision_id
      join public.match_submissions s on s.league_id=a.league_id and s.match_id=a.match_id
        and s.id=a.submission_id and s.revision_id=a.revision_id and s.kind=a.kind
      join public.match_approvals la on la.league_id=s.league_id and la.match_id=s.match_id
        and la.id=s.approved_lineup_approval_id and la.kind='lineup' and la.decision='approved'
      join public.match_revisions lr on lr.league_id=la.league_id and lr.match_id=la.match_id
        and lr.id=la.revision_id and lr.state='approved'
     where a.league_id=new.league_id and a.match_id=new.match_id and a.revision_id=new.revision_id
       and a.id=new.approval_id and a.kind='result' and a.decision='approved' and r.state='approved'
       and new.finalized_by=a.reviewed_by and new.finalized_at=a.reviewed_at;
    if not new.is_current or lineup_rev is null then
      raise exception 'official result requires a complete finalized result and approved lineup' using errcode='23514';
    end if;
    perform ff_private.require_current_lineup(new.league_id,new.match_id,lineup_rev);
    return new;
  end if;
  perform ff_private.require_organizer(old.league_id,old.match_id);
  if not exists(select 1 from public.match_corrections c
    where c.league_id=old.league_id and c.match_id=old.match_id and c.official_result_id=old.id) then
    raise exception 'correction record required to supersede result' using errcode='23514';
  end if;
  if not old.is_current or new.is_current or
    (new.id,new.league_id,new.match_id,new.revision_id,new.approval_id,new.decision,new.kind,
     new.finalized_by,new.finalized_at)
    is distinct from
    (old.id,old.league_id,old.match_id,old.revision_id,old.approval_id,old.decision,old.kind,
     old.finalized_by,old.finalized_at) then
    raise exception 'official result may only be superseded' using errcode='23514';
  end if;
  return new;
end $$;

create or replace function ff_private.after_approval() returns trigger
language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare previous public.official_match_results%rowtype; source_revision uuid; affected uuid[];
begin
  update public.match_revisions set state=new.decision
   where league_id=new.league_id and id=new.revision_id;

  if new.kind='result' and new.decision='approved' then
    select * into previous from public.official_match_results o
     where o.league_id=new.league_id and o.match_id=new.match_id and o.is_current for update;
    if found then
      select r.based_on_lineup_revision_id into source_revision
        from public.match_revisions r where r.league_id=new.league_id and r.id=new.revision_id;
      if source_revision is null or not exists(
        select 1 from public.match_corrections c
        join public.match_correction_attempts ca on ca.league_id=c.league_id and ca.correction_id=c.id
        where c.league_id=new.league_id and c.match_id=new.match_id
          and c.official_result_id=previous.id and ca.draft_revision_id=source_revision
      ) then
        raise exception 'a current official result can only be replaced by its correction revision' using errcode='23514';
      end if;
      select coalesce(array_agg(distinct run.id),'{}'::uuid[]) into affected
        from public.scoring_runs run join public.scoring_run_sources src
          on src.league_id=run.league_id and src.scoring_run_id=run.id
       where src.league_id=new.league_id and src.official_result_id=previous.id
         and run.status in ('pending','complete');
      update public.official_match_results set is_current=false
       where league_id=previous.league_id and id=previous.id and is_current;
      update public.scoring_runs set status='superseded'
       where league_id=new.league_id and id=any(affected);
      update public.league_standings st set is_stale=true
       where st.league_id=new.league_id and st.season_id in (
         select gw.season_id from public.real_matches m
         join public.gameweeks gw on gw.league_id=m.league_id and gw.id=m.gameweek_id
         where m.league_id=new.league_id and m.id=new.match_id);
    end if;
    insert into public.official_match_results(league_id,match_id,revision_id,approval_id,finalized_by,finalized_at)
    values(new.league_id,new.match_id,new.revision_id,new.id,new.reviewed_by,new.reviewed_at);
  end if;

  insert into public.audit_logs(league_id,actor_id,action,entity_type,entity_id,after_data,reason)
  values(new.league_id,ff_private.current_actor_id(),
    case when new.kind='result' and new.decision='approved' then 'finalize_result'
         else 'review_lineup' end,
    'match',new.match_id,to_jsonb(new),new.reason);
  return new;
end $$;

create or replace function ff_private.review_submission(p_league uuid,p_submission uuid,p_decision text,p_reason text default null) returns uuid
language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare s public.match_submissions%rowtype; approval uuid;
begin
  select * into s from public.match_submissions where league_id=p_league and id=p_submission;
  if not found then raise exception 'submission not found' using errcode='42501'; end if;
  perform 1 from public.real_matches where league_id=p_league and id=s.match_id for update;
  perform ff_private.require_leader(p_league);
  if s.kind<>'lineup' then
    raise exception 'result submissions finalize immediately and cannot be reviewed' using errcode='42501';
  end if;
  if s.submitted_by=ff_private.current_actor_id() then
    raise exception 'self approval is forbidden; Leader lineups are approved on submission' using errcode='42501';
  end if;
  insert into public.match_approvals(league_id,match_id,submission_id,revision_id,kind,decision,reviewed_by,reason)
  values(p_league,s.match_id,s.id,s.revision_id,s.kind,p_decision,ff_private.current_actor_id(),p_reason)
  returning id into approval;
  return approval;
end $$;

create or replace function ff_private.submit_lineup(p_league uuid,p_revision uuid) returns uuid
language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare match_id uuid; submission_id uuid;
begin
  select r.match_id into match_id from public.match_revisions r
   where r.league_id=p_league and r.id=p_revision;
  perform ff_private.require_organizer(p_league,match_id);
  insert into public.match_submissions(league_id,match_id,revision_id,kind,submitted_by)
  values(p_league,match_id,p_revision,'lineup',ff_private.current_actor_id()) returning id into submission_id;
  return submission_id;
end $$;

-- A result revision can be submitted once. A replay of the same still-pending
-- legacy submission returns its immutable submission id for safe finalization.
create or replace function ff_private.submit_result(p_league uuid,p_revision uuid,p_lineup_approval uuid) returns uuid
language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare v_match_id uuid; submission_id uuid; existing public.match_submissions%rowtype;
begin
  select r.match_id into v_match_id from public.match_revisions r
   where r.league_id=p_league and r.id=p_revision;
  perform ff_private.require_organizer(p_league,v_match_id);
  perform 1 from public.real_matches where league_id=p_league and id=v_match_id for update;
  select * into existing from public.match_submissions s
   where s.league_id=p_league and s.match_id=v_match_id and s.revision_id=p_revision and s.kind='result';
  if found then
    if existing.approved_lineup_approval_id is distinct from p_lineup_approval then
      raise exception 'result retry does not match the original lineup source' using errcode='23514';
    end if;
    return existing.id;
  end if;
  insert into public.match_submissions(league_id,match_id,revision_id,kind,approved_lineup_approval_id,
    approved_lineup_decision,approved_lineup_kind,submitted_by)
  values(p_league,v_match_id,p_revision,'result',p_lineup_approval,'approved','lineup',ff_private.current_actor_id())
  returning id into submission_id;
  return submission_id;
end $$;

create or replace function public.ff_match_submit_lineup(p_league uuid,p_revision uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare submission_id uuid; match_row public.match_revisions%rowtype; approval_id uuid;
begin
  submission_id:=ff_private.submit_lineup(p_league,p_revision);
  select * into match_row from public.match_revisions where league_id=p_league and id=p_revision;
  if ff_private.is_leader(p_league) then
    insert into public.match_approvals(league_id,match_id,submission_id,revision_id,kind,decision,reviewed_by)
    values(p_league,match_row.match_id,submission_id,p_revision,'lineup','approved',ff_private.current_actor_id())
    returning id into approval_id;
    return jsonb_build_object('submission_id',submission_id,'approval_id',approval_id,'state','approved');
  end if;
  perform ff_private.notify_leader(p_league,'lineup_submitted',
    jsonb_build_object('submission_id',submission_id,'match_id',match_row.match_id,'league_id',p_league));
  return jsonb_build_object('submission_id',submission_id,'state','submitted');
end $$;

create or replace function public.ff_match_submit_result(p_league uuid,p_revision uuid,p_lineup_approval uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare v_submission_id uuid; result_row public.official_match_results%rowtype; existing_approval public.match_approvals%rowtype;
  existing_submission public.match_submissions%rowtype; r public.match_revisions%rowtype;
  recipient record; did_finalize boolean:=false;
begin
  v_submission_id:=ff_private.submit_result(p_league,p_revision,p_lineup_approval);
  select * into existing_submission from public.match_submissions s
   where s.league_id=p_league and s.id=v_submission_id and s.kind='result';
  select * into existing_approval from public.match_approvals a
   where a.league_id=p_league and a.submission_id=v_submission_id and a.kind='result';
  if found then
    if existing_submission.submitted_by is distinct from ff_private.current_actor_id()
       and not ff_private.is_leader(p_league) then
      raise exception 'only the original submitter or League Leader may finalize this saved result' using errcode='42501';
    end if;
    select * into result_row from public.official_match_results o
     where o.league_id=p_league and o.approval_id=existing_approval.id and o.is_current;
    if not found then
      raise exception 'this result revision has already been finalized or superseded' using errcode='23514';
    end if;
  else
    select * into r from public.match_revisions where league_id=p_league and id=p_revision;
    insert into public.match_approvals(league_id,match_id,submission_id,revision_id,kind,decision,reviewed_by)
    values(p_league,r.match_id,v_submission_id,p_revision,'result','approved',ff_private.current_actor_id())
    returning * into existing_approval;
    select * into result_row from public.official_match_results o
     where o.league_id=p_league and o.approval_id=existing_approval.id and o.is_current;
    if not found then raise exception 'result finalization did not create an official result' using errcode='23514'; end if;
    did_finalize:=true;
  end if;

  if did_finalize then
    for recipient in select lm.user_id from public.league_members lm
      where lm.league_id=p_league and lm.status='active' and lm.user_id<>ff_private.current_actor_id() loop
      perform ff_private.notify(p_league,recipient.user_id,'match_finalized',
        jsonb_build_object('match_id',result_row.match_id,'official_result_id',result_row.id,
          'revision_id',result_row.revision_id,'finalized_by',result_row.finalized_by,
          'finalized_at',result_row.finalized_at,'league_id',p_league));
    end loop;
  end if;
  return jsonb_build_object('submission_id',v_submission_id,'official_result_id',result_row.id,
    'revision_id',result_row.revision_id,'state','official','finalized_by',result_row.finalized_by,
    'finalized_at',result_row.finalized_at);
end $$;

create or replace function public.ff_matches(p_league uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,ff_private as $$
begin
  perform ff_private.require_member(p_league);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',m.id,'gameweek_id',m.gameweek_id,'starts_at',m.starts_at,'venue',m.venue,
      'team_a_id',m.team_a_id,'team_a',ta.name,'team_b_id',m.team_b_id,'team_b',tb.name,
      'organizer_id',m.organizer_id,'starters_per_side',m.starters_per_side,'max_substitutes',m.max_substitutes,
      'revision_id',r.id,'revision_version',r.version,'revision_state',r.state,
      'team_a_score',official_revision.team_a_score,'team_b_score',official_revision.team_b_score,
      'is_official',(o.id is not null),'official_result_id',o.id,'official_revision_id',o.revision_id,
      'finalized_by',o.finalized_by,'finalized_at',o.finalized_at,
      'has_pending_lineup',exists(select 1 from public.match_submissions s
        where s.league_id=m.league_id and s.match_id=m.id and s.kind='lineup'
          and not exists(select 1 from public.match_approvals a where a.league_id=s.league_id and a.submission_id=s.id)),
      'has_pending_result',exists(select 1 from public.match_submissions s
        where s.league_id=m.league_id and s.match_id=m.id and s.kind='result'
          and not exists(select 1 from public.match_approvals a where a.league_id=s.league_id and a.submission_id=s.id)),
      'events',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'type',e.event_type,'minute',e.minute,
        'quantity',e.quantity,'player_id',e.player_id,'player_name',pp.display_name,
        'related_player_id',e.related_player_id) order by e.minute nulls last)
        from public.match_events e join public.player_profiles pp
          on pp.league_id=e.league_id and pp.id=e.player_id
        where e.league_id=m.league_id and e.revision_id=coalesce(o.revision_id,r.id)),'[]'::jsonb),
      'history',coalesce((select jsonb_agg(jsonb_build_object(
        'revision_id',v.id,'version',v.version,'state',v.state,'team_a_score',v.team_a_score,'team_b_score',v.team_b_score,
        'correction',(select jsonb_build_object('reason',c.reason,'actor_id',c.actor_id,'created_at',c.created_at)
          from public.match_corrections c left join public.match_correction_attempts ca
            on ca.league_id=c.league_id and ca.correction_id=c.id
          where c.league_id=v.league_id and c.match_id=v.match_id
            and (ca.draft_revision_id=v.id or ca.draft_revision_id=v.based_on_lineup_revision_id
                 or c.draft_revision_id=v.id) order by ca.attempt_no desc limit 1),
        'events',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'type',e.event_type,'minute',e.minute,
          'quantity',e.quantity,'player_id',e.player_id,'player_name',(select pp.display_name from public.player_profiles pp
            where pp.league_id=e.league_id and pp.id=e.player_id),'related_player_id',e.related_player_id)
          order by e.minute nulls last) from public.match_events e where e.league_id=v.league_id and e.revision_id=v.id),'[]'::jsonb),
        'submissions',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'kind',s.kind,'submitted_by',s.submitted_by,
          'submitted_at',s.submitted_at,'approval',(select jsonb_build_object('id',a.id,'decision',a.decision,
            'reason',a.reason,'reviewed_by',a.reviewed_by,'reviewed_at',a.reviewed_at,
            'finalized_by',case when s.kind='result' and a.decision='approved' then a.reviewed_by else null end,
            'finalized_at',case when s.kind='result' and a.decision='approved' then a.reviewed_at else null end)
            from public.match_approvals a where a.league_id=s.league_id and a.submission_id=s.id)) order by s.submitted_at)
          from public.match_submissions s where s.league_id=v.league_id and s.revision_id=v.id),'[]'::jsonb),
        'lineups',coalesce((select jsonb_agg(jsonb_build_object('team_id',ln.team_id,'players',coalesce(
          (select jsonb_agg(jsonb_build_object('player_id',lp.player_id,'name',pp.display_name,
            'selection',lp.selection,'actual_position',lp.actual_position) order by lp.selection,pp.display_name)
           from public.real_match_lineup_players lp join public.player_profiles pp
             on pp.league_id=lp.league_id and pp.id=lp.player_id
          where lp.league_id=ln.league_id and lp.lineup_id=ln.id),'[]'::jsonb)) order by ln.team_id)
          from public.real_match_lineups ln where ln.league_id=v.league_id and ln.revision_id=v.id),'[]'::jsonb)
      ) order by v.version desc) from public.match_revisions v
        where v.league_id=m.league_id and v.match_id=m.id),'[]'::jsonb)
    ) order by m.starts_at desc)
    from public.real_matches m
    join public.real_football_teams ta on ta.league_id=m.league_id and ta.id=m.team_a_id
    join public.real_football_teams tb on tb.league_id=m.league_id and tb.id=m.team_b_id
    left join lateral (select v0.* from public.match_revisions v0
      where v0.league_id=m.league_id and v0.match_id=m.id order by v0.version desc limit 1) r on true
    left join lateral (select o0.* from public.official_match_results o0
      where o0.league_id=m.league_id and o0.match_id=m.id and o0.is_current limit 1) o on true
    left join public.match_revisions official_revision
      on official_revision.league_id=o.league_id and official_revision.id=o.revision_id
    where m.league_id=p_league
  ),'[]'::jsonb);
end $$;

-- Preserve the existing authenticated-only signatures/grants. Manual review RPC
-- remains as a fail-closed compatibility stub for lineup submissions only.
commit;
