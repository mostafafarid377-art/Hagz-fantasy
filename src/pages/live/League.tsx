// Live dashboard, league overview, and league management.
//
// Everything here renders from server data (useLive). Loading, empty and error
// states are explicit: a leader with no league must see "create one", not a
// blank panel, and a refused action must say why.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertCircle, ArrowUpRight, CalendarDays, Check, Copy, Loader2, Shield, Trash2, Trophy, UsersRound, X,
} from 'lucide-react';
import { Badge, Empty, PageTitle, SectionHead } from '../../components/UI';
import { formatMoney } from '../../utils/format';
import { useLive } from '../../hooks/useLive';
import { useAuth } from '../../hooks/useAuth';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  const { t } = useTranslation();
  return (
    <div className="panel loading-panel" role="status" aria-live="polite">
      <Loader2 size={18} className="spin" /> {t(label)}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="panel error-panel" role="alert">
      <AlertCircle size={16} />
      <div>
        <strong>{t('That did not work')}</strong>
        <p>{message}</p>
      </div>
      {onRetry && <button className="button button-small" onClick={onRetry}>{t('Try again')}</button>}
    </div>
  );
}

/**
 * Some reads succeeded and others did not.
 *
 * Without this, a refused read (RLS misconfiguration, a revoked grant) falls back
 * to an empty list and the screen confidently reports "0 members", "no fixtures",
 * "0/15 squad" - stating as fact that the user's league is empty. That is worse
 * than an error, because nothing looks wrong. This note makes the gap explicit
 * and keeps the screen usable for the parts that did load.
 */
export function PartialDataNote({ failures, onRetry }: { failures: string[]; onRetry?: () => void }) {
  const { t } = useTranslation();
  if (failures.length === 0) return null;
  return (
    <div className="panel error-panel partial-panel" role="alert">
      <AlertCircle size={16} />
      <div>
        <strong>{t('Some data could not be loaded')}</strong>
        <p>{t('The numbers below may be incomplete. This is not an empty league.')}</p>
        <p className="partial-detail">{failures.join(' · ')}</p>
      </div>
      {onRetry && <button className="button button-small" onClick={onRetry}>{t('Try again')}</button>}
    </div>
  );
}

export function Success({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p className="validation-panel valid" role="status"><Check size={14} /> {message}</p>
  );
}

