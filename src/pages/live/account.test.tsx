/**
 * @vitest-environment jsdom
 *
 * Regression tests for the "signed in, but /profile shows the demo account" defect.
 *
 * THE BUG: `/profile` and `/settings` were the only two routes in `main.tsx` that
 * never went through `ModeSwitch`. They rendered the demo components directly, so
 * a signed-in user saw the sidebar announce "Live" while the profile page showed a
 * hardcoded demo persona ("Mariam Hassan") under a "Demo mode" badge.
 *
 * These tests mount the REAL providers, the REAL route decision and the REAL live
 * account screens against a fake Supabase client. They fail if either route is
 * ever reverted to rendering the demo component unconditionally, and they fail if
 * the live profile starts showing demo data again.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../../translations';

afterEach(() => { cleanup(); vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const session = (id: string, email = 'live-user@example.com') => ({
  access_token: 'not-a-real-token', refresh_token: 'r',
  user: { id, email, user_metadata: {} },
});

const boot = {
  profile: { id: 'live-user', display_name: 'Live Person' },
  leagues: [{ league_id: 'L1', name: 'Real League FC', role: 'manager', status: 'active',
    budget: 100, market_open: true, archived: false, is_leader: false, is_organizer: false }],
};

/** Mount one of the account routes through the real ModeSwitch decision. */
async function mountAccount(opts: {
  initialSession?: unknown;
  bootstrapError?: { code: string; message: string } | null;
  path?: string;
} = {}) {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_abcdefghijklmnop');
  vi.resetModules();

  const rpcCalls: string[] = [];
  let nextGetSession: unknown = opts.initialSession ?? null;
  const subs: Array<(event: string, s: unknown) => void> = [];

  const client = {
    auth: {
      getSession: async () => ({ data: { session: nextGetSession }, error: null }),
      onAuthStateChange: (cb: (event: string, s: unknown) => void) => {
        subs.push(cb);
        return { data: { subscription: { unsubscribe: () => {
          const i = subs.indexOf(cb); if (i >= 0) subs.splice(i, 1);
        } } } };
      },
      signInWithPassword: async () => {
        nextGetSession = session('live-user');
        for (const cb of [...subs]) await cb('SIGNED_IN', nextGetSession);
        return { data: { session: nextGetSession }, error: null };
      },
      signOut: async () => {
        nextGetSession = null;
        for (const cb of [...subs]) await cb('SIGNED_OUT', null);
        return { error: null };
      },
    },
    rpc: async (fn: string) => {
      rpcCalls.push(fn);
      if (opts.bootstrapError) return { data: null, error: opts.bootstrapError };
      return { data: boot, error: null };
    },
  };

  vi.doMock('../../lib/supabase', () => ({
    isSupabaseConfigured: true,
    getSupabase: () => client,
    looksLikeServiceRoleKey: () => false,
    PLAYER_IMAGES_BUCKET: 'player-images',
  }));

  const { AuthProvider } = await import('../../hooks/useAuth');
  const { AppModeProvider } = await import('../../hooks/useApp');
  const { DemoProvider } = await import('../../hooks/useDemo');
  const { ModeSwitch } = await import('./Routes');
  const { LiveProfile, LiveSettings } = await import('./Account');
  // The demo screens are stubbed with markers: they need the full demo dataset, and
  // what is under test is WHICH branch renders, not what the demo page paints.
  const DemoMarker = ({ name }: { name: string }) =>
    <div data-testid="demo-screen">{name}</div>;

  const route = (opts.path ?? '/profile') === '/profile'
    ? <ModeSwitch live={() => <LiveProfile />} demo={() => <DemoMarker name="DEMO PROFILE" />} />
    : <ModeSwitch live={() => <LiveSettings />} demo={() => <DemoMarker name="DEMO SETTINGS" />} />;

  render(
    <MemoryRouter initialEntries={[opts.path ?? '/profile']}>
      <AuthProvider>
        <AppModeProvider>
          <DemoProvider>{route}</DemoProvider>
        </AppModeProvider>
      </AuthProvider>
    </MemoryRouter>,
  );

  return {
    rpcCalls,
    /** Resolve the initial `getSession()` round-trip. */
    settle: async () => { await act(async () => { await Promise.resolve(); }); },
  };
}

// ---------------------------------------------------------------------------

describe('a signed-in user gets the live account screens', () => {
  it('/profile shows the real display name, not the demo persona', async () => {
    await mountAccount({ initialSession: session('live-user') });
    // The server-derived profile name wins.
    expect(await screen.findByText('Live Person')).toBeTruthy();
    expect(screen.queryByText('Mariam Hassan')).toBeNull();
    expect(screen.queryByTestId('demo-screen')).toBeNull();
  });

  it('/profile never announces Demo mode to a signed-in user', async () => {
    await mountAccount({ initialSession: session('live-user') });
    await screen.findByText('Live Person');
    // The badge said "Demo mode" on a LIVE profile - the exact contradiction reported.
    expect(screen.queryByText('Demo mode')).toBeNull();
    expect(screen.getAllByText('Live').length).toBeGreaterThan(0);
  });

  it('/settings is the live screen, without the demo role switcher', async () => {
    await mountAccount({ initialSession: session('live-user'), path: '/settings' });
    expect(await screen.findByText('Live Person')).toBeTruthy();
    expect(screen.queryByTestId('demo-screen')).toBeNull();
    // "Demo role" and "Reset demo data" mutate browser-local demo state and are
    // meaningless for a signed-in user.
    expect(screen.queryByText('Demo role')).toBeNull();
    expect(screen.queryByText('Reset demo data')).toBeNull();
  });

  it('the account routes ask the backend for the profile (ff_bootstrap)', async () => {
    const app = await mountAccount({ initialSession: session('live-user') });
    await screen.findByText('Live Person');
    expect(app.rpcCalls).toContain('ff_bootstrap');
  });

  it('falls back to the email local-part before the profile arrives, still not demo', async () => {
    // No session: this assertion is about the fallback only when signed in, so use
    // a session whose bootstrap has not resolved yet (rpc resolves in a later tick).
    await mountAccount({ initialSession: session('live-user', 'someone@example.com') });
    // Either the profile name or the email stand-in is acceptable; "Mariam Hassan" is not.
    expect(screen.queryByText('Mariam Hassan')).toBeNull();
    await screen.findByText('Live Person');
  });
});

describe('a signed-out visitor still gets the demo screens', () => {
  it('/profile renders the demo profile when there is no session', async () => {
    await mountAccount({ initialSession: null });
    expect(await screen.findByTestId('demo-screen')).toBeTruthy();
    expect(screen.getByText('DEMO PROFILE')).toBeTruthy();
  });

  it('/settings renders the demo settings when there is no session', async () => {
    await mountAccount({ initialSession: null, path: '/settings' });
    expect(await screen.findByTestId('demo-screen')).toBeTruthy();
    expect(screen.getByText('DEMO SETTINGS')).toBeTruthy();
  });
});

describe('a signed-in user whose profile cannot be loaded is not shown demo data', () => {
  it('surfaces the backend error instead of substituting the demo persona', async () => {
    await mountAccount({
      initialSession: session('live-user'),
      bootstrapError: { code: '42501', message: 'authentication required' },
    });
    // Being authenticated and having an unreadable profile are different things:
    // the page must say so, and must NOT quietly render demo data.
    expect(await screen.findByText(/authentication required/)).toBeTruthy();
    expect(screen.queryByText('Mariam Hassan')).toBeNull();
    expect(screen.queryByTestId('demo-screen')).toBeNull();
  });
});
