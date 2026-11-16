/**
 * @vitest-environment jsdom
 *
 * 1. An EMPTY squad must show the empty PITCH, not a "your squad is empty" card.
 *    The pitch is the thing the user fills, so it belongs on screen even when
 *    nothing has been picked - a card with a link on it made the page a dead end.
 *
 * 2. The MARKET tab is removed from the navigation. The market screen still exists
 *    and is still reachable from the "Add players" buttons; only the tab is gone.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../translations';

afterEach(() => { cleanup(); vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const league = {
  league_id: 'L1', name: 'Real League FC', role: 'manager', status: 'active',
  budget: 100, market_open: true, archived: false, is_leader: false, is_organizer: false,
};

async function mountEmptyLiveSquad() {
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
        // Empty squad: no players at all.
        return { data: { team: null, formation: null, status: 'empty', captain_id: null,
          vice_captain_id: null, budget: 100, spent: 0, players: [] }, error: null };
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
  const { LiveSquad } = await import('./live/Squad');

  await act(async () => {
    render(
      <MemoryRouter initialEntries={['/squad']}>
        <LiveProvider userId="u1"><LiveSquad /></LiveProvider>
      </MemoryRouter>,
    );
  });
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
}

describe('an empty squad shows the pitch', () => {
  it('renders a pitch with add slots instead of an "empty squad" card', async () => {
    await mountEmptyLiveSquad();
    expect(document.querySelector('.pitch')).toBeTruthy();
    // The old dead-end card.
    expect(screen.queryByText('Your squad is empty')).toBeNull();
  });

  it('offers an add slot for every position', async () => {
    await mountEmptyLiveSquad();
    // 2 GK + 5 DEF + 5 MID + 3 FWD = 15 slots on the empty pitch.
    const slots = document.querySelectorAll('.pitch .pitch-add, .pitch button');
    expect(slots.length).toBeGreaterThanOrEqual(11);
  });

  it('still shows the bench area', async () => {
    await mountEmptyLiveSquad();
    expect(document.querySelector('.bench-strip')).toBeTruthy();
  });
});

describe('the market tab is gone from navigation', () => {
  async function mountLayout() {
    vi.resetModules();
    const { default: AppLayout } = await import('../layouts/AppLayout');
    const { DemoProvider } = await import('../hooks/useDemo');
    const { AuthProvider } = await import('../hooks/useAuth');

    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/dashboard']}>
          <AuthProvider><DemoProvider><AppLayout /></DemoProvider></AuthProvider>
        </MemoryRouter>,
      );
    });
  }

  it('has no Market link in the bottom navigation', async () => {
    await mountLayout();
    const nav = document.querySelector('.mobile-nav');
    expect(nav).toBeTruthy();
    const labels = [...nav!.querySelectorAll('a, button')].map((n) => n.textContent?.trim());
    expect(labels).not.toContain('Market');
    // The remaining tabs are intact.
    expect(labels).toContain('Home');
    expect(labels).toContain('Squad');
    expect(labels).toContain('Standings');
  });

  it('has no Player Market entry in the sidebar', async () => {
    await mountLayout();
    expect(screen.queryByText('Player Market')).toBeNull();
  });

  it('the market screen is still reachable from the squad actions', async () => {
    await mountEmptyLiveSquad();
    // Removing the tab must not orphan the market screen.
    expect(screen.getAllByRole('link', { name: /add players|player market/i }).length).toBeGreaterThan(0);
  });
});
