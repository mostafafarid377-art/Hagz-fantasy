import { receiptServer } from '../test/receiptServer';
import '../test/indexedDbSetup';
/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiSquad } from '../types/api';
import { LiveProvider, useLive } from './useLive';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
let handleReceipt: ReturnType<typeof receiptServer>;
let actor = 'user-one';
vi.mock('../lib/supabase', () => ({ getSupabase: () => ({ rpc: (name: string, args: Record<string, any>) => name === 'ff_operation_for_actor' ? handleReceipt(args) : rpc(name, args), auth: { getSession: async () => ({ data: { session: { user: { id: actor } } }, error: null }) } }) }));
vi.mock('../services/points', () => ({ EMPTY_POINTS: {}, leaguePoints: async () => ({}) }));

const leagues = ['A', 'B'].map((id) => ({
  league_id: id, name: id, role: 'manager' as const, status: 'active', budget: 100,
  market_open: true, archived: false, is_leader: false, is_organizer: false,
}));

function squad(id: string, changed = false): ApiSquad {
  return {
    team: { id: `team-${id}`, name: id },
    status: 'draft', formation: changed ? '4-4-2' : '4-3-3', gameweek_id: `gw-${id}`,
    captain_id: changed ? 'in' : 'out', vice_captain_id: null, players: [
      { league_player_id: 'out', slot: changed ? 12 : 1, name: 'Outgoing', position: 'GK', price: 5, rating: 70, image_path: null, image_url: null, active: true, captain: !changed, vice_captain: false },
      { league_player_id: 'in', slot: changed ? 1 : 12, name: 'Incoming', position: 'GK', price: 5, rating: 70, image_path: null, image_url: null, active: true, captain: changed, vice_captain: false },
    ], spent: 10, budget: 100,
  };
}

const ok = (data: unknown) => ({ data, error: null });
const failure = (code: string, message: string, status = 500) => ({ data: null, error: { code, message }, status });
const stale = failure('40001', 'squad changed elsewhere; reload before substituting');
const poolTimeout = failure('PGRST003', 'pool checkout timed out', 504);
type RpcResult = ReturnType<typeof ok> | ReturnType<typeof failure>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const lineup = { formation: '4-3-3', playerIds: ['in', 'out'], captainId: 'out', viceCaptainId: null };
const calls = () => rpc.mock.calls.map(([name]) => name);

async function mount(userId = 'user-one') {
  actor = userId;
  const app = renderHook(useLive, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <LiveProvider userId={userId} initialLeagues={leagues} initialDirectoryLoaded>{children}</LiveProvider>
    ),
  });
  await act(async () => { if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0); else await new Promise(resolve => setTimeout(resolve, 10)); });
  await waitFor(() => expect(app.result.current.squadChange).toBeNull());
  return app;
}

