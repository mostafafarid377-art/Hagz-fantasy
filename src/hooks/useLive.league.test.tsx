import { receiptServer } from '../test/receiptServer';
import '../test/indexedDbSetup';
/**
 * @vitest-environment jsdom
 * League mutation verification: a write that may have succeeded must never be
 * resubmitted just because the directory read timed out. Verification is
 * read-only (ff_bootstrap + ff_league_members) and preserves the original
 * operation result.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../translations';

afterEach(() => { cleanup(); vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllEnvs(); sessionStorage.clear(); });

const league = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  league_id: id, name, role: 'leader' as const, status: 'active', budget: 100,
  market_open: true, archived: false, is_leader: true, is_organizer: false, ...extra,
});

async function mountLive(opts: {
  initialLeagues?: ReturnType<typeof league>[];
  bootstrapAfter?: ReturnType<typeof league>[];
  bootstrapHandler?: (readNumber: number) => Promise<ReturnType<typeof league>[]> | undefined;
  rpcHandler?: (fn: string, args?: Record<string, unknown>) => Promise<unknown>;
}) {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_abcdefghijklmnop');
  vi.resetModules();
  localStorage.removeItem('ff-live-league');
  sessionStorage.clear();

  let bootstrapCalls = 0;
  const counts: Record<string, number> = {};
  const handleReceipt = receiptServer((name, args) => client.rpc(name, args));
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } }, error: null }) },
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'ff_operation_for_actor') return handleReceipt(args!);
      counts[fn] = (counts[fn] ?? 0) + 1;
      if (fn === 'ff_bootstrap') {
        bootstrapCalls += 1;
        if (opts.bootstrapHandler) {
          const override = await opts.bootstrapHandler(bootstrapCalls);
          if (override !== undefined) {
            return { data: { profile: { id: 'u1', display_name: 'Me' }, leagues: override }, error: null };
          }
        }
        return {
          data: {
            profile: { id: 'u1', display_name: 'Me' },
            leagues: opts.bootstrapAfter ?? opts.initialLeagues ?? [],
          },
          error: null,
        };
      }
      if (opts.rpcHandler) return { data: await opts.rpcHandler(fn, args), error: null };
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
  function Probe() { ctx = useLive(); return <div>{ctx.loading ? 'loading' : 'ready'}</div>; }
  await act(async () => {
    render(
      <MemoryRouter>
        <LiveProvider userId="u1" initialLeagues={opts.initialLeagues}
          initialDirectoryLoaded={opts.initialLeagues !== undefined}><Probe /></LiveProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  return {
    get: () => ctx,
    counts: () => ({ ...counts }),
    getBootstrapCalls: () => bootstrapCalls,
  };
}

describe('create without a receipt', () => {
  it('never mistakes an unrelated new league for proof or resubmits the create', async () => {
    const app = await mountLive({ initialLeagues: [], bootstrapAfter: [league('unrelated', 'Another session')],
      rpcHandler: async (fn) => { if (fn === 'ff_league_create') throw new TypeError('Failed to fetch'); return []; } });
    let result: boolean | undefined;
    await act(async () => { result = await app.get().createLeague('My league'); });
    expect(result).toBe(false);
    expect(app.get().leagueChange).toMatchObject({ kind: 'create', phase: 'verificationRequired', acknowledged: false });
    await act(async () => { result = await app.get().verifyLeagueChange(); });
    expect(result).toBe(false);
    expect(app.get().leagueChange).toMatchObject({ phase: 'verificationRequired' });
    await expect(app.get().createLeague('My league')).rejects.toThrow(/verify/i);
    expect(app.counts()['ff_league_create']).toBe(1);
  });
});

describe('join verification', () => {
  it('preserves an acknowledged join across a verification timeout without a second join RPC', async () => {
    const app = await mountLive({
      initialLeagues: [],
      bootstrapAfter: [league('L-joined', 'Joined League')],
      bootstrapHandler: (n) => n === 1 ? Promise.reject(new TypeError('Load failed')) : undefined,
      rpcHandler: async (fn) => {
        if (fn === 'ff_league_join') return { id: 'L-joined', name: 'Joined League' };
        return [];
      },
    });
    let verified: boolean | undefined;
    await act(async () => { verified = await app.get().joinLeague('ABC123'); });
    expect(verified).toBe(false);
    expect(app.get().leagueChange).toMatchObject({ kind: 'join', phase: 'verificationRequired', acknowledged: true });
    expect(app.counts()['ff_league_join']).toBe(1);
    // Second submission refused without another join.
    await expect(app.get().joinLeague('ABC123')).rejects.toThrow(/verify/i);
    expect(app.counts()['ff_league_join']).toBe(1);
    // Read-only recovery.
    await act(async () => { verified = await app.get().verifyLeagueChange(); });
    expect(verified).toBe(true);
    expect(app.counts()['ff_league_join']).toBe(1);
    expect(app.get().leagueChange).toBeNull();
    expect(app.get().leagueId).toBe('L-joined');
  });
});

describe('archive verification', () => {
  it('requires read-only verification after an acknowledged archive', async () => {
    const app = await mountLive({
      initialLeagues: [league('L-one', 'First League')],
      bootstrapAfter: [],
      bootstrapHandler: (n) => n === 1 ? Promise.reject(new TypeError('Load failed')) : undefined,
      rpcHandler: async (fn) => {
        if (fn === 'ff_league_archive') return { id: 'L-one', archived: true };
        return [];
      },
    });
    let verified: boolean | undefined;
    await act(async () => { verified = await app.get().archiveLeague(); });
    expect(verified).toBe(false);
    expect(app.get().leagueChange).toMatchObject({ kind: 'archive', phase: 'verificationRequired', acknowledged: true });
    expect(app.counts()['ff_league_archive']).toBe(1);
    await act(async () => { verified = await app.get().verifyLeagueChange(); });
    expect(verified).toBe(true);
    expect(app.counts()['ff_league_archive']).toBe(1);
    expect(app.get().leagueChange).toBeNull();
  });
});

describe('settings verification', () => {
  it('requires read-only verification after an acknowledged market toggle', async () => {
    const app = await mountLive({
      initialLeagues: [league('L-one', 'First League')],
      bootstrapAfter: [league('L-one', 'First League', { market_open: false })],
      bootstrapHandler: (n) => n === 1 ? Promise.reject(new TypeError('Load failed')) : undefined,
      rpcHandler: async (fn) => {
        if (fn === 'ff_league_set_market') return { market_open: false };
        return [];
      },
    });
    await act(async () => { await app.get().setMarketOpen(false); });
    expect(app.get().leagueChange).toMatchObject({ kind: 'settings', phase: 'verificationRequired', acknowledged: true });
    expect(app.counts()['ff_league_set_market']).toBe(1);
    let verified: boolean | undefined;
    await act(async () => { verified = await app.get().verifyLeagueChange(); });
    expect(verified).toBe(true);
    expect(app.counts()['ff_league_set_market']).toBe(1);
    expect(app.get().leagueChange).toBeNull();
  });

  it('verifies membership changes against the members read, not just the directory', async () => {
    const app = await mountLive({
      initialLeagues: [league('L-one', 'First League')],
      bootstrapAfter: [league('L-one', 'First League')],
      rpcHandler: async (fn) => {
        if (fn === 'ff_league_set_organizer') return { user_id: 'u2', organizer: true };
        if (fn === 'ff_league_members') return [{ user_id: 'u2', role: 'manager', status: 'active', is_organizer: true }];
        return [];
      },
    });
    await act(async () => { await app.get().setOrganizer('u2', true); });
    expect(app.get().leagueChange).toBeNull();
    expect(app.counts()['ff_league_set_organizer']).toBe(1);
    expect(app.counts()['ff_league_members']).toBeGreaterThanOrEqual(1);
  });
});
