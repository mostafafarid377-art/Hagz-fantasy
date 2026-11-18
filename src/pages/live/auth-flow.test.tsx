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
import { StrictMode } from 'react';
import { render, screen, act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../../translations';

afterEach(() => { cleanup(); vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

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
  emitInitialSession?: boolean;
  bootstrapHandler?: (call: number) => Promise<{ data: unknown; error: unknown; status?: number }>;
  getSessionHandler?: () => Promise<unknown>;
  realDashboard?: boolean;
  path?: string;
} = {}) {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_abcdefghijklmnop');
  vi.resetModules();

  const bootstrapArgs: Array<Record<string, unknown> | undefined> = [];
  let nextGetSession: unknown = opts.initialSession ?? null;
  let nextSignIn: { session?: unknown; error?: unknown } = { session: session('live-user') };
  const subs: Listener[] = [];

  const client = {
    auth: {
      getSession: async () => ({
        data: { session: opts.getSessionHandler ? await opts.getSessionHandler() : nextGetSession }, error: null,
      }),
      onAuthStateChange: (cb: Listener) => {
        subs.push(cb);
        if (opts.emitInitialSession) cb('INITIAL_SESSION', nextGetSession);
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
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      if (fn !== 'ff_bootstrap') return { data: [], error: null };
      bootstrapArgs.push(args);
      if (opts.bootstrapHandler) return opts.bootstrapHandler(bootstrapArgs.length);
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

  // Most tests only check the mode decision. The recovery test clicks the
  // real dashboard's Try again button rather than calling the service directly.
  if (opts.realDashboard) vi.doUnmock('./League');
  else vi.doMock('./League', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('./League');
    return { ...actual, LiveDashboard: () => <div data-testid="live-dashboard">LIVE</div> };
  });

  const { AuthProvider, useAuth } = await import('../../hooks/useAuth');
  const { AppModeProvider } = await import('../../hooks/useApp');
  const { DemoProvider } = await import('../../hooks/useDemo');
  const { LiveProvider } = await import('../../hooks/useLive');
  const { DashboardRoute } = await import('./Routes');

  let currentAuthState: ReturnType<typeof useAuth> | null = null;
  /** Mirrors main.tsx's <LiveData>: the live screens require a LiveProvider. */
  function LiveProviderGate({ children }: { children: React.ReactNode }) {
    const auth = useAuth();
    currentAuthState = auth;
    if (!auth.session || !auth.bootstrapSession) return <>{children}</>;
    return <LiveProvider key={auth.session.user.id} userId={auth.session.user.id} initialLeagues={auth.leagues}
      bootstrapSession={auth.bootstrapSession} retryInitialBootstrap={auth.retryBootstrap}
      directoryReady={Boolean(auth.profile || auth.error)} initialDirectoryLoaded={Boolean(auth.profile)}
      directoryError={auth.profile ? null : auth.error}>
      {children}
    </LiveProvider>;
  }

  render(
    <StrictMode>
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
      </MemoryRouter>
    </StrictMode>,
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
    bootstrapCalls: () => bootstrapArgs.length,
    bootstrapArgs,
    authState: () => currentAuthState!,
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
    await waitFor(() => expect(app.bootstrapCalls()).toBe(1));
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

describe('bootstrap failures and duplicate session events', () => {
  it('makes one request across Strict Mode, session restore, and overlapping auth events', async () => {
    let finish!: (result: { data: unknown; error: null }) => void;
    const pending = new Promise<{ data: unknown; error: null }>((resolve) => { finish = resolve; });
    const app = await mountDashboardDecision({
      initialSession: session('live-user'),
      emitInitialSession: true,
      bootstrapHandler: () => pending,
    });
    await waitFor(() => expect(app.bootstrapCalls()).toBe(1));
    await app.emit('SIGNED_IN', session('live-user'));
    await app.emit('TOKEN_REFRESHED', { ...session('live-user'), access_token: 'new-token' });
    expect(app.bootstrapCalls()).toBe(1);

    await act(async () => { finish({ data: demoLeagues, error: null }); });
    expect(app.bootstrapCalls()).toBe(1);
    expect(app.authState().session?.access_token).toBe('new-token');
    expect(app.authState().profile?.id).toBe('live-user');
    expect(app.authState().error).toBeNull();
    expect(screen.getByTestId('live-dashboard')).toBeTruthy();
    expect(screen.queryByTestId('demo-dashboard')).toBeNull();
  });

  it('does not restart after 504 auth events, and recovers from the dashboard Try again button', async () => {
    const app = await mountDashboardDecision({
      initialSession: session('live-user'),
      realDashboard: true,
      bootstrapHandler: async (call) => call === 1
        ? { data: null, status: 504, error: { code: 'PGRST003', message: 'pool timeout' } }
        : { data: demoLeagues, error: null },
    });
    const retry = await screen.findByRole('button', { name: 'Try again' });
    await app.emit('TOKEN_REFRESHED', session('live-user'));
    await app.emit('SIGNED_IN', session('live-user'));
    await act(async () => { await app.authState().refresh(); });
    expect(app.bootstrapCalls()).toBe(1);
    expect(app.authState().session?.user.id).toBe('live-user');
    expect(app.authState().profile).toBeNull();

    fireEvent.click(retry);
    expect(await screen.findByRole('heading', { name: /welcome back/i })).toBeTruthy();
    expect(app.bootstrapCalls()).toBe(2);
    expect(app.authState().profile?.id).toBe('live-user');
    expect(app.authState().error).toBeNull();
    expect(screen.queryByTestId('demo-dashboard')).toBeNull();
  });

  it("does not carry the previous user's retry gate into a new user's session", async () => {
    const app = await mountDashboardDecision({
      initialSession: session('live-user'),
      bootstrapHandler: async (call) => call === 1
        ? { data: null, status: 504, error: { code: 'PGRST003' } }
        : { data: { profile: { id: 'new-user', display_name: 'New Player' }, leagues: [] }, error: null },
    });
    await waitFor(() => expect(app.authState().error).toBeTruthy());
    const newSession = session('new-user');
    await app.emit('SIGNED_IN', { ...newSession, user: { ...newSession.user, user_metadata: { display_name: 'New Player' } } });

    expect(app.authState().session?.user.id).toBe('new-user');
    expect(app.authState().profile?.id).toBe('new-user');
    expect(app.authState().error).toBeNull();
    expect(app.bootstrapArgs).toEqual([{ p_display_name: null }, { p_display_name: 'New Player' }]);
  });

  it('ignores a delayed session restore for a different user', async () => {
    let finish!: (session: unknown) => void;
    const stale = new Promise((resolve) => { finish = resolve; });
    const app = await mountDashboardDecision({ getSessionHandler: () => stale });
    await app.emit('SIGNED_IN', session('live-user'));
    await act(async () => { finish(session('stale-user')); });
    expect(app.bootstrapCalls()).toBe(1);
    expect(app.authState().session?.user.id).toBe('live-user');
    expect(app.authState().profile?.id).toBe('live-user');
  });

  it('retries an initial transport failure on the next auth refresh', async () => {
    const app = await mountDashboardDecision({
      initialSession: session('live-user'),
      bootstrapHandler: async (call) => {
        if (call === 1) throw new TypeError('Load failed');
        return { data: demoLeagues, error: null };
      },
    });

    await waitFor(() => expect(app.authState().error).toBe('Load failed'));
    expect(app.authState().session?.user.id).toBe('live-user');
    expect(screen.queryByTestId('demo-dashboard')).toBeNull();

    await app.emit('TOKEN_REFRESHED', session('live-user'));
    await waitFor(() => expect(app.authState().profile?.id).toBe('live-user'));
    expect(app.bootstrapCalls()).toBe(2);
    expect(app.authState().error).toBeNull();
  });

  it('does not reuse a stale in-flight bootstrap after sign-out and sign-in', async () => {
    let finishStale!: (result: { data: unknown; error: unknown }) => void;
    const staleRequest = new Promise<{ data: unknown; error: unknown }>((resolve) => { finishStale = resolve; });
    const app = await mountDashboardDecision({
      initialSession: session('live-user'),
      bootstrapHandler: async (call) => call === 1 ? staleRequest : { data: demoLeagues, error: null },
    });

    await waitFor(() => expect(app.bootstrapCalls()).toBe(1));
    await app.emit('SIGNED_OUT', null);
    await app.emit('SIGNED_IN', session('live-user'));
    await waitFor(() => expect(app.bootstrapCalls()).toBe(2));
    await waitFor(() => expect(app.authState().profile?.id).toBe('live-user'));

    await act(async () => {
      finishStale({ data: null, error: { code: '42501', message: 'stale request failed' } });
      await staleRequest;
    });
    expect(app.authState().profile?.id).toBe('live-user');
    expect(app.authState().error).toBeNull();
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