export function LiveDashboard() {
  const { t } = useTranslation();
  const live = useLive();
  const auth = useAuth();

  if (live.loading) return <Loading />;
  if (live.error) return <ErrorNote message={live.error} onRetry={() => void live.reload()} />;
  // A league is known to exist, but none of its slices could be read: every panel
  // below would render zeros ("0 members", "0 players", "no fixtures"), which the
  // user reads as an empty league rather than as a failure. Say what happened and
  // show the reasons instead of presenting fake emptiness as fact.
  if (live.leagues.length > 0 && !live.league) {
    return (
      <>
        <PageTitle eyebrow="DASHBOARD" title="Could not open your league"
          description="Your league exists, but its data could not be loaded." />
        <ErrorNote
          message={live.partialFailures.length
            ? live.partialFailures.join(' · ')
            : 'The league did not load.'}
          onRetry={() => void live.reload()}
        />
        <div className="panel narrow">
          <SectionHead title="What you can try" />
          <p className="section-description">
            {t('Reload the page. If it keeps happening, the database refused the request.')}
          </p>
          <Link className="button button-outline" to="/create-league">{t('Create League')}</Link>
        </div>
      </>
    );
  }
  if (!live.league) {
    return (
      <>
        <PageTitle eyebrow="WELCOME" title="Fantasy Friends" description="Create a league or join one with an invite code." />
        <Empty title="No league yet" description="A league is where your friends, your market and your fixtures live."
          to="/create-league" action="Create League" />
        <div className="page-actions">
          <Link className="button button-outline" to="/join-league">{t('Join League')}</Link>
        </div>
      </>
    );
  }

  const nextMatch = [...live.matches].sort((a, b) => +new Date(a.starts_at) - +new Date(b.starts_at))[0];
  const squadSize = live.squad?.players.length ?? 0;

  return (
    <>
      <PartialDataNote failures={live.partialFailures} onRetry={() => void live.reload()} />
      {live.isLeader && (
        // A leader who cannot reach their own tools assumes they were never granted
        // the role. Make the server-derived role visible instead of leaving it to a
        // menu that may be empty because of a failed read.
        <p className="notice">{t('You are the league leader of this league.')}</p>
      )}
      <PageTitle eyebrow="YOUR DASHBOARD" title="Welcome back"
        description={`${live.league.name} · ${t(live.league.role === 'leader' ? 'League Leader' : 'Fantasy manager')}`} />

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-top"><span>{t('SQUAD')}</span><span className="stat-icon"><UsersRound size={15} /></span></div>
          <div className="stat-number">{squadSize}<small>/15</small></div>
          <div className="stat-foot">{t(live.squad?.status === 'confirmed' ? 'Lineup confirmed' : 'Draft lineup')}</div>
        </div>
        <div className="stat-card">
          <div className="stat-top"><span>{t('BUDGET LEFT')}</span><span className="stat-icon"><Shield size={15} /></span></div>
          <div className="stat-number">{formatMoney((live.squad?.budget ?? 0) - (live.squad?.spent ?? 0))}</div>
          <div className="stat-foot">{t('Spent')} {formatMoney(live.squad?.spent ?? 0)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-top"><span>{t('MEMBERS')}</span><span className="stat-icon"><Trophy size={15} /></span></div>
          <div className="stat-number">{live.members.length}</div>
          <div className="stat-foot">{live.league.market_open ? t('Market open') : t('Market closed')}</div>
        </div>
        <div className="stat-card">
          <div className="stat-top"><span>{t('MATCHES')}</span><span className="stat-icon"><CalendarDays size={15} /></span></div>
          <div className="stat-number">{live.matches.length}</div>
          <div className="stat-foot">
            {nextMatch ? `${nextMatch.team_a} vs ${nextMatch.team_b}` : t('No fixtures yet')}
          </div>
        </div>
      </div>

      <div className="two-column section-spacer">
        <div className="panel">
          <SectionHead eyebrow="LIVE DATA" title="Your league" />
          <p className="section-description">
            {t('This league is stored in the database and shared with its members.')}
          </p>
          <div className="settings-row"><span>{t('Signed in as')}</span><strong>{auth.profile?.display_name}</strong></div>
          <div className="settings-row"><span>{t('Your role')}</span><Badge kind="lime">{t(live.isLeader ? 'League Leader' : 'Manager')}</Badge></div>
          {live.isOrganizer && <div className="settings-row"><span>{t('Match Organizer')}</span><Badge kind="lime">{t('Yes')}</Badge></div>}
          <div className="settings-row"><span>{t('Invite code')}</span><InviteCode /></div>
        </div>
        <div className="panel">
          <SectionHead eyebrow="QUICK LINKS" title="Quick actions" />
          {[['Player Market', '/market'], ['Suggest Player', '/suggest'], ['My Squad', '/squad'],
            ['Standings', '/standings'], ['Match Center', '/match-center']].map(([label, to]) => (
            <Link className="settings-row" to={to} key={to}>{t(label)}<ArrowUpRight size={16} /></Link>
          ))}
        </div>
      </div>
    </>
  );
}

/** Reads the invite code on demand; it never appears in the bootstrap payload. */
function InviteCode() {
  const { t } = useTranslation();
  const live = useLive();
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function reveal() {
    if (!live.leagueId) return;
    try {
      const { leagueCode } = await import('../../services/api');
      setCode(await leagueCode(live.leagueId));
    } catch { setStatus('failed'); }
  }

  if (!code) {
    return <button className="button button-small button-outline" onClick={() => void reveal()}>{t('Show code')}</button>;
  }
  return (
    <span className="invite-code">
      <strong>{code}</strong>
      <button className="button button-small button-outline" onClick={async () => {
        try { await navigator.clipboard.writeText(code); setStatus('copied'); }
        catch { setStatus('failed'); }
      }}>
        <Copy size={14} /> {t(status === 'copied' ? 'Copied!' : 'Copy code')}
      </button>
      {status === 'failed' && <small className="error">{t('Copy failed. Please copy the code manually.')}</small>}
    </span>
  );
}

export function LiveLeagueOverview() {
  const { t } = useTranslation();
  const live = useLive();
  const [busy, setBusy] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  async function deleteLeague() {
    setDeleting(true); setDeleteError('');
    try {
      await live.archiveLeague();
      // The archived league is filtered out of the next load, so this screen falls
      // back to another league or to the empty state.
      setConfirmingDelete(false);
    } catch (caught) {
      setDeleteError(caught instanceof Error ? caught.message : t('Could not delete the league.'));
    } finally { setDeleting(false); }
  }

  if (live.loading) return <Loading />;
  if (!live.league) return <Empty title="Join or create a league" to="/create-league" action="Create League" />;

  const act = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try { await action(); } catch { /* surfaced via live.error */ } finally { setBusy(''); }
  };

  return (
    <>
      <PageTitle eyebrow="YOUR COMMUNITY" title="League Overview" description="Members, roles and league settings.">
        <Link className="button button-outline" to="/create-league">{t('Create League')}</Link>
        <Link className="button" to="/join-league">{t('Join League')}</Link>
      </PageTitle>

      {live.error && <ErrorNote message={live.error} />}

      <div className="league-hero panel">
        <div className="league-logo large">{live.league.name.slice(0, 2).toUpperCase()}</div>
        <div>
          <div className="eyebrow">{t('Welcome to the circle')}</div>
          <h1>{live.league.name}</h1>
          <p>{live.members.length} {t('Members')} · {formatMoney(live.league.budget)} {t('budget')}</p>
        </div>
        <Badge kind="lime">{live.league.market_open ? t('Market open') : t('Market closed')}</Badge>
      </div>

      <div className="overview-cards">
        <div className="panel"><UsersRound /><small>{t('Members')}</small><strong>{live.members.length}</strong></div>
        <div className="panel"><Trophy /><small>{t('Your role')}</small><strong>{t(live.isLeader ? 'League Leader' : 'Manager')}</strong></div>
        <div className="panel"><CalendarDays /><small>{t('Gameweeks')}</small><strong>{live.gameweeks.length}</strong></div>
        <div className="panel"><Shield /><small>{t('Budget')}</small><strong>{formatMoney(live.league.budget)}</strong></div>
      </div>

      <div className="panel section-spacer">
        <SectionHead eyebrow="THE MEMBERS" title="Members and roles" />
        {live.members.length === 0
          ? <Empty title="No members yet" description="Share the invite code to bring your friends in." />
          : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('MEMBER')}</th><th>{t('Team')}</th><th>{t('Role')}</th>
                    <th>{t('Status')}</th>{live.isLeader && <th>{t('Actions')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {live.members.map((m) => (
                    <tr key={m.user_id}>
                      <td><strong>{m.name}</strong>{m.is_organizer && <> <Badge kind="lime">{t('Organizer')}</Badge></>}</td>
                      <td>{m.team_name ?? '—'}</td>
                      <td>{t(m.role === 'leader' ? 'League Leader' : 'Manager')}</td>
                      <td>{t(m.status === 'active' ? 'Active' : 'Inactive')}</td>
                      {live.isLeader && (
                        <td>
                          {m.user_id === live.myUserId ? <small>{t('You')}</small> : (
                            <div className="row-actions">
                              <button className="button button-small button-outline"
                                disabled={busy === m.user_id}
                                onClick={() => void act(m.user_id, () =>
                                  live.setOrganizer(m.user_id, !m.is_organizer))}>
                                {t(m.is_organizer ? 'Remove organizer' : 'Make organizer')}
                              </button>
                              <button className="button button-small button-outline"
                                disabled={busy === `${m.user_id}-s`}
                                onClick={() => void act(`${m.user_id}-s`, () =>
                                  live.setMember(m.user_id, undefined, m.status === 'active' ? 'inactive' : 'active'))}>
                                {t(m.status === 'active' ? 'Deactivate' : 'Reactivate')}
                              </button>
                              <button className="button button-small"
                                disabled={busy === `${m.user_id}-l` || m.status !== 'active'}
                                onClick={() => {
                                  if (confirm(t('Make this member the league leader? You will become a manager.'))) {
                                    void act(`${m.user_id}-l`, () => live.transferLeadership(m.user_id));
                                  }
                                }}>
                                {t('Make leader')}
                              </button>
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>

      {live.isLeader && (
        <div className="panel section-spacer">
          <SectionHead eyebrow="LEADER TOOLS" title="League settings" />
          <div className="settings-row">
            <span>{t('Transfer market')} · {t(live.league.market_open ? 'Open' : 'Closed')}</span>
            <button className="button button-outline" disabled={busy === 'market'}
              onClick={() => void act('market', () => live.setMarketOpen(!live.league!.market_open))}>
              {t(live.league.market_open ? 'Close market' : 'Open market')}
            </button>
          </div>
          <Link className="settings-row" to="/management">{t('Player Management')}<ArrowUpRight size={16} /></Link>
          <Link className="settings-row" to="/approvals">{t('Approval Queue')}<ArrowUpRight size={16} /></Link>
          <Link className="settings-row" to="/statistics">{t('Season and gameweeks')}<ArrowUpRight size={16} /></Link>
        </div>
      )}

      {/* Removing a league is leader-only and irreversible from the UI, so it sits
          apart from the settings and states plainly what happens. It is an archive,
          not a row delete: the history stays recoverable server-side while the
          league disappears from every screen. */}
      {live.isLeader && (
        <div className="panel section-spacer danger-zone">
          <SectionHead eyebrow="DANGER ZONE" title="Delete league" />
          <p className="section-description">
            {t('The league disappears from your dashboard and cannot be joined again. Members keep their history.')}
          </p>
          {confirmingDelete ? (
            <div className="button-row">
              <button className="button danger" disabled={deleting} onClick={() => void deleteLeague()}>
                {deleting ? t('Deleting…') : t('Yes, delete this league')}
              </button>
              <button className="button button-outline" disabled={deleting}
                onClick={() => { setConfirmingDelete(false); setDeleteError(''); }}>
                {t('Cancel')}
              </button>
            </div>
          ) : (
            <button className="button button-outline" onClick={() => setConfirmingDelete(true)}>
              <Trash2 size={15} /> {t('Delete league')}
            </button>
          )}
          {deleteError && <p className="error" role="alert"><AlertCircle size={14} /> {deleteError}</p>}
        </div>
      )}
    </>
  );
}

export function LiveLeagueForm({ join = false }: { join?: boolean }) {
  const { t } = useTranslation();
  const live = useLive();
  const auth = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(''); setBusy(true);
    try {
      if (join) await live.joinLeague(code.trim());
      else await live.createLeague(name.trim());
      await auth.refresh();
      // Confirm the action by going to the league. Before this the form stayed put
      // after a successful create, so "nothing happened" was indistinguishable from
      // a failure - the user's report was that it "just doesn't load".
      navigate('/league', { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('Could not complete that request.'));
    } finally { setBusy(false); }
  }

  return (
    <>
      <PageTitle eyebrow="YOUR COMMUNITY" title={join ? 'Join a league' : 'Create your league'}
        description={join ? 'Enter an invite code from your league leader.' : 'Make a home for your football community.'} />
      <form className="panel form-panel narrow" onSubmit={submit}>
        {join ? (
          <label>{t('League code')}
            <input required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABCD1234" maxLength={8} autoCapitalize="characters" />
          </label>
        ) : (
          <label>{t('League name')}
            <input required minLength={2} maxLength={100} value={name}
              onChange={(e) => setName(e.target.value)} placeholder={t('League name')} />
          </label>
        )}
        {error && <p className="error" role="alert"><AlertCircle size={14} /> {error}</p>}
        <button className="button" disabled={busy || (join ? !code : !name)}>
          {busy ? t('Please wait…') : t(join ? 'Join league' : 'Create league')}
        </button>
        <Link className="text-link" to={join ? '/create-league' : '/join-league'}>
          {t(join ? 'Create League' : 'Join League')} →
        </Link>
      </form>
      {!join && (
        <p className="notice narrow">
          {t('You become the league leader. Share the invite code so friends can join as managers.')}
        </p>
      )}
    </>
  );
}

/** Close button used by the inline dialogs in the market screens. */
export function DialogClose({ onClick, label = 'Close' }: { onClick: () => void; label?: string }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="sheet-close" aria-label={t(label)} onClick={onClick}>
      <X size={20} />
    </button>
  );
}
