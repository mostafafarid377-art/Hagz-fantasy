// Disposable standalone PostgreSQL only. These tests describe current behavior,
// including known vulnerabilities; a passing FINDING test is NOT a security pass.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const { Client } = pg;
const url = new URL(process.env.HAGZ_TEST_DATABASE_URL ?? '');
if (process.env.HAGZ_DISPOSABLE_POSTGRES !== 'yes' || !['127.0.0.1','localhost','::1','[::1]'].includes(url.hostname) || url.pathname !== '/postgres')
  throw new Error('Refusing non-disposable or non-loopback Postgres target');
const database = `hagz_security_${randomUUID().replaceAll('-', '')}`;
const base = new Client({ connectionString: url.toString() });
let admin, a, b;
const alice='00000000-0000-0000-0000-000000000001', bob='00000000-0000-0000-0000-000000000002';
let league;
const sql = async (client, statement, args=[]) => client.query(statement,args);
async function rpc(c,name,...args) { return (await sql(c,`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) as v`,args)).rows[0].v; }
async function actor(c,id) { await sql(c,"select set_config('request.jwt.claim.sub',$1,false)",[id]); await sql(c,'set role authenticated'); }
async function initialImage(name) {
  const s=await rpc(b,'ff_suggestion_submit',league.id,name,'MID');
  const path=(await rpc(b,'ff_image_reserve',league.id,'suggestion',s.id,'png')).path;
  await sql(b,"insert into storage.objects(bucket_id,name) values ('player-images',$1)",[path]);
  await rpc(b,'ff_image_set',league.id,'suggestion',s.id,null,path);
  return {s,path};
}
async function approval(s) { return rpc(a,'ff_suggestion_review',league.id,s.id,'approved',null,1000000,75,null); }
async function assertBlocked(pid) {
  const deadline=Date.now()+5000;
  while(Date.now()<deadline) {
    if ((await sql(admin,'select cardinality(pg_blocking_pids($1)) as n',[pid])).rows[0].n>0) return;
    await new Promise(r=>setTimeout(r,20));
  }
  assert.fail('second independent session never blocked on the expected transaction');
}
async function beginLockedSuggestion() {
  // The authorized image operation below acquires the row lock.
  await sql(b,'begin');
}
async function race(s,operation) {
  await beginLockedSuggestion(s.id);
  await operation();
  const pending = approval(s);
  const pid=(await sql(admin,"select pid from pg_stat_activity where application_name='hagz-race-leader' and datname=current_database()" )).rows[0].pid;
  await assertBlocked(pid);
  await sql(b,'commit');
  return await pending;
}
before(async()=>{
  await base.connect(); await base.query(`create database "${database}"`);
  const dburl=new URL(url); dburl.pathname=`/${database}`;
  admin=new Client({connectionString:dburl.toString(),application_name:'hagz-race-admin'}); await admin.connect();
  const load=async path=>sql(admin,await readFile(new URL(path,import.meta.url),'utf8'));
  await load('../setup.sql');
  for(const file of ['01_schema','02_security','03_storage','04_integrity_workflows','05_concurrency_hardening','06_revision_lineage','07_correction_attempts','08_result_fork_idempotency','09_ownership_and_grants','10_definer_ownership_transfer','11_application_api','12_definer_actor_identity','13_privilege_verification','14_api_surface_verification','15_actor_identity_claim_fallback','16_league_archive','18_player_image_uploads']) await load(`../../../migrations/202611150000${file}.sql`);
  // Stand-in only; the owner-assisted Storage SQL file is never executed.
  await sql(admin,`create function storage.ff_player_image_exists(p_name text) returns boolean language sql stable security definer set search_path=pg_catalog as $$ select exists(select 1 from storage.objects where bucket_id='player-images' and name=p_name) $$;
    revoke all on function storage.ff_player_image_exists(text) from public, anon, authenticated;
    grant execute on function storage.ff_player_image_exists(text) to ff_migration_owner;
    create policy test_reserved_insert on storage.objects for insert to authenticated with check (bucket_id='player-images' and ff_private.can_write_reserved_image(name,'insert'));
    grant insert on storage.objects to authenticated;`);
  await sql(admin,'insert into auth.users(id) values ($1),($2)',[alice,bob]);
  a=new Client({connectionString:dburl.toString(),application_name:'hagz-race-leader'}); b=new Client({connectionString:dburl.toString(),application_name:'hagz-race-author'});
  await a.connect(); await b.connect(); await actor(a,alice); await actor(b,bob);
  await rpc(a,'ff_bootstrap','Alice'); await rpc(b,'ff_bootstrap','Bob'); league=await rpc(a,'ff_league_create','Race League',100000000); await rpc(b,'ff_league_join',league.code);
});
after(async()=>{
  await a?.end().catch(()=>{}); await b?.end().catch(()=>{}); await admin?.end().catch(()=>{});
  if (base._connected) {
    await base.query(`drop database if exists "${database}" with (force)`);
    assert.equal((await base.query('select 1 from pg_database where datname=$1',[database])).rowCount,0,'test database was deleted');
    await base.end();
  }
});

test('FINDING: approval waiting on replacement publishes updated image despite stale selection',async()=>{
  const {s,path}=await initialImage('Replacement race');
  const snapshot=(await rpc(a,'ff_suggestions',league.id)).find(x=>x.id===s.id);
  assert.equal(snapshot.image_path,path);
  const next=(await rpc(b,'ff_image_reserve',league.id,'suggestion',s.id,'png')).path;
  await sql(b,"insert into storage.objects(bucket_id,name) values ('player-images',$1)",[next]);
  const approved=await race(s,()=>rpc(b,'ff_image_set',league.id,'suggestion',s.id,path,next));
  const profile=(await rpc(a,'ff_market_players',league.id)).find(p=>p.id===approved.league_player_id);
  assert.equal(profile.image_path,next,'current RPC accepts stale approval with no expected revision');
});

