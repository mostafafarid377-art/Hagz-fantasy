// Optional native PostgreSQL concurrency test. The configured cluster must be
// disposable and local. No schemas or databases are dropped or reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
const socket=process.env.FF_PG_AUDIT_SOCKET, driver=process.env.FF_PG_AUDIT_DRIVER;
test('receipt serialization and cancellation against independent PostgreSQL connections', {skip: !socket || !driver}, async () => {
  const {Client}=createRequire(import.meta.url)(driver);
  if (!socket.startsWith('/tmp/')) throw new Error('A disposable local /tmp socket is required');
  const admin=new Client({host:socket,port:55432,user:'audit',database:'postgres'}); await admin.connect();
  const database=`ff_receipt_${randomBytes(8).toString('hex')}`;
  await admin.query(`create database ${database}`);
  const connect=async()=>{const c=new Client({host:socket,port:55432,user:'audit',database});await c.connect();return c;};
  const a=await connect(), b=await connect();
  try {
    const setup=(await readFile(new URL('./setup.sql',import.meta.url),'utf8'))
      .replace('create role anon nologin;', () => "do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if; end $$;")
      .replace('create role authenticated nologin;', () => "do $$ begin if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if; end $$;");
    await a.query(setup);
    const load=async(url)=>a.query(await readFile(url,'utf8'));
    const dir=new URL('../../migrations/',import.meta.url);
    for(const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) await load(new URL(f,dir));
    const actor='10000000-0000-4000-8000-000000000001';
    await a.query('insert into auth.users(id) values ($1)',[actor]);
    for (const c of [a,b]) {
      await c.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
      await c.query('set role authenticated');
    }
    await a.query('select public.ff_bootstrap($1)',['Alice']);
    const id='20000000-0000-4000-8000-000000000001', args={name:'Concurrent League',budget:100000000};
    await a.query('select public.ff_operation_register($1,$2,$3)',[id,'league_create',args]);
    await a.query('begin');
    const first=(await a.query('select public.ff_operation_execute($1) v',[id])).rows[0].v;
    assert.deepEqual((await b.query('select public.ff_operation_status($1) v',[id])).rows[0].v,{state:'pending'});
    let settled=false;
    const parallel=b.query('select public.ff_operation_execute($1) v',[id]).then(r=>{settled=true;return r.rows[0].v;});
    // Verify PostgreSQL observes the second connection blocked by the first.
    const until=Date.now()+3000;
    let blocked=false;
    do {
      const rows=await admin.query('select cardinality(pg_blocking_pids($1)) > 0 as blocked',[b.processID]);
      blocked=rows.rows[0].blocked;
      if (!blocked) await new Promise(resolve=>setTimeout(resolve,10));
    } while (!blocked && Date.now()<until);
    assert.equal(blocked,true,'second execution must wait for the receipt lock');
    assert.equal(settled,false);
    await a.query('commit');
    assert.deepEqual(await parallel,first);
    const count=(await a.query('select count(*)::int n from public.leagues where name=$1',[args.name])).rows[0].n;
    assert.equal(count,1);
    // A squad write and cancellation racing on one receipt cannot both win.
    const squad='20000000-0000-4000-8000-000000000003';
    const payload={league:first.result.id,captain:null,vice:null};
    await a.query('select public.ff_operation_register($1,$2,$3)',[squad,'squad_captains',payload]);
    await a.query('begin');
    const squadResult=(await a.query('select public.ff_operation_execute($1) v',[squad])).rows[0].v;
    const pendingCancel=b.query('select public.ff_operation_cancel($1) v',[squad]);
    let cancelBlocked=false; const cancelUntil=Date.now()+3000;
    do {
      cancelBlocked=(await admin.query('select cardinality(pg_blocking_pids($1)) > 0 as blocked',[b.processID])).rows[0].blocked;
      if (!cancelBlocked) await new Promise(resolve=>setTimeout(resolve,10));
    } while (!cancelBlocked && Date.now()<cancelUntil);
    assert.equal(cancelBlocked,true,'cancellation waits for execution');
    await a.query('commit');
    assert.deepEqual((await pendingCancel).rows[0].v,squadResult);
    assert.deepEqual((await b.query('select public.ff_operation_execute($1) v',[squad])).rows[0].v,squadResult);
    const late='20000000-0000-4000-8000-000000000002';
    await a.query('begin');
    await a.query('select public.ff_operation_cancel($1)',[late]);
    const registration=b.query('select public.ff_operation_register($1,$2,$3) v',[late,'league_create',args]);
    await a.query('commit');
    assert.deepEqual((await registration).rows[0].v,{state:'cancelled'});
    assert.deepEqual((await b.query('select public.ff_operation_execute($1) v',[late])).rows[0].v,{state:'cancelled'});
  } finally {await a.end();await b.end();await admin.end();}
});
