/**
 * @vitest-environment jsdom
 *
 * Regression tests for the "login succeeded but the app showed Demo data" defect.
 *
 * THE BUG, in two parts:
 *   1. `DashboardRoute`/`ModeSwitch` decided Live-vs-Demo from a flag that was only
 *      true AFTER `ff_bootstrap()` returned. A freshly signed-in user has a session
 *      immediately and a profile a round-trip later, so during that window the
 *      route painted the DEMO dashboard. On a real connection the window is
 *      plainly visible.
 *   2. `AuthProvider.load(null)` cleared state unconditionally, so a `getSession()`
 *      that resolved after `SIGNED_IN` (or found storage empty) de-authenticated a
 *      user who had just logged in - and then they stayed on Demo until a reload.
 *      `AppLayout` compounded it by always rendering "Demo mode" chrome.
 *
 * These tests drive the REAL providers, the REAL route components and the REAL
 * layout against a fake Supabase client, so they fail if either part comes back.
 * No network, no real project: the client is mocked at `lib/supabase`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../../translations';

afterEach(() => { cleanup(); vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

/**
 * Holds the `useAuth` hook for the nested <LiveProviderGate> below. Declared at
 * module scope because the gate is rendered inside the tree, after the dynamic
 * import of the provider module.
 */
const useAuthRef: { current: (() => { session: { user: { id: string } } | null }) | null } = { current: null };

type Listener = (event: string, session: unknown) => void;

interface Harness {
  signIn: () => Promise<void>;
  emit: (event: string, session: unknown | null) => Promise<void>;
  setNextGetSession: (session: unknown | null) => void;
  setNextSignIn: (outcome: { session?: unknown; error?: unknown }) => void;
  listeners: () => number;
}

const session = (id: string) => ({
  access_token: 'not-a-real-token', refresh_token: 'r',
  user: { id, email: `${id}@example.com`, user_metadata: {} },
});

const demoLeagues = {
  profile: { id: 'live-user', display_name: 'Live Person' },
  leagues: [{ league_id: 'L1', name: 'Real League FC', role: 'manager', status: 'active',
    budget: 100, market_open: true, archived: false, is_leader: false, is_organizer: false }],
};

/**
 * Build a fake Supabase client and mount the app's provider stack.
 * `bootstrapDelayMs` lets a test sit inside the sign-in -> profile window.
 */
