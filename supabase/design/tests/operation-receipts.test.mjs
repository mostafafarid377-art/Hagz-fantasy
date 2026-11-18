// Local PGlite tests only; never connects to a hosted database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

for (const with026 of [false, true]) test(`receipt protocol with ${with026 ? 'design 026' : 'executable schema'}`, async () => {
  const db = await PGlite.create();
  try {
    const load = async (url) => db.exec(await readFile(url, 'utf8'));
    await load(new URL('./setup.sql', import.meta.url));
    const dir = new URL('../../migrations/', import.meta.url);
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql') && !f.includes('operation_receipts')).sort()) await load(new URL(f, dir));
    if (with026) await load(new URL('../migrations/026_squad_assignments_and_formats.sql', import.meta.url));
    await load(new URL('../../migrations/20261118000000_operation_receipts.sql', import.meta.url));
    const alice='10000000-0000-4000-8000-000000000001', bob='10000000-0000-4000-8000-000000000002';
    const op='20000000-0000-4000-8000-000000000001', cancelled='20000000-0000-4000-8000-000000000002';
    await db.query('insert into auth.users(id) values ($1),($2)',[alice,bob]);
    const as = async (id, fn, ...args) => {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
      await db.exec('set role authenticated');
      try { return (await db.query(`select public.${fn}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as value`,args)).rows[0].value; }
      finally { await db.exec('reset role'); }
    };
    await as(alice,'ff_bootstrap','Alice'); await as(bob,'ff_bootstrap','Bob');
    const payload={name:'Receipt League', budget:100000000};
    await assert.rejects(() => as(bob,'ff_operation_for_actor',alice,'register',op,'league_create',payload),{code:'42501'});
    assert.deepEqual(await as(alice,'ff_operation_for_actor',alice,'status',op,null,null),{state:'unknown'});

    assert.deepEqual(await as(alice,'ff_operation_status',op),{state:'unknown'});
    assert.deepEqual(await as(alice,'ff_operation_register',op,'league_create',payload),{state:'pending'});
    for (const action of ['execute','status','cancel']) {
      await assert.rejects(() => as(bob,'ff_operation_for_actor',alice,action,op,null,null),{code:'42501'});
    }
    assert.deepEqual(await as(alice,'ff_operation_status',op),{state:'pending'});
    assert.deepEqual(await as(alice,'ff_operation_register',op,'league_create',payload),{state:'pending'});
    await assert.rejects(() => as(alice,'ff_operation_register',op,'league_create',{...payload,name:'Other'}), { code:'23514' });
    const first=await as(alice,'ff_operation_execute',op);
    assert.equal(first.state,'committed'); assert.ok(first.result.id);
    assert.deepEqual(await as(alice,'ff_operation_execute',op),first);
    assert.deepEqual(await as(alice,'ff_operation_status',op),first);
    assert.deepEqual(await as(bob,'ff_operation_status',op),{state:'unknown'});
    const count=(await db.query("select count(*)::int n from public.leagues where name='Receipt League'")).rows[0].n;
    assert.equal(count,1);
    assert.deepEqual(await as(alice,'ff_operation_cancel',cancelled),{state:'cancelled'});
    assert.deepEqual(await as(alice,'ff_operation_register',cancelled,'league_create',payload),{state:'cancelled'});
    assert.deepEqual(await as(alice,'ff_operation_execute',cancelled),{state:'cancelled'});
    // A rejected domain mutation rolls back and never becomes a success receipt.
    const invalid='20000000-0000-4000-8000-000000000005';
    const invalidPayload={league:first.result.id,player:'30000000-0000-4000-8000-000000000001'};
    await as(alice,'ff_operation_register',invalid,'squad_buy',invalidPayload);
    await assert.rejects(() => as(alice,'ff_operation_execute',invalid));
    assert.deepEqual(await as(alice,'ff_operation_status',invalid),{state:'pending'});
    assert.deepEqual(await as(alice,'ff_operation_cancel',invalid),{state:'cancelled'});
    assert.deepEqual(await as(alice,'ff_operation_execute',invalid),{state:'cancelled'});
    // Switching identities never exposes another actor's receipt or result.
    assert.deepEqual(await as(bob,'ff_operation_execute',op),{state:'unknown'});
    assert.deepEqual(await as(bob,'ff_operation_cancel',op),{state:'cancelled'});
    assert.deepEqual(await as(alice,'ff_operation_status',op),first);
    const squadOp='20000000-0000-4000-8000-000000000003';
    await assert.rejects(() => as(bob,'ff_operation_register',squadOp,'squad_captains',{league:first.result.id,captain:null,vice:null}),{code:'42501'});
    assert.deepEqual(await as(alice,'ff_operation_register',squadOp,'squad_captains',{league:first.result.id,captain:null,vice:null}),{state:'pending'});
    const squadResult=await as(alice,'ff_operation_execute',squadOp);
    assert.equal(squadResult.state,'committed');
    assert.deepEqual(await as(alice,'ff_operation_execute',squadOp),squadResult);
    assert.deepEqual(await as(alice,'ff_operation_cancel',squadOp),squadResult);
    // Every migrated Live squad mutation, including duplicates, runs through
    // the actor-bound entry point against each real schema variant.
    let serial = 100;
    const viaReceipt = async (kind, data) => {
      const id = `40000000-0000-4000-8000-${String(serial++).padStart(12, '0')}`;
      assert.deepEqual(await as(alice, 'ff_operation_for_actor', alice, 'register', id, kind, data), { state:'pending' });
      const done = await as(alice, 'ff_operation_for_actor', alice, 'execute', id, null, null);
      assert.equal(done.state, 'committed');
      assert.deepEqual(await as(alice, 'ff_operation_for_actor', alice, 'execute', id, null, null), done);
      assert.deepEqual(await as(alice, 'ff_operation_for_actor', alice, 'status', id, null, null), done);
      return done.result;
    };
    const leagueId=first.result.id;
    await as(alice,'ff_league_set_market',leagueId,true);
    const players = { GK:[], DEF:[], MID:[], FWD:[] };
    for (const [position, count] of Object.entries({GK:2, DEF:5, MID:5, FWD:4})) {
      for (let i=0; i<count; i++) {
        const player=await as(alice,'ff_market_upsert_player',leagueId,`${position} ${i}`,position,1000000,70);
        players[position].push(player.id);
      }
    }
    for (const [position, ids] of Object.entries(players)) {
      for (const player of ids.slice(0, position === 'FWD' ? 3 : ids.length)) {
        await viaReceipt('squad_buy',{league:leagueId,player});
      }
    }
    await viaReceipt('squad_sell',{league:leagueId,player:players.GK[1]});
    await viaReceipt('squad_buy',{league:leagueId,player:players.GK[1]});
    const season=await as(alice,'ff_season_create',leagueId,'Receipt Season','2025-08-01T00:00:00Z','2026-05-31T00:00:00Z',3);
    await viaReceipt('squad_transfer',{league:leagueId,out:players.FWD[2],in:players.FWD[3]});
    const ordered=[players.GK[0],...players.DEF.slice(0,4),...players.MID.slice(0,3),players.FWD[0],players.FWD[1],players.FWD[3],players.GK[1],players.DEF[4],...players.MID.slice(3)];
    const saved=await viaReceipt('lineup_save',{league:leagueId,gameweek:season.gameweeks[0].id,formation:'4-3-3',players:ordered,captain:players.GK[0],vice:players.DEF[0]});
    assert.equal(saved.status,'draft');
    await viaReceipt('squad_captains',{league:leagueId,captain:players.GK[0],vice:players.DEF[0]});
    const confirmed=await viaReceipt('lineup_confirm',{league:leagueId,lineup:saved.lineup_id});
    assert.equal(confirmed.status,'confirmed');
    await db.query("update public.league_members set status='inactive' where user_id=$1 and league_id=$2",[alice,first.result.id]);
    await assert.rejects(() => as(alice,'ff_operation_status',op),{code:'42501'});
    await assert.rejects(() => as(alice,'ff_operation_status',squadOp),{code:'42501'});
    await db.query("update public.league_members set status='active' where user_id=$1 and league_id=$2",[alice,first.result.id]);
    await db.exec('set role authenticated');
    await assert.rejects(() => db.query('select * from ff_private.operation_receipts'));
    await db.exec('reset role');
    // Cutover is separately gated and never part of the executable package.
    const cutover=await readFile(new URL('../proposed/20261118010000_operation_receipts_cutover.sql',import.meta.url),'utf8');
    await assert.rejects(() => db.exec(cutover), /not approved/);
    await db.exec('rollback');
    await db.query("select set_config('ff.confirm_receipt_cutover','reviewed',false)");
    await db.exec(cutover);
    const privileges=await db.query(`select p.proname, has_function_privilege('authenticated',p.oid,'execute') as allowed
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('ff_league_create','ff_squad_buy','ff_squad_sell',
        'ff_squad_transfer','ff_squad_set_captains','ff_squad_substitute','ff_squad_save_assignments','ff_lineup_save','ff_lineup_confirm')`);
    assert.ok(privileges.rows.length >= 7);
    assert.ok(privileges.rows.every(row => !row.allowed));
    await assert.rejects(() => as(alice,'ff_league_create','Legacy league',100000000),{code:'42501'});
    const post='20000000-0000-4000-8000-000000000004';
    assert.deepEqual(await as(alice,'ff_operation_register',post,'league_create',{name:'After Cutover',budget:100000000}),{state:'pending'});
    assert.equal((await as(alice,'ff_operation_execute',post)).state,'committed');
  } finally { await db.close(); }
});
