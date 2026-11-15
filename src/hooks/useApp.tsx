// The single data interface the screens consume.
//
// The app has two backends behind one UI:
//   * Demo  - localStorage, no account, no network (src/hooks/useDemo.tsx)
//   * Live  - Supabase, real auth, server-enforced rules (src/hooks/useLive.tsx)
//
// Keeping Demo mode working is a stated requirement, so the mode is an explicit
// choice stored in this browser and never inferred silently. A user who picked
// Demo stays in Demo until they choose otherwise; a user who is signed in sees
// Live. `useApp()` returns which mode is active so screens can label dangerous
// actions honestly ("demo data, not real match results").

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from './useAuth';
import { isSupabaseConfigured } from '../lib/supabase';

export type AppMode = 'demo' | 'live';

const MODE_KEY = 'ff-app-mode';

interface AppModeValue {
  mode: AppMode;
  /** True when a real backend exists and could be used. */
  backendAvailable: boolean;
  /** Signed in with a real session (only meaningful in live mode). */
  signedIn: boolean;
  setMode: (mode: AppMode) => void;
}

const AppModeContext = createContext<AppModeValue | null>(null);

export function AppModeProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [preferred, setPreferred] = useState<AppMode>(() => {
    try { return (localStorage.getItem(MODE_KEY) as AppMode) === 'live' ? 'live' : 'demo'; }
    catch { return 'demo'; }
  });

  // A signed-in user is in live mode; a signed-out user who asked for live is
  // bounced back to the login screen by the route guard, not silently to demo.
  const mode: AppMode = auth.session ? 'live' : preferred;

  const setMode = useCallback((next: AppMode) => {
    setPreferred(next);
    try { localStorage.setItem(MODE_KEY, next); } catch { /* private mode */ }
  }, []);

  useEffect(() => {
    // Keep the stored preference consistent with reality once auth resolves.
    if (auth.session && preferred !== 'live') setMode('live');
  }, [auth.session, preferred, setMode]);

  const value = useMemo<AppModeValue>(() => ({
    mode,
    backendAvailable: isSupabaseConfigured,
    signedIn: Boolean(auth.session),
    setMode,
  }), [mode, auth.session, setMode]);

  return <AppModeContext.Provider value={value}>{children}</AppModeContext.Provider>;
}

export function useAppMode(): AppModeValue {
  const value = useContext(AppModeContext);
  if (!value) throw new Error('AppModeProvider required');
  return value;
}