beforeEach(() => {
  localStorage.clear();
  handleReceipt = receiptServer((name, args) => rpc(name, args));
  rpc.mockReset().mockImplementation(async (name: string, args: { p_league: string }) => {
    if (name === 'ff_squad') return ok(squad(args.p_league));
    return ok([]);
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('the session provider gates squad writes per team', () => {
  it('rejects overlap synchronously, including the explicit save and other writes, without queuing', async () => {
    const write = deferred<RpcResult>();
    const verify = deferred<RpcResult>();
    const app = await mount();
    rpc.mockClear();
    rpc.mockImplementation(async (name: string) => {
      if (name === 'ff_lineup_save') return write.promise;
      if (name === 'ff_squad') return verify.promise;
      return ok([]);
    });
    let first!: Promise<void>;
    await act(async () => {
      const { saveLineup, buy, transfer } = app.result.current;
      first = saveLineup(lineup);
      // Same tick: none of these callers has seen a re-render yet.
      const errors = await Promise.allSettled([saveLineup(lineup), buy('other'), transfer('out', 'other')]);
      expect(errors).toEqual(Array(3).fill(expect.objectContaining({
        status: 'rejected', reason: expect.objectContaining({ code: 'invalidState', message: expect.stringMatching(/already in progress/) }),
      })));
    });
    await waitFor(() => expect(calls()).toEqual(['ff_lineup_save']));
    expect(app.result.current.squadChange).toBe('saving');

    await act(async () => { write.resolve(ok({})); });
    expect(calls().filter((name) => name === 'ff_lineup_save')).toHaveLength(1);
    await expect(app.result.current.saveLineup(lineup)).rejects.toThrow(/already in progress/);
    await act(async () => { verify.resolve(ok(squad('A', true))); await first; });
    expect(app.result.current.squadChange).toBeNull();
    expect(app.result.current.squad).toEqual(squad('A', true));
    expect(calls().filter((name) => name === 'ff_lineup_save')).toHaveLength(1);
    expect(calls()).not.toContain('ff_bootstrap');
  });

  it('lets a second team save while the first is pending and never reloads the old league on completion', async () => {
    const writeA = deferred<RpcResult>();
    const writeB = deferred<RpcResult>();
    const app = await mount();
    rpc.mockImplementation(async (name: string, args: { p_league: string }) => {
      if (name === 'ff_lineup_save') return (args.p_league === 'A' ? writeA : writeB).promise;
      return name === 'ff_squad' ? ok(squad(args.p_league)) : ok([]);
    });

    let saveA!: Promise<void>;
    await act(async () => { saveA = app.result.current.saveLineup(lineup); });
    await waitFor(() => expect(calls()).toContain('ff_lineup_save'));
    await act(async () => { app.result.current.selectLeague('B'); });
    await waitFor(() => expect(app.result.current.squadChange).toBeNull());
    let saveB!: Promise<void>;
    await act(async () => { saveB = app.result.current.saveLineup(lineup); });
    await waitFor(() => expect(rpc.mock.calls.filter(([name]) => name === 'ff_lineup_save').map(([, args]) => args.p_league))
      .toEqual(['A', 'B']));

    // Switching back doesn't open a second slot for the same still-pending team.
    await act(async () => { app.result.current.selectLeague('A'); });
    await expect(app.result.current.saveLineup(lineup)).rejects.toThrow(/already in progress/);
    await act(async () => { app.result.current.selectLeague('B'); });
    expect(app.result.current.squadChange).toBe('saving');
    rpc.mockClear();
    await act(async () => { writeA.resolve(ok({})); await saveA; });
    expect(calls()).toEqual([]);
    expect(app.result.current.leagueId).toBe('B');
    expect(app.result.current.squadChange).toBe('saving');
    await act(async () => { writeB.resolve(ok({})); await saveB; });
    expect(app.result.current.squadChange).toBeNull();
    expect(app.result.current.squad?.team?.id).toBe('team-B');
    expect(calls()).not.toContain('ff_bootstrap');
    await act(async () => { app.result.current.selectLeague('A'); });
    expect(app.result.current.squadChange).toBe('refreshRequired');
    await act(async () => { await app.result.current.refreshSquad(); });
    expect(app.result.current.squadChange).toBe('reviewRequired');
    act(() => { app.result.current.acknowledgeSquadRefresh(); });
    expect(app.result.current.squadChange).toBeNull();
  });
});

describe('recovering from a squad conflict', () => {
  it('reads only the authoritative squad, blocks writes until review, and never replays the request', async () => {
    const latest = deferred<RpcResult>();
    const app = await mount();
    rpc.mockClear().mockImplementation(async (name: string) => name === 'ff_lineup_save' ? stale : latest.promise);
    let error!: Promise<unknown>;
    await act(async () => { error = app.result.current.saveLineup(lineup).catch((err: unknown) => err); });
    await waitFor(() => expect(app.result.current.squadChange).toBe('refreshing'));
    expect(calls()).toEqual(['ff_lineup_save', 'ff_squad']);
    await expect(app.result.current.saveLineup(lineup)).rejects.toThrow(/already in progress/);
    await app.result.current.refreshSquad();
    expect(calls()).toEqual(['ff_lineup_save', 'ff_squad']);

    await act(async () => { latest.resolve(ok(squad('A', true))); await expect(error).resolves.toMatchObject({ code: 'conflict', detail: '40001' }); });
    expect(app.result.current.squad).toEqual(squad('A', true));
    expect(app.result.current.squadChange).toBe('reviewRequired');
    await expect(app.result.current.saveLineup(lineup)).rejects.toThrow(/refresh and review/i);
    act(() => { app.result.current.acknowledgeSquadRefresh(); });
    expect(app.result.current.squadChange).toBeNull();
    expect(calls()).toEqual(['ff_lineup_save', 'ff_squad']);
  });

  it.each([
    { name: 'a failed conflict refresh', write: stale, automaticRead: true },
    { name: 'an ambiguous pool timeout', write: poolTimeout, automaticRead: false },
  ])('requires receipt reconciliation after $name', async ({ write, automaticRead }) => {
    const app = await mount();
    rpc.mockClear().mockImplementation(async (name: string) => name === 'ff_lineup_save' ? write : poolTimeout);
    await act(async () => { await app.result.current.saveLineup(lineup).catch(() => {}); });
    expect(calls()).toEqual(automaticRead ? ['ff_lineup_save', 'ff_squad'] : ['ff_lineup_save']);
    expect(app.result.current.squadChange).toBe('refreshRequired');
    expect(app.result.current.squad).toEqual(squad('A'));
    act(() => { app.result.current.acknowledgeSquadRefresh(); });
    await expect(app.result.current.saveLineup(lineup)).rejects.toThrow(/refresh and review/i);

    const latest = deferred<RpcResult>();
    rpc.mockClear().mockReturnValue(latest.promise);
    await act(async () => {
      // A pending receipt is not made final by reading the squad.
      void app.result.current.refreshSquad();
      void app.result.current.refreshSquad();
    });
    if (!automaticRead) {
      await waitFor(() => expect(app.result.current.squadChange).toBe('refreshRequired'));
      expect(calls()).toEqual([]);
      await act(async () => { void app.result.current.cancelSquadReceipt(); });
    }
    await waitFor(() => expect(calls()).toEqual(['ff_squad']));
    await act(async () => { latest.resolve(ok(squad('A', true))); });
    await waitFor(() => expect(app.result.current.squadChange).toBe('reviewRequired'));
    expect(app.result.current.squad).toEqual(squad('A', true));
    expect(calls()).toEqual(['ff_squad']);
  });

  it('discards a recovery read after league navigation without blocking the other team', async () => {
    const app = await mount();
    const oldRead = deferred<RpcResult>();
    rpc.mockImplementation(async (name: string, args: { p_league: string }) => {
      if (name === 'ff_lineup_save' && args.p_league === 'A') return stale;
      if (name === 'ff_squad') return args.p_league === 'A' ? oldRead.promise : ok(squad('B'));
      return ok([]);
    });
    let failed!: Promise<unknown>;
    await act(async () => { failed = app.result.current.saveLineup(lineup).catch((err: unknown) => err); });
    await waitFor(() => expect(app.result.current.squadChange).toBe('refreshing'));
    await act(async () => { app.result.current.selectLeague('B'); });
    await waitFor(() => expect(app.result.current.squadChange).toBeNull());
    await act(async () => { await app.result.current.saveLineup(lineup); });
    rpc.mockClear();
    await act(async () => { oldRead.resolve(ok(squad('A', true))); await failed; });
    expect(calls()).toEqual([]);
    expect(app.result.current.leagueId).toBe('B');
    expect(app.result.current.squad).toEqual(squad('B'));
    expect(app.result.current.squadChange).toBeNull();
    expect(app.result.current.error).toBeNull();
  });

  it('does not issue recovery for a write that fails after sign-out', async () => {
    const app = await mount();
    const write = deferred<RpcResult>();
    rpc.mockImplementation(async (name: string) => name === 'ff_lineup_save' ? write.promise : ok(squad('A')));
    let failed!: Promise<unknown>;
    await act(async () => { failed = app.result.current.saveLineup(lineup).catch((err: unknown) => err); });
    app.unmount();
    const next = await mount('user-two');
    rpc.mockClear();
    await act(async () => { write.resolve(stale); await failed; });
    expect(calls()).toEqual([]);
    expect(next.result.current.squadChange).toBeNull();
    expect(next.result.current.squad).toEqual(squad('A'));
  });

  it('does not let an older full-league read replace a fresher recovery snapshot', async () => {
    const app = await mount();
    const members = deferred<RpcResult>();
    let squadReads = 0;
    rpc.mockImplementation(async (name: string) => {
      if (name === 'ff_league_members') return members.promise;
      if (name === 'ff_lineup_save') return stale;
      if (name === 'ff_squad') return ok(squad('A', ++squadReads > 1));
      return ok([]);
    });
    await act(async () => { app.result.current.selectLeague('A'); }); // full read, partly pending
    expect(squadReads).toBe(1);
    await act(async () => { await app.result.current.saveLineup(lineup).catch(() => {}); });
    expect(app.result.current.squad).toEqual(squad('A', true));
    await act(async () => { members.resolve(ok([])); });
    expect(app.result.current.squad).toEqual(squad('A', true));
    expect(app.result.current.squadChange).toBe('reviewRequired');
  });
});

describe('ambiguous squad write failures', () => {
  it.each([
    { name: 'HTTP 502', write: failure('PGRST003', 'bad gateway', 502) },
    { name: 'HTTP 503', write: failure('PGRST003', 'unavailable', 503) },
    { name: 'HTTP 504', write: failure('PGRST003', 'pool timeout', 504) },
    { name: 'status 0', write: failure('PGRST003', 'network', 0) },
  ])('holds the guard after $name without replaying the write', async ({ write }) => {
    const app = await mount();
    rpc.mockClear().mockImplementation(async (name: string) => name === 'ff_lineup_save' ? write : ok(squad('A')));
    await act(async () => { await app.result.current.saveLineup(lineup).catch(() => {}); });
    expect(calls()).toEqual(['ff_lineup_save']);
    expect(app.result.current.squadChange).toBe('refreshRequired');
    expect(app.result.current.squad).toEqual(squad('A'));
    await expect(app.result.current.saveLineup(lineup)).rejects.toThrow(/refresh and review/i);
    expect(calls()).toEqual(['ff_lineup_save']);
    // Status alone cannot resolve pending. Cancellation serializes with any delayed execution.
    rpc.mockClear().mockImplementation(async (name: string) => name === 'ff_squad' ? ok(squad('A', true)) : ok([]));
    await act(async () => { await app.result.current.refreshSquad(); });
    expect(calls()).toEqual([]);
    expect(app.result.current.squadChange).toBe('refreshRequired');
    await act(async () => { await app.result.current.cancelSquadReceipt(); });
    expect(calls()).toEqual(['ff_squad']);
    expect(app.result.current.squadChange).toBe('reviewRequired');
    expect(app.result.current.squad).toEqual(squad('A', true));
  });

  it('holds the guard after a transport rejection without replaying', async () => {
    const app = await mount();
    rpc.mockClear().mockImplementation(async (name: string) => {
      if (name === 'ff_lineup_save') throw new TypeError('Failed to fetch');
      return ok(squad('A'));
    });
    await act(async () => { await app.result.current.saveLineup(lineup).catch(() => {}); });
    expect(calls()).toEqual(['ff_lineup_save']);
    expect(app.result.current.squadChange).toBe('refreshRequired');
    await expect(app.result.current.saveLineup(lineup)).rejects.toThrow(/refresh and review/i);
    expect(calls()).toEqual(['ff_lineup_save']);
  });

  it('holds the guard after a write deadline without replaying', async () => {
    const app = await mount();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const started = deferred<void>();
    rpc.mockClear().mockImplementation(async (name: string) => {
      if (name === 'ff_lineup_save') { started.resolve(); return new Promise(() => {}); }
      return ok(squad('A'));
    });
    let settled = false;
    const pending = app.result.current.saveLineup(lineup).catch(() => { settled = true; });
    await act(async () => { await started.promise; });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); await pending; });
    expect(settled).toBe(true);
    expect(calls()).toEqual(['ff_lineup_save']);
    expect(app.result.current.squadChange).toBe('refreshRequired');
    await expect(app.result.current.saveLineup(lineup)).rejects.toThrow(/refresh and review/i);
    expect(calls()).toEqual(['ff_lineup_save']);
  });
});

describe('squad guard lifecycle', () => {
  it('does not unlock on a competing reload while refresh is required', async () => {
    const app = await mount();
    rpc.mockClear().mockImplementation(async (name: string) => name === 'ff_lineup_save' ? poolTimeout : ok(squad('A')));
    await act(async () => { await app.result.current.saveLineup(lineup).catch(() => {}); });
    expect(app.result.current.squadChange).toBe('refreshRequired');
    rpc.mockClear().mockImplementation(async (name: string) => name === 'ff_squad' ? ok(squad('A', true)) : ok([]));
    // A full reload fetches squad data but must not release the write lease.
    await act(async () => { await app.result.current.reload(); });
    expect(app.result.current.squadChange).toBe('refreshRequired');
    await expect(app.result.current.saveLineup(lineup)).rejects.toThrow(/refresh and review/i);
    // Status alone cannot settle a pending receipt; cancel before reviewing.
    await act(async () => { await app.result.current.refreshSquad(); });
    expect(app.result.current.squadChange).toBe('refreshRequired');
    await act(async () => { await app.result.current.cancelSquadReceipt(); });
    expect(app.result.current.squadChange).toBe('reviewRequired');
    act(() => { app.result.current.acknowledgeSquadRefresh(); });
    expect(app.result.current.squadChange).toBeNull();
  });

  it('bounds the recovery read so controls do not lock indefinitely', async () => {
    const app = await mount();
    rpc.mockClear().mockImplementation(async (name: string) => name === 'ff_lineup_save' ? poolTimeout : ok(squad('A')));
    await act(async () => { await app.result.current.saveLineup(lineup).catch(() => {}); });
    expect(app.result.current.squadChange).toBe('refreshRequired');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const started = deferred<void>();
    rpc.mockClear().mockImplementation(async (name: string) => {
      if (name === 'ff_squad') { started.resolve(); return new Promise(() => {}); }
      return ok([]);
    });
    const refreshing = app.result.current.cancelSquadReceipt();
    await act(async () => { await started.promise; });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); await refreshing; });
    expect(calls()).toEqual(['ff_squad']);
    expect(app.result.current.squadChange).toBe('refreshRequired');
  });
});