async function mountApp(opts: {
  initialSession?: unknown;
  bootstrapDelayMs?: number;
  bootstrapError?: { code: string; message: string } | null;
  path?: string;
  /** Route tree under AppLayout: use the real `/dashboard` decision. */
} = {}) {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_abcdefghijklmnop');
  vi.resetModules();

  let currentSession: unknown = opts.initialSession ?? null;
  let nextGetSession: unknown = opts.initialSession ?? null;
  let nextSignIn: { session?: unknown; error?: unknown } = { session: session('live-user') };
  const subs: Listener[] = [];

  const client = {
    auth: {
      getSession: async () => ({ data: { session: nextGetSession }, error: null }),
      onAuthStateChange: (cb: Listener) => {
        subs.push(cb);
        return { data: { subscription: { unsubscribe: () => {
          const i = subs.indexOf(cb); if (i >= 0) subs.splice(i, 1);
        } } } };
      },
      signInWithPassword: async () => {
        if (nextSignIn.error) return { data: { session: null }, error: nextSignIn.error };
        currentSession = nextSignIn.session;
        nextGetSession = nextSignIn.session;
        // Mirrors supabase-js: SIGNED_IN is emitted from inside signInWithPassword.
        for (const cb of [...subs]) await cb('SIGNED_IN', currentSession);
        return { data: { session: nextSignIn.session }, error: null };
      },
      signOut: async () => {
        currentSession = null; nextGetSession = null;
        for (const cb of [...subs]) await cb('SIGNED_OUT', null);
        return { error: null };
      },
    },
    rpc: async () => {
      if (opts.bootstrapDelayMs) await new Promise((r) => setTimeout(r, opts.bootstrapDelayMs));
      if (opts.bootstrapError) return { data: null, error: opts.bootstrapError };
      return { data: demoLeagues, error: null };
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
  const { default: AppLayout } = await import('../../layouts/AppLayout');
  const { DashboardRoute } = await import('./Routes');
  const { LiveDashboard } = await import('./League');

  // The demo dashboard is replaced by a marker so a test can tell unambiguously
  // which branch of DashboardRoute rendered. The real one needs the full demo
  // dataset; the decision under test is the branch, not the pixels.
  const DemoDashboard = () => <div data-testid="demo-dashboard">DEMO ACCOUNT</div>;

  render(
    <MemoryRouter initialEntries={[opts.path ?? '/dashboard']}>
      <AuthProvider>
        <AppModeProvider>
          <DemoProvider>
            <AppLayout />
          </DemoProvider>
        </AppModeProvider>
      </AuthProvider>
    </MemoryRouter>,
  );

  // AppLayout renders an <Outlet/>, so the route element is mounted separately by
  // rendering DashboardRoute into the same tree via a nested Routes would be
  // circular; instead assert on the decision component directly below.
  return {
    listeners: () => subs.length,
    setNextGetSession: (s: unknown | null) => { nextGetSession = s; },
    setNextSignIn: (o: { session?: unknown; error?: unknown }) => { nextSignIn = o; },
    emit: async (event: string, s: unknown) => {
      await act(async () => { for (const cb of [...subs]) await cb(event, s); });
    },
    signIn: async () => {
      await act(async () => {
        const { signIn } = await import('../../services/auth');
        await signIn('live@example.com', 'password123');
      });
    },
    DemoDashboard,
    DashboardRoute,
    LiveDashboard,
  } satisfies Partial<Harness> & Record<string, unknown>;
}

/** Render just the `/dashboard` decision, inside the same provider stack. */
async function mountDashboardDecision(opts: {
  initialSession?: unknown; bootstrapDelayMs?: number; bootstrapError?: { code: string; message: string } | null;
  path?: string;
} = {}) {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_abcdefghijklmnop');
  vi.resetModules();

  let nextGetSession: unknown = opts.initialSession ?? null;
  let nextSignIn: { session?: unknown; error?: unknown } = { session: session('live-user') };
  const subs: Listener[] = [];

  const client = {
    auth: {
      getSession: async () => ({ data: { session: nextGetSession }, error: null }),
      onAuthStateChange: (cb: Listener) => {
        subs.push(cb);
        return { data: { subscription: { unsubscribe: () => {
          const i = subs.indexOf(cb); if (i >= 0) subs.splice(i, 1);
        } } } };
      },
      signInWithPassword: async () => {
        if (nextSignIn.error) return { data: { session: null }, error: nextSignIn.error };
        nextGetSession = nextSignIn.session;
        for (const cb of [...subs]) await cb('SIGNED_IN', nextSignIn.session);
        return { data: { session: nextSignIn.session }, error: null };
      },
      signOut: async () => {
        nextGetSession = null;
        for (const cb of [...subs]) await cb('SIGNED_OUT', null);
        return { error: null };
      },
    },
    rpc: async () => {
      if (opts.bootstrapDelayMs) await new Promise((r) => setTimeout(r, opts.bootstrapDelayMs));
      if (opts.bootstrapError) return { data: null, error: opts.bootstrapError };
      return { data: demoLeagues, error: null };
    },
  };

  vi.doMock('../../lib/supabase', () => ({
    isSupabaseConfigured: true,
    getSupabase: () => client,
    looksLikeServiceRoleKey: () => false,
    PLAYER_IMAGES_BUCKET: 'player-images',
  }));

  // Stub the live dashboard BEFORE Routes is imported: rendering the real one needs
  // the full live dataset, and the decision under test is which branch of
  // DashboardRoute is taken, not what the live screen paints.
  vi.doMock('./League', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('./League');
    return { ...actual, LiveDashboard: () => <div data-testid="live-dashboard">LIVE</div> };
  });

  const { AuthProvider, useAuth } = await import('../../hooks/useAuth');
  const { AppModeProvider } = await import('../../hooks/useApp');
  const { DemoProvider } = await import('../../hooks/useDemo');
  const { LiveProvider } = await import('../../hooks/useLive');
  const { DashboardRoute } = await import('./Routes');

  /** Mirrors main.tsx's <LiveData>: the live screens require a LiveProvider. */
  function LiveProviderGate({ children }: { children: React.ReactNode }) {
    const auth = useAuthRef.current!();
    if (!auth.session) return <>{children}</>;
    return <LiveProvider userId={auth.session.user.id}>{children}</LiveProvider>;
  }
  useAuthRef.current = useAuth;

  render(
    <MemoryRouter initialEntries={[opts.path ?? '/dashboard']}>
      <AuthProvider>
        <AppModeProvider>
          <DemoProvider>
            <LiveProviderGate>
              <DashboardRoute demo={() => <div data-testid="demo-dashboard">DEMO ACCOUNT</div>} />
            </LiveProviderGate>
          </DemoProvider>
        </AppModeProvider>
      </AuthProvider>
    </MemoryRouter>,
  );

  return {
    signIn: async () => {
      await act(async () => {
        const { signIn } = await import('../../services/auth');
        await signIn('live@example.com', 'password123');
      });
    },
    signInExpectingError: async (): Promise<unknown> => {
      const { signIn, AuthError } = await import('../../services/auth');
      try { await signIn('live@example.com', 'wrong'); return null; }
      catch (e) { return e instanceof AuthError ? e : null; }
    },
    setNextGetSession: (s: unknown | null) => { nextGetSession = s; },
    setNextSignIn: (o: { session?: unknown; error?: unknown }) => { nextSignIn = o; },
    emit: async (event: string, s: unknown) => {
      await act(async () => { for (const cb of [...subs]) await cb(event, s); });
    },
    listenerCount: () => subs.length,
  };
}

// ---------------------------------------------------------------------------

describe('successful login enters Live mode', () => {
  it('renders the live dashboard, never the demo dashboard, after signIn()', async () => {
    const app = await mountDashboardDecision();
    // While the session is still being resolved there is a neutral placeholder -
    // NOT demo data. That distinction is the fix: demo is never painted just
    // because auth has not answered yet.
    await waitFor(() => expect(screen.queryByTestId('demo-dashboard')).toBeNull());

    await app.signIn();

    await waitFor(() => expect(screen.getByTestId('live-dashboard')).toBeTruthy());
    expect(screen.queryByTestId('demo-dashboard')).toBeNull();
  });

  it('enters Live immediately - it must not wait for ff_bootstrap() before choosing', async () => {
    // The original bug: for the whole bootstrap round-trip the route rendered the
    // demo branch. With a slow bootstrap the correct behaviour is to show the live
    // branch with a loading state, not demo data.
    const app = await mountDashboardDecision({ bootstrapDelayMs: 250 });
    await app.signIn();

    // Still inside the bootstrap window: the DEMO dashboard must not be painted.
    expect(screen.queryByTestId('demo-dashboard')).toBeNull();

    await waitFor(() => expect(screen.getByTestId('live-dashboard')).toBeTruthy(), { timeout: 2000 });
  });
});

describe('authenticated users never see demo data on /dashboard', () => {
  it('a restored session renders Live on a cold load', async () => {
    await mountDashboardDecision({ initialSession: session('live-user') });
    await waitFor(() => expect(screen.getByTestId('live-dashboard')).toBeTruthy());
    expect(screen.queryByTestId('demo-dashboard')).toBeNull();
  });

  it('a late getSession()=null cannot knock a signed-in user back to Demo', async () => {
    // The race that made the symptom intermittent: SIGNED_IN lands first, then the
    // mount-time restore (or a second read) reports null.
    const app = await mountDashboardDecision();
    await app.signIn();
    await waitFor(() => expect(screen.getByTestId('live-dashboard')).toBeTruthy());

    app.setNextGetSession(null);
    await app.emit('INITIAL_SESSION', null);

    expect(screen.queryByTestId('demo-dashboard')).toBeNull();
    expect(screen.getByTestId('live-dashboard')).toBeTruthy();
  });

  it('a TOKEN_REFRESHED event keeps the user on Live', async () => {
    const app = await mountDashboardDecision({ initialSession: session('live-user') });
    await waitFor(() => expect(screen.getByTestId('live-dashboard')).toBeTruthy());
    await app.emit('TOKEN_REFRESHED', session('live-user'));
    expect(screen.getByTestId('live-dashboard')).toBeTruthy();
  });

  it('an explicit SIGNED_OUT does return to Demo', async () => {
    // The guard must suppress stale nulls only - a real logout still works.
    await mountDashboardDecision({ initialSession: session('live-user') });
    await waitFor(() => expect(screen.getByTestId('live-dashboard')).toBeTruthy());

    const { signOut } = await import('../../services/auth');
    await act(async () => { await signOut(); });

    await waitFor(() => expect(screen.getByTestId('demo-dashboard')).toBeTruthy());
  });
});

describe('unauthenticated users can still explicitly enter Demo mode', () => {
  it('/dashboard?demo=1 renders demo for a signed-out visitor', async () => {
    await mountDashboardDecision({ path: '/dashboard?demo=1' });
    await waitFor(() => expect(screen.getByTestId('demo-dashboard')).toBeTruthy());
  });

  it('/dashboard?demo=1 still renders demo for a signed-in user who asked for it', async () => {
    // Demo mode is a feature, not a fallback: choosing it must keep working.
    await mountDashboardDecision({ initialSession: session('live-user'), path: '/dashboard?demo=1' });
    await waitFor(() => expect(screen.getByTestId('demo-dashboard')).toBeTruthy());
    expect(screen.queryByTestId('live-dashboard')).toBeNull();
  });

  it('a signed-out visitor on plain /dashboard gets demo', async () => {
    await mountDashboardDecision();
    await waitFor(() => expect(screen.getByTestId('demo-dashboard')).toBeTruthy());
  });
});

describe('session restoration after refresh', () => {
  it('restores the session before deciding, so no demo flash occurs', async () => {
    await mountDashboardDecision({ initialSession: session('live-user'), bootstrapDelayMs: 120 });
    // Not even momentarily: the very first committed render must not be demo.
    expect(screen.queryByTestId('demo-dashboard')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('live-dashboard')).toBeTruthy());
  });
});

