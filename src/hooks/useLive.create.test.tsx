import { receiptServer } from '../test/receiptServer';
import '../test/indexedDbSetup';
/**
 * @vitest-environment jsdom
 *
 * Regression test for "I created a league and nothing happened".
 *
 * THE BUG: `createLeague` called the RPC and then reloaded, but never checked the
 * result. If the RPC succeeded and the league still did not appear in the reloaded
 * list (a missing membership row, an archived league, a bootstrap that does not
 * list it), the promise resolved successfully: the form showed no error, no new
 * league, and no navigation. Silence that is indistinguishable from success.
 *
 * It now verifies the league is visible and throws a clear message if it is not.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../translations';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const league = (id: string, name: string) => ({
  league_id: id, name, role: 'leader' as const, status: 'active', budget: 100,
  market_open: true, archived: false, is_leader: true, is_organizer: false,
});

/**
 * Mount LiveProvider with a fake client.
 * `bootstrapAfterCreate` decides what `ff_bootstrap` reports AFTER `ff_league_create`,
 * i.e. whether the new league ever becomes visible.
 */
async function mountLive(opts: {
  createdId: string;
  /** Leagues bootstrap reports on the SECOND (post-create) load. */
  bootstrapAfterCreate: ReturnType<typeof league>[];
  initialLeagues?: ReturnType<typeof league>[];
  storedLeagueId?: string;
  beforeCreate?: () => Promise<void>;
  bootstrapHandler?: (readNumber: number) => Promise<ReturnType<typeof league>[]> | undefined;
  matchReadHandler?: (readNumber: number) => Promise<unknown>;
  readHandler?: (fn: string, args?: Record<string, unknown>) => Promise<unknown>;
}) {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_abcdefghijklmnop');
  vi.resetModules();
  localStorage.removeItem('ff-live-league');
  sessionStorage.clear();
  if (opts.storedLeagueId) localStorage.setItem('ff-live-league', opts.storedLeagueId);

  let created = false;
  let createCalls = 0;
  let bootstrapCalls = 0;
  let failNextBootstrap = false;
  let matchRead = 0;
  const loadingSnapshots: boolean[] = [];
  const handleReceipt = receiptServer((name, args) => client.rpc(name, args));
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } }, error: null }) },
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'ff_operation_for_actor') return handleReceipt(args!);
      if (fn === 'ff_league_create') {
        createCalls += 1;
        await opts.beforeCreate?.();
        created = true;
        return { data: { id: opts.createdId, name: 'New League', budget: 100, market_open: true, code: 'ABC123' }, error: null };
      }
      if (fn === 'ff_bootstrap') {
        bootstrapCalls += 1;
        if (failNextBootstrap) { failNextBootstrap = false; throw new TypeError('Load failed'); }
        return {
          data: {
            profile: { id: 'u1', display_name: 'Me' },
            leagues: (await opts.bootstrapHandler?.(bootstrapCalls))
              ?? (created ? opts.bootstrapAfterCreate : (opts.initialLeagues ?? [])),
          },
          error: null,
        };
      }
      if (fn === 'ff_matches') {
        matchRead += 1;
        if (opts.matchReadHandler) return { data: await opts.matchReadHandler(matchRead), error: null };
        return { data: [{ id: matchRead === 1 ? 'match-before' : 'match-after' }], error: null };
      }
      if (opts.readHandler) return { data: await opts.readHandler(fn, args), error: null };
      // Every other read returns an empty payload.
      return { data: [], error: null };
    },
  };

  vi.doMock('../lib/supabase', () => ({
    isSupabaseConfigured: true,
    getSupabase: () => client,
    looksLikeServiceRoleKey: () => false,
    PLAYER_IMAGES_BUCKET: 'player-images',
  }));

  const { LiveProvider, useLive } = await import('./useLive');

  let ctx: any = null;
  function Probe() {
    ctx = useLive();
    loadingSnapshots.push(ctx.loading);
    return <div>{ctx.loading ? 'loading' : 'ready'}</div>;
  }

  await act(async () => {
    render(
      <MemoryRouter>
        <LiveProvider userId="u1" initialLeagues={opts.initialLeagues}
          initialDirectoryLoaded={opts.initialLeagues !== undefined}><Probe /></LiveProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => { if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0); else await new Promise((resolve) => setTimeout(resolve, 10)); });

  return {
    get: () => ctx,
    loadingSnapshots: () => [...loadingSnapshots],
    getBootstrapCalls: () => bootstrapCalls,
    getCreateCalls: () => createCalls,
    failNextBootstrap: () => { failNextBootstrap = true; },
    reload: async () => { await act(async () => { await ctx.reload(); }); },
    switchLeague: async (id: string) => {
      await act(async () => { ctx.selectLeague(id); await new Promise((resolve) => setTimeout(resolve, 0)); });
    },
    selectLeagueNow: async (id: string) => { await act(async () => { ctx.selectLeague(id); }); },
    refreshMatches: async () => {
      await act(async () => { await ctx.refreshMatches(); });
    },
    /** Call createLeague and report whether it rejected, and with what message. */
    create: async (): Promise<{ rejected: boolean; message?: string; value?: boolean }> => {
      let rejected = false; let message: string | undefined; let value: boolean | undefined;
      await act(async () => {
        try { value = await ctx.createLeague('New League'); }
        catch (e) { rejected = true; message = (e as Error).message; }
      });
      return { rejected, message, value };
    },
  };
}

