// Authentication against Supabase Auth.
//
// Roles are NEVER decided here. The database derives the caller from auth.uid()
// and the league_members row; this module only carries the session. `is_leader`
// flags returned by the server are used to decide what to *render*, never what to
// *allow* - every write is re-checked in PostgreSQL.
//
// Note on email confirmation: when a project requires confirmation, signUp()
// returns a user but no session, and the user must click the emailed link before
// signInWithPassword() succeeds. The UI has to show "check your email" rather than
// assuming the session exists, which is why signUp returns a discriminated result.

import { getSupabase, isSupabaseConfigured } from '../lib/supabase';
import type { Session, User } from '@supabase/supabase-js';

export type AuthErrorCode =
  | 'notConfigured' | 'invalidCredentials' | 'emailNotConfirmed' | 'emailTaken'
  | 'weakPassword' | 'rateLimited' | 'network' | 'unknown';

export class AuthError extends Error {
  constructor(public code: AuthErrorCode, message: string) { super(message); this.name = 'AuthError'; }
}

function normalise(error: { message?: string; status?: number; code?: string } | null): AuthError {
  const message = error?.message ?? 'unknown error';
  if (/Invalid login credentials/i.test(message)) return new AuthError('invalidCredentials', message);
  if (/Email not confirmed/i.test(message)) return new AuthError('emailNotConfirmed', message);
  if (/already registered|already been registered/i.test(message)) return new AuthError('emailTaken', message);
  if (/Password should be at least|weak password/i.test(message)) return new AuthError('weakPassword', message);
  if (/rate limit|too many requests/i.test(message) || error?.status === 429) return new AuthError('rateLimited', message);
  if (/fetch|network/i.test(message)) return new AuthError('network', message);
  return new AuthError('unknown', message);
}

const requireClient = () => {
  const supabase = getSupabase();
  if (!supabase) throw new AuthError('notConfigured', 'Supabase is not configured');
  return supabase;
};

export const isAuthConfigured = isSupabaseConfigured;

export type SignUpResult =
  | { kind: 'session'; session: Session }
  | { kind: 'verifyEmail' };

/**
 * Create an account. `displayName` is stored in user metadata only as a
 * convenience: the authoritative profile row is created by ff_bootstrap() on
 * first authenticated call, so a missing metadata field cannot break sign-in.
 */
export async function signUp(email: string, password: string, displayName: string): Promise<SignUpResult> {
  const supabase = requireClient();
  const { data, error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: {
      data: { display_name: displayName.trim() },
      emailRedirectTo: `${window.location.origin}${import.meta.env.BASE_URL ?? '/'}`,
    },
  });
  if (error) throw normalise(error);
  // No session means the project requires email confirmation.
  if (!data.session) return { kind: 'verifyEmail' };
  return { kind: 'session', session: data.session };
}

export async function signIn(email: string, password: string): Promise<Session> {
  const supabase = requireClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw normalise(error);
  if (!data.session) throw new AuthError('unknown', 'no session returned');
  return data.session;
}

export async function signOut(): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw normalise(error);
}

export async function sendPasswordReset(email: string): Promise<void> {
  const supabase = requireClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: `${window.location.origin}${import.meta.env.BASE_URL ?? '/'}`,
  });
  // A reset request for an unknown address must not reveal whether the account
  // exists, so this deliberately succeeds either way.
  if (error && !/not found|no user/i.test(error.message)) throw normalise(error);
}

export async function updatePassword(password: string): Promise<void> {
  const supabase = requireClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw normalise(error);
}

export async function resendVerification(email: string): Promise<void> {
  const supabase = requireClient();
  const { error } = await supabase.auth.resend({ type: 'signup', email: email.trim() });
  if (error) throw normalise(error);
}

export async function getSession(): Promise<Session | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

/**
 * Subscribe to auth changes. Fires immediately with the current session so the
 * caller can restore state on mount without a second round-trip, then on every
 * sign-in, sign-out and token refresh.
 */
export function onAuthChange(
  callback: (session: Session | null, user: User | null, event: string) => void,
): () => void {
  const supabase = getSupabase();
  if (!supabase) { callback(null, null, 'SIGNED_OUT'); return () => {}; }
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    // The event name matters, not just the session: `SIGNED_OUT` is the client
    // telling us explicitly that the user logged out, which must be distinguished
    // from a stale/racing read that merely *looks* like "no session".
    callback(session, session?.user ?? null, event);
  });
  return () => data.subscription.unsubscribe();
}
