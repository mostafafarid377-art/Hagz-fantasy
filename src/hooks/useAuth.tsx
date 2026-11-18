// Auth state for the live backend. 'ready' means the session is established,
// not that the application profile has already loaded. A bootstrap failure
// must never make an authenticated user fall back to Demo mode.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { getSession, onAuthChange } from '../services/auth';
import { ApiError, createBootstrapSession, updateProfile, type Bootstrap, type BootstrapSession } from '../services/api';
import { isSupabaseConfigured } from '../lib/supabase';
import { recordBootstrapAuthEvent } from '../services/bootstrapDiagnostics';

export interface AuthState {
  status: 'loading' | 'anon' | 'ready';
  session: Session | null;
  user: User | null;
  profile: Bootstrap['profile'] | null;
  leagues: Bootstrap['leagues'];
  /** Last initial bootstrap failure, independent of the session. */
  error: string | null;
}

type State = AuthState & { bootstrapSession: BootstrapSession | null };

interface AuthContextValue extends State {
  /** `force` clears state even without a session; only a sign-out should ask for it. */
  refresh: (options?: { force?: boolean }) => Promise<void>;
  retryBootstrap: () => Promise<void>;
  setDisplayName: (name: string) => Promise<void>;
}

interface Identity {
  userId: string;
  bootstrap: BootstrapSession;
  profileLoaded: boolean;
}

const ANON: State = {
  status: 'anon', session: null, user: null, bootstrapSession: null, profile: null, leagues: [], error: null,
};
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ ...ANON, status: isSupabaseConfigured ? 'loading' : 'anon' });
  // A sign-out or account change ends this identity, even if the same user
  // signs back in. Token refreshes, by contrast, keep the same bootstrap flight.
  const current = useRef<Identity | null>(null);
  const authRevision = useRef(0);

  const loadProfile = useCallback(async (identity: Identity, retry = false) => {
    if (identity.profileLoaded) return;
    try {
      const data = await identity.bootstrap.load({ retry });
      if (current.current !== identity || identity.profileLoaded) return;
      identity.profileLoaded = true;
      // Keep the latest session; a token refresh may have joined this request.
      setState((previous) => ({ ...previous, profile: data.profile, leagues: data.leagues, error: null }));
    } catch (error) {
      if (current.current !== identity || identity.profileLoaded) return;
      const message = error instanceof Error ? error.message : 'Could not load your profile';
      setState((previous) => ({ ...previous, error: message }));
    }
  }, []);

  const load = useCallback(async (session: Session | null, signedOut = false) => {
    if (!session) {
      // A stale getSession() or INITIAL_SESSION=null cannot de-authenticate a
      // user we have already established. Honour only an explicit sign-out.
      if (current.current && !signedOut) return;
      current.current?.bootstrap.close();
      current.current = null;
      setState(ANON);
      return;
    }

    let identity = current.current;
    if (!identity || identity.userId !== session.user.id) {
      identity?.bootstrap.close();
      const displayName = session.user.user_metadata?.display_name;
      identity = {
        userId: session.user.id,
        profileLoaded: false,
        bootstrap: createBootstrapSession(session.user.id, {
          displayName: typeof displayName === 'string' ? displayName : undefined,
        }),
      };
      current.current = identity;
    }

    // Publish auth immediately, before the server-derived profile is ready.
    const bootstrapSession = identity.bootstrap;
    setState((previous) => ({
      ...(previous.bootstrapSession === bootstrapSession ? previous : ANON),
      status: 'ready', session, user: session.user, bootstrapSession,
    }));
    await loadProfile(identity);
  }, [loadProfile]);

  useEffect(() => {
    if (!isSupabaseConfigured) return undefined;
    let active = true;
    let sawSessionChange = false;
    const revision = authRevision.current;

    // Restore on mount, but don't let a delayed storage read replace a newer
    // auth event (including a sign-out or a different account).
    void (async () => {
      const session = await getSession();
      if (active && revision === authRevision.current) await load(session);
    })();

    const unsubscribe = onAuthChange((session, _user, event) => {
      if (!active) return;
      recordBootstrapAuthEvent(event);
      if (event === 'INITIAL_SESSION' && sawSessionChange) return;
      if (event !== 'INITIAL_SESSION') sawSessionChange = true;
      if (session || event === 'SIGNED_OUT') authRevision.current += 1;
      if (event === 'SIGNED_OUT') void load(null, true);
      else void load(session);
    });
    return () => {
      active = false;
      unsubscribe();
      authRevision.current += 1;
      current.current?.bootstrap.close();
      current.current = null;
    };
  }, [load]);

  const refresh = useCallback(async (options?: { force?: boolean }) => {
    const revision = authRevision.current;
    const session = await getSession();
    if (revision !== authRevision.current) return;
    if (!session && options?.force) authRevision.current += 1;
    await load(session, options?.force);
  }, [load]);

  const retryBootstrap = useCallback(async () => {
    const identity = current.current;
    if (identity) await loadProfile(identity, true);
  }, [loadProfile]);

  const setDisplayName = useCallback(async (name: string) => {
    const identity = current.current;
    if (!identity?.profileLoaded) throw new ApiError('invalidState', 'Load your profile before changing your name.');
    const profile = await updateProfile(name);
    if (current.current !== identity || profile.id !== identity.userId) {
      throw new ApiError('notAuthenticated', 'The session changed while saving your profile.');
    }
    setState((previous) => ({ ...previous, profile, error: null }));
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, refresh, retryBootstrap, setDisplayName }), [state, refresh, retryBootstrap, setDisplayName],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider required');
  return value;
}
