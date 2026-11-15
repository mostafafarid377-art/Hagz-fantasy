/**
 * @vitest-environment jsdom
 *
 * Tests for two missing account/league controls:
 *
 *   1. NO LOG OUT. `signOut()` existed in services/auth but nothing in the UI
 *      called it, so a signed-in user could not leave their session.
 *   2. NO DELETE LEAGUE. League overview had no way to get rid of a league. It is
 *      implemented as an archive (see migration 016): every FK to `leagues` is
 *      `on delete restrict`, so a hard delete would cascade across ~15 tables and
 *      destroy other managers' history.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../../translations';

afterEach(() => { cleanup(); vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const league = {
  league_id: 'L1', name: 'My Real League', role: 'leader', status: 'active',
  budget: 100, market_open: true, archived: false, is_leader: true, is_organizer: false,
};

async function mountOverview(opts: { archiveError?: { code: string; message: string } | null } = {}) {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_abcdefghijklmnop');
  vi.resetModules();

  const calls: string[] = [];
  let archived = false;
  const client = {
    auth: { getSession: async () => ({ data: { session: null }, error: null }) },
    rpc: async (fn: string) => {
      calls.push(fn);
      if (fn === 'ff_league_archive') {
        if (opts.archiveError) return { data: null, error: opts.archiveError };
        archived = true;
        return { data: { id: 'L1', archived: true }, error: null };
      }
      if (fn === 'ff_bootstrap') {
        return {
          data: {
            profile: { id: 'u1', display_name: 'Me' },
            leagues: archived ? [{ ...league, archived: true }] : [league],
          },
          error: null,
        };
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
  const { LiveLeagueOverview } = await import('./League');

  await act(async () => {
    render(
      <MemoryRouter>
        <LiveProvider userId="u1"><LiveLeagueOverview /></LiveProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });

  return { calls, isArchived: () => archived };
}

describe('a leader can delete (archive) a league', () => {
  it('shows a delete control in the league overview', async () => {
    await mountOverview();
    expect(screen.getByRole('button', { name: /delete league/i })).toBeTruthy();
  });

  it('requires confirmation before doing anything', async () => {
    const app = await mountOverview();
    // First click only reveals the confirmation - no RPC, no destruction.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /delete league/i })); });
    expect(app.calls).not.toContain('ff_league_archive');
    expect(screen.getByRole('button', { name: /yes, delete this league/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy();
  });

  it('archives via ff_league_archive once confirmed', async () => {
    const app = await mountOverview();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /delete league/i })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /yes, delete this league/i })); });
    expect(app.calls).toContain('ff_league_archive');
    expect(app.isArchived()).toBe(true);
  });

  it('cancelling leaves the league alone', async () => {
    const app = await mountOverview();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /delete league/i })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /cancel/i })); });
    expect(app.calls).not.toContain('ff_league_archive');
    expect(screen.queryByRole('button', { name: /yes, delete this league/i })).toBeNull();
  });

  it('surfaces a refusal instead of pretending it worked', async () => {
    await mountOverview({ archiveError: { code: '42501', message: 'not an active league leader' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /delete league/i })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /yes, delete this league/i })); });
    expect(await screen.findByText(/not an active league leader/)).toBeTruthy();
  });

  it('says the league is archived, not that history is destroyed', async () => {
    await mountOverview();
    expect(screen.getByText(/members keep their history/i)).toBeTruthy();
  });
});