test('FINDING: approval waiting on removal succeeds with no stale-version check',async()=>{
  const {s,path}=await initialImage('Removal race');
  assert.equal((await rpc(a,'ff_suggestions',league.id)).find(x=>x.id===s.id).image_path,path);
  const approved=await race(s,()=>rpc(b,'ff_image_set',league.id,'suggestion',s.id,path,null));
  const profile=(await rpc(a,'ff_market_players',league.id)).find(p=>p.id===approved.league_player_id);
  assert.equal(profile.image_path,null,'old image not published, but stale approval did not fail');
});

test('approval after cancellation uses original image; cancelled reservation cannot attach',async()=>{
  const {s,path}=await initialImage('Cancellation race');
  const next=(await rpc(b,'ff_image_reserve',league.id,'suggestion',s.id,'png')).path;
  const approved=await race(s,()=>rpc(b,'ff_image_cancel',league.id,'suggestion',s.id,next));
  const profile=(await rpc(a,'ff_market_players',league.id)).find(p=>p.id===approved.league_player_id);
  assert.equal(profile.image_path,path,'cancelled replacement does not replace the original');
  await assert.rejects(()=>rpc(b,'ff_image_set',league.id,'suggestion',s.id,path,next));
});

test('concurrent duplicate approvals serialize: one commits and one fails',async()=>{
  const {s}=await initialImage('Retry race');
  // Both connections act as leader; two physically separate backend sessions.
  await actor(b,alice); await sql(a,'begin');
  const first=await approval(s);
  const second=rpc(b,'ff_suggestion_review',league.id,s.id,'approved',null,1000000,75,null);
  const pid=(await sql(admin,"select pid from pg_stat_activity where application_name='hagz-race-author' and datname=current_database()" )).rows[0].pid;
  await assertBlocked(pid); await sql(a,'commit');
  await assert.rejects(second,e=>e.code==='23514');
  assert.ok(first.league_player_id); await actor(b,bob);
});

test('FINDING: direct reserved Storage object can be attached without validation',async()=>{
  const s=await rpc(b,'ff_suggestion_submit',league.id,'Direct bypass','MID');
  const path=(await rpc(b,'ff_image_reserve',league.id,'suggestion',s.id,'png')).path;
  await sql(b,"insert into storage.objects(bucket_id,name) values ('player-images',$1)",[path]);
  await rpc(b,'ff_image_set',league.id,'suggestion',s.id,null,path);
  const approved=await approval(s);
  const profile=(await rpc(a,'ff_market_players',league.id)).find(p=>p.id===approved.league_player_id);
  assert.equal(profile.image_path,path,'object metadata only; no trusted validation was invoked');
});

test('forged object path and cross-user cancellation are denied',async()=>{
  const s=await rpc(b,'ff_suggestion_submit',league.id,'Forged attempt','MID');
  const path=(await rpc(b,'ff_image_reserve',league.id,'suggestion',s.id,'png')).path;
  await assert.rejects(()=>sql(b,"insert into storage.objects(bucket_id,name) values ('player-images',$1)",[path.replace('/players/','/other/')]),e=>e.code==='42501');
  await assert.rejects(()=>rpc(a,'ff_image_cancel',league.id,'suggestion',s.id,path),e=>e.code==='42501');
  await rpc(b,'ff_image_cancel',league.id,'suggestion',s.id,path);
});

test('approval committing first prevents a concurrent author image removal',async()=>{
  const {s,path}=await initialImage('Approval first removal');
  await sql(a,'begin');
  const approved=await approval(s);
  // Query starts on a second connection while approval holds the suggestion lock.
  // Attach a handler immediately so a fast failure is never an unhandled rejection.
  const removal=rpc(b,'ff_image_set',league.id,'suggestion',s.id,path,null).then(
    value=>({value}), error=>({error}));
  const pid=(await sql(admin,"select pid from pg_stat_activity where application_name='hagz-race-author' and datname=current_database()")).rows[0].pid;
  await assertBlocked(pid); await sql(a,'commit');
  const result=await removal;
  assert.ok(result.error,'removal after committed approval must be rejected');
  assert.ok(['23514','42501'].includes(result.error.code), `unexpected error ${result.error.code}`);
  const profile=(await rpc(a,'ff_market_players',league.id)).find(p=>p.id===approved.league_player_id);
  assert.equal(profile.image_path,path,'approved player retains the image selected by this unversioned request');
});

test('FINDING: a stale null-path removal clears a newer URL in a separate session',async()=>{
  const p=await rpc(a,'ff_market_upsert_player',league.id,'Concurrent URL','MID',1000000,75);
  await actor(b,alice);
  await sql(a,'begin');
  await rpc(a,'ff_market_upsert_player',league.id,'Concurrent URL','MID',1000000,75,true,null,'https://example.test/new.png',p.player_id);
  const stale=rpc(b,'ff_image_set',league.id,'player',p.player_id,null,null).then(value=>({value}),error=>({error}));
  const pid=(await sql(admin,"select pid from pg_stat_activity where application_name='hagz-race-author' and datname=current_database()")).rows[0].pid;
  await assertBlocked(pid); await sql(a,'commit');
  const result=await stale;
  assert.ok(!result.error,'current API accepts stale null-path request');
  const after=(await rpc(a,'ff_market_players',league.id)).find(row=>row.id===p.id);
  assert.equal(after.image_url,null,'current draft loses the concurrently updated URL');
  await actor(b,bob);
});
