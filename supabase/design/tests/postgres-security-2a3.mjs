// Optional real-PostgreSQL compatibility run of the existing hardening suite.
// It refuses TCP and requires a disposable cluster under /tmp/ff-pg-audit.
// It is NOT a Supabase integration test; setup.sql mocks Auth and Storage.
import { PGlite } from '@electric-sql/pglite';
import { createRequire } from 'node:module';
import { realpath, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const socket = process.env.FF_PG_AUDIT_SOCKET;
const modulePath = process.env.FF_PG_AUDIT_DRIVER;
if (!socket || !modulePath) throw new Error('Set FF_PG_AUDIT_SOCKET and FF_PG_AUDIT_DRIVER for the disposable local test cluster');
const socketDir = await realpath(socket);
if (!socketDir.startsWith('/tmp/ff-pg-audit/')) throw new Error('Only the disposable /tmp/ff-pg-audit socket is allowed');
const require = createRequire(import.meta.url);
const { Client } = require(modulePath);
PGlite.create = async () => {
  const client = new Client({host:socketDir, port:55432, user:'audit', database:'postgres'});
  await client.connect();
  try {
    const info = await client.query("select version() as version, current_setting('data_directory') as data_dir, inet_server_addr() as tcp_addr");
    assert.match(info.rows[0].version,/^PostgreSQL /);
    assert.match(info.rows[0].data_dir,/^\/tmp\/ff-pg-audit\//);
    assert.equal(info.rows[0].tcp_addr,null,'test connection must use a local Unix socket');
    console.log('PostgreSQL compatibility target:', info.rows[0].version);
    return {
      query: (sql,params=[]) => client.query(sql,params),
      exec: async sql => {
        const result = await client.query(sql);
        if (sql.includes('PHASE 2A.1 OFFLINE DESIGN ONLY')) await client.query(await readFile(new URL('../migrations/005_concurrency_hardening.sql',import.meta.url),'utf8'));
        return result;
      },
      close: () => client.end(),
    };
  } catch (error) { await client.end(); throw error; }
};
await import('./hardening.test.mjs');

// Regression checks against 001-005. Historic 004 witnesses remain unchanged in postgres-compat.mjs.
const { test } = await import('node:test');
const { randomUUID } = await import('node:crypto');
const L='10000000-0000-0000-0000-000000000001';
const leader='20000000-0000-0000-0000-000000000001';
const organizer='20000000-0000-0000-0000-000000000002';
const match='60000000-0000-0000-0000-000000000001';
const gw='50000000-0000-0000-0000-000000000002';
const A='40000000-0000-0000-0000-000000000001';
const B='40000000-0000-0000-0000-000000000002';
const P1='30000000-0000-0000-0000-000000000001';
const P2='30000000-0000-0000-0000-000000000002';
let auditClient;
// hardening.test.mjs registered all its tests above; its after() closes this
// client only after all tests in this file complete.
async function pgClient(actor) {
 const c=new Client({host:socketDir,port:55432,user:'audit',database:'postgres'});await c.connect();
 if(actor){await c.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);await c.query('set role ff_test_gateway');}
 return c;
}
auditClient=await pgClient();
const { after } = await import('node:test');
after(()=>auditClient.end());
async function currentOfficial(){return (await auditClient.query('select id from public.official_match_results where league_id=$1 and match_id=$2 and is_current',[L,match])).rows[0].id;}
async function latestLineupApproval(){return (await auditClient.query(`select a.id from public.match_approvals a join public.match_revisions r on r.id=a.revision_id
 where a.league_id=$1 and a.match_id=$2 and a.kind='lineup' and a.decision='approved' order by r.version desc limit 1`,[L,match])).rows[0].id;}
async function waitForBlocking(pid){
 const deadline=Date.now()+5000;
 while(Date.now()<deadline){const x=await auditClient.query('select pg_blocking_pids($1) as p',[pid]);if(x.rows[0].p.length)return;await new Promise(resolve=>setTimeout(resolve,20));}
 throw new Error(`backend ${pid} did not block on a lock`);
}
async function createMatchFixture(){
 const m=randomUUID(),r=randomUUID(),la=randomUUID(),lb=randomUUID();
 await auditClient.query(`insert into public.real_matches(id,league_id,gameweek_id,team_a_id,team_b_id,organizer_id,starts_at,venue,starters_per_side,max_substitutes) values($1,$2,$3,$4,$5,$6,now(),'Audit pitch',1,0)`,[m,L,gw,A,B,organizer]);
 await auditClient.query('insert into public.match_revisions(id,league_id,match_id,version) values($1,$2,$3,1)',[r,L,m]);
 await auditClient.query('insert into public.real_match_lineups(id,league_id,match_id,revision_id,team_id) values($1,$2,$3,$4,$5),($6,$2,$3,$4,$7)',[la,L,m,r,A,lb,B]);
 await auditClient.query(`insert into public.real_match_lineup_players(league_id,revision_id,lineup_id,player_id,selection,actual_position,eligibility_kind,eligibility_evidence)
 values($1,$2,$3,$4,'starter','GK','registered','{}'),($1,$2,$5,$6,'starter','DEF','registered','{}')`,[L,r,la,P1,lb,P2]);
 return {m,r};
}

test('native PostgreSQL: concurrent scoring retries return one pending run',async()=>{
 const source=await currentOfficial();const a=await pgClient(leader),b=await pgClient(leader);
 try {
  const [x,y]=await Promise.all([a.query('select ff_private.start_scoring($1,$2,$3::uuid[]) as id',[L,gw,[source]]),b.query('select ff_private.start_scoring($1,$2,$3::uuid[]) as id',[L,gw,[source]])]);
  assert.equal(x.rows[0].id,y.rows[0].id);
  const count=await auditClient.query('select count(*)::int n from public.scoring_run_sources where official_result_id=$1',[source]);assert.equal(count.rows[0].n,1);
 } finally {await a.end();await b.end();}
});
test('native PostgreSQL: concurrent result forks serialize versions but are not idempotent',async()=>{
 const lineup=await latestLineupApproval(),a=await pgClient(organizer),b=await pgClient(organizer);
 try {
  const [x,y]=await Promise.all([a.query('select ff_private.fork_result($1,$2) as id',[L,lineup]),b.query('select ff_private.fork_result($1,$2) as id',[L,lineup])]);
  assert.notEqual(x.rows[0].id,y.rows[0].id);
  const versions=await auditClient.query('select version from public.match_revisions where id=any($1::uuid[])',[[x.rows[0].id,y.rows[0].id]]);
  assert.equal(new Set(versions.rows.map(v=>v.version)).size,2);
 } finally {await a.end();await b.end();}
});
test('stale pending result is rejected after correction without lineup reapproval',async()=>{
 const lineup=await latestLineupApproval(),org=await pgClient(organizer),lead=await pgClient(leader);
 try {
  const r=(await org.query('select ff_private.fork_result($1,$2) as id',[L,lineup])).rows[0].id;
  await org.query('select ff_private.set_result_score($1,$2,3,0)',[L,r]);
  const submission=(await org.query('select ff_private.submit_result($1,$2,$3) as id',[L,r,lineup])).rows[0].id;
  const draft=(await lead.query("select ff_private.open_correction($1,$2,'audit witness') as id",[L,match])).rows[0].id;
  await assert.rejects(lead.query("select ff_private.review_submission($1,$2,'approved',null) as id",[L,submission]), e=>e.code==='23514');
  const official=await auditClient.query('select count(*)::int n from public.official_match_results where league_id=$1 and match_id=$2 and is_current',[L,match]);
  const corrected=await auditClient.query("select count(*)::int n from public.match_approvals where league_id=$1 and revision_id=$2 and kind='lineup' and decision='approved'",[L,draft]);
  assert.equal(official.rows[0].n,0);assert.equal(corrected.rows[0].n,0);
 } finally {await org.end();await lead.end();}
});
test('organizer revocation during match-lock wait prevents submission',async()=>{
 const f=await createMatchFixture(),locker=await pgClient(),victim=await pgClient(organizer);let open=false;
 try {
  await locker.query('begin');open=true;await locker.query('select id from public.real_matches where id=$1 for update',[f.m]);
  const pid=(await victim.query('select pg_backend_pid() pid')).rows[0].pid;
  const pending=victim.query('select ff_private.submit_lineup($1,$2) as id',[L,f.r]).then(value=>({value}),error=>({error}));
  await waitForBlocking(pid);
  await locker.query("update public.league_members set status='inactive' where league_id=$1 and user_id=$2",[L,organizer]);
  await locker.query('commit');open=false;
  const outcome=await pending;assert.equal(outcome.error?.code,'42501');
  const row=await auditClient.query('select count(*)::int n from public.match_submissions where revision_id=$1',[f.r]);assert.equal(row.rows[0].n,0);
 } finally {
  if(open)await locker.query('rollback');
  await auditClient.query("update public.league_members set status='active' where league_id=$1 and user_id=$2",[L,organizer]);
  await locker.end();await victim.end();
 }
});
test('leader revocation during match-lock wait prevents approval',async()=>{
 const f=await createMatchFixture(),org=await pgClient(organizer),locker=await pgClient(),victim=await pgClient(leader);let open=false;
 try {
  const sub=(await org.query('select ff_private.submit_lineup($1,$2) as id',[L,f.r])).rows[0].id;
  await locker.query('begin');open=true;await locker.query('select id from public.real_matches where id=$1 for update',[f.m]);
  const pid=(await victim.query('select pg_backend_pid() pid')).rows[0].pid;
  const pending=victim.query("select ff_private.review_submission($1,$2,'approved',null) as id",[L,sub]).then(value=>({value}),error=>({error}));
  await waitForBlocking(pid);
  await locker.query("update public.league_members set status='inactive' where league_id=$1 and user_id=$2",[L,leader]);
  await locker.query('commit');open=false;
  const outcome=await pending;assert.equal(outcome.error?.code,'42501');
  const row=await auditClient.query('select count(*)::int n from public.match_approvals where submission_id=$1',[sub]);assert.equal(row.rows[0].n,0);
 } finally {
  if(open)await locker.query('rollback');
  await auditClient.query("update public.league_members set status='active' where league_id=$1 and user_id=$2",[L,leader]);
  await org.end();await locker.end();await victim.end();
 }
});

test('native PostgreSQL: valid referenced storage image path is readable by an active member',async()=>{
 const name=`${L}/players/${P1}.jpg`;
 await auditClient.query('update public.player_profiles set image_path=$1 where league_id=$2 and id=$3',[name,L,P1]);
 const client=await pgClient();
 try {
  await client.query("select set_config('request.jwt.claim.sub',$1,false)",[leader]);
  await client.query('set role authenticated');
  const result=await client.query('select ff_private.can_read_image($1) allowed',[name]);
  assert.equal(result.rows[0].allowed,true);
  const invalid=await client.query('select ff_private.can_read_image($1) allowed',[`${L}/players/../private.jpg`]);
  assert.equal(invalid.rows[0].allowed,false);
 } finally {await client.end();}
});

async function makeOfficialWithPending(){
 const f=await createMatchFixture(), org=await pgClient(organizer), lead=await pgClient(leader);
 try {
  const sub=(await org.query('select ff_private.submit_lineup($1,$2) id',[L,f.r])).rows[0].id;
  const lap=(await lead.query("select ff_private.review_submission($1,$2,'approved',null) id",[L,sub])).rows[0].id;
  async function result(){const r=(await org.query('select ff_private.fork_result($1,$2) id',[L,lap])).rows[0].id;await org.query('select ff_private.set_result_score($1,$2,2,0)',[L,r]);return (await org.query('select ff_private.submit_result($1,$2,$3) id',[L,r,lap])).rows[0].id;}
  const one=await result();await lead.query("select ff_private.review_submission($1,$2,'approved',null)",[L,one]);
  const official=(await auditClient.query('select id,revision_id from public.official_match_results where match_id=$1 and is_current',[f.m])).rows[0];
  return {...f,official, pending:await result()};
 } finally {await org.end();await lead.end();}
}
test('concurrent conflicting reviews cannot both commit',async()=>{
 const f=await createMatchFixture(), org=await pgClient(organizer), a=await pgClient(leader), b=await pgClient(leader);let active=false;
 try {
  const sub=(await org.query('select ff_private.submit_lineup($1,$2) id',[L,f.r])).rows[0].id;
  await a.query('begin');active=true;
  await a.query("select ff_private.review_submission($1,$2,'approved',null)",[L,sub]);
  const pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
  const pending=b.query("select ff_private.review_submission($1,$2,'rejected','conflict')",[L,sub]).then(value=>({value}),error=>({error}));
  await waitForBlocking(pid);await a.query('commit');active=false;
  const result=await pending;assert.ok(['23514','23505'].includes(result.error?.code),result.error?.message);
  const rows=await auditClient.query('select decision from public.match_approvals where submission_id=$1',[sub]);assert.deepEqual(rows.rows.map(x=>x.decision),['approved']);
 } finally {if(active)await a.query('rollback');await org.end();await a.end();await b.end();}
});
test('correction racing with pending result approval rejects the stale review',async()=>{
 const f=await makeOfficialWithPending(), a=await pgClient(leader), b=await pgClient(leader);let active=false;
 try {
  await a.query('begin');active=true;await a.query("select ff_private.open_correction($1,$2,'race correction')",[L,f.m]);
  const pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
  const pending=b.query("select ff_private.review_submission($1,$2,'approved',null)",[L,f.pending]).then(value=>({value}),error=>({error}));
  await waitForBlocking(pid);await a.query('commit');active=false;
  const res=await pending;assert.equal(res.error?.code,'23514');
  const results=await auditClient.query('select count(*)::int n from public.official_match_results where match_id=$1 and is_current',[f.m]);assert.equal(results.rows[0].n,0);
 } finally {if(active)await a.query('rollback');await a.end();await b.end();}
});
async function rosterFixture(){
 const m=randomUUID(),r=randomUUID(),line=randomUUID(),player=randomUUID(),reg=randomUUID();
 await auditClient.query("insert into public.player_profiles(id,league_id,display_name) values($1,$2,'Roster test')",[player,L]);
 await auditClient.query("insert into public.real_team_players(id,league_id,team_id,player_id,valid_from) values($1,$2,$3,$4,now()-interval '10 days')",[reg,L,A,player]);
 await auditClient.query("insert into public.real_matches(id,league_id,gameweek_id,team_a_id,team_b_id,organizer_id,starts_at,venue,starters_per_side,max_substitutes) values($1,$2,$3,$4,$5,$6,now(),'Roster audit',1,0)",[m,L,gw,A,B,organizer]);
 await auditClient.query('insert into public.match_revisions(id,league_id,match_id,version) values($1,$2,$3,1)',[r,L,m]);
 await auditClient.query('insert into public.real_match_lineups(id,league_id,match_id,revision_id,team_id) values($1,$2,$3,$4,$5)',[line,L,m,r,A]);
 return {m,r,line,player,reg};
}
const insertSelection=(c,f)=>c.query("insert into public.real_match_lineup_players(league_id,revision_id,lineup_id,player_id,selection,actual_position,eligibility_kind,eligibility_evidence) values($1,$2,$3,$4,'starter','MID','registered','{}')",[L,f.r,f.line,f.player]);
test('roster revocation commits before blocked lineup insertion: insertion fails',async()=>{
 const f=await rosterFixture(), a=await pgClient(), b=await pgClient();let active=false;
 try {
  await a.query('begin');active=true;await a.query("update public.real_team_players set valid_until=now()-interval '1 day' where id=$1",[f.reg]);
  const pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
  const pending=insertSelection(b,f).then(value=>({value}),error=>({error}));await waitForBlocking(pid);
  await a.query('commit');active=false;const result=await pending;assert.equal(result.error?.code,'23514');
  assert.equal((await auditClient.query('select count(*)::int n from public.real_match_lineup_players where revision_id=$1',[f.r])).rows[0].n,0);
 } finally {if(active)await a.query('rollback');await a.end();await b.end();}
});
test('lineup insertion commits before blocked roster revocation: revocation fails',async()=>{
 const f=await rosterFixture(), a=await pgClient(), b=await pgClient();let active=false;
 try {
  await a.query('begin');active=true;await insertSelection(a,f);
  const pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
  const pending=b.query("update public.real_team_players set valid_until=now()-interval '1 day' where id=$1",[f.reg]).then(value=>({value}),error=>({error}));await waitForBlocking(pid);
  await a.query('commit');active=false;const result=await pending;assert.equal(result.error?.code,'23514');
  assert.equal((await auditClient.query('select valid_until from public.real_team_players where id=$1',[f.reg])).rows[0].valid_until,null);
 } finally {if(active)await a.query('rollback');await a.end();await b.end();}
});
test('concurrent duplicate lineup selections do not both commit',async()=>{
 const f=await rosterFixture(),a=await pgClient(),b=await pgClient();let active=false;
 try {
  await a.query('begin');active=true;await insertSelection(a,f);
  const pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
  const pending=insertSelection(b,f).then(value=>({value}),error=>({error}));await waitForBlocking(pid);
  await a.query('commit');active=false;const result=await pending;assert.ok(['23505','23514'].includes(result.error?.code),result.error?.message);
  assert.equal((await auditClient.query('select count(*)::int n from public.real_match_lineup_players where revision_id=$1',[f.r])).rows[0].n,1);
 } finally {if(active)await a.query('rollback');await a.end();await b.end();}
});
test('correction invalidates a committed source run; blocked retry rejects stale source',async()=>{
 const f=await makeOfficialWithPending(),a=await pgClient(leader),b=await pgClient(leader);let active=false;
 try {
  const run=(await b.query('select ff_private.start_scoring($1,$2,$3::uuid[]) id',[L,gw,[f.official.id]])).rows[0].id;
  await a.query('begin');active=true;await a.query("select ff_private.open_correction($1,$2,'source race')",[L,f.m]);
  const pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
  const pending=b.query('select ff_private.start_scoring($1,$2,$3::uuid[]) id',[L,gw,[f.official.id]]).then(value=>({value}),error=>({error}));
  await waitForBlocking(pid);await a.query('commit');active=false;const res=await pending;assert.equal(res.error?.code,'23514');
  const row=(await auditClient.query('select status,sources_sealed from public.scoring_runs where id=$1',[run])).rows[0];assert.deepEqual(row,{status:'superseded',sources_sealed:true});
  await assert.rejects(auditClient.query('insert into public.scoring_run_sources(league_id,scoring_run_id,official_result_id,revision_id) values($1,$2,$3,$4)',[L,run,f.official.id,f.official.revision_id]),e=>e.code==='23514');
 } finally {if(active)await a.query('rollback');await a.end();await b.end();}
});

test('concurrent conflicting team registrations serialize and one is rejected',async()=>{
 const f=await rosterFixture(),a=await pgClient(),b=await pgClient();let active=false;
 try {
  await a.query('begin');active=true;
  await a.query("update public.real_team_players set valid_until=now()+interval '10 days' where id=$1",[f.reg]);
  const pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
  const pending=b.query("insert into public.real_team_players(league_id,team_id,player_id,valid_from) values($1,$2,$3,now()-interval '1 day')",[L,B,f.player]).then(value=>({value}),error=>({error}));
  await waitForBlocking(pid);await a.query('commit');active=false;
  const result=await pending;assert.equal(result.error?.code,'23514');
  assert.equal((await auditClient.query('select count(*)::int n from public.real_team_players where league_id=$1 and player_id=$2',[L,f.player])).rows[0].n,1);
 } finally {if(active)await a.query('rollback');await a.end();await b.end();}
});
test('roster and privileged approval fail closed under repeatable read',async()=>{
 const f=await rosterFixture(), c=await pgClient();
 try {
  await c.query('begin isolation level repeatable read');
  await assert.rejects(insertSelection(c,f),e=>e.code==='25001');await c.query('rollback');
  await c.query("select set_config('request.jwt.claim.sub',$1,false)",[leader]);await c.query('set role ff_test_gateway');
  await c.query('begin isolation level repeatable read');
  await assert.rejects(c.query('select ff_private.open_correction($1,$2,$3)',[L,match,'isolation test']),e=>e.code==='25001');
  await c.query('rollback');
 } finally {await c.end();}
});

test('approval racing ahead of correction publishes then correction atomically supersedes it',async()=>{
 const f=await createMatchFixture(),org=await pgClient(organizer),a=await pgClient(leader),b=await pgClient(leader);let active=false;
 try {
  const ls=(await org.query('select ff_private.submit_lineup($1,$2) id',[L,f.r])).rows[0].id;
  const lap=(await a.query("select ff_private.review_submission($1,$2,'approved',null) id",[L,ls])).rows[0].id;
  const rev=(await org.query('select ff_private.fork_result($1,$2) id',[L,lap])).rows[0].id;
  await org.query('select ff_private.set_result_score($1,$2,1,0)',[L,rev]);
  const sub=(await org.query('select ff_private.submit_result($1,$2,$3) id',[L,rev,lap])).rows[0].id;
  await a.query('begin');active=true;await a.query("select ff_private.review_submission($1,$2,'approved',null)",[L,sub]);
  const pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
  const pending=b.query("select ff_private.open_correction($1,$2,'approval first') id",[L,f.m]).then(value=>({value}),error=>({error}));
  await waitForBlocking(pid);await a.query('commit');active=false;const result=await pending;assert.ifError(result.error);
  const rows=(await auditClient.query('select revision_id,is_current from public.official_match_results where match_id=$1',[f.m])).rows;
  assert.deepEqual(rows,[{revision_id:rev,is_current:false}]);
  assert.equal((await auditClient.query('select count(*)::int n from public.match_corrections where match_id=$1',[f.m])).rows[0].n,1);
 } finally {if(active)await a.query('rollback');await org.end();await a.end();await b.end();}
});
test('sealed run lock excludes a concurrent source insertion',async()=>{
 const f=await makeOfficialWithPending(),a=await pgClient(),b=await pgClient(),lead=await pgClient(leader);let active=false;
 try {
  const run=(await lead.query('select ff_private.start_scoring($1,$2,$3::uuid[]) id',[L,gw,[f.official.id]])).rows[0].id;
  await a.query('begin');active=true;await a.query('select id from public.scoring_runs where id=$1 for update',[run]);
  const pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
  const pending=b.query('insert into public.scoring_run_sources(league_id,scoring_run_id,official_result_id,revision_id) values($1,$2,$3,$4)',[L,run,f.official.id,f.official.revision_id]).then(value=>({value}),error=>({error}));
  await waitForBlocking(pid);await a.query('commit');active=false;const result=await pending;assert.equal(result.error?.code,'23514');
  assert.equal((await auditClient.query('select count(*)::int n from public.scoring_run_sources where scoring_run_id=$1',[run])).rows[0].n,1);
 } finally {if(active)await a.query('rollback');await a.end();await b.end();await lead.end();}
});
test('older result submission is rejected when a newer result was submitted',async()=>{
 const f=await createMatchFixture(),org=await pgClient(organizer),lead=await pgClient(leader);
 try {
  const ls=(await org.query('select ff_private.submit_lineup($1,$2) id',[L,f.r])).rows[0].id;
  const lap=(await lead.query("select ff_private.review_submission($1,$2,'approved',null) id",[L,ls])).rows[0].id;
  async function submit(){const r=(await org.query('select ff_private.fork_result($1,$2) id',[L,lap])).rows[0].id;await org.query('select ff_private.set_result_score($1,$2,1,0)',[L,r]);return (await org.query('select ff_private.submit_result($1,$2,$3) id',[L,r,lap])).rows[0].id;}
  const old=await submit(),fresh=await submit();
  await assert.rejects(lead.query("select ff_private.review_submission($1,$2,'approved',null)",[L,old]),e=>e.code==='23514');
  await lead.query("select ff_private.review_submission($1,$2,'approved',null)",[L,fresh]);
  assert.equal((await auditClient.query('select count(*)::int n from public.official_match_results where match_id=$1 and is_current',[f.m])).rows[0].n,1);
 } finally {await org.end();await lead.end();}
});

test('a current official result prevents lineup replacement without a correction',async()=>{
 const f=await makeOfficialWithPending(),org=await pgClient(organizer);
 try {
  const rev=randomUUID(),la=randomUUID(),lb=randomUUID();
  await auditClient.query('insert into public.match_revisions(id,league_id,match_id,version) values($1,$2,$3,100)',[rev,L,f.m]);
  await auditClient.query('insert into public.real_match_lineups(id,league_id,match_id,revision_id,team_id) values($1,$2,$3,$4,$5),($6,$2,$3,$4,$7)',[la,L,f.m,rev,A,lb,B]);
  await auditClient.query("insert into public.real_match_lineup_players(league_id,revision_id,lineup_id,player_id,selection,actual_position,eligibility_kind,eligibility_evidence) values($1,$2,$3,$4,'starter','MID','registered','{}'),($1,$2,$5,$6,'starter','MID','registered','{}')",[L,rev,la,P1,lb,P2]);
  await assert.rejects(org.query('select ff_private.submit_lineup($1,$2)',[L,rev]),e=>e.code==='23514');
  assert.equal((await auditClient.query('select count(*)::int n from public.match_submissions where revision_id=$1',[rev])).rows[0].n,0);
 } finally {await org.end();}
});