describe('failed authentication does not mark the user as authenticated', () => {
  it('an invalid password leaves the user on Demo and reports an AuthError', async () => {
    const app = await mountDashboardDecision();
    app.setNextSignIn({ error: { message: 'Invalid login credentials', status: 400 } });

    const error = await app.signInExpectingError();
    expect(error).toBeTruthy();
    expect((error as { code: string }).code).toBe('invalidCredentials');

    // No session may have been established by a failed attempt.
    await waitFor(() => expect(screen.getByTestId('demo-dashboard')).toBeTruthy());
    expect(screen.queryByTestId('live-dashboard')).toBeNull();
  });

  it('a session whose bootstrap fails is still signed in, and is not downgraded to demo', async () => {
    // Being authenticated and having an unreadable profile are different things.
    // The former decides the mode; the latter is surfaced as an error on the live
    // screen by RequireAuth/LiveDashboard.
    await mountDashboardDecision({
      initialSession: session('live-user'),
      bootstrapError: { code: '42501', message: 'authentication required' },
    });
    await waitFor(() => expect(screen.getByTestId('live-dashboard')).toBeTruthy());
    expect(screen.queryByTestId('demo-dashboard')).toBeNull();
  });
});

describe('the app frame reflects the real session', () => {
  it('AppLayout announces Live, not Demo mode, for a signed-in user', async () => {
    const app = await mountApp({ initialSession: session('live-user') });
    await waitFor(() => expect(screen.getByTestId('mode-pill').textContent).toContain('Live'));
    expect(screen.getByTestId('mode-pill').textContent).not.toContain('Demo mode');
    expect(screen.getByTestId('mode-footer').textContent).toContain('Live');
    expect(app.listeners()).toBeGreaterThan(0);
  });

  it('AppLayout still announces Demo mode when signed out', async () => {
    await mountApp();
    await waitFor(() => expect(screen.getByTestId('mode-pill').textContent).toContain('Demo mode'));
    expect(screen.getByTestId('mode-footer').textContent).toContain('Demo mode');
  });
});
