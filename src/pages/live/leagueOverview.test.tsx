/**
 * @vitest-environment jsdom
 *
 * Requirements 2 and 3 - League Overview and the invite code.
 *
 * The invite code previously sat at the bottom of a "Quick links" list behind a
 * "Show code" button, so on a phone it was below the fold and one tap away. It is now
 * a dedicated card directly under the league hero, read from ff_league_code (the
 * member-scoped RPC) on mount, with Copy and - where the platform supports it - Share.
 *
 * Everything asserted here is rendered from the mocked server responses. Nothing is
 * claimed about the hosted project: that is covered by the PGlite SQL suite.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../../translations';

afterEach(() => {
  cleanup(); vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

const league = {
  league_id: 'L1', name: 'Real League FC', role: 'leader', status: 'active',
  budget: 100_000_000, market_open: true, archived: false,
  is_leader: true, is_organizer: false,
};

const members = [
  { user_id: 'u1', name: 'Me Leader', role: 'leader', status: 'active', joined_at: '2026-01-01T00:00:00Z', team_id: 't1', team_name: 'Real League FC', is_organizer: false },
  { user_id: 'u2', name: 'Second Manager', role: 'manager', status: 'active', joined_at: '2026-01-02T00:00:00Z', team_id: 't2', team_name: 'Second XI', is_organizer: false },
];

interface MockOptions {
  /** The code the RPC returns, or an error object to refuse it. */
  code?: string | { code: string; message: string };
  isLeader?: boolean;
}

async function mountOverview(opts: MockOptions = {}) {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_abcdefghijklmnop');
  vi.resetModules();

  const isLeader = opts.isLeader ?? true;
  const client = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: () => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      for (const method of ['select', 'eq', 'in', 'order', 'limit', 'is']) chain[method] = self;
      chain.then = (resolve: (value: unknown) => void) => Promise.resolve({ data: [], error: null }).then(resolve);
      return chain;
    },
    rpc: async (fn: string) => {
      if (fn === 'ff_bootstrap') {
        return {
          data: {
            profile: { id: 'u1', display_name: 'Me Leader' },
            leagues: [{ ...league, role: isLeader ? 'leader' : 'manager', is_leader: isLeader }],
          },
          error: null,
        };
      }
      if (fn === 'ff_league_code') {
        if (opts.code && typeof opts.code === 'object') {
          return { data: null, error: opts.code };
        }
        return { data: opts.code ?? 'A1B2C3D4', error: null };
      }
      if (fn === 'ff_league_members') return { data: members, error: null };
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
  const { LiveLeagueOverview } = await import('./League');

  await act(async () => {
    render(
      <MemoryRouter initialEntries={['/league']}>
        <LiveProvider userId="u1"><LiveLeagueOverview /></LiveProvider>
      </MemoryRouter>,
    );
  });
  for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); });
}

describe('the invite code is the real, server-provided code', () => {
  it('shows the code without requiring a tap', async () => {
    await mountOverview({ code: 'A1B2C3D4' });
    await waitFor(() => expect(document.querySelector('.invite-code')?.textContent).toContain('A1B2C3D4'));
    // It is not hidden behind a "Show code" control any more.
    expect(screen.queryByText(/show code/i)).toBeNull();
  });

  it('places the invite card above the members table so it is reachable on a phone', async () => {
    await mountOverview();
    const card = document.querySelector('.invite-card');
    const table = document.querySelector('.table-wrap, table');
    expect(card).toBeTruthy();
    if (table) {
      expect(card!.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('copies the code to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await mountOverview({ code: 'DEADBEEF' });

    const copy = await screen.findByRole('button', { name: /copy code/i });
    await act(async () => { copy.click(); });
    expect(writeText).toHaveBeenCalledWith('DEADBEEF');
    await waitFor(() => expect(screen.getByRole('button', { name: /copied!/i })).toBeTruthy());
  });

  it('reports a clipboard failure instead of pretending it worked', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) },
    });
    await mountOverview();
    const copy = await screen.findByRole('button', { name: /copy code/i });
    await act(async () => { copy.click(); });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/copy failed/i));
  });

  it('offers Share only when the platform supports it', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, share });
    await mountOverview({ code: 'A1B2C3D4' });
    const button = await screen.findByRole('button', { name: /share invitation/i });
    await act(async () => { button.click(); });
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0][0].text).toContain('A1B2C3D4');
  });

  it('hides Share when the platform has no Web Share API', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn() } });
    await mountOverview();
    expect(screen.queryByRole('button', { name: /share invitation/i })).toBeNull();
  });

  it('shows the server refusal, never a placeholder code, when access is denied', async () => {
    await mountOverview({ code: { code: '42501', message: 'not a member' } });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/do not have access/i));
    expect(document.querySelector('.invite-code')).toBeNull();
  });
});

describe('the overview renders the real league', () => {
  it('shows the league name, budget in millions and member count', async () => {
    await mountOverview();
    await waitFor(() => expect(document.querySelector('.league-hero h1')?.textContent).toBe('Real League FC'));
    const hero = document.querySelector('.league-hero')?.textContent?.replace(/\s/g, '') ?? '';
    expect(hero).toContain('100M');
    expect(hero).not.toMatch(/\d,\d{3}/);
  });

  it('lists every member with their role', async () => {
    await mountOverview();
    await waitFor(() => expect(document.querySelectorAll('tbody tr').length).toBe(2));
    const text = document.querySelector('table')?.textContent ?? '';
    expect(text).toContain('Me Leader');
    expect(text).toContain('Second Manager');
    expect(text).toMatch(/leader/i);
    expect(text).toMatch(/manager/i);
  });

  it('shows leader-only actions for a leader', async () => {
    await mountOverview({ isLeader: true });
    // The members table carries an Actions column only for a leader.
    await waitFor(() => expect(document.querySelector('table')?.textContent).toMatch(/actions/i));
  });
});
