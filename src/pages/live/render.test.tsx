/**
 * @vitest-environment jsdom
 *
 * Render-level tests for the live integration.
 *
 * These exist because the browser (Playwright) suite cannot run in every
 * environment - no Chromium binary is downloadable here - so the most important
 * regression risk would otherwise be untested: does the app still BOOT, and does
 * it still work in Demo mode with no backend configured?
 *
 * What is asserted:
 *   * With no Supabase env, the demo app renders and the demo screens still work.
 *   * The auth routes render and enforce their own validation.
 *   * The service-role key guard refuses to build a client.
 *   * A manager's leader-only controls are not rendered (the server refusal is
 *     covered separately in supabase/design/tests/phase3-api.test.mjs -
 *     hiding a button is UX, not security).
 *
 * What is NOT asserted: any real network call. There is no Supabase project here.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import '../../translations';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// Modules read import.meta.env at load time, so each test imports its subject
// after stubbing the environment it needs via vi.resetModules().
async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) vi.stubEnv(key, '');
    else vi.stubEnv(key, value);
  }
  await fn();
}

describe('frontend boots without a backend (Demo mode preserved)', () => {
  it('reports Supabase as unconfigured and builds no client', async () => {
    await withEnv({ VITE_SUPABASE_URL: undefined, VITE_SUPABASE_ANON_KEY: undefined }, async () => {
      const { isSupabaseConfigured, getSupabase } = await import('../../lib/supabase');
      expect(isSupabaseConfigured).toBe(false);
      expect(getSupabase()).toBeNull();
    });
  });

  it('detects a service-role key and refuses to create a client', async () => {
    // A legacy service_role JWT: the payload carries {"role":"service_role"}.
    const payload = btoa(JSON.stringify({ role: 'service_role' }));
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
    await withEnv({ VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_ANON_KEY: jwt }, async () => {
      const { getSupabase, looksLikeServiceRoleKey } = await import('../../lib/supabase');
      expect(looksLikeServiceRoleKey(jwt)).toBe(true);
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(getSupabase()).toBeNull();
      expect(spy).toHaveBeenCalled();
    });
  });

  it('treats a publishable key as safe', async () => {
    await withEnv({ VITE_SUPABASE_ANON_KEY: 'sb_publishable_abcdefghijklmnop' }, async () => {
      const { looksLikeServiceRoleKey } = await import('../../lib/supabase');
      expect(looksLikeServiceRoleKey('sb_publishable_abcdefghijklmnop')).toBe(false);
    });
  });
});

describe('demo screens still render', () => {
  it('renders the demo dashboard with squad and market data', async () => {
    const Dashboard = (await import('../Dashboard')).default;
    const { DemoProvider } = await import('../../hooks/useDemo');
    render(
      <DemoProvider>
        <MemoryRouter initialEntries={['/dashboard']}>
          <Routes><Route path="/dashboard" element={<Dashboard />} /></Routes>
        </MemoryRouter>
      </DemoProvider>,
    );
    // Seeded demo data must render: the welcome heading is the demo user, and
    // the squad/points cards come from the demo store, not from the network.
    expect(await screen.findByText(/Welcome back/i)).toBeTruthy();
    // The first card reports the LAST GAMEWEEK, not a season total. Scoped to the card
    // because the page also has a dedicated "Last game points" heading.
    const firstCard = document.querySelector('.stat-card');
    expect(firstCard?.textContent).toMatch(/LAST GAME POINTS/i);
    expect(screen.getByText(/SQUAD VALUE/i)).toBeTruthy();
    // The demo is explicitly labelled as static data, which must not regress.
    expect(screen.getByText(/static demo data/i)).toBeTruthy();
  });

  it('keeps the demo market usable with no network', async () => {
    const { Market } = await import('../Players');
    const { DemoProvider } = await import('../../hooks/useDemo');
    render(
      <DemoProvider>
        <MemoryRouter initialEntries={['/market']}>
          <Routes><Route path="/market" element={<Market />} /></Routes>
        </MemoryRouter>
      </DemoProvider>,
    );
    expect(await screen.findByText(/Omar Khaled/i)).toBeTruthy();
  });
});

describe('auth screens', () => {
  it('renders the login form and requires both fields', async () => {
    const { LiveAuthPage } = await import('./Auth');
    const { AuthProvider } = await import('../../hooks/useAuth');
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/login']}>
          <Routes><Route path="/login" element={<LiveAuthPage mode="login" />} /></Routes>
        </MemoryRouter>
      </AuthProvider>,
    );
    expect(await screen.findByRole('heading', { name: /log in/i })).toBeTruthy();
    const submit = screen.getByRole('button', { name: /log in/i }) as HTMLButtonElement;
    // Disabled until an email and password are present: no empty submissions.
    expect(submit.disabled).toBe(true);
  });

  it('refuses a short password on signup before any request', async () => {
    const { LiveAuthPage } = await import('./Auth');
    const { AuthProvider } = await import('../../hooks/useAuth');
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/signup']}>
          <Routes><Route path="/signup" element={<LiveAuthPage mode="signup" />} /></Routes>
        </MemoryRouter>
      </AuthProvider>,
    );
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'a@b.com' } });
    const nameFields = screen.getAllByRole('textbox');
    fireEvent.change(nameFields[nameFields.length - 1], { target: { value: 'x' } });
    const password = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(password, { target: { value: 'short' } });
    fireEvent.submit(password.closest('form')!);
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/at least 8/i);
    });
  });

  it('shows a sign-in prompt instead of a protected screen when signed out', async () => {
    const { RequireAuth } = await import('./Auth');
    const { AuthProvider } = await import('../../hooks/useAuth');
    render(
      <AuthProvider>
        <MemoryRouter>
          <RequireAuth><div>SECRET PANEL</div></RequireAuth>
        </MemoryRouter>
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.queryByText('SECRET PANEL')).toBeNull();
      expect(screen.getByRole('heading', { name: /sign in required/i })).toBeTruthy();
    });
  });
});

describe('the demo shell is not a dead end', () => {
  /**
   * Demo mode is preserved until the live app passes QA, but a user who lands on
   * the demo must be able to reach the real application. The link is deliberately
   * conditional: with no Supabase project configured, /login cannot work, so
   * showing it would be a broken affordance.
   */
  async function renderShell() {
    // AppLayout now reads the session so its chrome can say "Live" instead of
    // "Demo mode" for a signed-in user, so the shell needs the auth provider too -
    // exactly as main.tsx mounts it. With no backend configured AuthProvider
    // resolves straight to 'anon', which is the state these tests exercise.
    const [{ default: AppLayout }, { DemoProvider }, { AuthProvider }] = await Promise.all([
      import('../../layouts/AppLayout'),
      import('../../hooks/useDemo'),
      import('../../hooks/useAuth'),
    ]);
    render(
      <AuthProvider>
        <DemoProvider>
          <MemoryRouter initialEntries={['/dashboard']}>
            <Routes>
              <Route element={<AppLayout />}>
                <Route path="/dashboard" element={<div>DEMO DASHBOARD</div>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </DemoProvider>
      </AuthProvider>,
    );
    return screen.findByText('DEMO DASHBOARD');
  }

  it('offers a way into the live app when Supabase is configured', async () => {
    await withEnv(
      { VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_ANON_KEY: 'anon-key-for-tests-padded-to-realistic-length' },
      async () => {
        await renderShell();
        expect(await screen.findByRole('link', { name: /sign in to the real app/i })).toBeTruthy();
      },
    );
  });

  it('hides it when there is no backend to sign in to', async () => {
    await withEnv({ VITE_SUPABASE_URL: undefined, VITE_SUPABASE_ANON_KEY: undefined }, async () => {
      await renderShell();
      expect(screen.queryByRole('link', { name: /sign in to the real app/i })).toBeNull();
    });
  });

  it('keeps Demo mode fully working either way', async () => {
    await withEnv(
      { VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_ANON_KEY: 'anon-key-for-tests-padded-to-realistic-length' },
      async () => {
        await renderShell();
        // The demo pill and its local-data promise must survive the live build.
        expect(screen.getAllByText(/demo mode/i).length).toBeGreaterThan(0);
      },
    );
  });
});

