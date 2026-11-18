/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import { act, cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { LiveProvider, useLive } from './useLive';
import { SquadChangeNotice } from '../pages/live/Squad';
import { readOperation } from '../services/operationReceipts';
import '../translations';

const { rpc, session } = vi.hoisted(() => ({ rpc: vi.fn(), session: { actor: 'alice' as string | null } }));
vi.mock('../lib/supabase', () => ({ getSupabase: () => ({ rpc, auth: { getSession: async () => ({ data: { session: session.actor ? { user: { id: session.actor } } : null }, error: null }) } }), isSupabaseConfigured: true, looksLikeServiceRoleKey: () => false, PLAYER_IMAGES_BUCKET: 'player-images' }));
vi.mock('../services/points', () => ({ EMPTY_POINTS: {}, leaguePoints: async () => ({}) }));
const league = { league_id: 'league', name: 'League', role: 'leader' as const, status: 'active', budget: 100,
  market_open: true, archived: false, is_leader: true, is_organizer: false };
const ok = (data: unknown) => ({ data, error: null });
const squad = { team: { id: 'team', name: 'team' }, players: [], status: 'draft', formation: '4-3-3', gameweek_id: 'gw', captain_id: null, vice_captain_id: null, spent: 0, budget: 100 };
let ctx: ReturnType<typeof useLive>;
function Probe() { ctx = useLive(); return <><span data-testid="state">{ctx.squadChange ?? 'ready'}</span><SquadChangeNotice /></>; }
function Wrapper({ user = 'alice', children = <Probe /> }: { user?: string; children?: ReactNode }) {
  return <MemoryRouter><LiveProvider userId={user} initialLeagues={[league]} initialDirectoryLoaded>{children}</LiveProvider></MemoryRouter>;
}
let records: Map<string, { kind: string; payload: unknown; result?: unknown; state: string }>;
let lostRegister: boolean;
let operations: Array<{ actor: string; id: string; action: string; kind: string; payload: unknown }>;

beforeEach(async () => {
  cleanup(); localStorage.clear(); sessionStorage.clear();
  // Each test uses a fresh database; previous test reservations are not user data.
  await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase('ff-operation-receipts-v1'); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); });
  records = new Map(); operations = []; lostRegister = false; session.actor = 'alice';
  rpc.mockReset().mockImplementation(async (name: string, args: Record<string, any>) => {
    if (name === 'ff_squad') return ok(squad);
    if (name === 'ff_bootstrap') return ok({ profile: { id: 'alice' }, leagues: [league] });
    if (name !== 'ff_operation_for_actor') return ok([]);
    const { p_actor: actor, p_action: action, p_operation: id, p_kind: kind, p_payload: payload } = args;
    operations.push({ actor, id, action, kind, payload });
    const key = `${actor}:${id}`; let record = records.get(key);
    if (action === 'register') {
      const persisted = await readOperation(actor, kind === 'league_create' ? 'league-create' : `squad:${payload.league}`);
      expect(persisted).toMatchObject({ actorId: actor, operationId: id, kind, payload, recoveryState: 'unresolved' });
      if (!record) { record = { kind, payload: structuredClone(payload), state: 'pending' }; records.set(key, record); }
      if (lostRegister) { lostRegister = false; throw new TypeError('lost response'); }
      return ok({ state: record.state });
    }
    if (action === 'status') return ok(record ? { state: record.state, ...(record.result ? { result: record.result } : {}) } : { state: 'unknown' });
    if (action === 'cancel') { if (record?.state === 'committed') return ok({ state: 'committed', result: record.result }); records.set(key, { kind, payload, state: 'cancelled' }); return ok({ state: 'cancelled' }); }
    if (!record) return ok({ state: 'unknown' });
    if (record.state === 'cancelled') return ok({ state: 'cancelled' });
    record.state = 'committed'; record.result = record.kind === 'league_create' ? { id: 'league' } : { id: 'done' };
    return ok({ state: 'committed', result: record.result });
  });
});
afterEach(cleanup);
async function mount(user = 'alice') {
  const view = render(<Wrapper user={user} />);
  await waitFor(() => expect(ctx.loading).toBe(false));
  await waitFor(() => expect(ctx.squadChange).toBeNull());
  await waitFor(() => expect(ctx.leagueChange).toBeNull());
  return view;
}

