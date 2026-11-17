// Auth state for the live backend.
//
// Three states the UI must distinguish:
//   status 'loading'  - the session has not been restored yet (do not redirect!)
//   status 'anon'     - no session; protected routes bounce to /login
//   status 'ready'    - a session plus the server-derived profile and leagues
//
// The bootstrap call is what turns a bare auth session into an application user:
// it creates/updates the profile row and returns the leagues with the roles the
// DATABASE believes the user has. Nothing here trusts client-side role state.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { getSession, onAuthChange } from '../services/auth';
import { bootstrap, type Bootstrap } from '../services/api';
import { isSupabaseConfigured } from '../lib/supabase';

export interface AuthState {
  status: 'loading' | 'anon' | 'ready';
  session: Session | null;
  user: User | null;
  profile: Bootstrap['profile'] | null;
  leagues: Bootstrap['leagues'];
  /** Last bootstrap failure, shown once rather than swallowed. */
  error: string | null;
}

interface AuthContextValue extends AuthState {
  /** `force` clears state even without a session; only a sign-out should ask for it. */
  refresh: (options?: { force?: boolean }) => Promise<void>;
  setDisplayName: (name: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    status: isSupabaseConfigured ? 'loading' : 'anon',
    session: null, user: null, profile: null, leagues: [], error: null,
  });
  // Guards against a bootstrap response for an old user overwriting a new one.
  const generation = useRef(0);
  // The user id this provider currently believes it is signed in as, if any.
  // Written synchronously with the session so event handlers reconcile instead of
  // racing: see `load`.
  const currentUserId = useRef<string | null>(null);
  // The user whose profile is already loaded, so a token refresh does not re-bootstrap.
  const bootstrappedUserId = useRef<string | null>(null);
  // `getSession()` and Supabase's INITIAL_SESSION event can resolve together on
  // mount. Share one RPC for that user so a late duplicate failure cannot win the
  // generation race after an earlier bootstrap already succeeded.
  const bootstrapInFlight = useRef(new Map<string, Promise<Bootstrap>>());

  const load = useCallback(async (session: Session | null) => {
    const mine = ++generation.current;
    if (!session) {
      // A `null` session must never silently de-authenticate a user we have already
      // established. This is not defensive noise: the mount-time `getSession()`
      // restore and `onAuthStateChange` run concurrently, and a `getSession()` that
      // resolves late (or that finds storage empty while the auth client has already
      // emitted SIGNED_IN) used to clear a perfectly good session. The result was
      // `/dashboard` falling back to Demo data seconds after a successful login.
      //
      // A real sign-out is always announced explicitly as SIGNED_OUT, so the only
      // thing this guard can suppress is a stale read, never a genuine logout.
      if (currentUserId.current !== null) return;
      setState({ status: 'anon', session: null, user: null, profile: null, leagues: [], error: null });
      return;
    }

    // Establish the session IMMEDIATELY. This is the crux of the dashboard bug:
    // `session` used to be published only after `ff_bootstrap()` returned, so for
    // a whole network round-trip the app believed the user was signed out and every
    // route rendered its Demo branch. Sign-in must decide the mode at once; loading
    // the profile is a separate, later concern that the live screens show as a
    // spinner (see LiveProvider). `status: 'ready'` therefore means "auth is
    // resolved", not "the profile is here".
    const sameUser = session.user.id === currentUserId.current;
    currentUserId.current = session.user.id;
    setState((previous) => ({
      ...previous, status: 'ready', session, user: session.user,
      // Keep the profile/leagues we already have for this user so a token refresh
      // does not blank the screen or restart the spinner.
      profile: sameUser ? previous.profile : null,
      leagues: sameUser ? previous.leagues : [],
    }));

    // Already bootstrapped this user: a TOKEN_REFRESHED (or a duplicate SIGNED_IN)
    // only needs the fresh session object, not another round-trip. The ref mirrors
    // the profile so this check does not need `state` in the dependency list.
    if (sameUser && bootstrappedUserId.current === session.user.id) return;

    const userId = session.user.id;
    let request = bootstrapInFlight.current.get(userId);
    if (!request) {
      request = bootstrap(
        (session.user.user_metadata?.display_name as string | undefined) ?? undefined,
      );
      bootstrapInFlight.current.set(userId, request);
    }
    try {
      const data = await request;
      if (mine !== generation.current) return;
      bootstrappedUserId.current = userId;
      setState({
        status: 'ready', session, user: session.user,
        profile: data.profile, leagues: data.leagues, error: null,
      });
    } catch (error) {
      if (mine !== generation.current) return;
      // The session is valid but the backend refused bootstrap: surface it rather
      // than leaving the user on a spinner forever. This is NOT a reason to fall
      // back to Demo - the user is authenticated either way.
      setState((previous) => ({
        status: 'ready', session, user: session.user,
        // A transient refresh failure is not evidence that the account has no
        // leagues. Keep the last verified directory for this same identity; only
        // a genuinely new user starts without cached memberships.
        profile: sameUser ? previous.profile : null,
        leagues: sameUser ? previous.leagues : [],
        error: error instanceof Error ? error.message : 'Could not load your profile',
      }));
    } finally {
      if (bootstrapInFlight.current.get(userId) === request) {
        bootstrapInFlight.current.delete(userId);
      }
    }
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured) return undefined;
    let active = true;

    // Restore an existing session first, so a reload does not flash the login page.
    void (async () => {
      const session = await getSession();
      if (active) await load(session);
    })();

    const unsubscribe = onAuthChange((session, _user, event) => {
      if (!active) return;
      // An explicit sign-out clears the established identity FIRST, so the `null`
      // that follows is honoured instead of being suppressed as a stale read.
      if (event === 'SIGNED_OUT') {
        currentUserId.current = null;
        bootstrappedUserId.current = null;
        bootstrapInFlight.current.clear();
      }
      void load(session);
    });
    return () => { active = false; unsubscribe(); };
  }, [load]);

  /**
   * Re-read the session from storage and reload the profile.
   *
   * `force` is for the one caller that legitimately needs to clear state: an
   * explicit sign-out. Ordinary callers get the stale-read protection in `load`,
   * which is what stops a refresh from bouncing a signed-in user to Demo mode.
   */
  const refresh = useCallback(async (options?: { force?: boolean }) => {
    const session = await getSession();
    if (!session && options?.force) { currentUserId.current = null; bootstrappedUserId.current = null; }
    await load(session);
  }, [load]);

  const setDisplayName = useCallback(async (name: string) => {
    const data = await bootstrap(name);
    setState((previous) => ({ ...previous, profile: data.profile, leagues: data.leagues, error: null }));
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, refresh, setDisplayName }), [state, refresh, setDisplayName],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider required');
  return value;
}
