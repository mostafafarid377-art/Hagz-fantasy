// Route-level switch between the demo UI and the live UI.
//
// Every existing route path is preserved: `/market`, `/squad`, `/standings` and
// the rest resolve to the live screen when a real session exists, and to the
// unchanged demo screen otherwise. That keeps both modes working from one URL
// space, which is what allows "keep Demo mode until the backend passes QA".
//
// `/login`, `/signup` and `/reset` are new and always live (the demo needs no
// account). `/dashboard?demo=1` forces demo mode without a backend.

import type { ReactElement } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAppMode } from '../../hooks/useApp';
import { RequireAuth } from './Auth';
import { LiveDashboard } from './League';

/**
 * Choose between the live screen and the demo screen for one route.
 * `live` is only used when a session exists; otherwise `demo` renders untouched.
 */
export function ModeSwitch({ live, demo }: { live: () => ReactElement; demo: () => ReactElement }) {
  const { signedIn } = useAppMode();
  if (!signedIn) return demo();
  return <RequireAuth>{live()}</RequireAuth>;
}

/** `/dashboard?demo=1` explicitly opts into demo mode, even when signed in. */
export function DashboardRoute({ demo }: { demo: () => ReactElement }) {
  const [params] = useSearchParams();
  const { signedIn } = useAppMode();
  if (params.get('demo') === '1' || !signedIn) return demo();
  return <RequireAuth><LiveDashboard /></RequireAuth>;
}
