import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const db=await PGlite.create();
for (const file of ['setup.sql','../migrations/001_schema.sql','../migrations/002_security.sql','../migrations/003_storage.sql']) await db.exec(await readFile(new URL(file,import.meta.url),'utf8'));
after(()=>db.close());
const L='10000000-0000-0000-0000-000000000001', L2='10000000-0000-0000-0000-000000000002';
const U=['20000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000005'];
const P=['30000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000004'];
const LP=['31000000-0000-0000-0000-000000000001','31000000-0000-0000-0000-000000000002','31000000-0000-0000-0000-000000000003','31000000-0000-0000-0000-000000000004'];
const A='40000000-0000-0000-0000-000000000001', B='40000000-0000-0000-0000-000000000002';
const T1='50000000-0000-0000-0000-000000000001', T2='50000000-0000-0000-0000-000000000002';
const SEASON='61000000-0000-0000-0000-000000000001';
const GW='60000000-0000-0000-0000-000000000001',M='70000000-0000-0000-0000-000000000001',R='71000000-0000-0000-0000-000000000001', LA='72000000-0000-0000-0000-000000000001',LB='72000000-0000-0000-0000-000000000002';
const SUB='73000000-0000-0000-0000-000000000001',REJ='74000000-0000-0000-0000-000000000001', LS='73000000-0000-0000-0000-000000000002', LAP='74000000-0000-0000-0000-000000000002';
const Q=(sql,params=[])=>db.query(sql,params);
async function asUser(user,fn){await Q("select set_config('request.jwt.claim.sub',$1,false)",[user]);await db.exec('set role authenticated');try{return await fn();}finally{await db.exec('reset role');}}
async function mustFail(promise,code){await assert.rejects(promise,e=>{assert.equal(e.code,code, e.message);return true;});}
await db.exec(`insert into auth.users(id) values ${U.map(x=>`('${x}')`).join(',')};
insert into public.profiles(id,display_name) values ${U.map((x,i)=>`('${x}','User ${i+1}')`).join(',')};
insert into public.leagues(id,name) values ('${L}','League A'),('${L2}','League B');
insert into public.league_members(league_id,user_id,role) values ('${L}','${U[0]}','leader'),('${L}','${U[1]}','manager'),('${L}','${U[2]}','manager'),('${L}','${U[3]}','manager'),('${L2}','${U[4]}','leader');
insert into public.match_organizers values ('${L}','${U[1]}');
insert into public.player_profiles(id,league_id,display_name) values ('${P[0]}','${L}','Alpha'),('${P[1]}','${L}','Bravo'),('${P[2]}','${L}','Charlie'),('${P[3]}','${L2}','Other');
insert into public.league_players(id,league_id,player_id,position,price,rating) values ('${LP[0]}','${L}','${P[0]}','GK',5000000,80),('${LP[1]}','${L}','${P[1]}','DEF',5000000,80),('${LP[2]}','${L}','${P[2]}','MID',5000000,80),('${LP[3]}','${L2}','${P[3]}','MID',5000000,80);
insert into public.real_football_teams(id,league_id,name) values ('${A}','${L}','Team A'),('${B}','${L}','Team B');
insert into public.fantasy_teams(id,league_id,manager_id,name) values ('${T1}','${L}','${U[2]}','One'),('${T2}','${L}','${U[3]}','Two');
insert into public.seasons(id,league_id,name,starts_at,ends_at) values ('${SEASON}','${L}','Season 1',now(),now()+interval '1 year');
insert into public.gameweeks(id,league_id,season_id,number,deadline) values ('${GW}','${L}','${SEASON}',1,now());
insert into public.real_matches(id,league_id,gameweek_id,team_a_id,team_b_id,organizer_id,starts_at,venue,starters_per_side,max_substitutes) values ('${M}','${L}','${GW}','${A}','${B}','${U[1]}',now(),'Pitch',7,5);
insert into public.match_revisions(id,league_id,match_id,version) values ('${R}','${L}','${M}',1);
insert into public.real_match_lineups(id,league_id,match_id,revision_id,team_id) values ('${LA}','${L}','${M}','${R}','${A}'),('${LB}','${L}','${M}','${R}','${B}');
insert into public.real_match_lineup_players(league_id,revision_id,lineup_id,player_id,selection,actual_position,eligibility_kind,eligibility_evidence) values ('${L}','${R}','${LA}','${P[0]}','starter','GK','registered','{}'),('${L}','${R}','${LB}','${P[1]}','substitute','DEF','temporary','{}');`);

