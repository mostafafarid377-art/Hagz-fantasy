/**
 * @vitest-environment jsdom
 *
 * Three requirements for the squad tab:
 *
 * 1. It looks like the demo squad screen - the pitch is the page.
 * 2. No squad LIST under the pitch. The roster panel repeated every player the
 *    pitch already showed.
 * 3. "Edit squad" opens the PLayer Market. It used to point at /squad-builder,
 *    which in live mode re-rendered the same squad screen, so it looked dead.
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

const squadPlayer = (n: number, position: string) => ({
  league_player_id: `lp${n}`, name: `P${n}`, position, price: 5, rating: 70,
  image_path: null, image_url: null, active: true, slot: n, captain: false,
});

const FULL_SQUAD = [
  squadPlayer(1, 'GK'), squadPlayer(2, 'GK'),
  ...Array.from({ length: 5 }, (_, i) => squadPlayer(3 + i, 'DEF')),
  ...Array.from({ length: 5 }, (_, i) => squadPlayer(8 + i, 'MID')),
  ...Array.from({ length: 3 }, (_, i) => squadPlayer(13 + i, 'FWD')),
];

async function mountLiveSquad(players = FULL_SQUAD) {
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
      if (fn === 'ff_squad') {
        return { data: { team: { id: 't1', name: 'Real League FC' }, formation: '4-3-3', status: 'draft',
          captain_id: null, vice_captain_id: null, budget: 100, spent: 10, players }, error: null };
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
  const { LiveSquad } = await import('./Squad');

  await act(async () => {
    render(
      <MemoryRouter initialEntries={['/squad']}>
        <LiveProvider userId="u1"><LiveSquad /></LiveProvider>
      </MemoryRouter>,
    );
  });
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
}

describe('the live squad tab is laid out like the demo one', () => {
  it('shows the pitch', async () => {
    await mountLiveSquad();
    expect(document.querySelector('.pitch')).toBeTruthy();
  });

  it('uses the demo squad layout wrapper', async () => {
    await mountLiveSquad();
    expect(document.querySelector('.squad-layout')).toBeTruthy();
  });

  it('stacks positions on the pitch itself instead of in stat cards', async () => {
    await mountLiveSquad();
    // The old screen put GK/DEF/MID/FWD counts in four stat cards above the pitch.
    // The demo screen shows positions on the pitch, which is the point of a pitch.
    expect(document.querySelector('.pitch .pitch-player, .pitch .pitch-empty')).toBeTruthy();
  });

  it('shows the bench strip under the pitch', async () => {
    await mountLiveSquad();
    expect(document.querySelector('.bench-strip')).toBeTruthy();
  });
});

describe('the summary strip matches the demo squad screen', () => {
  it('shows the 7-cell summary: size, value, budget, then four position counts', async () => {
    await mountLiveSquad();
    const cells = document.querySelectorAll('.squad-summary > div');
    expect(cells.length).toBe(7);
  });

  it('labels the cells the way the demo does', async () => {
    await mountLiveSquad();
    const text = document.querySelector('.squad-summary')?.textContent ?? '';
    for (const label of ['Squad', 'Squad value', 'Budget remaining', 'GK', 'DEF', 'MID', 'FWD']) {
      expect(text).toContain(label);
    }
  });

  it('shows the squad as n/15', async () => {
    await mountLiveSquad();
    const text = document.querySelector('.squad-summary')?.textContent ?? '';
    // FULL_SQUAD is 15 players.
    expect(text).toMatch(/15\/15/);
  });
});

describe('there is no squad list under the pitch', () => {
  it('renders no roster rows', async () => {
    await mountLiveSquad();
    expect(document.querySelectorAll('.roster-row').length).toBe(0);
  });

  it('renders no roster panel', async () => {
    await mountLiveSquad();
    expect(document.querySelectorAll('.roster').length).toBe(0);
  });

  it('does not repeat every player name a second time below the pitch', async () => {
    await mountLiveSquad();
    // Each player should appear once - on the pitch. The roster list showed them
    // all again underneath, which is what the user asked to remove.
    const occurrences = screen.queryAllByText('P1', { exact: true }).length;
    expect(occurrences).toBeGreaterThan(0);
    expect(occurrences).toBe(1);
  });
});

describe('captaincy and selling survive the roster removal', () => {
  it('still offers captain and vice captain controls', async () => {
    await mountLiveSquad();
    expect(screen.getByLabelText('Captain')).toBeTruthy();
    expect(screen.getByLabelText('Vice captain')).toBeTruthy();
  });

  it('still offers a way to sell a player', async () => {
    await mountLiveSquad();
    expect(screen.getByLabelText('Sell a player')).toBeTruthy();
  });
});

describe('Edit squad opens the player market', () => {
  it('the dashboard Edit squad action routes to /market', async () => {
    await mountLiveSquad();
    // The live dashboard's "Edit squad" must not point at /squad-builder: in live
    // mode that route renders this same screen again, so the button appeared dead.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/pages/live/League.tsx', 'utf8');
    expect(src).toContain('action="Edit squad" to="/market"');
    expect(src).not.toContain('action="Edit squad" to="/squad-builder"');
  });

  it('the squad screen links to the market', async () => {
    await mountLiveSquad();
    const links = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toContain('/market');
  });
});