describe('Live receipt integration', () => {
  it('persists a lost registration and retries the exact envelope after remount through visible controls', async () => {
    const view = await mount(); lostRegister = true;
    await act(async () => { await expect(ctx.buy('player')).rejects.toMatchObject({ code: 'outcomeUnknown' }); });
    const saved = await readOperation('alice', 'squad:league');
    expect(saved).toMatchObject({ kind: 'squad_buy', actorId: 'alice', payload: { league: 'league', player: 'player' }, recoveryState: 'unresolved' });
    view.unmount(); render(<Wrapper />);
    await waitFor(() => expect(ctx.squadChange).toBe('refreshRequired'));
    expect(screen.getByText('Retry same operation')).toBeTruthy();
    fireEvent.click(screen.getByText('Retry same operation'));
    await waitFor(() => expect(ctx.squadChange).toBe('reviewRequired'));
    const registers = operations.filter(x => x.action === 'register');
    expect(registers).toHaveLength(2);
    expect(registers[0]).toEqual(registers[1]);
    expect(await readOperation('alice', 'squad:league')).toBeUndefined();
  });
  it('restores and retries a league create without changing its ID or payload', async () => {
    const view = await mount(); lostRegister = true;
    await act(async () => { expect(await ctx.createLeague('New League')).toBe(false); });
    const saved = await readOperation('alice', 'league-create');
    expect(saved?.payload).toEqual({ name: 'New League', budget: 100000000 });
    view.unmount(); render(<Wrapper />);
    await waitFor(() => expect(ctx.leagueChange?.phase).toBe('verificationRequired'));
    await act(async () => { expect(await ctx.retryLeagueReceipt()).toBe(true); });
    const registers = operations.filter(x => x.action === 'register');
    expect(registers).toHaveLength(2); expect(registers[0]).toEqual(registers[1]);
    expect(await readOperation('alice', 'league-create')).toBeUndefined();
  });
  it('checks the current auth session before a retry, including sign-out', async () => {
    await mount(); lostRegister = true;
    await act(async () => { await expect(ctx.buy('player')).rejects.toThrow(); });
    const before = operations.length;
    session.actor = null;
    await act(async () => { await ctx.retrySquadReceipt(); });
    session.actor = 'bob';
    await act(async () => { await ctx.retrySquadReceipt(); });
    expect(operations).toHaveLength(before);
    expect(await readOperation('alice', 'squad:league')).toBeDefined();
  });
  it('checks committed registration via status without executing again', async () => {
    const view = await mount(); lostRegister = true;
    await act(async () => { await expect(ctx.buy('player')).rejects.toThrow(); });
    const op = await readOperation('alice', 'squad:league');
    records.set(`alice:${op!.operationId}`, { kind: 'squad_buy', payload: op!.payload, state: 'committed', result: { id: 'done' } });
    view.unmount(); render(<Wrapper />);
    await waitFor(() => expect(ctx.squadChange).toBe('refreshRequired'));
    await act(async () => { await ctx.retrySquadReceipt(); });
    expect(operations.map(x => x.action)).toEqual(['register', 'register', 'status']);
    expect(ctx.squadChange).toBe('reviewRequired');
  });
  it('does not submit a previous account operation on account switch', async () => {
    const view = await mount(); lostRegister = true;
    await act(async () => { await expect(ctx.buy('player')).rejects.toThrow(); });
    view.unmount(); session.actor = 'bob'; await mount('bob');
    expect(await readOperation('alice', 'squad:league')).toBeDefined();
    expect(await readOperation('bob', 'squad:league')).toBeUndefined();
    await act(async () => { await ctx.retrySquadReceipt(); });
    expect(operations.every(op => op.actor === 'alice')).toBe(true);
  });
  it('blocks duplicate submission while registration is delayed and after sign-out never executes', async () => {
    const view = await mount();
    const base = rpc.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    rpc.mockImplementation(async (name: string, args: Record<string, any>) => {
      if (name === 'ff_operation_for_actor' && args.p_action === 'register') await gate;
      return base(name, args);
    });
    let first!: Promise<void>;
    await act(async () => { first = ctx.buy('a'); });
    await expect(ctx.buy('b')).rejects.toMatchObject({ code: 'invalidState' });
    await waitFor(() => expect(rpc.mock.calls.some(([name, args]) => name === 'ff_operation_for_actor' && args.p_action === 'register')).toBe(true));
    view.unmount(); session.actor = null;
    release();
    await act(async () => { await first; });
    expect(operations.filter(x => x.action === 'register')).toHaveLength(1);
    expect(operations.filter(x => x.action === 'execute')).toHaveLength(0);
    expect(await readOperation('alice', 'squad:league')).toBeDefined();
  });
  it('keeps unknown unresolved until explicit cancellation and authoritative refresh', async () => {
    await mount(); lostRegister = true;
    await act(async () => { await expect(ctx.sell('a')).rejects.toThrow(); });
    records.clear(); // emulate a registration that never reached the server
    await act(async () => { await ctx.refreshSquad(); });
    expect(ctx.squadChange).toBe('refreshRequired');
    expect(await readOperation('alice', 'squad:league')).toBeDefined();
    await act(async () => { await ctx.cancelSquadReceipt(); });
    expect(ctx.squadChange).toBe('reviewRequired');
    expect(await readOperation('alice', 'squad:league')).toBeUndefined();
  });
  it.each([
    { kind: 'league_create', payload: { name: 'New', budget: 100000000 }, scope: 'league-create', create: true,
      run: () => ctx.createLeague('New') },
    { kind: 'squad_buy', payload: { league: 'league', player: 'a' }, scope: 'squad:league', run: () => ctx.buy('a') },
    { kind: 'squad_sell', payload: { league: 'league', player: 'b' }, scope: 'squad:league', run: () => ctx.sell('b') },
    { kind: 'squad_transfer', payload: { league: 'league', out: 'a', in: 'b' }, scope: 'squad:league', run: () => ctx.transfer('a', 'b') },
    { kind: 'squad_captains', payload: { league: 'league', captain: 'a', vice: null }, scope: 'squad:league', run: () => ctx.setSquadCaptains('a', null) },
    { kind: 'lineup_save', payload: { league: 'league', gameweek: 'gw', formation: '4-3-3', players: ['a'], captain: null, vice: null }, scope: 'squad:league', run: () => ctx.saveLineup({ formation: '4-3-3', playerIds: ['a'], captainId: null, viceCaptainId: null, gameweekId: 'gw' }) },
    { kind: 'lineup_confirm', payload: { league: 'league', lineup: 'lineup' }, scope: 'squad:league', run: () => ctx.confirmLineup('lineup') },
  ])('$kind preserves the exact persisted envelope across a lost response and retry', async ({ kind, payload, scope, create, run }) => {
    const view = await mount(); lostRegister = true;
    await act(async () => { if (create) expect(await run()).toBe(false); else await expect(run()).rejects.toMatchObject({ code: 'outcomeUnknown' }); });
    const saved = await readOperation('alice', scope);
    expect(saved).toMatchObject({ actorId: 'alice', kind, payload, recoveryState: 'unresolved' });
    expect(saved?.createdAt).toBeTruthy(); expect(saved?.operationId).toBeTruthy();
    view.unmount(); render(<Wrapper />);
    await waitFor(() => expect(create ? ctx.leagueChange?.phase : ctx.squadChange).toBe(create ? 'verificationRequired' : 'refreshRequired'));
    if (create) await act(async () => { expect(await ctx.retryLeagueReceipt()).toBe(true); });
    else await act(async () => { await ctx.retrySquadReceipt(); });
    const registers = operations.filter(op => op.action === 'register');
    expect(registers).toHaveLength(2);
    expect(registers[0]).toEqual(registers[1]);
    expect(registers[0]).toMatchObject({ id: saved?.operationId, actor: 'alice', kind, payload });
    expect(operations.filter(op => op.action === 'execute')).toHaveLength(1);
    expect(rpc.mock.calls.some(([name]) => ['ff_league_create', 'ff_squad_buy', 'ff_squad_sell', 'ff_squad_transfer', 'ff_squad_set_captains', 'ff_lineup_save', 'ff_lineup_confirm'].includes(name))).toBe(false);
  });
  it('never reports success when a new operation is cancelled before execution', async () => {
    await mount();
    const base = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (name: string, args: Record<string, any>) => {
      if (name === 'ff_operation_for_actor' && args.p_action === 'execute') return ok({ state: 'cancelled' });
      return base(name, args);
    });
    await act(async () => { await expect(ctx.buy('player')).rejects.toMatchObject({ code: 'invalidState', detail: 'receipt-cancelled' }); });
    expect(await readOperation('alice', 'squad:league')).toBeUndefined();
  });
  it('retains the guard if conflict cancellation reports a commit but the squad read fails', async () => {
    await mount();
    const base = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (name: string, args: Record<string, any>) => {
      if (name === 'ff_operation_for_actor' && args.p_action === 'execute') return { data: null, error: { code: '40001', message: 'conflict' } };
      if (name === 'ff_operation_for_actor' && args.p_action === 'cancel') return ok({ state: 'committed', result: { id: 'done' } });
      if (name === 'ff_squad') return { data: null, error: { code: 'PGRST003', message: 'pool timeout' }, status: 504 };
      return base(name, args);
    });
    await act(async () => { await expect(ctx.buy('player')).rejects.toMatchObject({ code: 'outcomeUnknown' }); });
    expect(ctx.squadChange).toBe('refreshRequired');
    expect(await readOperation('alice', 'squad:league')).toBeDefined();
  });
  it('does not treat a pending status as success or send a duplicate write', async () => {
    await mount(); lostRegister = true;
    await act(async () => { await expect(ctx.buy('player')).rejects.toThrow(); });
    await act(async () => { await ctx.refreshSquad(); });
    expect(ctx.squadChange).toBe('refreshRequired');
    expect(operations.map(op => op.action)).toEqual(['register', 'status']);
    await expect(ctx.buy('player')).rejects.toMatchObject({ code: 'invalidState' });
    expect(operations.map(op => op.action)).toEqual(['register', 'status']);
    await act(async () => { await ctx.cancelSquadReceipt(); });
    expect(ctx.squadChange).toBe('reviewRequired');
  });
  it('handles a cancelled receipt returned by status without executing', async () => {
    const view = await mount(); lostRegister = true;
    await act(async () => { await expect(ctx.sell('player')).rejects.toThrow(); });
    const op = await readOperation('alice', 'squad:league');
    records.set(`alice:${op!.operationId}`, { kind: op!.kind, payload: op!.payload, state: 'cancelled' });
    view.unmount(); render(<Wrapper />);
    await waitFor(() => expect(ctx.squadChange).toBe('refreshRequired'));
    await act(async () => { await ctx.refreshSquad(); });
    expect(ctx.squadChange).toBe('reviewRequired');
    expect(operations.map(x => x.action)).toEqual(['register', 'status']);
    expect(await readOperation('alice', 'squad:league')).toBeUndefined();
  });
  it('routes all provider mutation kinds through actor-bound receipts', async () => {
    await mount();
    const jobs = [
      () => ctx.createLeague('New'), () => ctx.buy('a'), () => ctx.sell('b'), () => ctx.transfer('a', 'b'),
      () => ctx.setSquadCaptains('a', null), () => ctx.saveLineup({ formation: '4-3-3', playerIds: ['a'], captainId: null, viceCaptainId: null, gameweekId: 'gw' }),
      () => ctx.confirmLineup('lineup'),
    ];
    for (const job of jobs) await act(async () => { await job(); });
    expect(operations.filter(x => x.action === 'register').map(x => x.kind)).toEqual([
      'league_create', 'squad_buy', 'squad_sell', 'squad_transfer', 'squad_captains', 'lineup_save', 'lineup_confirm',
    ]);
    expect(operations.every(x => x.actor === 'alice')).toBe(true);
    expect(rpc.mock.calls.some(([name]) => ['ff_league_create', 'ff_squad_buy', 'ff_squad_sell', 'ff_squad_transfer', 'ff_squad_set_captains', 'ff_lineup_save', 'ff_lineup_confirm'].includes(name))).toBe(false);
  });
});