test('multiple fantasy teams may own the same player, but not twice in one team',async()=>{
  await Q('insert into public.fantasy_squad_players values ($1,$2,$3,5000000),($1,$4,$3,5000000)',[L,T1,LP[0],T2]);
  await mustFail(Q('insert into public.fantasy_squad_players values ($1,$2,$3,5000000)',[L,T1,LP[0]]),'23505');
  await mustFail(Q('insert into public.fantasy_squad_players values ($1,$2,$3,5000000)',[L,T1,LP[3]]),'23503');
});
test('match lineup prevents the same player on either side or twice on one side',async()=>{
  for(const lineup of [LA,LB]) await mustFail(Q("insert into public.real_match_lineup_players(league_id,revision_id,lineup_id,player_id,selection,actual_position,eligibility_kind,eligibility_evidence) values ($1,$2,$3,$4,'starter','GK','registered','{}')",[L,R,lineup,P[0]]),'23505');
  const result=await Q('select selection from public.real_match_lineup_players where revision_id=$1 order by selection',[R]);assert.deepEqual(result.rows.map(x=>x.selection),['starter','substitute']);
});
test('match events must reference selected players in the same revision',async()=>{
  await mustFail(Q("insert into public.match_events(league_id,revision_id,player_id,event_type) values ($1,$2,$3,'goal')",[L,R,P[2]]),'23503');
  await Q("insert into public.match_events(league_id,revision_id,player_id,event_type) values ($1,$2,$3,'goal')",[L,R,P[0]]);
});
test('official result cannot reference a missing, rejected, wrong-kind, or different-revision approval',async()=>{
  await Q("insert into public.match_submissions(id,league_id,match_id,revision_id,kind,submitted_by) values ($1,$2,$3,$4,'lineup',$5)",[LS,L,M,R,U[1]]);
  await Q("insert into public.match_approvals(id,league_id,match_id,submission_id,revision_id,kind,decision,reviewed_by) values ($1,$2,$3,$4,$5,'lineup','approved',$6)",[LAP,L,M,LS,R,U[0]]);
  await mustFail(Q("insert into public.match_submissions(id,league_id,match_id,revision_id,kind,submitted_by) values ($1,$2,$3,$4,'result',$5)",[SUB,L,M,R,U[1]]),'23514');
  await mustFail(Q("insert into public.match_submissions(id,league_id,match_id,revision_id,kind,approved_lineup_approval_id,submitted_by) values($1,$2,$3,$4,'result',$5,$6)",[SUB,L,M,R,LAP,U[1]]),'23514');
  await Q("insert into public.match_submissions(id,league_id,match_id,revision_id,kind,approved_lineup_approval_id,approved_lineup_decision,approved_lineup_kind,submitted_by) values ($1,$2,$3,$4,'result',$5,'approved','lineup',$6)",[SUB,L,M,R,LAP,U[1]]);
  await Q("insert into public.match_approvals(id,league_id,match_id,submission_id,revision_id,kind,decision,reviewed_by) values ($1,$2,$3,$4,$5,'result','rejected',$6)",[REJ,L,M,SUB,R,U[0]]);
  await mustFail(Q('insert into public.official_match_results(league_id,match_id,revision_id,approval_id) values ($1,$2,$3,$4)',[L,M,R,REJ]),'23503');
  await mustFail(Q('insert into public.official_match_results(league_id,match_id,revision_id,approval_id) values ($1,$2,$3,$4)',[L,M,R,LAP]),'23503');
  const other='71000000-0000-0000-0000-000000000002';await Q('insert into public.match_revisions(id,league_id,match_id,version) values($1,$2,$3,2)',[other,L,M]);
  const approvedSubmission='73000000-0000-0000-0000-000000000003', approvedResult='74000000-0000-0000-0000-000000000003';
  await Q("insert into public.match_submissions(id,league_id,match_id,revision_id,kind,approved_lineup_approval_id,approved_lineup_decision,approved_lineup_kind,submitted_by) values($1,$2,$3,$4,'result',$5,'approved','lineup',$6)",[approvedSubmission,L,M,other,LAP,U[1]]);
  await Q("insert into public.match_approvals(id,league_id,match_id,submission_id,revision_id,kind,decision,reviewed_by) values($1,$2,$3,$4,$5,'result','approved',$6)",[approvedResult,L,M,approvedSubmission,other,U[0]]);
  await mustFail(Q('insert into public.official_match_results(league_id,match_id,revision_id,approval_id) values ($1,$2,$3,$4)',[L,M,R,approvedResult]),'23503');
  await mustFail(Q('insert into public.official_match_results(league_id,match_id,revision_id,approval_id) values ($1,$2,$3,$4)',[L,M,R,'74000000-0000-0000-0000-000000000099']),'23503');
  await Q('insert into public.official_match_results(league_id,match_id,revision_id,approval_id) values ($1,$2,$3,$4)',[L,M,other,approvedResult]);
});
test('historical records cannot be cascade-deleted, and scoring values have no invented defaults',async()=>{
  await mustFail(Q('delete from public.real_matches where id=$1',[M]),'23001');
  assert.equal((await Q('select count(*)::int n from public.scoring_rule_values')).rows[0].n,0);
  await mustFail(Q("insert into public.fantasy_score_items(league_id,scoring_run_id,fantasy_lineup_id,performance_id,base_points,multiplier,points) values ($1,$2,$3,$4,5,3,15)",[L,R,LA,P[0]]),'23514');
});
test('lineup captain and vice are unique and scoring configuration is versioned by position',async()=>{
  const lineup='75000000-0000-0000-0000-000000000001',rule='76000000-0000-0000-0000-000000000001';
  await Q("insert into public.fantasy_lineups(id,league_id,fantasy_team_id,gameweek_id,version,status) values($1,$2,$3,$4,1,'draft')",[lineup,L,T1,GW]);
  await Q("insert into public.fantasy_lineup_players(league_id,lineup_id,league_player_id,position_snapshot,slot,captain) values($1,$2,$3,'GK',1,true)",[L,lineup,LP[0]]);
  await mustFail(Q("insert into public.fantasy_lineup_players(league_id,lineup_id,league_player_id,position_snapshot,slot,captain) values($1,$2,$3,'DEF',2,true)",[L,lineup,LP[1]]),'23505');
  await mustFail(Q("insert into public.fantasy_lineup_players(league_id,lineup_id,league_player_id,position_snapshot,slot,captain,vice_captain) values($1,$2,$3,'MID',3,true,true)",[L,lineup,LP[2]]),'23514');
  await Q("insert into public.scoring_rule_sets(id,league_id,version,state) values($1,$2,1,'draft')",[rule,L]);assert.equal(Number((await Q('select captain_multiplier from public.scoring_rule_sets where id=$1',[rule])).rows[0].captain_multiplier),2);
  await mustFail(Q('update public.scoring_rule_sets set captain_multiplier=3 where id=$1',[rule]),'23514');
  await Q("insert into public.scoring_rule_values(league_id,rule_set_id,event_type,position,points) values($1,$2,'test-event','GK',1),($1,$2,'test-event','DEF',2)",[L,rule]);
  await mustFail(Q("insert into public.scoring_rule_values(league_id,rule_set_id,event_type,position,points) values($1,$2,'test-event','DEF',3)",[L,rule]),'23505');
});
test('active membership isolates leagues, private squads, draft matches and suggestions',async()=>{
  await Q("insert into public.player_suggestions(league_id,submitted_by,name,position) values ($1,$2,'Private Name','MID')",[L,U[2]]);
  await asUser(U[2],async()=>{
    assert.deepEqual((await Q('select name from public.leagues')).rows.map(x=>x.name),['League A']);
    assert.equal((await Q('select count(*)::int n from public.fantasy_squad_players')).rows[0].n,1);
    assert.equal((await Q('select count(*)::int n from public.real_matches')).rows[0].n,0);
    assert.equal((await Q('select count(*)::int n from public.player_suggestions')).rows[0].n,1);
  });
  await asUser(U[3],async()=>assert.equal((await Q('select count(*)::int n from public.player_suggestions')).rows[0].n,0));
  await asUser(U[1],async()=>assert.equal((await Q('select count(*)::int n from public.real_matches')).rows[0].n,1));
  await asUser(U[4],async()=>assert.equal((await Q('select count(*)::int n from public.player_profiles')).rows[0].n,1));
});
test('clients, including organizer and leader, cannot write draft or approved data or forge audits',async()=>{
  for(const actor of [U[0],U[1],U[2]]) await asUser(actor,async()=>{
    await mustFail(Q("update public.match_revisions set state='approved' where id=$1",[R]),'42501');
    await mustFail(Q("insert into public.match_events(league_id,revision_id,player_id,event_type) values ($1,$2,$3,'goal')",[L,R,P[0]]),'42501');
    await mustFail(Q("update public.real_match_lineup_players set selection='substitute' where revision_id=$1",[R]),'42501');
    await mustFail(Q("insert into public.match_approvals(league_id,match_id,submission_id,revision_id,kind,decision,reviewed_by) values ($1,$2,$3,$4,'result','approved',$5)",[L,M,SUB,R,actor]),'42501');
    await mustFail(Q('insert into public.official_match_results(league_id,match_id,revision_id,approval_id) values ($1,$2,$3,$4)',[L,M,R,REJ]),'42501');
    await mustFail(Q("insert into public.audit_logs(league_id,actor_id,action,entity_type,entity_id) values ($1,$2,'approve','match',$3)",[L,actor,M]),'42501');
    await mustFail(Q("insert into public.fantasy_scores(league_id,scoring_run_id,fantasy_team_id,points) values ($1,$2,$3,99)",[L,R,T1]),'42501');
  });
});
test('anonymous and inactive organizers cannot read league drafts',async()=>{
  await Q("select set_config('request.jwt.claim.sub','',false)");
  await db.exec('set role anon');
  try { await mustFail(Q('select * from public.real_matches'),'42501'); }
  finally { await db.exec('reset role'); }
  await Q("update public.league_members set status='inactive' where league_id=$1 and user_id=$2",[L,U[1]]);
  try {
    await asUser(U[1],async()=>{
      assert.equal((await Q('select count(*)::int n from public.leagues')).rows[0].n,0);
      assert.equal((await Q('select count(*)::int n from public.real_matches')).rows[0].n,0);
      assert.equal((await Q('select count(*)::int n from public.match_revisions')).rows[0].n,0);
    });
  } finally { await Q("update public.league_members set status='active' where league_id=$1 and user_id=$2",[L,U[1]]); }
});
test('private bucket allows members to read only associated authorized image paths',async()=>{
  const image=`${L}/players/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png`;
  const privateImage=`${L}/players/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jpg`;
  await Q('update public.player_profiles set image_path=$1 where id=$2',[image,P[0]]);
  await Q('update public.player_suggestions set image_path=$1 where submitted_by=$2',[privateImage,U[2]]);
  await Q("insert into storage.objects(bucket_id,name) values ('player-images',$1),('player-images',$2),('player-images',$3)",[image,privateImage,`${L}/players/cccccccc-cccc-cccc-cccc-cccccccccccc.png`]);
  await asUser(U[2],async()=>assert.equal((await Q('select count(*)::int n from storage.objects')).rows[0].n,2));
  await asUser(U[3],async()=>assert.equal((await Q('select count(*)::int n from storage.objects')).rows[0].n,1));
  await asUser(U[4],async()=>assert.equal((await Q('select count(*)::int n from storage.objects')).rows[0].n,0));
  await asUser(U[2],async()=>await mustFail(Q("insert into storage.objects(bucket_id,name) values ('player-images','forged')"),'42501'));
});
