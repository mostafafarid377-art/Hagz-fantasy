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
import { render, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../translations';

afterEach(() => { cleanup(); vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const league = (id: string, name: string) => ({
  league_id: id, name, role: 'leader', status: 'active', budget: 100,
  market_open: true, archived: false, is_leader: true, is_organizer: false,
});

/**
 * Mount LiveProvider with a fake client.
 * `bootstrapLists` decides what `ff_bootstrap` reports AFTER `ff_league_create`,
 * i.e. whether the new league ever becomes visible.
 */
async function mountLive(opts: {
  createdId: string;
  /** Leagues bootstrap reports on the SECOND (post-create) load. */
  bootstrapAfterCreate: ReturnType<typeof league>[];
}) {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_abcdefghijklmnop');
  vi.resetModules();

  let created = false;
  const client = {
    auth: { getSession: async () => ({ data: { session: null }, error: null }) },
    rpc: async (fn: string) => {
      if (fn === 'ff_league_create') {
        created = true;
        return { data: { id: opts.createdId, name: 'New League', budget: 100, market_open: true, code: 'ABC123' }, error: null };
      }
      if (fn === 'ff_bootstrap') {
        return {
          data: {
            profile: { id: 'u1', display_name: 'Me' },
            leagues: created ? opts.bootstrapAfterCreate : [],
          },
          error: null,
        };
      }
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
    return <div>{ctx.loading ? 'loading' : 'ready'}</div>;
  }

  await act(async () => {
    render(
      <MemoryRouter>
        <LiveProvider userId="u1"><Probe /></LiveProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => { await Promise.resolve(); });

  return {
    get: () => ctx,
    /** Call createLeague and report whether it rejected, and with what message. */
    create: async (): Promise<{ rejected: boolean; message?: string }> => {
      let rejected = false; let message: string | undefined;
      await act(async () => {
        try { await ctx.createLeague('New League'); }
        catch (e) { rejected = true; message = (e as Error).message; }
      });
      return { rejected, message };
    },
  };
}

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

  it('throws a clear error when the league is created but never becomes visible', async () => {
    // The RPC succeeds, but bootstrap never lists the new league - the state that
    // produced "no error, just doesn't load".
    const app = await mountLive({ createdId: 'L-new', bootstrapAfterCreate: [] });
    const result = await app.create();
    expect(result.rejected).toBe(true);
    expect(result.message).toMatch(/could not be loaded/i);
  });
});
