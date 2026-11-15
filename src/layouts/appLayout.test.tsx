/**
 * @vitest-environment jsdom
 *
 * Regression tests for the sidebar league selector.
 *
 * THE BUG: `AppLayout` read `state.leagues` from `useDemo` unconditionally. The
 * demo dataset contains two leagues ("The Football Circle" and "Friday Night
 * League"), so a SIGNED-IN user saw those two listed under "YOUR LEAGUE" as if
 * they were real leagues they had created. Nothing was leaking across accounts -
 * `ff_bootstrap` scopes correctly to `m.user_id = auth.uid()` - the sidebar was
 * simply rendering demo data while the content pane showed live data.
 *
 * The selector must therefore list the live leagues when a LiveProvider exists,
 * and the demo leagues only when it does not.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../translations';

afterEach(() => { cleanup(); vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const fakeAuth = () => ({
  status: 'ready' as const,
  session: { access_token: 't', refresh_token: 'r', user: { id: 'live-user', email: 'live@example.com', user_metadata: {} } },
  user: { id: 'live-user', email: 'live@example.com', user_metadata: {} },
  profile: { id: 'live-user', display_name: 'Live Person' },
  leagues: [], error: null,
  refresh: async () => {}, setDisplayName: async () => {},
});

/**
 * Mount AppLayout with a LiveProvider exposing `liveLeagues`.
 * `withLiveProvider: false` simulates demo mode (no provider, as in main.tsx).
 */
async function mountLayout(opts: { withLiveProvider: boolean; liveLeagues?: Array<{ league_id: string; name: string }> }) {
  vi.resetModules();
  const liveLeagues = (opts.liveLeagues ?? []).map((l) => ({
    ...l, role: 'manager', status: 'active', budget: 100, market_open: true,
    archived: false, is_leader: false, is_organizer: false,
  }));

  // `isLive` is `Boolean(auth.session) && isSupabaseConfigured`, so the configured
  // flag must be true or the layout takes the demo branch regardless of the mock.
  vi.doMock('../lib/supabase', () => ({
    isSupabaseConfigured: opts.withLiveProvider,
    getSupabase: () => null,
    looksLikeServiceRoleKey: () => false,
    PLAYER_IMAGES_BUCKET: 'player-images',
  }));

  vi.doMock('../hooks/useAuth', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../hooks/useAuth');
    return { ...actual, useAuth: fakeAuth, AuthProvider: ({ children }: any) => children };
  });

  // A minimal live context: only what AppLayout reads.
  vi.doMock('../hooks/useLive', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../hooks/useLive');
    const context = {
      leagues: liveLeagues,
      league: liveLeagues[0] ?? null,
      selectLeague: () => {},
    };
    const { createContext } = await import('react');
    const Ctx = createContext<unknown>(null);
    return {
      ...actual,
      LiveContext: Ctx,
      LiveProvider: ({ children }: any) => <Ctx.Provider value={context}>{children}</Ctx.Provider>,
      useLiveOptional: () => context,
    };
  });

  const { default: AppLayout } = await import('./AppLayout');
  const { DemoProvider } = await import('../hooks/useDemo');
  const { AuthProvider } = await import('../hooks/useAuth');
  const { LiveProvider } = await import('../hooks/useLive');

  const body = (
    <MemoryRouter initialEntries={['/dashboard']}>
      <AuthProvider>
        <DemoProvider>
          {opts.withLiveProvider
            ? <LiveProvider userId="live-user"><AppLayout /></LiveProvider>
            : <AppLayout />}
        </DemoProvider>
      </AuthProvider>
    </MemoryRouter>
  );

  await act(async () => { render(body); });
}

describe('the sidebar league selector shows the signed-in user\'s leagues', () => {
  it('lists live leagues, never the demo leagues', async () => {
    await mountLayout({
      withLiveProvider: true,
      liveLeagues: [{ league_id: 'L1', name: 'My Real League' }],
    });
    const selector = screen.getByLabelText('Switch league') as HTMLSelectElement;
    const options = [...selector.options].map((o) => o.textContent);
    expect(options).toContain('My Real League');
    // The exact leagues the user reported as "2 leagues I didn't create".
    expect(options).not.toContain('The Football Circle');
    expect(options).not.toContain('Friday Night League');
  });

  it('shows an explicit empty state instead of demo leagues when there are none', async () => {
    await mountLayout({ withLiveProvider: true, liveLeagues: [] });
    const selector = screen.getByLabelText('Switch league') as HTMLSelectElement;
    const options = [...selector.options].map((o) => o.textContent);
    expect(options).not.toContain('The Football Circle');
    expect(options).not.toContain('Friday Night League');
  });
});

describe('demo mode is unchanged', () => {
  it('still lists the demo leagues when there is no live session', async () => {
    await mountLayout({ withLiveProvider: false });
    const selector = screen.getByLabelText('Switch league') as HTMLSelectElement;
    const options = [...selector.options].map((o) => o.textContent);
    // Demo mode is a feature; its own leagues must keep working.
    expect(options).toContain('The Football Circle');
    expect(options).toContain('Friday Night League');
  });
});
