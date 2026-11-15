-- PHASE 2A.4 OFFLINE DESIGN ONLY. NOT DEPLOYABLE. Requires pristine test data.
-- This deliberately refuses existing revisions: 001-005 did not persist the
-- actual fork lineage, so an automatic backfill would invent provenance.
do $$ begin
 if exists(select 1 from public.match_revisions) then
   raise exception 'revision lineage cannot be inferred for existing data; human migration review required' using errcode='23514';
 end if;
end $$;

alter table public.match_approvals add constraint lineup_source_identity_unique unique(league_id,match_id,id,revision_id);
alter table public.match_revisions add column based_on_lineup_approval_id uuid;
alter table public.match_revisions add column based_on_lineup_revision_id uuid;
alter table public.match_revisions add constraint lineup_source_complete check (
 (based_on_lineup_approval_id is null and based_on_lineup_revision_id is null) or
 (based_on_lineup_approval_id is not null and based_on_lineup_revision_id is not null));
alter table public.match_revisions add constraint result_lineup_source_fk
 foreign key(league_id,match_id,based_on_lineup_approval_id,based_on_lineup_revision_id)
 references public.match_approvals(league_id,match_id,id,revision_id) on delete restrict;

create function ff_private.guard_result_revision_lineage() returns trigger
language plpgsql security definer set search_path=pg_catalog,ff_private as $$
begin
 perform ff_private.require_read_committed();
 if tg_op='UPDATE' then
   if (new.based_on_lineup_approval_id,new.based_on_lineup_revision_id) is distinct from (old.based_on_lineup_approval_id,old.based_on_lineup_revision_id) then
     raise exception 'result revision lineage is immutable' using errcode='23514'; end if;
   return new;
 end if;
 if new.based_on_lineup_approval_id is not null then
   perform 1 from public.real_matches where league_id=new.league_id and id=new.match_id for update;
   if not exists(select 1 from public.match_approvals a join public.match_revisions r on r.league_id=a.league_id and r.match_id=a.match_id and r.id=a.revision_id
     where a.league_id=new.league_id and a.match_id=new.match_id and a.id=new.based_on_lineup_approval_id
       and a.revision_id=new.based_on_lineup_revision_id and a.kind='lineup' and a.decision='approved' and r.state='approved') then
     raise exception 'result revision requires exact approved lineup lineage' using errcode='23514'; end if;
   perform ff_private.require_current_lineup(new.league_id,new.match_id,new.based_on_lineup_revision_id);
 end if;
 return new;
end $$;
create trigger guard_result_revision_lineage before insert or update on public.match_revisions for each row execute function ff_private.guard_result_revision_lineage();

-- Existing validation compares all copied lineup fields and snapshot. This
-- additional check forbids substituting a different but identical approval.
create function ff_private.guard_submission_lineage() returns trigger
language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare revision public.match_revisions%rowtype;
begin
 select * into revision from public.match_revisions where league_id=new.league_id and match_id=new.match_id and id=new.revision_id;
 if not found then raise exception 'revision not found' using errcode='23514'; end if;
 if new.kind='lineup' and revision.based_on_lineup_approval_id is not null then
   raise exception 'result revision cannot be submitted as lineup' using errcode='23514'; end if;
 if new.kind='result' and (revision.based_on_lineup_approval_id is null or revision.based_on_lineup_approval_id is distinct from new.approved_lineup_approval_id or
   not exists(select 1 from public.match_approvals a where a.league_id=new.league_id and a.match_id=new.match_id and a.id=new.approved_lineup_approval_id
    and a.revision_id=revision.based_on_lineup_revision_id and a.kind='lineup' and a.decision='approved')) then
   raise exception 'result submission must use its original approved lineup' using errcode='23514'; end if;
 return new;
end $$;
create trigger zzz_guard_submission_lineage before insert on public.match_submissions for each row execute function ff_private.guard_submission_lineage();

-- The decision is also rechecked at the privileged review/publication boundary.
create function ff_private.guard_review_lineage() returns trigger
language plpgsql security definer set search_path=pg_catalog,ff_private as $$
begin
 if new.kind='result' and not exists(
   select 1 from public.match_submissions s join public.match_revisions r on r.league_id=s.league_id and r.match_id=s.match_id and r.id=s.revision_id
   join public.match_approvals la on la.league_id=r.league_id and la.match_id=r.match_id and la.id=r.based_on_lineup_approval_id
     and la.revision_id=r.based_on_lineup_revision_id and la.kind='lineup' and la.decision='approved'
   where s.league_id=new.league_id and s.match_id=new.match_id and s.id=new.submission_id and s.revision_id=new.revision_id
     and s.kind='result' and s.approved_lineup_approval_id=r.based_on_lineup_approval_id) then
   raise exception 'result approval lineage mismatch' using errcode='23514'; end if;
 return new;
end $$;
create trigger zzz_guard_review_lineage before insert on public.match_approvals for each row execute function ff_private.guard_review_lineage();

create or replace function ff_private.fork_result(p_league uuid,p_lineup_approval uuid) returns uuid
language plpgsql security definer set search_path=pg_catalog,ff_private as $$
declare a public.match_approvals%rowtype; next_rev uuid; next_ver integer; line record; next_line uuid;
begin
 select * into a from public.match_approvals where league_id=p_league and id=p_lineup_approval and kind='lineup' and decision='approved';
 if not found then raise exception 'approved lineup required' using errcode='23514'; end if;
 perform ff_private.require_organizer(p_league,a.match_id);
 perform 1 from public.real_matches where league_id=p_league and id=a.match_id for update;
 perform ff_private.require_current_lineup(p_league,a.match_id,a.revision_id);
 select coalesce(max(version),0)+1 into next_ver from public.match_revisions where league_id=p_league and match_id=a.match_id;
 insert into public.match_revisions(league_id,match_id,version,match_snapshot,based_on_lineup_approval_id,based_on_lineup_revision_id)
 select p_league,a.match_id,next_ver,match_snapshot,a.id,a.revision_id from public.match_revisions where league_id=p_league and id=a.revision_id returning id into next_rev;
 for line in select * from public.real_match_lineups where league_id=p_league and revision_id=a.revision_id loop
   insert into public.real_match_lineups(league_id,match_id,revision_id,team_id) values(p_league,a.match_id,next_rev,line.team_id) returning id into next_line;
   insert into public.real_match_lineup_players(league_id,revision_id,lineup_id,player_id,selection,actual_position,eligibility_kind,eligibility_evidence)
   select league_id,next_rev,next_line,player_id,selection,actual_position,eligibility_kind,eligibility_evidence from public.real_match_lineup_players where league_id=p_league and lineup_id=line.id;
 end loop;
 insert into public.audit_logs(league_id,actor_id,action,entity_type,entity_id,after_data) values(p_league,auth.uid(),'fork_result','match',a.match_id,jsonb_build_object('lineup_approval',a.id,'draft_revision',next_rev));
 return next_rev;
end $$;

revoke all on all functions in schema ff_private from public,anon,authenticated;
grant execute on function ff_private.is_member(uuid),ff_private.is_leader(uuid),ff_private.is_organizer(uuid),ff_private.owns_team(uuid,uuid),
 ff_private.can_read_lineup(uuid,uuid),ff_private.can_read_revision(uuid,uuid),ff_private.can_read_match(uuid,uuid),
 ff_private.can_read_suggestion(uuid,uuid),ff_private.can_read_image(text),ff_private.is_match_organizer(uuid,uuid) to authenticated;
