// Optional real-PostgreSQL compatibility run of the existing hardening suite.
// It refuses TCP and requires a disposable cluster under /tmp/ff-pg-audit.
// It is NOT a Supabase integration test; setup.sql mocks Auth and Storage.
import { PGlite } from '@electric-sql/pglite';
import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
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
      exec: sql => client.query(sql),
      close: () => client.end(),
    };
  } catch (error) { await client.end(); throw error; }
};
await import('./hardening.test.mjs');

// The tests below intentionally document defects in the unmodified 004 draft.
// A passing "witness" confirms the unsafe behavior exists; it is NOT a security
// pass. They run only in the disposable native PostgreSQL test cluster.
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
test('VULNERABILITY witness: a pending old result can be approved after a correction without lineup reapproval',async()=>{
 const lineup=await latestLineupApproval(),org=await pgClient(organizer),lead=await pgClient(leader);
 try {
  const r=(await org.query('select ff_private.fork_result($1,$2) as id',[L,lineup])).rows[0].id;
  await org.query('select ff_private.set_result_score($1,$2,3,0)',[L,r]);
  const submission=(await org.query('select ff_private.submit_result($1,$2,$3) as id',[L,r,lineup])).rows[0].id;
  const draft=(await lead.query("select ff_private.open_correction($1,$2,'audit witness') as id",[L,match])).rows[0].id;
  const approval=(await lead.query("select ff_private.review_submission($1,$2,'approved',null) as id",[L,submission])).rows[0].id;
  const official=await auditClient.query('select revision_id from public.official_match_results where league_id=$1 and match_id=$2 and is_current and approval_id=$3',[L,match,approval]);
  const corrected=await auditClient.query("select count(*)::int n from public.match_approvals where league_id=$1 and revision_id=$2 and kind='lineup' and decision='approved'",[L,draft]);
  assert.equal(official.rows[0].revision_id,r);assert.equal(corrected.rows[0].n,0);
  console.log('CONFIRMED: current result approved using pre-correction lineup while correction lineup lacks approval');
 } finally {await org.end();await lead.end();}
});
test('VULNERABILITY witness: organizer revocation during lock wait does not stop submission',async()=>{
 const f=await createMatchFixture(),locker=await pgClient(),victim=await pgClient(organizer);let open=false;
 try {
  await locker.query('begin');open=true;await locker.query('select id from public.real_matches where id=$1 for update',[f.m]);
  const pid=(await victim.query('select pg_backend_pid() pid')).rows[0].pid;
  const pending=victim.query('select ff_private.submit_lineup($1,$2) as id',[L,f.r]).then(value=>({value}),error=>({error}));
  await waitForBlocking(pid);
  await locker.query("update public.league_members set status='inactive' where league_id=$1 and user_id=$2",[L,organizer]);
  await locker.query('commit');open=false;
  const outcome=await pending;assert.ifError(outcome.error);
  const row=await auditClient.query('select submitted_by from public.match_submissions where id=$1',[outcome.value.rows[0].id]);assert.equal(row.rows[0].submitted_by,organizer);
  console.log('CONFIRMED: submission committed after organizer membership was revoked');
 } finally {
  if(open)await locker.query('rollback');
  await auditClient.query("update public.league_members set status='active' where league_id=$1 and user_id=$2",[L,organizer]);
  await locker.end();await victim.end();
 }
});
test('VULNERABILITY witness: leader revocation during lock wait does not stop approval',async()=>{
 const f=await createMatchFixture(),org=await pgClient(organizer),locker=await pgClient(),victim=await pgClient(leader);let open=false;
 try {
  const sub=(await org.query('select ff_private.submit_lineup($1,$2) as id',[L,f.r])).rows[0].id;
  await locker.query('begin');open=true;await locker.query('select id from public.real_matches where id=$1 for update',[f.m]);
  const pid=(await victim.query('select pg_backend_pid() pid')).rows[0].pid;
  const pending=victim.query("select ff_private.review_submission($1,$2,'approved',null) as id",[L,sub]).then(value=>({value}),error=>({error}));
  await waitForBlocking(pid);
  await locker.query("update public.league_members set status='inactive' where league_id=$1 and user_id=$2",[L,leader]);
  await locker.query('commit');open=false;
  const outcome=await pending;assert.ifError(outcome.error);
  const row=await auditClient.query('select reviewed_by from public.match_approvals where id=$1',[outcome.value.rows[0].id]);assert.equal(row.rows[0].reviewed_by,leader);
  console.log('CONFIRMED: approval committed after leader membership was revoked');
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