describe('league switching reuses the authenticated league directory', () => {
  it('does not bootstrap again on startup for a stale saved league', async () => {
    const app = await mountLive({
      createdId: 'unused', bootstrapAfterCreate: [], storedLeagueId: 'old-account-league',
      initialLeagues: [league('L-one', 'First League')],
    });
    expect(app.get().leagueId).toBe('L-one');
    expect(app.getBootstrapCalls()).toBe(0);
  });

  it('does not issue another ff_bootstrap for a known league switch', async () => {
    const app = await mountLive({
      createdId: 'L-new',
      bootstrapAfterCreate: [],
      initialLeagues: [league('L-one', 'First League'), league('L-two', 'Second League')],
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(app.get().leagueId).toBe('L-one');
    const callsBeforeSwitch = app.getBootstrapCalls();

    await app.switchLeague('L-two');

    expect(app.get().leagueId).toBe('L-two');
    expect(app.getBootstrapCalls()).toBe(callsBeforeSwitch);
    expect(app.get().loading).toBe(false);
  });
});

describe('league creation does not amplify requests', () => {
  it('accepts only one in-flight league-create submission', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const app = await mountLive({
      createdId: 'L-new', initialLeagues: [], bootstrapAfterCreate: [league('L-new', 'New League')],
      beforeCreate: () => pending,
    });
    await act(async () => {
      const first = app.get().createLeague('New League');
      await expect(app.get().createLeague('New League')).rejects.toThrow(/already being created/i);
      await waitFor(() => expect(app.getCreateCalls()).toBe(1));
      finish();
      await first;
    });
    expect(app.get().leagueId).toBe('L-new');
    expect(app.getBootstrapCalls()).toBe(1);
  });

  it('verifies a successful write with one fresh read, not a pre-write snapshot', async () => {
    const oldLeague = league('L-old', 'Old League');
    let finishRead!: (leagues: typeof oldLeague[]) => void;
    const pending = new Promise<typeof oldLeague[]>((resolve) => { finishRead = resolve; });
    const app = await mountLive({
      createdId: 'L-new', initialLeagues: [oldLeague], bootstrapAfterCreate: [oldLeague, league('L-new', 'New League')],
      bootstrapHandler: (readNumber) => readNumber === 1 ? pending : undefined,
    });
    let reload: Promise<void>;
    await act(async () => { reload = app.get().reload(); });
    expect(app.getBootstrapCalls()).toBe(1);

    let create: Promise<void>;
    await act(async () => { create = app.get().createLeague('New League'); });
    await waitFor(() => expect(app.getCreateCalls()).toBe(1));
    expect(app.getBootstrapCalls()).toBe(1); // Never overlap the pre-write request.

    await act(async () => { finishRead([oldLeague]); await Promise.all([reload, create]); });
    expect(app.get().leagueId).toBe('L-new');
    expect(app.getBootstrapCalls()).toBe(2);
  });
});

describe('transient bootstrap failures do not erase a verified league', () => {
  it('retains the league directory and loaded slice while exposing a retryable error', async () => {
    const app = await mountLive({
      createdId: 'L-known',
      bootstrapAfterCreate: [league('L-known', 'Known League')],
    });
    expect((await app.create()).rejected).toBe(false);
    const originalLeagues = app.get().leagues.map((row: any) => row.league_id);
    const originalLeagueId = app.get().leagueId;
    app.failNextBootstrap();

    await app.reload();

    expect(app.get().error).toBe('Load failed');
    expect(app.get().leagues.map((row: any) => row.league_id)).toEqual(originalLeagues);
    expect(app.get().leagueId).toBe(originalLeagueId);
    expect(app.get().loading).toBe(false);

    await app.reload();
    expect(app.get().error).toBeNull();
    expect(app.get().leagueId).toBe(originalLeagueId);
    expect(app.get().leagues.map((row: any) => row.league_id)).toEqual(originalLeagues);
    expect(app.get().loading).toBe(false);
  });
});

describe('stalled reads cannot hold the live dashboard on a spinner', () => {
  it('releases loading with a visible partial failure when one RPC never responds', async () => {
    vi.useFakeTimers();
    const app = await mountLive({
      createdId: 'unused',
      bootstrapAfterCreate: [],
      initialLeagues: [league('L-stalled', 'Stalled League')],
      readHandler: async (fn) => fn === 'ff_market_players' ? new Promise(() => {}) : [],
    });
    expect(app.get().loading).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });

    expect(app.get().loading).toBe(false);
    expect(app.get().partialFailures).toContain('players: ff_market_players did not respond within 15000 ms');
    expect(app.get().leagueId).toBe('L-stalled');
  });
});

