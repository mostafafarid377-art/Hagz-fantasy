/**
 * @vitest-environment jsdom
 *
 * Regression tests for the league table.
 *
 * THE BUG: `LiveStandings` preferred `head_to_head` rows over `fantasy_total`
 * rows and relied on the server's ordering, which put every head-to-head row above
 * every fantasy row and ranked by h2h_points. This league is scored on fantasy
 * points only, so the table showed the wrong ranking and the wrong columns.
 *
 * These tests feed a deliberately H2H-ordered payload - the worst case, as if the
 * database still has the old ordering - and assert the rendered table is ranked by
 * fantasy points.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../../translations';

afterEach(() => { cleanup(); vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

type Row = {
  team_id: string; team_name: string; manager_id: string; manager_name: string;
  mode: 'head_to_head' | 'fantasy_total';
  fantasy_points: number; h2h_points: number | null;
  is_stale: boolean; computed_at: string;
};

const row = (o: Partial<Row> & { team_id: string; team_name: string; fantasy_points: number }): Row => ({
  manager_id: 'u1', manager_name: 'Manager', mode: 'fantasy_total',
  h2h_points: null, is_stale: false, computed_at: '2026-01-01T00:00:00Z', ...o,
});

async function mountStandings(standings: Row[]) {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_abcdefghijklmnop');
  vi.resetModules();

  const league = {
    league_id: 'L1', name: 'Real League', role: 'manager', status: 'active',
    budget: 100, market_open: true, archived: false, is_leader: false, is_organizer: false,
  };

  const client = {
    auth: { getSession: async () => ({ data: { session: null }, error: null }) },
    rpc: async (fn: string) => {
      if (fn === 'ff_bootstrap') {
        return { data: { profile: { id: 'u1', display_name: 'Me' }, leagues: [league] }, error: null };
      }
      if (fn === 'ff_standings') return { data: standings, error: null };
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
  const { LiveStandings } = await import('./Squad');

  await act(async () => {
    render(
      <MemoryRouter>
        <LiveProvider userId="u1"><LiveStandings /></LiveProvider>
      </MemoryRouter>,
    );
  });
  // Let bootstrap + the slice loads settle.
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

/** Team names in render order, excluding header cells. */
function renderedTeams(): string[] {
  return screen.getAllByRole('row')
    .slice(1) // drop the header row
    .map((r) => r.querySelector('td:nth-child(2)')?.textContent?.trim() ?? '');
}

describe('the league table is ranked by fantasy points', () => {
  it('ranks by fantasy points even when head-to-head rows sort first', async () => {
    // Deliberately in the OLD server order: h2h rows first, h2h_points desc.
    await mountStandings([
      row({ team_id: 't1', team_name: 'H2H Winner', mode: 'head_to_head', fantasy_points: 412, h2h_points: 19 }),
      row({ team_id: 't2', team_name: 'H2H Runner', mode: 'head_to_head', fantasy_points: 505, h2h_points: 17 }),
      row({ team_id: 't3', team_name: 'Top Scorer', mode: 'fantasy_total', fantasy_points: 640 }),
      row({ team_id: 't4', team_name: 'Mid Table', mode: 'fantasy_total', fantasy_points: 430 }),
    ]);

    // Expected: pure fantasy-points order, regardless of mode.
    expect(renderedTeams()).toEqual(['Top Scorer', 'H2H Runner', 'Mid Table', 'H2H Winner']);
  });

  it('does not show head-to-head points as a ranking column', async () => {
    await mountStandings([
      row({ team_id: 't1', team_name: 'A', mode: 'head_to_head', fantasy_points: 100, h2h_points: 9 }),
      row({ team_id: 't2', team_name: 'B', mode: 'fantasy_total', fantasy_points: 200 }),
    ]);
    // The column was removed entirely: it was a ranking input the league does not use.
    expect(screen.queryByText('H2H points')).toBeNull();
    expect(screen.queryByText('Fantasy points')).not.toBeNull();
  });

  it('breaks ties by team name so the order is deterministic', async () => {
    await mountStandings([
      row({ team_id: 't1', team_name: 'Zebras', fantasy_points: 300 }),
      row({ team_id: 't2', team_name: 'Antelopes', fantasy_points: 300 }),
    ]);
    expect(renderedTeams()).toEqual(['Antelopes', 'Zebras']);
  });

  it('says the table is ranked by fantasy points', async () => {
    await mountStandings([row({ team_id: 't1', team_name: 'A', fantasy_points: 10 })]);
    // Both the page description and the footnote state the ranking rule.
    expect(screen.getAllByText(/ranked by fantasy points/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/head-to-head points decide/i)).toBeNull();
  });

  it('shows the empty state when there is no result yet', async () => {
    await mountStandings([]);
    expect(screen.getByText('No standings yet')).toBeTruthy();
  });
});
