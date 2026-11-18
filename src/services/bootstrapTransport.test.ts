import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercise the locked SDK and the real browser client wiring. No requests leave
// the test process: the mock fetch is installed before the singleton is created.
async function clientWith(fetch: typeof globalThis.fetch) {
  vi.resetModules();
  vi.stubEnv('PROD', false);
  vi.stubEnv('VITE_SUPABASE_URL', 'https://postgrest-test.example');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_for_mock_transport');
  vi.stubGlobal('fetch', fetch);
  const { getSupabase } = await import('../lib/supabase');
  return getSupabase()!;
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('PostgREST retries with the installed SDK', () => {
  it('retries a GET on 503 but not on 504', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('schema cache unavailable', { status: 503, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(new Response('[]'))
      .mockImplementation(async () => new Response('proxy timeout', { status: 504 }));
    const client = await clientWith(fetch);

    await expect(client.from('fixture').select('id')).resolves.toMatchObject({ status: 200 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('x-retry-count')).toBe('1');

    await expect(client.from('fixture').select('id')).resolves.toMatchObject({ status: 504 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not replay any affected RPC POST on 504 with default settings', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(
      JSON.stringify({ code: 'PGRST003', message: 'pool timeout' }), { status: 504 },
    ));
    const client = await clientWith(fetch);
    const rpcNames = ['ff_bootstrap', 'ff_squad_substitute', 'ff_league_create'];
    for (const fn of rpcNames) {
      await expect(client.rpc(fn)).resolves.toMatchObject({ status: 504, error: { code: 'PGRST003' } });
    }
    expect(fetch.mock.calls.map(([url, init]) => [String(url).split('/').pop(), init?.method]))
      .toEqual(rpcNames.map((name) => [name, 'POST']));
  });

  it.each(['ff_lineup_save', 'ff_squad_substitute'])('surfaces 40001 from %s without another POST', async (name) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      code: '40001', message: 'squad changed elsewhere; reload before substituting',
    }), { status: 500 }));
    await clientWith(fetch);
    const api = await import('./api');
    const result = name === 'ff_lineup_save'
      ? api.saveLineup('league', { gameweekId: 'gw', formation: '4-3-3', playerIds: [], captainId: null, viceCaptainId: null })
      : api.rpc(name, { p_league: 'league', p_out: 'a', p_in: 'b', p_expected_revision: 7 });

    await expect(result).rejects.toMatchObject({ code: 'conflict', detail: '40001' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain(`/rpc/${name}`);
    expect(fetch.mock.calls[0][1]?.method).toBe('POST');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).has('x-retry-count')).toBe(false);
  });

  it('blocks background bootstrap replays even if the 504 has no PostgREST JSON body', async () => {
    const result = { profile: { id: 'u1', display_name: 'Player' }, leagues: [] };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('<h1>Gateway Timeout</h1>', { status: 504 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(result)));
    await clientWith(fetch);
    const { createBootstrapSession } = await import('./api');
    const bootstrap = createBootstrapSession('u1');

    await expect(bootstrap.load()).rejects.toMatchObject({ detail: '504' });
    await expect(bootstrap.load()).rejects.toMatchObject({ detail: '504' });
    expect(fetch).toHaveBeenCalledTimes(1);

    await expect(bootstrap.load({ retry: true })).resolves.toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('older browsers without AbortSignal.throwIfAborted', () => {
  it('completes initial bootstrap and explicit retry without the method', async () => {
    const proto = AbortSignal.prototype as AbortSignal & { throwIfAborted?: unknown };
    const original = proto.throwIfAborted;
    // Simulate the Vite target range (Chrome 87 / Firefox 78 / Safari 14):
    // the method does not exist.
    Reflect.deleteProperty(proto, 'throwIfAborted');
    expect(typeof (AbortSignal.prototype as any).throwIfAborted).toBe('undefined');
    try {
      const result = { profile: { id: 'u1', display_name: 'Player' }, leagues: [] };
      const fetch = vi.fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response('<h1>Gateway Timeout</h1>', { status: 504 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(result)));
      await clientWith(fetch);
      const { createBootstrapSession } = await import('./api');
      const bootstrap = createBootstrapSession('u1');
      // Initial bootstrap must reach the network (no TypeError before fetch).
      await expect(bootstrap.load()).rejects.toMatchObject({ detail: '504' });
      expect(fetch).toHaveBeenCalledTimes(1);
      // Dashboard Try again (retry: true) must also work without the method.
      await expect(bootstrap.load({ retry: true })).resolves.toEqual(result);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      if (original !== undefined) (AbortSignal.prototype as any).throwIfAborted = original;
    }
  });
});

describe('scoped error mapping', () => {
  async function apiWithRpc(rpcImpl: (...args: any[]) => any) {
    vi.resetModules();
    vi.stubEnv('PROD', false);
    vi.stubEnv('VITE_SUPABASE_URL', 'https://postgrest-test.example');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_for_mock_transport');
    vi.doMock('../lib/supabase', () => ({
      isSupabaseConfigured: true,
      getSupabase: () => ({ rpc: rpcImpl }),
      looksLikeServiceRoleKey: () => false,
      PLAYER_IMAGES_BUCKET: 'player-images',
    }));
    return import('./api');
  }

  it.each([502, 503, 504])('treats HTTP %i on a squad write as outcomeUnknown without replay', async (status) => {
    const rpc = vi.fn(async () => ({ data: null, status, error: { code: 'PGRST003', message: 'pool timeout' } }));
    const api = await apiWithRpc(rpc);
    await expect(api.saveLineup('league', { gameweekId: 'gw', formation: '4-3-3', playerIds: [], captainId: null, viceCaptainId: null }))
      .rejects.toMatchObject({ code: 'outcomeUnknown' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each([502, 503, 504])('treats HTTP %i on a league write as outcomeUnknown without replay', async (status) => {
    const rpc = vi.fn(async () => ({ data: null, status, error: { code: 'PGRST003', message: 'pool timeout' } }));
    const api = await apiWithRpc(rpc);
    await expect(api.createLeague('New League')).rejects.toMatchObject({ code: 'outcomeUnknown' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('does not remap 40001 on a non-squad RPC to conflict', async () => {
    const rpc = vi.fn(async () => ({ data: null, status: 500, error: { code: '40001', message: 'serialization failure' } }));
    const api = await apiWithRpc(rpc);
    await expect(api.createLeague('New League')).rejects.not.toMatchObject({ code: 'conflict' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('does not remap gateway failures on unrelated reads to outcomeUnknown', async () => {
    const rpc = vi.fn(async () => ({ data: null, status: 502, error: { code: 'PGRST003', message: 'pool timeout' } }));
    const api = await apiWithRpc(rpc);
    await expect(api.transfers('league')).rejects.not.toMatchObject({ code: 'outcomeUnknown' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('treats a transport rejection on a squad write as outcomeUnknown', async () => {
    const rpc = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const api = await apiWithRpc(rpc);
    await expect(api.saveLineup('league', { gameweekId: 'gw', formation: '4-3-3', playerIds: [], captainId: null, viceCaptainId: null }))
      .rejects.toMatchObject({ code: 'outcomeUnknown' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('treats a squad write deadline as outcomeUnknown', async () => {
    vi.useFakeTimers();
    const rpc = vi.fn(() => ({ abortSignal: () => new Promise(() => {}) }));
    const api = await apiWithRpc(rpc);
    const pending = expect(api.saveLineup('league', { gameweekId: 'gw', formation: '4-3-3', playerIds: [], captainId: null, viceCaptainId: null }))
      .rejects.toMatchObject({ code: 'outcomeUnknown', detail: 'timeout' });
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(rpc).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('deadline cancellation', () => {
  it('settles a closed bootstrap even when the transport ignores abort and never returns', async () => {
    vi.resetModules();
    const rpc = vi.fn(() => ({ abortSignal: () => new Promise(() => {}) }));
    vi.doMock('../lib/supabase', () => ({ getSupabase: () => ({ rpc }) }));
    const { createBootstrapSession } = await import('./api');
    const first = createBootstrapSession('old-user');
    const pending = first.load();
    await Promise.resolve();
    first.close();
    await expect(pending).rejects.toMatchObject({ code: 'notAuthenticated' });
    await expect(first.load({ retry: true })).rejects.toMatchObject({ code: 'notAuthenticated' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('does not begin a request when its signal is already aborted', async () => {
    const { withDeadline } = await import('./api');
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(async () => 'unexpected');
    await expect(withDeadline('read', run, { signal: controller.signal })).rejects.toMatchObject({ detail: 'cancelled' });
    expect(run).not.toHaveBeenCalled();
  });

  it('reports cancelled in-flight writes as outcome unknown, not rolled back', async () => {
    const { withDeadline } = await import('./api');
    const controller = new AbortController();
    const pending = withDeadline('write', () => new Promise(() => {}), { signal: controller.signal }, 'outcomeUnknown');
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'outcomeUnknown', detail: 'cancelled' });
  });
});