describe('refresh failures preserve the last successful league slice', () => {
  it('retains the same league players when one refresh request fails, then retries cleanly', async () => {
    let failMarketRead = false;
    const app = await mountLive({
      createdId: 'L-slice',
      bootstrapAfterCreate: [league('L-slice', 'Slice League')],
      readHandler: async (fn, args) => {
        if (fn === 'ff_market_players') {
          if (failMarketRead) throw new TypeError('Load failed');
          return [{ id: `player-${String(args?.p_league)}`, name: 'Confirmed player' }];
        }
        return [];
      },
    });
    expect((await app.create()).rejected).toBe(false);
    const confirmedPlayer = app.get().players[0];
    const selectedLeague = app.get().leagueId;

    failMarketRead = true;
    await app.reload();
    expect(app.get().leagueId).toBe(selectedLeague);
    expect(app.get().players).toEqual([confirmedPlayer]);
    expect(app.get().partialFailures).toContain('players: Load failed');
    expect(app.get().loading).toBe(false);

    failMarketRead = false;
    await app.reload();
    expect(app.get().leagueId).toBe(selectedLeague);
    expect(app.get().players).toEqual([confirmedPlayer]);
    expect(app.get().partialFailures).toEqual([]);
    expect(app.get().error).toBeNull();
  });
});

describe('rapid league switching isolates stale responses', () => {
  it('keeps the newest league selected when an older league request later fails', async () => {
    let rejectOldMarket!: (error: unknown) => void;
    let oldMarketStarted!: () => void;
    const oldMarketPending = new Promise<unknown>((_resolve, reject) => { rejectOldMarket = reject; });
    const oldStarted = new Promise<void>((resolve) => { oldMarketStarted = resolve; });
    const app = await mountLive({
      createdId: 'unused',
      bootstrapAfterCreate: [],
      initialLeagues: [league('L-one', 'First'), league('L-two', 'Second'), league('L-three', 'Third')],
      readHandler: async (fn, args) => {
        const requestedLeague = String(args?.p_league);
        if (fn === 'ff_market_players' && requestedLeague === 'L-two') {
          oldMarketStarted();
          return oldMarketPending;
        }
        if (fn === 'ff_market_players') return [{ id: `player-${requestedLeague}`, name: requestedLeague }];
        return [];
      },
    });
    await waitFor(() => expect(app.get().leagueId).toBe('L-one'));

    await app.selectLeagueNow('L-two');
    await oldStarted;
    await app.selectLeagueNow('L-three');
    await waitFor(() => expect(app.get().leagueId).toBe('L-three'));
    await waitFor(() => expect(app.get().players[0]?.name).toBe('L-three'));

    await act(async () => {
      rejectOldMarket(new TypeError('Load failed'));
      await oldMarketPending.catch(() => undefined);
      await Promise.resolve();
    });

    expect(app.get().leagueId).toBe('L-three');
    expect(app.get().players[0]?.name).toBe('L-three');
    expect(app.get().error).toBeNull();
    expect(app.get().partialFailures).toEqual([]);
    expect(app.get().loading).toBe(false);
  });
});

