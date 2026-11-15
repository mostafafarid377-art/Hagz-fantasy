// Live account screens: /profile and /settings for a signed-in user.
//
// These two routes were the only ones never switched from the demo screens, so a
// signed-in user saw the sidebar announce "Live" while /profile rendered the demo
// persona (a hardcoded "Mariam Hassan") under a "Demo mode" badge. The live
// profile is therefore built from the session and the server-derived profile, not
// from demo state, and it says plainly when the profile could not be loaded
// instead of substituting a demo name.
//
// Editing is deliberately narrow: only the display name is writable, via the
// existing `ff_update_profile` RPC reached through `useAuth().setDisplayName`.
// Email and password live in Supabase Auth and are not edited here.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AlertCircle, Check, Globe2, Mail, ShieldCheck, UsersRound } from 'lucide-react';
import { Avatar, Badge, PageTitle, SectionHead } from '../../components/UI';
import { useAuth } from '../../hooks/useAuth';
import { ErrorNote, Loading } from './League';

/** The name to show for the signed-in user, preferring the server profile. */
function displayName(profileName?: string | null, email?: string | null): string {
  const trimmed = profileName?.trim();
  if (trimmed) return trimmed;
  // The email local-part is a reasonable stand-in until ff_bootstrap has run.
  const local = email?.split('@')[0]?.trim();
  return local || '';
}

export function LiveProfile() {
  const { t } = useTranslation();
  const auth = useAuth();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const email = auth.user?.email ?? auth.session?.user.email ?? '';
  const current = displayName(auth.profile?.display_name as string | undefined, email);

  // Seed the field from the server value, and re-seed when it arrives, so the
  // input is not stuck showing the fallback from before bootstrap finished.
  useEffect(() => { setName(current); }, [current]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const next = name.trim();
    if (!next || next === current) return;
    setBusy(true); setError(''); setSaved(false);
    try {
      await auth.setDisplayName(next);
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('Could not save your name.'));
    } finally {
      setBusy(false);
    }
  }

  // The session is established but ff_bootstrap has not resolved: show a spinner
  // rather than a name we cannot yet vouch for.
  if (auth.status === 'loading') return <Loading />;

  return (
    <>
      <PageTitle eyebrow="YOUR ACCOUNT" title="User Profile" description="Your account details." />
      <div className="panel profile-hero">
        <Avatar name={current || 'You'} size="lg" />
        <div>
          <Badge kind="lime">{t('Live')}</Badge>
          <h1>{current || t('Signed in')}</h1>
          <p>{email}</p>
        </div>
        <Link to="/settings" className="button button-outline">{t('Settings')}</Link>
      </div>

      {auth.error && <ErrorNote message={auth.error} onRetry={() => void auth.refresh()} />}

      <div className="panel narrow form-panel section-spacer">
        <SectionHead eyebrow="YOUR DETAILS" title="Display name" />
        <form onSubmit={save}>
          <label>{t('Display name')}
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); setSaved(false); }}
              maxLength={60}
              placeholder={t('Display name')}
              aria-label={t('Display name')}
            />
          </label>
          {saved && <p className="notice" role="status"><Check size={14} /> {t('Saved')}</p>}
          {error && <p className="error" role="alert"><AlertCircle size={14} /> {error}</p>}
          <button className="button" disabled={busy || !name.trim() || name.trim() === current}>
            {busy ? t('Please wait…') : t('Save changes')}
          </button>
        </form>
        <div className="settings-row">
          <span><Mail size={18} /> {t('Email')}</span>
          <strong>{email || t('Unknown')}</strong>
        </div>
        <p className="notice">{t('Your email and password are managed by the sign-in service.')}</p>
      </div>
    </>
  );
}

export function LiveSettings() {
  const { t, i18n } = useTranslation();
  const auth = useAuth();
  const email = auth.user?.email ?? auth.session?.user.email ?? '';
  const current = displayName(auth.profile?.display_name as string | undefined, email);

  return (
    <>
      <PageTitle eyebrow="PREFERENCES" title="Settings" description="Your account and appearance." />
      <div className="panel narrow settings-panel">
        <SectionHead title="Settings" />
        <div className="settings-row">
          <span><Globe2 size={18} /> {t('Language')}</span>
          <select aria-label={t('Language')} value={i18n.language}
            onChange={(e) => i18n.changeLanguage(e.target.value)}>
            <option value="en">{t('English')}</option>
            <option value="ar">{t('Arabic')}</option>
          </select>
        </div>
        <div className="settings-row">
          <span><UsersRound size={18} /> {t('Display name')}</span>
          <strong>{current || t('Signed in')}</strong>
        </div>
        <div className="settings-row">
          <span><ShieldCheck size={18} /> {t('Status')}</span>
          <Badge kind="lime">{t('Live')}</Badge>
        </div>
        <Link className="settings-row" to="/profile">{t('Edit your profile')} <Check size={16} /></Link>
        {/* The demo-only controls (role switch, reset demo data) intentionally do
            not appear here: they mutate browser-local demo state and would be
            meaningless - and misleading - for a signed-in user. */}
        <p className="notice">{t('Demo role and demo data are available in Demo mode.')}</p>
      </div>
    </>
  );
}
