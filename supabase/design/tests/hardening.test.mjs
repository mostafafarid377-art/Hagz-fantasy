// Offline-only PGlite tests. Claims and privileged function gateway are mocked;
// neither models a verified Supabase JWT or production roles.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const db=await PGlite.create();
for(const file of ['setup.sql','../migrations/001_schema.sql','../migrations/002_security.sql','../migrations/003_storage.sql','../migrations/004_integrity_workflows.sql']) await db.exec(await readFile(new URL(file,import.meta.url),'utf8'));
after(()=>db.close());
const q=(sql,params=[])=>db.query(sql,params);
const L='10000000-0000-0000-0000-000000000001', L2='10000000-0000-0000-0000-000000000002';
const leader='20000000-0000-0000-0000-000000000001', organizer='20000000-0000-0000-0000-000000000002', manager='20000000-0000-0000-0000-000000000003', foreign='20000000-0000-0000-0000-000000000004';
const players=Array.from({length:7},(_,i)=>`30000000-0000-0000-0000-${String(i+1).padStart(12,'0')}`);
const A='40000000-0000-0000-0000-000000000001',B='40000000-0000-0000-0000-000000000002',C='40000000-0000-0000-0000-000000000003';
const season='50000000-0000-0000-0000-000000000001',gw='50000000-0000-0000-0000-000000000002';
const match='60000000-0000-0000-0000-000000000001', rev='70000000-0000-0000-0000-000000000001',la='80000000-0000-0000-0000-000000000001',lb='80000000-0000-0000-0000-000000000002';
const fail=async(p,code)=>assert.rejects(p,e=>{assert.equal(e.code,code,e.message);return true;});
async function actor(id,fn,role='ff_test_gateway') {await q("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec(`set role ${role}`);try{return await fn();}finally{await db.exec('reset role');}}
async function value(sql,params=[]){return (await q(sql,params)).rows[0].id;}
await db.exec(`create role ff_test_gateway nologin;
grant usage on schema ff_private, auth to ff_test_gateway;
grant execute on function ff_private.submit_lineup(uuid,uuid), ff_private.fork_result(uuid,uuid), ff_private.set_result_score(uuid,uuid,integer,integer), ff_private.record_event(uuid,uuid,uuid,uuid,text,integer,integer,jsonb), ff_private.submit_result(uuid,uuid,uuid), ff_private.review_submission(uuid,uuid,text,text), ff_private.authorize_temporary(uuid,uuid,uuid,uuid,text), ff_private.open_correction(uuid,uuid,text), ff_private.start_scoring(uuid,uuid,uuid[]) to ff_test_gateway;
insert into auth.users values ('${leader}'),('${organizer}'),('${manager}'),('${foreign}');
insert into public.profiles(id,display_name) values ('${leader}','Leader'),('${organizer}','Organizer'),('${manager}','Manager'),('${foreign}','Other leader');
insert into public.leagues(id,name) values ('${L}','League A'),('${L2}','League B');
insert into public.league_members(league_id,user_id,role) values ('${L}','${leader}','leader'),('${L}','${organizer}','manager'),('${L}','${manager}','manager'),('${L2}','${foreign}','leader');
insert into public.match_organizers values ('${L}','${organizer}'),('${L}','${leader}'),('${L}','${manager}');
insert into public.player_profiles(id,league_id,display_name) values ${players.map((p,i)=>`('${p}','${L}','Player ${i+1}')`).join(',')};
insert into public.real_football_teams(id,league_id,name) values ('${A}','${L}','A'),('${B}','${L}','B'),('${C}','${L}','C');
insert into public.real_team_players(league_id,team_id,player_id,valid_from) values
 ('${L}','${A}','${players[0]}',now()-interval '1 day'),('${L}','${B}','${players[1]}',now()-interval '1 day'),
 ('${L}','${A}','${players[2]}',now()-interval '1 day'),('${L}','${A}','${players[3]}',now()-interval '1 day'),
 ('${L}','${B}','${players[5]}',now()+interval '1 day');
insert into public.seasons(id,league_id,name,starts_at,ends_at) values ('${season}','${L}','Season',now(),now()+interval '1 year');
insert into public.gameweeks(id,league_id,season_id,number,deadline) values ('${gw}','${L}','${season}',1,now());
insert into public.real_matches(id,league_id,gameweek_id,team_a_id,team_b_id,organizer_id,starts_at,venue,starters_per_side,max_substitutes)
 values ('${match}','${L}','${gw}','${A}','${B}','${organizer}',now(),'Pitch',1,1);
insert into public.match_revisions(id,league_id,match_id,version,match_snapshot) values ('${rev}','${L}','${match}',1,'{"format":"test"}');
insert into public.real_match_lineups(id,league_id,match_id,revision_id,team_id) values ('${la}','${L}','${match}','${rev}','${A}'),('${lb}','${L}','${match}','${rev}','${B}');`);
const add=(lineup,player,selection,kind='registered',position='MID')=>q('insert into public.real_match_lineup_players(league_id,revision_id,lineup_id,player_id,selection,actual_position,eligibility_kind,eligibility_evidence) values($1,$2,$3,$4,$5,$6,$7,\'{}\')',[L,rev,lineup,player,selection,position,kind]);
let lineupSubmission,lineupApproval,rejectedRevision,approvedRevision,official,run,correction,rule;

test('team side, registered membership at kickoff, exact temporary authorization and format maxima',async()=>{
 await fail(q('insert into public.real_match_lineups(league_id,match_id,revision_id,team_id) values($1,$2,$3,$4)',[L,match,rev,C]),'23514');
 await fail(add(la,players[1],'starter'),'23514'); // registered for B, not A
 await fail(add(lb,players[5],'starter'),'23514'); // membership not active at kickoff
 await fail(add(lb,players[4],'substitute','temporary'),'23514');
 await fail(actor(manager,()=>q('select ff_private.authorize_temporary($1,$2,$3,$4,$5)',[L,match,B,players[4],'guest'])),'42501');
 await fail(actor(leader,()=>q('select ff_private.authorize_temporary($1,$2,$3,$4,$5)',[L,match,C,players[4],'guest'])),'23514');
 await actor(leader,()=>q('select ff_private.authorize_temporary($1,$2,$3,$4,$5)',[L,match,B,players[4],'guest']));
 await fail(add(la,players[4],'substitute','temporary'),'23514'); // authorized for B only
 await add(la,players[0],'starter');
 // Even a valid temporary authorization on B cannot select a player already on A.
 await actor(leader,()=>q('select ff_private.authorize_temporary($1,$2,$3,$4,$5)',[L,match,B,players[0],'duplicate coverage']));
 await fail(add(lb,players[0],'substitute','temporary'),'23505');
 await fail(q('delete from public.real_team_players where league_id=$1 and team_id=$2 and player_id=$3',[L,A,players[0]]),'23514');
 await fail(q("update public.real_matches set starts_at=starts_at+interval '1 day' where id=$1",[match]),'23514');
 await fail(q('update public.real_match_lineups set team_id=$1 where id=$2',[B,la]),'23514');
 await add(lb,players[1],'starter');
 await fail(add(la,players[2],'starter'),'23514');
 await add(la,players[2],'substitute');await fail(add(la,players[3],'substitute'),'23514');
 await add(lb,players[4],'substitute','temporary');
 await actor(manager,async()=>{
   assert.equal((await q('select count(*)::int n from public.real_matches')).rows[0].n,0);
   assert.equal((await q('select count(*)::int n from public.temporary_participant_authorizations')).rows[0].n,0);
 },'authenticated');
 await actor(organizer,async()=>{
   assert.equal((await q('select count(*)::int n from public.real_matches')).rows[0].n,1);
   assert.equal((await q('select count(*)::int n from public.temporary_participant_authorizations')).rows[0].n,2);
 },'authenticated');

});
test('lineup submission requires both complete sides and assigned active organizer',async()=>{
 const incomplete=await value('insert into public.match_revisions(league_id,match_id,version) values($1,$2,2) returning id',[L,match]);
 const empty=await value('insert into public.real_match_lineups(league_id,match_id,revision_id,team_id) values($1,$2,$3,$4) returning id',[L,match,incomplete,A]);
 assert.ok(empty);
 await fail(q("insert into public.real_match_lineup_players(league_id,revision_id,lineup_id,player_id,selection,actual_position,eligibility_kind,eligibility_evidence) values($1,$2,$3,$4,'starter','INVALID','registered','{}')",[L,incomplete,empty,players[0]]),'23514');
 await fail(actor(organizer,()=>q('select ff_private.submit_lineup($1,$2)',[L,incomplete])),'23514');
 await fail(actor(manager,()=>q('select ff_private.submit_lineup($1,$2)',[L,rev])),'42501');
 await fail(actor(foreign,()=>q('select ff_private.submit_lineup($1,$2)',[L,rev])),'42501');
 await fail(actor(organizer,()=>q('select ff_private.submit_lineup($1,$2)',[L2,rev])),'42501');
 lineupSubmission=await actor(organizer,()=>value('select ff_private.submit_lineup($1,$2) as id',[L,rev]));
 assert.equal((await q('select state from public.match_revisions where id=$1',[rev])).rows[0].state,'submitted');
 await fail(q('update public.real_match_lineup_players set actual_position=\'DEF\' where revision_id=$1',[rev]),'23514');
 await fail(actor(manager,()=>q('select ff_private.review_submission($1,$2,$3,$4)',[L,lineupSubmission,'approved',null])),'42501');
 await fail(actor(foreign,()=>q('select ff_private.review_submission($1,$2,$3,$4)',[L,lineupSubmission,'approved',null])),'42501');
 lineupApproval=await actor(leader,()=>value('select ff_private.review_submission($1,$2,$3,$4) as id',[L,lineupSubmission,'approved',null]));
 assert.equal((await q('select state from public.match_revisions where id=$1',[rev])).rows[0].state,'approved');
 await fail(q("update public.match_revisions set team_a_score=2 where id=$1",[rev]),'23514');
 await fail(q('delete from public.real_match_lineup_players where revision_id=$1',[rev]),'23514');
 await fail(q('delete from public.real_team_players where league_id=$1 and team_id=$2 and player_id=$3',[L,A,players[0]]),'23514');
 await fail(q("update public.real_matches set venue='Other' where id=$1",[match]),'23514');
});
test('leader cannot review their own submission',async()=>{
 const m=await value("insert into public.real_matches(league_id,gameweek_id,team_a_id,team_b_id,organizer_id,starts_at,venue,starters_per_side,max_substitutes) values($1,$2,$3,$4,$5,now(),'Pitch',1,0) returning id",[L,gw,A,B,leader]);
 const r=await value('insert into public.match_revisions(league_id,match_id,version) values($1,$2,1) returning id',[L,m]);
 for(const [team,player] of [[A,players[0]],[B,players[1]]]){
  const line=await value('insert into public.real_match_lineups(league_id,match_id,revision_id,team_id) values($1,$2,$3,$4) returning id',[L,m,r,team]);
  if(team===B) await fail(q("insert into public.real_match_lineup_players(league_id,revision_id,lineup_id,player_id,selection,actual_position,eligibility_kind,eligibility_evidence) values($1,$2,$3,$4,'starter','MID','temporary','{}')",[L,r,line,players[4]]),'23514'); // authorization was for another match
  await q("insert into public.real_match_lineup_players(league_id,revision_id,lineup_id,player_id,selection,actual_position,eligibility_kind,eligibility_evidence) values($1,$2,$3,$4,'starter','MID','registered','{}')",[L,r,line,player]);
 }
 const s=await actor(leader,()=>value('select ff_private.submit_lineup($1,$2) as id',[L,r]));
 await fail(actor(leader,()=>q('select ff_private.review_submission($1,$2,$3,$4)',[L,s,'approved',null])),'42501');
});
async function resultDraft(){
 const r=await actor(organizer,()=>value('select ff_private.fork_result($1,$2) as id',[L,lineupApproval]));
 await actor(organizer,()=>q('select ff_private.set_result_score($1,$2,$3,$4)',[L,r,1,0]));
 return r;
}
test('result must match approved lineup and requires independent leader approval',async()=>{
 rejectedRevision=await resultDraft();
 await q("update public.real_match_lineup_players set actual_position='DEF' where league_id=$1 and revision_id=$2 and player_id=$3",[L,rejectedRevision,players[0]]);
 await fail(actor(organizer,()=>q('select ff_private.submit_result($1,$2,$3)',[L,rejectedRevision,lineupApproval])),'23514');
 await q("update public.real_match_lineup_players set actual_position='MID' where league_id=$1 and revision_id=$2 and player_id=$3",[L,rejectedRevision,players[0]]);
 await fail(actor(manager,()=>q("select ff_private.record_event($1,$2,$3,null,'goal',10,1,'{}')",[L,rejectedRevision,players[0]])),'42501');
 await actor(organizer,()=>q("select ff_private.record_event($1,$2,$3,null,'goal',10,1,'{}')",[L,rejectedRevision,players[0]]));
 const rs=await actor(organizer,()=>value('select ff_private.submit_result($1,$2,$3) as id',[L,rejectedRevision,lineupApproval]));
 await fail(actor(leader,()=>q('select ff_private.review_submission($1,$2,$3,$4)',[L,rs,'rejected',null])),'23514');
 const rejectedApproval=await actor(leader,()=>value('select ff_private.review_submission($1,$2,$3,$4) as id',[L,rs,'rejected','Incorrect score']));
 await fail(q('insert into public.official_match_results(league_id,match_id,revision_id,approval_id) values($1,$2,$3,$4)',[L,match,rejectedRevision,rejectedApproval]),'23514');
 assert.equal((await q('select count(*)::int n from public.official_match_results where revision_id=$1',[rejectedRevision])).rows[0].n,0);
 approvedRevision=await resultDraft();
 await actor(organizer,()=>q("select ff_private.record_event($1,$2,$3,null,'goal',10,1,'{}')",[L,approvedRevision,players[0]]));
 const submit=await actor(organizer,()=>value('select ff_private.submit_result($1,$2,$3) as id',[L,approvedRevision,lineupApproval]));
 await actor(leader,()=>q('select ff_private.review_submission($1,$2,$3,$4)',[L,submit,'approved',null]));
 official=await value('select id from public.official_match_results where league_id=$1 and match_id=$2 and is_current',[L,match]);
 await fail(q("update public.match_events set quantity=2 where league_id=$1 and revision_id=$2",[L,approvedRevision]),'23514');
});
test('scoring accepts only current approved sources and immutable published rules, idempotently',async()=>{
 rule=await value("insert into public.scoring_rule_sets(league_id,version,state) values($1,1,'draft') returning id",[L]);
 await q("insert into public.scoring_rule_values(league_id,rule_set_id,event_type,position,points) values($1,$2,'goal','MID',1)",[L,rule]);
 await q("update public.scoring_rule_sets set state='published' where id=$1",[rule]);await q('update public.gameweeks set scoring_rule_set_id=$1 where id=$2',[rule,gw]);
 await fail(q("update public.scoring_rule_values set points=2 where rule_set_id=$1",[rule]),'23514');
 await fail(actor(leader,()=>q('select ff_private.start_scoring($1,$2,$3::uuid[])',[L,gw,[]])),'23514');
 await fail(actor(leader,()=>q('select ff_private.start_scoring($1,$2,$3::uuid[])',[L,gw,[rejectedRevision]])),'23514');
 await fail(actor(manager,()=>q('select ff_private.start_scoring($1,$2,$3::uuid[])',[L,gw,[official]])),'42501');
 await fail(actor(leader,()=>q('select ff_private.start_scoring($1,$2,$3::uuid[])',[L,gw,[official,official]])),'23514');
 await fail(q("insert into public.scoring_runs(league_id,gameweek_id,rule_set_id,status,input_hash) values($1,$2,$3,'pending','empty')",[L,gw,rule]),'23514');
 run=await actor(leader,()=>value('select ff_private.start_scoring($1,$2,$3::uuid[]) as id',[L,gw,[official]]));
 assert.equal(await actor(leader,()=>value('select ff_private.start_scoring($1,$2,$3::uuid[]) as id',[L,gw,[official]])),run);
 assert.equal((await q('select count(*)::int n from public.scoring_runs where league_id=$1',[L])).rows[0].n,1);
 await fail(q('insert into public.scoring_run_sources(league_id,scoring_run_id,official_result_id,revision_id) values($1,$2,$3,$4)',[L,run,official,approvedRevision]),'23514'); // sealed source set
 // Isolate wrong-revision validation from the sealed-source check.
 await db.exec('begin');
 try {
   const unsealed=await value("insert into public.scoring_runs(league_id,gameweek_id,rule_set_id,status,input_hash) values($1,$2,$3,'pending','wrong-revision') returning id",[L,gw,rule]);
   await fail(q('insert into public.scoring_run_sources(league_id,scoring_run_id,official_result_id,revision_id) values($1,$2,$3,$4)',[L,unsealed,official,rejectedRevision]),'23514');
 } finally { await db.exec('rollback'); }
 await fail(actor(leader,()=>q('select ff_private.start_scoring($1,$2,$3::uuid[])',[L,gw,[official]]),'authenticated'),'42501'); // no client EXECUTE

 await fail(q("update public.scoring_runs set status='complete' where id=$1",[run]),'23514'); // owner with prior leader claim cannot publish
 await fail(actor(leader,()=>q("update public.scoring_runs set status='complete' where id=$1",[run])),'42501'); // gateway has no table DML
 await fail(q('insert into public.fantasy_scores(league_id,scoring_run_id,fantasy_team_id,points) values($1,$2,$3,5)',[L,run,match]),'42501');
 await fail(q("insert into public.league_standings(league_id,season_id,fantasy_team_id,mode,fantasy_points) values($1,$2,$3,'fantasy_total',5)",[L,season,match]),'42501');
 await fail(actor(manager,()=>q('insert into public.fantasy_scores(league_id,scoring_run_id,fantasy_team_id,points) values($1,$2,$3,5)',[L,run,match]),'authenticated'),'42501');
});
test('corrections are authorized, auditable, supersede sources and preserve old snapshots',async()=>{
 await fail(actor(manager,()=>q('select ff_private.open_correction($1,$2,$3)',[L,match,'Wrong score'])),'42501');
 await fail(actor(foreign,()=>q('select ff_private.open_correction($1,$2,$3)',[L,match,'Wrong score'])),'42501');
 await fail(actor(leader,()=>q('select ff_private.open_correction($1,$2,$3)',[L,match,''])),'23514');
 correction=await actor(leader,()=>value('select ff_private.open_correction($1,$2,$3) as id',[L,match,'Wrong score']));
 assert.equal((await q('select is_current from public.official_match_results where id=$1',[official])).rows[0].is_current,false);
 assert.equal((await q('select status from public.scoring_runs where id=$1',[run])).rows[0].status,'superseded');
 const audit=(await q("select actor_id,reason,after_data from public.audit_logs where league_id=$1 and action='open_correction'",[L])).rows[0];
 assert.equal(audit.actor_id,leader);assert.equal(audit.reason,'Wrong score');assert.equal(audit.after_data.draft_revision,correction);assert.ok(audit.after_data.superseded_runs.includes(run));
 assert.equal((await q('select corrects_revision_id from public.match_revisions where id=$1',[correction])).rows[0].corrects_revision_id,approvedRevision);
 await fail(actor(leader,()=>q('select ff_private.start_scoring($1,$2,$3::uuid[])',[L,gw,[official]])),'23514');
 await fail(q('update public.audit_logs set reason=\'forged\' where league_id=$1',[L]),'23514');
 await fail(q('delete from public.audit_logs where league_id=$1',[L]),'23514');
 await fail(actor(manager,()=>q('delete from public.audit_logs where league_id=$1',[L]),'authenticated'),'42501');
 await fail(actor(leader,()=>q("update public.audit_logs set reason='tamper' where league_id=$1",[L]),'authenticated'),'42501');
 await fail(q('delete from public.scoring_run_sources where scoring_run_id=$1',[run]),'23514');
 await fail(q("update public.match_revisions set team_b_score=9 where id=$1",[approvedRevision]),'23514');
 await fail(actor(organizer,()=>q('select ff_private.fork_result($1,$2)',[L,lineupApproval])),'23514');
 const correctionSubmission=await actor(organizer,()=>value('select ff_private.submit_lineup($1,$2) as id',[L,correction]));
 const newApproval=await actor(leader,()=>value('select ff_private.review_submission($1,$2,$3,$4) as id',[L,correctionSubmission,'approved',null]));
 const result=await actor(organizer,()=>value('select ff_private.fork_result($1,$2) as id',[L,newApproval]));
 await actor(organizer,()=>q('select ff_private.set_result_score($1,$2,$3,$4)',[L,result,2,0]));
 const newSubmission=await actor(organizer,()=>value('select ff_private.submit_result($1,$2,$3) as id',[L,result,newApproval]));
 assert.equal((await q('select count(*)::int n from public.official_match_results where match_id=$1 and is_current',[match])).rows[0].n,0);
 await actor(leader,()=>q('select ff_private.review_submission($1,$2,$3,$4)',[L,newSubmission,'approved',null]));
 assert.equal((await q('select count(*)::int n from public.official_match_results where match_id=$1 and is_current',[match])).rows[0].n,1);
});

test('hardening catalogs keep clients read-only and definer search paths fixed',async()=>{
 const names=['submit_lineup','fork_result','set_result_score','record_event','submit_result','review_submission','authorize_temporary','open_correction','start_scoring'];
 const grants=(await q(`select p.proname,has_function_privilege('authenticated',p.oid,'EXECUTE') allowed,
   p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='ff_private' and p.proname=any($1::text[])`,[names])).rows;
 assert.equal(grants.length,names.length);
 for(const row of grants){assert.equal(row.allowed,false,row.proname);assert.equal(row.prosecdef,true,row.proname);assert.ok(row.proconfig.some(x=>x==='search_path=pg_catalog, ff_private'),row.proname);}
 const unsafe=(await q("select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity")).rows;
 assert.deepEqual(unsafe,[]);
 const definers=(await q("select p.proname,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='ff_private' and p.prosecdef")).rows;
 for(const row of definers) assert.ok(row.proconfig?.includes('search_path=pg_catalog, ff_private'),row.proname);
 const writable=(await q(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind='r' and (has_table_privilege('authenticated',c.oid,'INSERT') or has_table_privilege('authenticated',c.oid,'UPDATE') or has_table_privilege('authenticated',c.oid,'DELETE') or has_table_privilege('authenticated',c.oid,'TRUNCATE'))`)).rows;
 assert.deepEqual(writable,[]);
 assert.equal((await q("select has_schema_privilege('authenticated','ff_private','CREATE') as ok")).rows[0].ok,false);
 await actor(foreign,async()=>{
   assert.equal((await q('select count(*)::int n from public.match_corrections')).rows[0].n,0);
   assert.equal((await q('select count(*)::int n from public.scoring_run_sources')).rows[0].n,0);
 },'authenticated');
});
