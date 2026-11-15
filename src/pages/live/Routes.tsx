// Route-level switch between the demo UI and the live UI.
//
// Every existing route path is preserved: `/market`, `/squad`, `/standings` and
// the rest resolve to the live screen when a real session exists, and to the
// unchanged demo screen otherwise. That keeps both modes working from one URL
// space, which is what allows "keep Demo mode until the backend passes QA".
//
// `/login`, `/signup` and `/reset` are new and always live (the demo needs no
// account). `/dashboard?demo=1` forces demo mode without a backend.
//
// TWO SEPARATE QUESTIONS, deliberately not conflated:
//   * "is this user signed in?"  -> `signedIn`. Decides Live vs Demo, and must
//     answer yes the moment the session exists.
//   * "has the profile loaded?"  -> `auth.status === 'ready'`. Decides whether the
//     live screen has data to render yet; `RequireAuth` shows a spinner for it.
//
// The bug this file used to have: both questions were answered by one flag. A
// freshly signed-in user has a session immediately but a profile only after
// `ff_bootstrap()` returns, and during that window `signedIn` was false - so the
// route rendered the DEMO dashboard instead of waiting. Sign-in is a network
// round-trip; on a real connection the window is plainly visible, and the demo
// content it painted looked like "login succeeded but I am still on Demo".

import type { ReactElement } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppMode } from '../../hooks/useApp';
import { useAuth } from '../../hooks/useAuth';
import { RequireAuth } from './Auth';
import { LiveDashboard } from './League';

/**
 * Choose between the live screen and the demo screen for one route.
 * `live` is only used when a session exists; otherwise `demo` renders untouched.
 */
export function ModeSwitch({ live, demo }: { live: () => ReactElement; demo: () => ReactElement }) {
  const { signedIn } = useAppMode();
  const { status } = useAuth();
  if (!signedIn) {
    // Do not render the demo content while the session is still being restored.
    // A returning signed-in user would otherwise see a flash of demo data on every
    // refresh - the same class of mistake as choosing Demo on a timing event.
    if (status === 'loading') return <RestoringSession />;
    return demo();
  }
  return <RequireAuth>{live()}</RequireAuth>;
}

/** Neutral placeholder while the session is restored; not demo, not live. */
function RestoringSession() {
  const { t } = useTranslation();
  return <div className="panel loading-panel" role="status">{t('Loading…')}</div>;
}

/**
 * `/dashboard` resolves to Live for any signed-in user.
 *
 * `?demo=1` remains an explicit opt-in to the demo dashboard, including while
 * signed in, because Demo mode is a feature users choose - never a state they are
 * dropped into by a timing accident.
 */
export function DashboardRoute({ demo }: { demo: () => ReactElement }) {
  const [params] = useSearchParams();
  const { signedIn } = useAppMode();
  const { status } = useAuth();
  // An explicit "show me the demo" always wins, signed in or not: Demo mode is a
  // feature the user chooses, never something they are dropped into.
  if (params.get('demo') === '1') return demo();
  if (!signedIn) {
    if (status === 'loading') return <RestoringSession />;
    return demo();
  }
  return <RequireAuth><LiveDashboard /></RequireAuth>;
}