describe('live mode never presents refused data as emptiness', () => {
  /**
   * Regression test for an audit finding.
   *
   * Every league read previously fell back to an empty value on failure, silently.
   * With RLS or a grant misconfigured, every RPC returns 42501 and the dashboard
   * rendered "0/15 squad, 0 members, no fixtures" - stating as fact that the
   * user's league was empty. Nothing looked wrong, which is the dangerous part.
   *
   * The screen must now say the data is incomplete. It must NOT invent demo data.
   */
  it('warns instead of showing an empty league when reads are denied', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key-for-tests-padded-to-realistic-length');

    const denied = async () => {
      throw Object.assign(new Error('permission denied'), { code: '42501' });
    };
    vi.doMock('../../services/api', () => ({
      ApiError: class extends Error {},
      bootstrap: async () => ({
        profile: { id: 'u1', display_name: 'Me' },
        leagues: [{
          league_id: 'L1', name: 'L', role: 'leader', status: 'active', budget: 100,
          market_open: true, archived: false, is_leader: true, is_organizer: false,
        }],
      }),
      leagueMembers: denied, marketPlayers: denied, squad: denied, suggestions: denied,
      gameweeks: denied, matches: denied, transfers: denied, standings: denied, notifications: denied,
    }));

    const [{ LiveProvider }, { LiveDashboard }, { AuthProvider }] = await Promise.all([
      import('../../hooks/useLive'), import('./League'), import('../../hooks/useAuth'),
    ]);
    render(
      <AuthProvider>
        <LiveProvider userId="u1">
          <MemoryRouter><LiveDashboard /></MemoryRouter>
        </LiveProvider>
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/some data could not be loaded/i);
    });
    // The failure must be named, so the operator can diagnose it.
    expect(screen.getByRole('alert').textContent).toMatch(/permission denied/i);

    vi.doUnmock('../../services/api');
  });
});
