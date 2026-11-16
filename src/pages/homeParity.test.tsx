/**
 * @vitest-environment jsdom
 *
 * The home page must not look like a different product in Demo mode and Live mode.
 *
 * THE PROBLEM: the demo dashboard was a welcome row + hero + overview heading +
 * four stat cards + a two-column dashboard (pitch, next fixture, standings) + a
 * lower grid. The live dashboard was four bare stat cards and one text panel. A
 * user switching modes saw a completely different page.
 *
 * These tests render both and assert they agree on the structural elements a user
 * navigates by: the welcome row, the overview heading, the stat cards, the squad
 * panel with a pitch, the next-fixture panel and the standings panel.
 *
 * They deliberately do NOT assert identical text - live shows real data and demo
 * shows demo data, which is the point. What must match is the page's shape.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../translations';

afterEach(() => { cleanup(); vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

/** Structural landmarks that must exist on BOTH home pages. */
const LANDMARKS = [
  '.welcome-row',
  '.overview-heading',
  '.stat-grid',
  '.dashboard-grid',
  '.squad-panel',
  '.pitch',
  '.fixture-panel',
  '.standings-panel',
  '.lower-grid',
];

const league = {
  league_id: 'L1', name: 'Real League FC', role: 'manager', status: 'active',
  budget: 100, market_open: true, archived: false, is_leader: false, is_organizer: false,
};

async function mountDemoHome() {
  vi.resetModules();
  const { default: Dashboard } = await import('./Dashboard');
  const { DemoProvider } = await import('../hooks/useDemo');
  await act(async () => {
    render(<MemoryRouter initialEntries={['/dashboard']}><DemoProvider><Dashboard /></DemoProvider></MemoryRouter>);
  });
}

async function mountLiveHome() {
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
        return { data: { profile: { id: 'u1', display_name: 'Live Person' }, leagues: [league] }, error: null };
      }
      if (fn === 'ff_standings') {
        return { data: [{ team_id: 't1', team_name: 'Real League FC', manager_id: 'u1', manager_name: 'Live Person',
          mode: 'fantasy_total', fantasy_points: 500, h2h_points: null, is_stale: false, computed_at: '2026-01-01T00:00:00Z' }], error: null };
      }
      if (fn === 'ff_squad') {
        return { data: { team: { id: 't1', name: 'Real League FC' }, formation: '4-3-3', status: 'draft',
          captain_id: null, vice_captain_id: null, budget: 100, spent: 10,
          players: [{ league_player_id: 'lp1', name: 'Live Striker', position: 'FWD', price: 5, rating: 80,
            image_path: null, image_url: null, active: true, slot: 1, captain: false }] }, error: null };
      }
      if (fn === 'ff_matches') {
        return { data: [{ id: 'm1', gameweek_id: 'g1', starts_at: '2026-01-10T18:00:00Z', venue: 'The Cage',
          team_a_id: 't1', team_a: 'Real League FC', team_b_id: 't2', team_b: 'Rivals FC', organizer_id: 'u1',
          starters_per_side: 7, max_substitutes: 5, revision_id: null, revision_version: null, revision_state: null }], error: null };
      }
      return { data: [], error: null };
    },
  };

  vi.doMock('../lib/supabase', () => ({
    isSupabaseConfigured: true,
    getSupabase: () => client,
    looksLikeServiceRoleKey: () => false,
    PLAYER_IMAGES_BUCKET: 'player-images',
  }));

  const { LiveProvider } = await import('../hooks/useLive');
  const { LiveDashboard } = await import('./live/League');
  const { AuthProvider } = await import('../hooks/useAuth');

  await act(async () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <AuthProvider><LiveProvider userId="u1"><LiveDashboard /></LiveProvider></AuthProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

describe('live and demo home pages share the same structure', () => {
  for (const selector of LANDMARKS) {
    it(`both render ${selector}`, async () => {
      await mountDemoHome();
      const demo = document.querySelectorAll(selector).length;
      cleanup();
      vi.resetModules();

      await mountLiveHome();
      const live = document.querySelectorAll(selector).length;

      expect(demo, `demo home is missing ${selector}`).toBeGreaterThan(0);
      expect(live, `live home is missing ${selector}`).toBeGreaterThan(0);
    });
  }
});

describe('the live home shows real data, not placeholders', () => {
  it('renders its own league name, not a demo league', async () => {
    await mountLiveHome();
    // The league name appears in the welcome row, the standings and the fixture.
    expect(screen.queryAllByText(/Real League FC/).length).toBeGreaterThan(0);
    // The demo leagues must never appear in live mode.
    expect(screen.queryByText(/The Football Circle/)).toBeNull();
    expect(screen.queryByText(/Friday Night League/)).toBeNull();
  });

  it('never shows the demo persona on the live home', async () => {
    await mountLiveHome();
    // "Mariam" is the hardcoded demo manager name; it must not leak into live mode.
    expect(screen.queryByText(/Mariam/)).toBeNull();
  });

  it('does not print fabricated "0 pts" on the pitch', async () => {
    await mountLiveHome();
    // A live squad player has no points field. Rendering p.points anyway would show
    // a zero for every player, which reads as a real result.
    expect(document.querySelector('.pitch')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/0 pts/);
  });

  it('lists the next fixture from live matches', async () => {
    await mountLiveHome();
    expect(screen.queryByText('Rivals FC')).not.toBeNull();
  });
});
