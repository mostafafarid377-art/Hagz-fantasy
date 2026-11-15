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
  refresh: () => Promise<void>;
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

  const load = useCallback(async (session: Session | null) => {
    const mine = ++generation.current;
    if (!session) {
      setState({ status: 'anon', session: null, user: null, profile: null, leagues: [], error: null });
      return;
    }
    try {
      const data = await bootstrap(
        (session.user.user_metadata?.display_name as string | undefined) ?? undefined,
      );
      if (mine !== generation.current) return;
      setState({
        status: 'ready', session, user: session.user,
        profile: data.profile, leagues: data.leagues, error: null,
      });
    } catch (error) {
      if (mine !== generation.current) return;
      // The session is valid but the backend refused bootstrap: surface it rather
      // than leaving the user on a spinner forever.
      setState({
        status: 'ready', session, user: session.user, profile: null, leagues: [],
        error: error instanceof Error ? error.message : 'Could not load your profile',
      });
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

    const unsubscribe = onAuthChange((session) => {
      if (active) void load(session);
    });
    return () => { active = false; unsubscribe(); };
  }, [load]);

  const refresh = useCallback(async () => { await load(await getSession()); }, [load]);

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
