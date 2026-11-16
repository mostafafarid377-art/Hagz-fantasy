/**
 * @vitest-environment jsdom
 *
 * Live screens must be laid out like their demo counterparts, so switching modes
 * does not feel like switching products.
 *
 * This file pins the parity that EXISTS. It deliberately does not claim full
 * parity: some live screens have no demo equivalent because the demo has no such
 * feature (season/gameweek setup is a live-only admin screen, for example). Those
 * are listed in the last describe block as known gaps rather than quietly skipped,
 * so the file stays honest about what it covers.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act, fireEvent, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../../translations';

afterEach(() => { cleanup(); vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const league = {
  league_id: 'L1', name: 'Real League FC', role: 'manager', status: 'active',
  budget: 100, market_open: true, archived: false, is_leader: true, is_organizer: false,
};

const matches = [
  {
    id: 'm1', gameweek_id: 'g1', starts_at: '2020-01-10T18:00:00Z', venue: 'The Cage',
    team_a_id: 't1', team_a: 'Real League FC', team_b_id: 't2', team_b: 'Rivals FC',
    organizer_id: 'u1', starters_per_side: 7, max_substitutes: 5,
    revision_id: null, revision_version: null, revision_state: null,
    team_a_score: null, team_b_score: null,
  },
  {
    id: 'm2', gameweek_id: 'g1', starts_at: '2030-06-10T18:00:00Z', venue: 'The Cage',
    team_a_id: 't3', team_a: 'Antelopes', team_b_id: 't4', team_b: 'Zebras',
    organizer_id: 'u1', starters_per_side: 7, max_substitutes: 5,
    revision_id: null, revision_version: null, revision_state: null,
    team_a_score: null, team_b_score: null,
  },
];

const standings = [
  { team_id: 't1', team_name: 'Real League FC', manager_id: 'u1', manager_name: 'Me',
    mode: 'fantasy_total', fantasy_points: 500, h2h_points: null, is_stale: false,
    computed_at: '2026-01-01T00:00:00Z' },
  { team_id: 't2', team_name: 'Rivals FC', manager_id: 'u2', manager_name: 'Them',
    mode: 'fantasy_total', fantasy_points: 400, h2h_points: null, is_stale: false,
    computed_at: '2026-01-01T00:00:00Z' },
];

async function mountLive(which: 'fixtures' | 'standings' | 'matchcenter' | 'notifications' | 'market' | 'management') {
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
        return { data: { profile: { id: 'u1', display_name: 'Me' }, leagues: [league] }, error: null };
      }
      if (fn === 'ff_matches') return { data: matches, error: null };
      if (fn === 'ff_squad') {
        return { data: { team: { id: 't1', name: 'Real League FC' }, formation: '4-3-3',
          status: 'empty', captain_id: null, vice_captain_id: null, budget: 100,
          spent: 0, players: [] }, error: null };
      }
      if (fn === 'ff_market_players') {
        return { data: [{ id: 'p1', player_id: 'pl1', name: 'Market Player', position: 'MID',
          price: 5_000_000, rating: 80, active: true, image_path: null, image_url: null,
          owned_by: 0, created_at: '2026-01-01' }], error: null };
      }
      if (fn === 'ff_notifications') {
        return { data: [{ id: 'n1', kind: 'suggestion_approved', payload: { name: 'X' },
          read_at: null, created_at: '2026-01-01T00:00:00Z' }], error: null };
      }
      if (fn === 'ff_standings') return { data: standings, error: null };
      if (fn === 'ff_gameweeks') {
        return { data: [{ id: 'g1', number: 1, season_id: 's1', season_name: 'S', deadline: '2030-01-01', rules_pinned: true }], error: null };
      }
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
  const mod = await import('./Match');
  const market = await import('./Market');
  const { LiveStandings } = await import('./Squad');
  const Component = which === 'fixtures' ? mod.LiveFixtures
    : which === 'notifications' ? mod.LiveNotifications
    : which === 'matchcenter' ? mod.LiveMatchCenter
    : which === 'market' ? market.LiveMarket
    : which === 'management' ? market.LiveManagement
    : LiveStandings;

  await act(async () => {
    render(
      <MemoryRouter initialEntries={['/x']}>
        <LiveProvider userId="u1"><Component /></LiveProvider>
      </MemoryRouter>,
    );
  });
  for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); });
}

describe('standings look like the demo standings', () => {
  it('no longer shows the scoring strip above the table', async () => {
    // Removed on request (it was one of the two circled annotations).
    await mountLive('standings');
    expect(document.querySelector('.scoring-strip')).toBeNull();
  });

  it('puts the team and its manager in one cell, like the demo table', async () => {
    await mountLive('standings');
    const cell = document.querySelector('tbody tr td:nth-child(2)');
    expect(cell?.querySelector('.table-team')).toBeTruthy();
    expect(cell?.textContent).toContain('Real League FC');
    expect(cell?.textContent).toContain('Me');
  });

  it("highlights the user's own row", async () => {
    await mountLive('standings');
    const own = [...document.querySelectorAll('tbody tr')]
      .filter((r) => r.textContent?.includes('Real League FC'));
    expect(own.length).toBe(1);
    expect(own[0].className).toContain('highlight-row');
  });
});

describe('fixtures look like the demo fixtures', () => {
  it('has All/Upcoming/Played filter tabs', async () => {
    await mountLive('fixtures');
    const tabs = document.querySelector('.tabs');
    expect(tabs).toBeTruthy();
    const labels = [...tabs!.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual(['All', 'Upcoming', 'Played']);
  });

  it('renders each match as a linked fixture row', async () => {
    await mountLive('fixtures');
    const rows = document.querySelectorAll('.fixture-list .fixture-row');
    expect(rows.length).toBe(matches.length);
    expect(rows[0].getAttribute('href')).toBe('/match-center/m1');
  });

  it('keeps a past unapproved fixture out of Upcoming and marks its result as awaiting review', async () => {
    await mountLive('fixtures');
    const rows = [...document.querySelectorAll('.fixture-list .fixture-row')];
    const played = rows.find((r) => r.textContent?.includes('Real League FC'));
    const upcoming = rows.find((r) => r.textContent?.includes('Antelopes'));
    expect(played?.textContent).toMatch(/Awaiting result/);
    expect(upcoming?.textContent).toMatch(/Upcoming/);
  });
});

describe('the live match center', () => {
  it('opens with a hero block for the featured match', async () => {
    await mountLive('matchcenter');
    expect(document.querySelector('.match-center-hero')).toBeTruthy();
  });

  it('shows the real match creation workflow to the League Leader', async () => {
    await mountLive('matchcenter');
    fireEvent.click(screen.getByRole('button', { name: 'Schedule match' }));
    expect(screen.getByText('Schedule a real match')).toBeTruthy();
    expect(screen.getByLabelText('New real team')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add team' })).toBeTruthy();
    expect(screen.getByLabelText(/Gameweek/)).toBeTruthy();
    expect(screen.getByRole('option', { name: 'No gameweek' })).toBeTruthy();
    expect(screen.getByLabelText('Assigned Organizer')).toBeTruthy();
    expect(screen.getByLabelText('Date & kick-off')).toBeTruthy();
    expect(screen.getByText(/does not create player profiles or affect fantasy squads/i)).toBeTruthy();
  });
});

describe('notifications already match the demo', () => {
  it('renders activity items inside a panel', async () => {
    await mountLive('notifications');
    expect(document.querySelector('.panel .activity-item')).toBeTruthy();
    expect(document.querySelector('.activity-icon')).toBeTruthy();
  });
});

describe('the market and leader tools match the demo layouts', () => {
  it('the market uses the demo filter bar with a labelled search', async () => {
    await mountLive('market');
    expect(document.querySelector('.filter-bar .search-box input[aria-label]')).toBeTruthy();
    expect(document.querySelector('.filter-bar .filters select')).toBeTruthy();
    // The bespoke class it replaced must be gone.
    expect(document.querySelector('.market-filters')).toBeNull();
  });

  it('player management uses card rows, not a table', async () => {
    await mountLive('management');
    expect(document.querySelector('.management-list .manage-row')).toBeTruthy();
  });
});

describe('known gaps - no demo equivalent', () => {
  // These live screens have no demo counterpart to mirror, so "make live look like
  // demo" has no answer for them. Recorded so it is clear this file does not cover
  // them, rather than implying the whole app is at parity.
  it('season and gameweek setup is live-only', async () => {
    const { LiveSeason } = await import('./Squad');
    expect(LiveSeason).toBeTruthy();
  });
});
