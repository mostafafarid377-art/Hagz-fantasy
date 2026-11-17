// Authentication screens for the live backend.
//
// Three routes share this file: /login, /signup, /reset. They must work without a
// session, so they live outside the protected layout. Every state is visible:
// submitting, field errors, "check your email", and a real error message - the
// failure mode to avoid is a button that appears to do nothing.

import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { AlertCircle, Mail, ShieldCheck } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { BootstrapDiagnosticsPanel } from '../../components/BootstrapDiagnostics';
import { AuthError, sendPasswordReset, signIn, signUp } from '../../services/auth';

type Mode = 'login' | 'signup' | 'reset';

/** Human-readable, translatable text for each auth failure. */
function authMessage(error: unknown): string {
  if (!(error instanceof AuthError)) return 'Something went wrong. Please try again.';
  switch (error.code) {
    case 'invalidCredentials': return 'Email or password is incorrect.';
    case 'emailNotConfirmed': return 'Confirm your email address first. Check your inbox for the link.';
    case 'emailTaken': return 'This email is already registered. Try logging in instead.';
    case 'weakPassword': return 'Choose a stronger password (at least 8 characters).';
    case 'rateLimited': return 'Too many attempts. Please wait a few minutes and try again.';
    case 'network': return 'Network problem. Check your connection and try again.';
    case 'notConfigured': return 'The backend is not configured. Demo mode is still available.';
    default: return 'Could not complete that request. Please try again.';
  }
}

function Field({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  const { t } = useTranslation();
  return (
    <label>
      {t(label)}
      <input {...props} />
    </label>
  );
}

export function LiveAuthPage({ mode }: { mode: Mode }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const auth = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<'verify' | 'reset' | ''>('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(''); setSent('');
    if (mode !== 'login' && password.length < 8) {
      setError(t('Choose a stronger password (at least 8 characters).'));
      return;
    }
    setBusy(true);
    try {
      if (mode === 'login') {
        await signIn(email, password);
        navigate('/dashboard', { replace: true });
      } else if (mode === 'signup') {
        const result = await signUp(email, password, name || email.split('@')[0]);
        if (result.kind === 'verifyEmail') {
          setSent('verify');
        } else {
          // A session came back immediately: bootstrap runs in the auth provider.
          await auth.refresh();
          navigate('/dashboard', { replace: true });
        }
      } else {
        await sendPasswordReset(email);
        setSent('reset');
      }
    } catch (caught) {
      setError(t(authMessage(caught)));
    } finally {
      setBusy(false);
    }
  }

  const titles: Record<Mode, string> = {
    login: 'Log in', signup: 'Create your account', reset: 'Reset your password',
  };

  return (
    <div className="auth-page">
      <div className="auth-top">
        <Link className="brand" to="/">
          <span className="brand-mark">⚡</span>
          <span>fantasy<span className="brand-light">friends</span></span>
        </Link>
        <div>
          <button
            className="language-button"
            aria-label={t('Switch language')}
            onClick={() => i18n.changeLanguage(i18n.language === 'en' ? 'ar' : 'en')}
          >
            {i18n.language === 'en' ? 'العربية' : 'English'}
          </button>
          <Link to="/login">{t('Log in')}</Link>
          <Link className="button" to="/signup">{t('Sign up')}</Link>
        </div>
      </div>

      <div className="auth-content">
        <div className="eyebrow">{t('THE GAME IS BETTER TOGETHER')}</div>
        <h1>{t('Your friends.')}<br />{t('Your team.')}<br /><em>{t('Your league.')}</em></h1>
        <p>{t('The fantasy game made for your football crew.')}</p>

        <div className="panel auth-card">
          <h2>{t(titles[mode])}</h2>

          {sent === 'verify' && (
            <div className="notice" role="status">
              <ShieldCheck size={16} />{' '}
              {t('Account created. Check your email for the confirmation link, then log in.')}
            </div>
          )}
          {sent === 'reset' && (
            <div className="notice" role="status">
              <Mail size={16} />{' '}
              {t('If that address has an account, a reset link is on its way.')}
            </div>
          )}

          <form onSubmit={submit} className="form-panel">
            {mode === 'signup' && (
              <Field label="Your name" value={name} onChange={(e) => setName(e.target.value)}
                autoComplete="name" minLength={2} maxLength={100} placeholder={t('Your name')} />
            )}
            <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              autoComplete="email" required placeholder="you@example.com" />
            {mode !== 'reset' && (
              <Field label="Password" type="password" value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required minLength={mode === 'login' ? undefined : 8}
                placeholder={mode === 'signup' ? t('At least 8 characters') : t('Password')} />
            )}

            {error && (
              <p className="error" role="alert">
                <AlertCircle size={14} /> {error}
              </p>
            )}
            {auth.error && <p className="error" role="alert">{auth.error}</p>}
            {(error || auth.error) && <BootstrapDiagnosticsPanel />}

            <button className="button" disabled={busy || !email || (mode !== 'reset' && !password)}>
              {busy ? t('Please wait…') : t(titles[mode])}
            </button>
          </form>

          <div className="auth-links">
            {mode !== 'login' && <Link className="text-link" to="/login">{t('Log in')} →</Link>}
            {mode !== 'signup' && <Link className="text-link" to="/signup">{t('Sign up')} →</Link>}
            {mode !== 'reset' && <Link className="text-link" to="/reset">{t('Forgot password?')} →</Link>}
            <Link className="text-link" to="/dashboard?demo=1">{t('Explore demo')} →</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Route guard. It must NOT redirect while the session is still being restored,
 * or a refresh on a protected page would bounce a signed-in user to /login.
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const { t } = useTranslation();

  if (auth.status === 'loading') {
    return <div className="panel loading-panel" role="status">{t('Loading…')}</div>;
  }
  if (auth.status === 'anon' || !auth.session) {
    return (
      <div className="panel narrow">
        <h2>{t('Sign in required')}</h2>
        <p className="section-description">
          {t('This page needs an account. You can also continue in Demo mode with local data.')}
        </p>
        <div className="page-actions">
          <Link className="button" to="/login">{t('Log in')}</Link>
          <Link className="button button-outline" to="/signup">{t('Sign up')}</Link>
          <Link className="button button-outline" to="/dashboard?demo=1">{t('Explore demo')}</Link>
        </div>
        {auth.error && <p className="error" role="alert">{auth.error}</p>}
      </div>
    );
  }
  return <>{children}</>;
}
