/**
 * @vitest-environment jsdom
 *
 * Guards for the Live/Demo parity audit.
 *
 * These are the properties the audit found broken or at risk, written down so they
 * cannot regress silently:
 *
 * 1. No live screen may render demo data or a demo identity. The rule is that Live
 *    shows the authenticated user's real league, never Omar Khaled or Mariam.
 * 2. /statistics must be the player table in BOTH modes. It used to render the live
 *    season/gameweek admin form, which shadowed the demo route.
 * 3. The season admin screen must still exist - parity means the feature is moved
 *    into its own route, not deleted.
 * 4. Live must not fabricate figures the schema does not carry (per-player points).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../../translations';

afterEach(() => { cleanup(); vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const league = {
  league_id: 'L1', name: 'Real League FC', role: 'manager', status: 'active',
  budget: 100, market_open: true, archived: false, is_leader: false, is_organizer: false,
};

const players = [
  { id: 'p1', player_id: 'pl1', name: 'Real Striker', position: 'FWD', price: 9_000_000,
    rating: 88, active: true, image_path: null, image_url: null, league_id: 'L1',
    owned_by: 2, created_at: '2026-01-01' },
  { id: 'p2', player_id: 'pl2', name: 'Real Keeper', position: 'GK', price: 5_000_000,
    rating: 80, active: true, image_path: null, image_url: null, league_id: 'L1',
    owned_by: 0, created_at: '2026-01-01' },
];

async function mountLive(which: 'statistics' | 'season' | 'profile') {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_abcdefghijklmnop');
  vi.resetModules();

  const client = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: async (fn: string) => {
      if (fn === 'ff_bootstrap') {
        return { data: { profile: { id: 'u1', display_name: 'Real User' }, leagues: [league] }, error: null };
      }
      if (fn === 'ff_market_players') return { data: players, error: null };
      if (fn === 'ff_squad') {
        return { data: { team: { id: 't1', name: 'Real League FC' }, formation: '4-3-3',
          status: 'empty', captain_id: null, vice_captain_id: null, budget: 100, spent: 0,
          players: [] }, error: null };
      }
      if (fn === 'ff_gameweeks') return { data: [], error: null };
      return { data: [], error: null };
    },
  };

  vi.doMock('../../lib/supabase', () => ({
    isSupabaseConfigured: true,
    getSupabase: () => client,
    looksLikeServiceRoleKey: () => false,
    PLAYER_IMAGES_BUCKET: 'player-images',
  }));

  const { LiveProvider } = await import('../../hooks/useLive');
  const squad = await import('./Squad');
  const market = await import('./Market');
  const Component = which === 'statistics' ? squad.LiveStatistics
    : which === 'season' ? squad.LiveSeason
    : market.LivePlayerProfile;

  await act(async () => {
    render(
      <MemoryRouter initialEntries={['/x']}>
        <LiveProvider userId="u1"><Component /></LiveProvider>
      </MemoryRouter>,
    );
  });
  for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); });
}

describe('live never shows demo data', () => {
  const DEMO_NAMES = ['Mariam', 'Omar Khaled', 'Karim Hassan', 'Goal Diggers', 'The Football Circle'];

  for (const which of ['statistics', 'season'] as const) {
    it(`${which} contains no demo identity`, async () => {
      await mountLive(which);
      const text = document.body.textContent ?? '';
      for (const name of DEMO_NAMES) expect(text).not.toContain(name);
    });
  }

  it('statistics lists the league real players, not sample ones', async () => {
    await mountLive('statistics');
    expect(screen.queryByText('Real Striker')).not.toBeNull();
    expect(screen.queryByText('Real Keeper')).not.toBeNull();
  });
});

describe('the statistics route is the player table in both modes', () => {
  it('live statistics is a table of players', async () => {
    await mountLive('statistics');
    expect(document.querySelector('.table-wrap table')).toBeTruthy();
    // The season/gameweek admin form must NOT be what /statistics renders.
    expect(screen.queryByText(/Season and gameweeks/i)).toBeNull();
  });

  it('live statistics has the same filter bar as the demo market', async () => {
    await mountLive('statistics');
    expect(document.querySelector('.filter-bar')).toBeTruthy();
  });
});

describe('the season admin screen is moved, not deleted', () => {
  it('still renders the season form', async () => {
    await mountLive('season');
    expect(screen.queryByText(/Season and gameweeks/i)).not.toBeNull();
  });
});

describe('live does not fabricate figures the schema lacks', () => {
  it('the statistics table has no fantasy points column', async () => {
    await mountLive('statistics');
    const headers = [...document.querySelectorAll('thead th')].map((t) => t.textContent?.toLowerCase());
    // A live player has no points field; a points column could only be zeros.
    expect(headers.some((h) => h?.includes('points'))).toBe(false);
  });

  it('the statistics table sorts by rating, which does exist', async () => {
    await mountLive('statistics');
    const first = document.querySelector('tbody tr td:nth-child(2)')?.textContent ?? '';
    expect(first).toContain('Real Striker'); // rating 88 > 80
  });
});