describe('match refresh keeps the open workflow mounted', () => {
  it('updates only matches without toggling the provider loading screen', async () => {
    const app = await mountLive({
      createdId: 'L-match',
      bootstrapAfterCreate: [league('L-match', 'Match League')],
    });
    expect((await app.create()).rejected).toBe(false);
    expect(app.get().matches[0].id).toBe('match-before');
    const renderStart = app.loadingSnapshots().length;

    await app.refreshMatches();

    expect(app.get().matches[0].id).toBe('match-after');
    expect(app.loadingSnapshots().slice(renderStart)).not.toContain(true);
    expect(app.get().loading).toBe(false);
  });
});

describe('match refresh keeps the newest active-match snapshot', () => {
  it('does not let an older read overwrite a newer league-wide match response', async () => {
    let resolveOlder!: (value: unknown) => void;
    let resolveNewer!: (value: unknown) => void;
    const older = new Promise<unknown>((resolve) => { resolveOlder = resolve; });
    const newer = new Promise<unknown>((resolve) => { resolveNewer = resolve; });
    const app = await mountLive({
      createdId: 'L-match-race',
      bootstrapAfterCreate: [league('L-match-race', 'Match League')],
      matchReadHandler: (readNumber) => readNumber === 1 ? Promise.resolve([{ id: 'match-initial' }])
        : readNumber === 2 ? older : newer,
    });
    expect((await app.create()).rejected).toBe(false);

    let olderRequest!: Promise<unknown>;
    let newerRequest!: Promise<unknown>;
    await act(async () => {
      olderRequest = app.get().refreshMatches();
      newerRequest = app.get().refreshMatches();
    });
    await act(async () => { resolveNewer([{ id: 'match-newest' }]); await newerRequest; });
    await act(async () => { resolveOlder([{ id: 'match-stale' }]); await olderRequest; });

    expect(app.get().matches.map((row: any) => row.id)).toEqual(['match-newest']);
  });
});

describe('createLeague reports failure instead of failing silently', () => {
  it('resolves successfully when the created league becomes visible', async () => {
    const app = await mountLive({
      createdId: 'L-new',
      bootstrapAfterCreate: [league('L-new', 'New League')],
    });
    const result = await app.create();
    expect(result.rejected).toBe(false);
    expect(app.get().leagues.map((l: any) => l.league_id)).toContain('L-new');
  });

  it('returns false and requires verification when the league never becomes visible', async () => {
    // The RPC succeeds, but bootstrap never lists the new league - the state that
    // produced "no error, just doesn't load". The new contract preserves the
    // acknowledged write and requires read-only verification instead of throwing
    // or allowing a duplicate create.
    const app = await mountLive({ createdId: 'L-new', bootstrapAfterCreate: [] });
    const result = await app.create();
    expect(result.rejected).toBe(false);
    expect(result.value).toBe(false);
    expect(app.get().leagueChange).toMatchObject({
      kind: 'create', phase: 'verificationRequired', acknowledged: true,
    });
    expect(app.getCreateCalls()).toBe(1);
    // A second submission is refused without another create RPC.
    await expect(app.get().createLeague('New League')).rejects.toThrow(/verify/i);
    expect(app.getCreateCalls()).toBe(1);
    // Read-only verification retries without repeating the create.
    let verified: boolean | undefined;
    await act(async () => { verified = await app.get().verifyLeagueChange(); });
    expect(verified).toBe(false);
    expect(app.getCreateCalls()).toBe(1);
    expect(app.get().leagueChange).toMatchObject({ phase: 'verificationRequired' });
  });

  it('preserves an acknowledged create across a verification timeout and recovers without a second RPC', async () => {
    const app = await mountLive({
      createdId: 'L-new', bootstrapAfterCreate: [league('L-new', 'New League')],
      bootstrapHandler: (readNumber) => {
        if (readNumber === 2) throw new TypeError('Load failed');
        return undefined;
      },
    });
    const result = await app.create();
    expect(result.rejected).toBe(false);
    expect(result.value).toBe(false);
    expect(app.get().leagueChange).toMatchObject({
      kind: 'create', phase: 'verificationRequired', acknowledged: true,
    });
    expect(app.getCreateCalls()).toBe(1);
    // Recovery is a directory read only.
    let verified: boolean | undefined;
    await act(async () => { verified = await app.get().verifyLeagueChange(); });
    expect(verified).toBe(true);
    expect(app.getCreateCalls()).toBe(1);
    expect(app.get().leagueChange).toBeNull();
    expect(app.get().leagueId).toBe('L-new');
  });
});
