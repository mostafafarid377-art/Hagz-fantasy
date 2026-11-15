// Live Match Center, fixtures and notifications.
//
// The match workflow is the most stateful part of the product:
//   organizer: create → open revision → set both lineups → submit lineup
//   leader:    approve/reject the lineup
//   organizer: fork result → set score → record events → submit result
//   leader:    approve/reject the result  (only this creates an official result)
//   leader:    open a correction, which preserves history and supersedes scores
//
// Every refusal comes from the database (self-approval, wrong organizer, not a
// leader, unsupported event type). This screen never decides authorization; it
// only offers the next step that the server would accept.

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, Check, MapPin, RefreshCw, Trophy, X } from 'lucide-react';
import { Badge, Empty, PageTitle } from '../../components/UI';
import { useLive } from '../../hooks/useLive';
import { ErrorNote, Loading, PartialDataNote } from './League';
import type { ApiMatch } from '../../types/api';

export function LiveMatchCenter() {
  const { t } = useTranslation();
  const live = useLive();
  const [selected, setSelected] = useState<ApiMatch | null>(null);

  const sorted = useMemo(
    () => [...live.matches].sort((a, b) => +new Date(b.starts_at) - +new Date(a.starts_at)),
    [live.matches],
  );

  if (live.loading) return <Loading />;
  if (!live.league) return <Empty title="Join or create a league" to="/create-league" action="Create League" />;

  return (
    <>
      <PageTitle eyebrow="MATCHDAY" title="Match Center"
        description="Real matches, organizer submissions and leader approvals.">
        <button className="button button-outline" onClick={() => void live.refreshMatches()}>
          <RefreshCw size={15} /> {t('Refresh')}
        </button>
      </PageTitle>

      {live.error && <ErrorNote message={live.error} onRetry={() => void live.reload()} />}
      <PartialDataNote failures={live.partialFailures} onRetry={() => void live.reload()} />

      {sorted.length === 0 ? (
        <Empty title="No matches yet"
          description="A league leader schedules real matches and appoints an organizer to record them." />
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('MATCH')}</th><th>{t('Kick-off')}</th><th>{t('Venue')}</th>
                <th>{t('Score')}</th><th>{t('Status')}</th><th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((m) => (
                <tr key={m.id}>
                  <td><strong>{m.team_a}</strong> <span className="muted">vs</span> <strong>{m.team_b}</strong></td>
                  <td>{new Date(m.starts_at).toLocaleString()}</td>
                  <td>{m.venue}</td>
                  <td>{m.team_a_score == null ? '—' : `${m.team_a_score} – ${m.team_b_score}`}</td>
                  <td>
                    <Badge kind={m.revision_state === 'approved' ? 'lime' : 'neutral'}>
                      {t(m.revision_state ?? 'scheduled')}
                    </Badge>
                  </td>
                  <td>
                    <button className="button button-small button-outline" onClick={() => setSelected(m)}>
                      {t('Open')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <dialog open className="player-sheet" aria-labelledby="match-title">
          <div className="sheet-handle" aria-hidden="true" />
          <button className="sheet-close" aria-label={t('Close')} onClick={() => setSelected(null)}><X size={20} /></button>
          <div className="eyebrow">{t('MATCHDAY')}</div>
          <h2 id="match-title">{selected.team_a} vs {selected.team_b}</h2>
          <p className="sheet-note">
            <CalendarDays size={14} /> {new Date(selected.starts_at).toLocaleString()} ·{' '}
            <MapPin size={14} /> {selected.venue}
          </p>
          <div className="sheet-stats">
            <div><small>{t('A')}</small><strong>{selected.team_a_score ?? '—'}</strong></div>
            <div><small>{t('State')}</small><strong>{t(selected.revision_state ?? 'scheduled')}</strong></div>
            <div><small>{t('B')}</small><strong>{selected.team_b_score ?? '—'}</strong></div>
          </div>

          {selected.events.length > 0 && (
            <>
              <h3 className="roster-heading">{t('Match events')}</h3>
              {selected.events.map((e) => (
                <div className="event-row" key={e.id}>
                  <span>{e.minute ?? '—'}′</span>
                  <b>{eventGlyph(e.type)}</b>
                  <div><strong>{t(e.type)}</strong><small>{e.player_name ?? ''}</small></div>
                </div>
              ))}
            </>
          )}

          <p className="notice">
            {t('Only an approved result creates official points. Scoring values are not approved yet, so no fantasy points are calculated.')}
          </p>
          <div className="sheet-actions">
            <button className="button button-outline" onClick={() => setSelected(null)}>{t('Close')}</button>
          </div>
        </dialog>
      )}
    </>
  );
}

function eventGlyph(type: string): string {
  switch (type) {
    case 'goal': return '⚽';
    case 'assist': return '↗';
    case 'yellow_card': return '▮';
    case 'red_card': return '▮▮';
    case 'mvp': return '★';
    case 'clean_sheet': return '🧤';
    case 'own_goal': return '↩';
    default: return '•';
  }
}

export function LiveFixtures() {
  const live = useLive();
  if (live.loading) return <Loading />;
  if (!live.league) return <Empty title="Join or create a league" to="/create-league" action="Create League" />;

  return (
    <>
      <PageTitle eyebrow="UP NEXT" title="Fixtures" description="Real matches scheduled for this league." />
      {live.matches.length === 0
        ? <Empty title="No fixtures yet" description="Your league leader schedules the matches." />
        : (
          <div className="panel">
            {live.matches.map((m) => (
              <div className="fixture-row" key={m.id}>
                <div>
                  <span className="eyebrow">GW {live.gameweeks.find((g) => g.id === m.gameweek_id)?.number ?? '—'}</span>
                  <strong>{m.team_a} vs {m.team_b}</strong>
                  <small>{new Date(m.starts_at).toLocaleString()} · {m.venue}</small>
                </div>
                <Trophy size={16} />
              </div>
            ))}
          </div>
        )}
    </>
  );
}

export function LiveNotifications() {
  const { t } = useTranslation();
  const live = useLive();
  const [busy, setBusy] = useState('');

  if (live.loading) return <Loading />;
  if (!live.league) return <Empty title="Join or create a league" to="/create-league" action="Create League" />;

  const unread = live.notifications.filter((n) => !n.read_at).length;

  return (
    <>
      <PageTitle eyebrow="YOUR ACTIVITY" title="Notifications"
        description={unread ? `${unread} ${t('unread')}` : t('All caught up!')} />
      {live.notifications.length === 0
        ? <Empty title="No new notifications" description="Decisions on suggestions, matches and membership appear here." />
        : (
          <div className="panel">
            {live.notifications.map((n) => (
              <div className={`activity-item ${n.read_at ? '' : 'unread'}`} key={n.id}>
                <span className="activity-icon"><Check size={16} /></span>
                <div>
                  <strong>{notificationText(n.kind, n.payload, t)}</strong>
                  <small>{new Date(n.created_at).toLocaleString()}</small>
                </div>
                {!n.read_at && (
                  <button className="button button-small button-outline" disabled={busy === n.id}
                    onClick={async () => {
                      setBusy(n.id);
                      try { await live.markNotificationRead(n.id); } finally { setBusy(''); }
                    }}>
                    {t('Mark read')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
    </>
  );
}

/** Render a notification payload as a sentence rather than raw JSON. */
function notificationText(kind: string, payload: Record<string, unknown>, t: (key: string) => string): string {
  const name = typeof payload.name === 'string' ? payload.name : '';
  switch (kind) {
    case 'suggestion_submitted': return `${name} ${t('suggested a player')}`;
    case 'suggestion_approved': return `${name} ${t('was approved and added to the market')}`;
    case 'suggestion_rejected': return `${name} ${t('was rejected')}`;
    case 'member_joined': return `${name} ${t('joined the league')}`;
    case 'membership_updated': return t('Your league membership was updated');
    case 'leadership_transferred': return t('You are now the league leader');
    case 'organizer_updated': return t('Your match organizer role was updated');
    case 'lineup_submitted': return t('A lineup was submitted for your review');
    case 'result_submitted': return t('A match result was submitted for your review');
    case 'match_reviewed': return `${t('A submission was')} ${String(payload.decision ?? '')}`;
    default: return kind.replace(/_/g, ' ');
  }
}
