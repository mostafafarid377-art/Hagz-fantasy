// Local PGlite authorization tests only; this is not a hosted Storage test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const db = await PGlite.create();
const load = async f => db.exec(await readFile(new URL(f, import.meta.url), 'utf8'));
await load('setup.sql');
for (const file of ['01_schema','02_security','03_storage','04_integrity_workflows','05_concurrency_hardening','06_revision_lineage','07_correction_attempts','08_result_fork_idempotency','09_ownership_and_grants','10_definer_ownership_transfer','11_application_api','12_definer_actor_identity','13_privilege_verification','14_api_surface_verification','15_actor_identity_claim_fallback','16_league_archive','18_player_image_uploads']) await load(`../../migrations/202611150000${file}.sql`);
// Stand-in policies in the disposable PGlite schema. This deliberately does NOT
// execute the owner-assisted SQL file and cannot verify the hosted owner step.
await db.exec(`
  create function storage.ff_player_image_exists(p_name text) returns boolean
    language sql stable security definer set search_path=pg_catalog as $$
      select exists(select 1 from storage.objects where bucket_id='player-images' and name=p_name)
    $$;
  revoke all on function storage.ff_player_image_exists(text) from public, anon, authenticated;
  grant execute on function storage.ff_player_image_exists(text) to ff_migration_owner;
  create policy test_reserved_insert on storage.objects for insert to authenticated
    with check (bucket_id='player-images' and ff_private.can_write_reserved_image(name,'insert'));
  create policy test_reserved_read on storage.objects for select to authenticated
    using (bucket_id='player-images' and ff_private.can_write_reserved_image(name,'read'));
  create policy test_reserved_delete on storage.objects for delete to authenticated
    using (bucket_id='player-images' and ff_private.can_write_reserved_image(name,'delete'));
  grant insert,delete on storage.objects to authenticated;
`);
after(() => db.close());
const q = (sql, args=[]) => db.query(sql,args);
const alice='00000000-0000-0000-0000-000000000001', bob='00000000-0000-0000-0000-000000000002', mallory='00000000-0000-0000-0000-000000000003';
await q('insert into auth.users(id) values ($1),($2),($3)',[alice,bob,mallory]);
async function as(user, cb) {
  await q("select set_config('request.jwt.claim.sub',$1,false)",[user]);
  await db.exec('set role authenticated');
  try { return await cb(); } finally { await db.exec('reset role'); }
}
const rpc=(user,name,...args)=>as(user,async()=> (await q(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) v`,args)).rows[0].v);
const insert=(user,path)=>as(user,()=>q("insert into storage.objects(bucket_id,name) values ('player-images',$1)",[path]));
const remove=(user,path)=>as(user,()=>q("delete from storage.objects where bucket_id='player-images' and name=$1 returning name",[path]));
const denied=async (fn,code='42501')=>assert.rejects(fn,e=>e.code===code);
for(const [user,name] of [[alice,'Alice'],[bob,'Bob'],[mallory,'Mallory']]) await rpc(user,'ff_bootstrap',name);
const league=await rpc(alice,'ff_league_create','Test League',100000000);
await rpc(bob,'ff_league_join',league.code);
const other=await rpc(mallory,'ff_league_create','Other League',100000000);
const player=await rpc(alice,'ff_market_upsert_player',league.id,'Image Player','MID',1000000,75);
const suggestion=await rpc(bob,'ff_suggestion_submit',league.id,'Suggested Player','MID');

test('leaders reserve and upload for their player; outsiders and managers cannot',async()=>{
  await denied(()=>rpc(bob,'ff_image_reserve',league.id,'player',player.player_id,'png'));
  await denied(()=>rpc(mallory,'ff_image_reserve',league.id,'player',player.player_id,'png'));
  await denied(()=>rpc(alice,'ff_image_reserve',other.id,'player',player.player_id,'png'));
  await denied(()=>rpc(alice,'ff_image_reserve',league.id,'player',player.player_id,'../png'),'23514');
  const {path}=await rpc(alice,'ff_image_reserve',league.id,'player',player.player_id,'png');
  await denied(()=>insert(bob,path));
  await denied(()=>insert(mallory,path));
  await denied(()=>insert(alice,path.replace('/players/','/../players/')));
  await insert(alice,path);
  assert.equal((await remove(alice,path)).rowCount,0,'a staged upload cannot race with attachment');
  await rpc(alice,'ff_image_set',league.id,'player',player.player_id,null,path);
  assert.equal((await rpc(alice,'ff_market_players',league.id))[0].image_path,path);
  assert.equal((await as(bob,()=>q('select name from storage.objects where name=$1',[path]))).rowCount,1);
  assert.equal((await as(mallory,()=>q('select name from storage.objects where name=$1',[path]))).rowCount,0);
  assert.equal((await remove(alice,path)).rowCount,0,'referenced image cannot be deleted');
  assert.equal((await remove(bob,path)).rowCount,0);
  globalThis.playerPath=path;
});

test('replacement and removal prevent unauthorized users and stale writes',async()=>{
  const old=globalThis.playerPath;
  await denied(()=>rpc(bob,'ff_image_set',league.id,'player',player.player_id,old,null));
  await denied(()=>rpc(mallory,'ff_image_set',league.id,'player',player.player_id,old,null));
  const next=(await rpc(alice,'ff_image_reserve',league.id,'player',player.player_id,'webp')).path;
  await denied(()=>rpc(alice,'ff_image_set',league.id,'player',player.player_id,old,next),'23514');
  await insert(alice,next);
  await denied(()=>rpc(alice,'ff_image_set',league.id,'player',player.player_id,'wrong',next),'40001');
  await rpc(alice,'ff_image_set',league.id,'player',player.player_id,old,next);
  assert.equal((await remove(alice,old)).rowCount,1,'unreferenced own old object can be cleaned up');
  await rpc(alice,'ff_image_set',league.id,'player',player.player_id,next,null);
  assert.equal((await remove(alice,next)).rowCount,1);
});

test('manager uploads only to own pending suggestion; approval preserves it',async()=>{
  await denied(()=>rpc(alice,'ff_image_reserve',league.id,'suggestion',suggestion.id,'jpg'));
  await denied(()=>rpc(mallory,'ff_image_reserve',league.id,'suggestion',suggestion.id,'jpg'));
  const path=(await rpc(bob,'ff_image_reserve',league.id,'suggestion',suggestion.id,'jpg')).path;
  await insert(bob,path);
  await rpc(bob,'ff_image_set',league.id,'suggestion',suggestion.id,null,path);
  await denied(()=>rpc(alice,'ff_image_set',league.id,'suggestion',suggestion.id,path,null));
  await denied(()=>rpc(bob,'ff_suggestion_submit',league.id,'Bad Path','MID',null,path));
  const approved=await rpc(alice,'ff_suggestion_review',league.id,suggestion.id,'approved',null,1000000,75,null);
  assert.ok(approved.league_player_id);
  assert.equal((await rpc(alice,'ff_market_players',league.id)).find(p=>p.id===approved.league_player_id).image_path,path);
  await denied(()=>rpc(bob,'ff_image_reserve',league.id,'suggestion',suggestion.id,'png'));
  assert.equal((await remove(bob,path)).rowCount,0);
});

test('anonymous and cross-tenant callers cannot reserve or attach a forged path', async () => {
  await db.exec('set role anon');
  try { await assert.rejects(()=>q('select public.ff_image_reserve($1,$2,$3,$4)',[league.id,'player',player.player_id,'png']),e=>e.code==='42501'); }
  finally { await db.exec('reset role'); }
  const forged=`${other.id}/players/00000000-0000-0000-0000-000000000001.png`;
  await denied(()=>rpc(alice,'ff_image_set',league.id,'player',player.player_id,null,forged));
  await denied(()=>rpc(bob,'ff_suggestion_submit',league.id,'Forged','MID',null,forged));
  await denied(()=>rpc(alice,'ff_market_upsert_player',league.id,'Forged Player','MID',1000000,75,true,forged,null),'23514');
  await denied(()=>insert(mallory,forged));
});

// Regression for the previously reproduced pending-image publication bypass.
test('only approval of the exact suggestion can publish its image', async () => {
  const charlie = '00000000-0000-0000-0000-000000000004';
  await q('insert into auth.users(id) values ($1)',[charlie]);
  await rpc(charlie,'ff_bootstrap','Charlie');
  await rpc(charlie,'ff_league_join',league.code);
  const privateSuggestion=await rpc(bob,'ff_suggestion_submit',league.id,'Private Pending','MID');
  const unrelated=await rpc(bob,'ff_suggestion_submit',league.id,'Another Pending','MID');
  const path=(await rpc(bob,'ff_image_reserve',league.id,'suggestion',privateSuggestion.id,'png')).path;
  await insert(bob,path);
  await rpc(bob,'ff_image_set',league.id,'suggestion',privateSuggestion.id,null,path);
  assert.equal((await as(charlie,()=>q('select name from storage.objects where name=$1',[path]))).rowCount,0);
  await denied(()=>rpc(charlie,'ff_image_reserve',league.id,'suggestion',privateSuggestion.id,'png'));
  await denied(()=>rpc(charlie,'ff_image_set',league.id,'suggestion',privateSuggestion.id,path,null));
  assert.equal((await remove(charlie,path)).rowCount,0);
  await denied(()=>rpc(alice,'ff_market_upsert_player',league.id,'Unrelated Player','MID',1000000,75,true,path,null));
  await denied(()=>rpc(alice,'ff_market_upsert_player',league.id,'Image Player','MID',1000000,75,true,path,null,player.player_id));
  await denied(()=>rpc(alice,'ff_suggestion_review',league.id,unrelated.id,'approved',null,1000000,75,path));
  await denied(()=>rpc(mallory,'ff_suggestion_review',other.id,unrelated.id,'approved',null,1000000,75,path));
  assert.equal((await as(charlie,()=>q('select name from storage.objects where name=$1',[path]))).rowCount,0);
  assert.equal((await rpc(bob,'ff_suggestions',league.id)).find(s=>s.id===privateSuggestion.id).status,'pending');
  await rpc(alice,'ff_suggestion_review',league.id,privateSuggestion.id,'approved',null,1000000,75,null);
  assert.equal((await as(charlie,()=>q('select name from storage.objects where name=$1',[path]))).rowCount,1,
    'matching approved suggestion image is readable only after approval');
});

// SECURITY/RELIABILITY FINDING: path-only compare-and-swap does not cover an
// existing URL. A stale removal with expected NULL can erase a newer URL.
test('SECURITY FINDING: a stale null-path removal erases a newer image URL', async () => {
  const p=await rpc(alice,'ff_market_upsert_player',league.id,'URL Race','MID',1000000,75);
  await rpc(alice,'ff_market_upsert_player',league.id,'URL Race','MID',1000000,75,true,null,'https://example.test/new.png',p.player_id);
  await rpc(alice,'ff_image_set',league.id,'player',p.player_id,null,null);
  const after=(await rpc(alice,'ff_market_players',league.id)).find(row=>row.id===p.id);
  assert.equal(after.image_url,null,'current draft silently loses the newer URL');
});

test('approval with image removal commits a profile without the suggestion image', async () => {
  const pending=await rpc(bob,'ff_suggestion_submit',league.id,'Removed on approval','MID',null,null,'https://example.test/old.png');
  const path=(await rpc(bob,'ff_image_reserve',league.id,'suggestion',pending.id,'png')).path;
  await insert(bob,path);
  await rpc(bob,'ff_image_set',league.id,'suggestion',pending.id,null,path);
  const approved=await rpc(alice,'ff_suggestion_review',league.id,pending.id,'approved',null,1000000,75,'__remove__');
  const profile=(await rpc(alice,'ff_market_players',league.id)).find(p=>p.id===approved.league_player_id);
  assert.equal(profile.image_path,null); assert.equal(profile.image_url,null);
  const charlie='00000000-0000-0000-0000-000000000004';
  assert.equal((await as(charlie,()=>q('select name from storage.objects where name=$1',[path]))).rowCount,0);
});

test('approval with removal also drops a legacy URL without any uploaded path', async () => {
  const pending=await rpc(bob,'ff_suggestion_submit',league.id,'Remove legacy url','MID',null,null,'https://example.test/old.png');
  const approved=await rpc(alice,'ff_suggestion_review',league.id,pending.id,'approved',null,1000000,75,'__remove__');
  const profile=(await rpc(alice,'ff_market_players',league.id)).find(p=>p.id===approved.league_player_id);
  assert.equal(profile.image_path,null); assert.equal(profile.image_url,null);
});

test('an in-flight suggestion upload blocks approval until attached or cancelled', async () => {
  const pending=await rpc(bob,'ff_suggestion_submit',league.id,'Concurrent draft','MID');
  const first=(await rpc(bob,'ff_image_reserve',league.id,'suggestion',pending.id,'png')).path;
  await insert(bob,first); await rpc(bob,'ff_image_set',league.id,'suggestion',pending.id,null,first);
  const next=(await rpc(bob,'ff_image_reserve',league.id,'suggestion',pending.id,'png')).path;
  await denied(()=>rpc(alice,'ff_suggestion_review',league.id,pending.id,'approved',null,1000000,75,null),'40001');
  await denied(()=>rpc(alice,'ff_image_cancel',league.id,'suggestion',pending.id,next));
  await insert(bob,next);
  await rpc(bob,'ff_image_set',league.id,'suggestion',pending.id,first,next);
  const approved=await rpc(alice,'ff_suggestion_review',league.id,pending.id,'approved',null,1000000,75,null);
  const profile=(await rpc(alice,'ff_market_players',league.id)).find(p=>p.id===approved.league_player_id);
  assert.equal(profile.image_path,next);
  await denied(()=>rpc(bob,'ff_image_reserve',league.id,'suggestion',pending.id,'png'));
  await denied(()=>rpc(bob,'ff_image_set',league.id,'suggestion',pending.id,next,first));
});

test('a failed suggestion upload can be cancelled and retried before approval', async () => {
  const pending=await rpc(bob,'ff_suggestion_submit',league.id,'Retry draft','MID');
  const abandoned=(await rpc(bob,'ff_image_reserve',league.id,'suggestion',pending.id,'png')).path;
  await denied(()=>rpc(alice,'ff_suggestion_review',league.id,pending.id,'approved',null,1000000,75,null),'40001');
  await rpc(bob,'ff_image_cancel',league.id,'suggestion',pending.id,abandoned);
  await denied(()=>rpc(bob,'ff_image_set',league.id,'suggestion',pending.id,null,abandoned));
  const retry=(await rpc(bob,'ff_image_reserve',league.id,'suggestion',pending.id,'png')).path;
  await insert(bob,retry); await rpc(bob,'ff_image_set',league.id,'suggestion',pending.id,null,retry);
  const approved=await rpc(alice,'ff_suggestion_review',league.id,pending.id,'approved',null,1000000,75,null);
  assert.equal((await rpc(alice,'ff_market_players',league.id)).find(p=>p.id===approved.league_player_id).image_path,retry);
});
