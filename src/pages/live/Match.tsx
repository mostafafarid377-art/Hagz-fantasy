// Live Match Center, fixtures and notifications. Match mutations are backed by
// the authenticated ff_match_* RPCs; visibility here is convenience only, while
// authorization and immutable-history rules remain enforced in PostgreSQL.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, CalendarDays, Check, MapPin, RefreshCw, Shield, X, Zap } from 'lucide-react';
import { Badge, Empty, PageTitle } from '../../components/UI';
import { useLive } from '../../hooks/useLive';
import * as api from '../../services/api';
import { ErrorNote, Loading, PartialDataNote } from './League';
import type { ApiMatch, ApiMatchRevision, Position } from '../../types/api';
import { ScheduleMatchForm } from './ScheduleMatchForm';
import './matchWorkflow.css';

export function LiveMatchCenter() {
  const { t } = useTranslation();
  const live = useLive();
  const { matchId: routeMatchId } = useParams();
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const matchDialog = useRef<HTMLDialogElement>(null);

  const sorted = useMemo(() => [...live.matches].sort((a, b) => +new Date(b.starts_at) - +new Date(a.starts_at)), [live.matches]);
  const selected = live.matches.find((m) => m.id === (selectedId ?? routeMatchId)) ?? null;

  useEffect(() => {
    const element = matchDialog.current;
    if (!selected || !element || element.open) return;
    if (typeof element.showModal === 'function') element.showModal();
    else element.setAttribute('open', '');
  }, [selected?.id]);

  function closeMatch() {
    setSelectedId(null);
    if (routeMatchId) navigate('/match-center', { replace: true });
  }

  if (live.loading) return <Loading />;
  if (!live.league) return <Empty title="Join or create a league" to="/create-league" action="Create League" />;
  const featured = sorted[0];

  return <>
    <PageTitle eyebrow="MATCHDAY" title="Match Center" description={t('Schedule matches, manage lineups and publish official results.')}>
      {live.isLeader && <button className="button button-primary" onClick={() => setCreateOpen((v) => !v)}>{t('Schedule match')}</button>}
      <button className="button button-outline" onClick={() => void live.refreshMatches()}><RefreshCw size={15} /> {t('Refresh')}</button>
    </PageTitle>
    {live.error && <ErrorNote message={live.error} onRetry={() => void live.reload()} />}
    <PartialDataNote failures={live.partialFailures} onRetry={() => void live.reload()} />
    {createOpen && live.isLeader && live.leagueId && <ScheduleMatchForm leagueId={live.leagueId} gameweeks={live.gameweeks} members={live.members} onCancel={() => setCreateOpen(false)} onCreated={async () => { await live.refreshMatches(); setCreateOpen(false); }} />}

    {sorted.length === 0 ? <Empty title="No matches yet" description={live.isLeader ? 'Schedule the first match for this league.' : 'A League Leader schedules matches and appoints an organizer.'} /> : <>
      {featured && <div className="match-center-hero panel">
        <Badge kind={featured.is_official ? 'lime' : 'neutral'}>{t(featured.is_official ? 'Full time' : 'Scheduled')}</Badge>
        <div className="center-teams"><div><div className="team-crest crest-lime"><Shield size={30} /></div><strong>{featured.team_a}</strong></div><div><small>{featured.is_official ? t('Final score') : t('Upcoming')}</small><b>{featured.is_official ? `${featured.team_a_score} : ${featured.team_b_score}` : 'VS'}</b></div><div><div className="team-crest crest-orange"><Zap size={30} /></div><strong>{featured.team_b}</strong></div></div>
        <div className="match-info"><span><CalendarDays size={16} /> {new Date(featured.starts_at).toLocaleString()}</span><span><MapPin size={16} /> {featured.venue}</span>{featured.gameweek_id && <span>{t('GAMEWEEK')} {live.gameweeks.find((g) => g.id === featured.gameweek_id)?.number ?? '—'}</span>}</div>
      </div>}
      <div className="panel table-wrap"><table><thead><tr><th>{t('MATCH')}</th><th>{t('Kick-off')}</th><th>{t('Venue')}</th><th>{t('Score')}</th><th>{t('Status')}</th><th /></tr></thead><tbody>
        {sorted.map((m) => <tr key={m.id}><td><strong>{m.team_a}</strong> <span className="muted">vs</span> <strong>{m.team_b}</strong></td><td>{new Date(m.starts_at).toLocaleString()}</td><td>{m.venue}</td><td>{m.is_official ? `${m.team_a_score} – ${m.team_b_score}` : '—'}</td><td><Badge kind={m.is_official ? 'lime' : 'neutral'}>{t(m.is_official ? 'Full time' : m.revision_state ?? 'scheduled')}</Badge></td><td><button className="button button-small button-outline" onClick={() => setSelectedId(m.id)}>{t('Open')}</button></td></tr>)}
      </tbody></table></div>
    </>}
    {selected && <dialog ref={matchDialog} className="player-sheet match-detail-sheet" aria-labelledby="match-title"
      onClose={closeMatch} onClick={(event) => { if (event.target === event.currentTarget) closeMatch(); }}>
      <div className="sheet-handle" aria-hidden="true" />
      <button type="button" className="sheet-close" aria-label={t('Close')} onClick={closeMatch}><X size={20} /></button>
      <div className="eyebrow">{t('MATCHDAY')}</div><h2 id="match-title">{selected.team_a} vs {selected.team_b}</h2>
      <p className="sheet-note"><CalendarDays size={14} /> {new Date(selected.starts_at).toLocaleString()} · <MapPin size={14} /> {selected.venue}</p>
      <MatchWorkflow match={selected} />
      <div className="sheet-actions"><button type="button" className="button button-outline" onClick={closeMatch}>{t('Close')}</button></div>
    </dialog>}
  </>;
}

function MatchWorkflow({ match }: { match: ApiMatch }) {
  const { t } = useTranslation();
  const live = useLive();
  const [busy, setBusy] = useState(false);
  const [forkRequestId, setForkRequestId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reason, setReason] = useState('');
  const [playersBySide, setPlayersBySide] = useState<Record<string, Record<string, 'starter' | 'substitute'>>>({});
  const [scoreA, setScoreA] = useState(0); const [scoreB, setScoreB] = useState(0);
  const [eventPlayer, setEventPlayer] = useState(''); const [eventType, setEventType] = useState('goal');
  const [eventMinute, setEventMinute] = useState(''); const [relatedPlayer, setRelatedPlayer] = useState('');
  const history = match.history ?? [];
  const current: ApiMatchRevision | undefined = history[0];
  const canOrganize = live.isLeader || (match.organizer_id === live.myUserId && live.members.some((member) => member.user_id === live.myUserId && member.status === 'active' && member.is_organizer));
  const approvedLineups = history.flatMap((r) => r.submissions.filter((s) => s.kind === 'lineup' && s.approval?.decision === 'approved').map((s) => ({ revision: r, approval: s.approval! })));
  const approvedLineup = approvedLineups[0];
  const currentLineups = current?.lineups ?? [];
  const selectedPlayers = playersBySide;
  const eventPlayers = currentLineups.flatMap((l) => l.players);

  useEffect(() => {
    const seeded: Record<string, Record<string, 'starter' | 'substitute'>> = {};
    for (const l of current?.lineups ?? []) seeded[l.team_id] = Object.fromEntries(l.players.map((p) => [p.player_id, p.selection]));
    setPlayersBySide(seeded);
    setScoreA(current?.team_a_score ?? 0); setScoreB(current?.team_b_score ?? 0);
  }, [current?.revision_id]);

  async function run(action: () => Promise<unknown>, success: string) {
    if (!live.leagueId) return;
    setBusy(true); setError(''); setNotice('');
    try { await action(); await live.refreshMatches(); setNotice(success); }
    catch (e) {
      setError(e instanceof Error ? e.message : 'The server refused this action');
      // A multi-call action (saving two side lineups) can partially persist before
      // a later RPC is refused. Refresh even on failure so the UI reflects the
      // server's actual state instead of hiding that committed first step.
      try { await live.refreshMatches(); } catch { /* keep the original action error visible */ }
    }
    finally { setBusy(false); }
  }
  async function openResultRevision(approvalId: string) {
    if (!live.leagueId) return;
    const requestId = forkRequestId ?? crypto.randomUUID();
    setForkRequestId(requestId); setBusy(true); setError(''); setNotice('');
    try {
      const opened = await api.forkResult(live.leagueId, approvalId, requestId);
      await live.refreshMatches();
      const persisted = await api.matches(live.leagueId);
      if (!persisted.some((row) => row.id === match.id && row.revision_id === opened.revision_id)) {
        throw new Error('The result draft was created but could not be verified. Retry to safely retrieve the same revision.');
      }
      setForkRequestId(null);
      setNotice('Editable result revision opened.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The result revision could not be opened');
      // Reuse the same key after a lost response; the RPC returns the original
      // revision rather than creating a second result draft on retry.
      try { await live.refreshMatches(); } catch { /* retain the retry key */ }
    } finally { setBusy(false); }
  }
  const togglePlayer = (team: string, id: string, checked: boolean) => setPlayersBySide((prev) => {
    const side = { ...(prev[team] ?? {}) };
    if (checked) side[id] = 'starter'; else delete side[id];
    return { ...prev, [team]: side };
  });
  const setSelection = (team: string, id: string, selection: 'starter' | 'substitute') => setPlayersBySide((prev) => ({ ...prev, [team]: { ...(prev[team] ?? {}), [id]: selection } }));
  const pending = history.flatMap((r) => r.submissions.filter((s) => s.kind === 'lineup' && !s.approval).map((s) => ({ revision: r, submission: s })));
  const pendingResult = current?.submissions.find((s) => s.kind === 'result' && !s.approval);
  const canEditDraft = canOrganize && !!current && (current.state === 'draft' || current.state === 'corrected');
  const isResultDraft = !!current && current.state === 'draft' && !!approvedLineup && current.revision_id !== approvedLineup.revision.revision_id && !current.correction && current.lineups.length === 2;

  return <div className="match-workflow">
    <div className="sheet-stats"><div><small>A</small><strong>{match.team_a_score ?? '—'}</strong></div><div><small>Workflow</small><strong>{current?.state ?? 'Scheduled'}</strong></div><div><small>B</small><strong>{match.team_b_score ?? '—'}</strong></div></div>
    {error && <p className="error-text" role="alert">{error}</p>}{notice && <p className="success-text" role="status">{notice}</p>}
    {canOrganize && <p className="notice">{t('League Leader and assigned active Organizer can manage this match. Organizer results publish immediately when complete; the Leader may also finalize them. Fantasy scoring remains pending until scoring rules are approved.')}</p>}
    {canOrganize && !current && <button className="button button-primary" disabled={busy} onClick={() => void run(() => api.openRevision(live.leagueId!, match.id), 'Match record opened.')}>Open match record</button>}
    {canOrganize && current?.state === 'rejected' && <button className="button button-primary" disabled={busy} onClick={() => void run(() => api.openRevision(live.leagueId!, match.id), 'A new immutable revision is open for correction.')}>Open new revision</button>}
    {canEditDraft && <section className="workflow-section"><h3>Lineups · published League Market</h3><p className="muted">Choose players independently for both sides. Selection uses Market player identity, not fantasy ownership. The server checks active same-league Market membership, duplicate selection, and lineup limits.</p>
      {[{id:match.team_a_id,name:match.team_a},{id:match.team_b_id,name:match.team_b}].map((side) => <fieldset className="match-side-picker" key={side.id}><legend>{side.name} · {Object.values(selectedPlayers[side.id] ?? {}).filter((x) => x === 'starter').length}/{match.starters_per_side} starters · {Object.values(selectedPlayers[side.id] ?? {}).filter((x) => x === 'substitute').length}/{match.max_substitutes} substitutes</legend>
        {live.players.filter((p) => p.active).map((player) => <label className="match-player-choice" key={player.player_id}><input type="checkbox" checked={!!selectedPlayers[side.id]?.[player.player_id]} disabled={!!playersBySide[side.id === match.team_a_id ? match.team_b_id : match.team_a_id]?.[player.player_id]} onChange={(e) => togglePlayer(side.id, player.player_id, e.target.checked)} /><span>{player.name} <small>{player.position}</small></span>{selectedPlayers[side.id]?.[player.player_id] && <select aria-label={`${player.name} selection`} value={selectedPlayers[side.id][player.player_id]} onChange={(e) => setSelection(side.id, player.player_id, e.target.value as 'starter' | 'substitute')}><option value="starter">Starter</option><option value="substitute">Substitute</option></select>}</label>)}
        {live.players.filter((p) => p.active).length === 0 && <p className="muted">No active published Market players are available.</p>}
      </fieldset>)}
      <button className="button button-outline" disabled={busy || live.players.filter((p) => p.active).length === 0} onClick={() => void run(async () => {
        for (const sideId of [match.team_a_id, match.team_b_id]) {
          const rows = Object.entries(selectedPlayers[sideId] ?? {}).map(([player_id, selection]) => ({ player_id, selection, actual_position: (live.players.find((p) => p.player_id === player_id)?.position ?? 'MID') as Position, eligibility_kind: 'market' as const, eligibility_evidence: { source: 'league_market' } }));
          await api.setMatchLineup(live.leagueId!, current!.revision_id, sideId, rows);
        }
      }, 'Both side lineups saved.')}>Save both lineups</button>
      <button className="button button-primary" disabled={busy} onClick={() => void run(() => api.submitMatchLineup(live.leagueId!, current.revision_id), t(live.isLeader ? 'Lineup saved and approved.' : 'Lineup submitted for Leader review.'))}>{t(live.isLeader ? 'Save and approve lineups' : 'Submit lineups for review')}</button>
    </section>}
    {live.isLeader && pending.length > 0 && <section className="workflow-section"><h3>Review queue</h3>{pending.map(({revision,submission}) => <div className="review-row" key={submission.id}><span>{submission.kind} · revision {revision.version} · submitted {new Date(submission.submitted_at).toLocaleString()}</span><div><input aria-label="Review reason" placeholder="Reason required when rejecting" value={reason} onChange={(e) => setReason(e.target.value)} /><button className="button button-small button-primary" disabled={busy} onClick={() => void run(() => api.reviewMatchSubmission(live.leagueId!, submission.id, 'approved'), `${submission.kind} approved.`)}>Approve</button><button className="button button-small button-outline" disabled={busy || !reason.trim()} onClick={() => void run(() => api.reviewMatchSubmission(live.leagueId!, submission.id, 'rejected', reason), `${submission.kind} rejected.`)}>Reject</button></div></div>)}</section>}
    {canOrganize && approvedLineup && current?.state === 'approved' && current.revision_id === approvedLineup.revision.revision_id && !current.submissions.some((s) => s.kind === 'result' && s.approval?.decision === 'approved') && <button className="button button-primary" disabled={busy} onClick={() => void openResultRevision(approvedLineup.approval.id)}>{t('Record match result')}</button>}
    {canOrganize && pendingResult && approvedLineup && current && <section className="workflow-section"><h3>{t('Saved result')}</h3><p className="muted">{t('A previously submitted result can be finalized here. Only complete saved match details will be published.')}</p><button className="button button-primary" disabled={busy} onClick={() => void run(() => api.submitMatchResult(live.leagueId!, current.revision_id, approvedLineup.approval.id), t('Result finalized and published to the league.'))}>{t('Finalize saved result')}</button></section>}
    {canEditDraft && isResultDraft && <section className="workflow-section"><h3>Score and match events</h3><div className="score-editor"><label>{match.team_a}<input type="number" min={0} value={scoreA} onChange={(e) => setScoreA(Number(e.target.value))} /></label><span>–</span><label>{match.team_b}<input type="number" min={0} value={scoreB} onChange={(e) => setScoreB(Number(e.target.value))} /></label><button className="button button-outline" disabled={busy} onClick={() => void run(() => api.setMatchScore(live.leagueId!, current.revision_id, scoreA, scoreB), 'Score saved.')}>Save score</button></div>
      <div className="event-editor"><label>Player<select value={eventPlayer} onChange={(e) => setEventPlayer(e.target.value)}><option value="">Select lineup player</option>{eventPlayers.map((p) => <option key={p.player_id} value={p.player_id}>{p.name}</option>)}</select></label><label>Event<select value={eventType} onChange={(e) => setEventType(e.target.value)}>{['appearance','goal','assist','clean_sheet','yellow_card','red_card','own_goal','mvp','penalty_saved','penalty_missed','substitution_out','substitution_in'].map((x) => <option key={x} value={x}>{x.replace(/_/g, ' ')}</option>)}</select></label><label>Minute<input type="number" min={0} max={130} value={eventMinute} onChange={(e) => setEventMinute(e.target.value)} /></label>{eventType.startsWith('substitution_') && <label>Related player<select value={relatedPlayer} onChange={(e) => setRelatedPlayer(e.target.value)}><option value="">Optional related player</option>{eventPlayers.filter((p) => p.player_id !== eventPlayer).map((p) => <option key={p.player_id} value={p.player_id}>{p.name}</option>)}</select></label>}<button className="button button-outline" disabled={busy || !eventPlayer} onClick={() => void run(() => api.recordMatchEvent(live.leagueId!, current.revision_id, eventPlayer, eventType, { minute: eventMinute ? Number(eventMinute) : null, relatedPlayerId: relatedPlayer || null }), 'Event recorded.')}>Record event</button></div>
      <button className="button button-primary" disabled={busy || !approvedLineup} onClick={() => void run(() => api.submitMatchResult(live.leagueId!, current.revision_id, approvedLineup!.approval.id), t('Result finalized and published to the league.'))}>{t('Finalize and publish result')}</button>
    </section>}
    {canOrganize && match.is_official && match.official_revision_id === match.revision_id && <section className="workflow-section"><h3>Corrections</h3><p className="muted">{t('A correction starts a new immutable draft. The current official result stays visible until the corrected result is complete and finalized. A reason and full audit history are retained.')}</p><button className="button button-outline" disabled={busy} onClick={() => { const why = window.prompt('Reason for opening this correction?'); if (why?.trim()) void run(() => api.openCorrection(live.leagueId!, match.id, why), t('Correction draft opened. The current official result remains active.')); }}>{t('Open correction')}</button></section>}
    {match.events.length > 0 && <><h3>Latest revision events</h3>{match.events.map((e) => <div className="event-row" key={e.id}><span>{e.minute ?? '—'}′</span><b>{eventGlyph(e.type)}</b><div><strong>{e.type.replace(/_/g, ' ')}</strong><small>{e.player_name ?? ''}</small></div></div>)}</>}
    <section className="workflow-section"><h3>Revision and approval history</h3>{history.length === 0 ? <p className="muted">No revisions or submissions yet.</p> : history.map((revision) => <div className="history-item" key={revision.revision_id}><strong>Revision {revision.version} · {revision.state}</strong>{revision.team_a_score !== null && <span> · {revision.team_a_score}–{revision.team_b_score}</span>}{revision.correction && <p>Correction: {revision.correction.reason}</p>}{revision.events.length > 0 && <p>Events: {revision.events.map((event) => `${event.minute ?? '—'}′ ${event.type.replace(/_/g, ' ')} · ${event.player_name ?? 'player'}`).join('; ')}</p>}{revision.submissions.map((submission) => <p key={submission.id}>{submission.kind} submitted {new Date(submission.submitted_at).toLocaleString()} — {submission.approval ? `${submission.approval.decision}${submission.approval.reason ? `: ${submission.approval.reason}` : ''}` : t(submission.kind === 'result' ? 'ready for finalization' : 'awaiting League Leader review')}</p>)}</div>)}</section>
    <p className="notice">{t('Only a complete, saved result finalized by the Leader or assigned active Organizer becomes official. Fantasy scoring is intentionally pending until the league has an approved scoring configuration.')}</p>
  </div>;
}

function eventGlyph(type: string): string {
  switch (type) { case 'goal': return '⚽'; case 'assist': return '↗'; case 'yellow_card': return '▮'; case 'red_card': return '▮▮'; case 'mvp': return '★'; case 'clean_sheet': return '🧤'; case 'own_goal': return '↩'; default: return '•'; }
}

export function LiveFixtures() {
  const { t } = useTranslation();
  const live = useLive();
  const [filter, setFilter] = useState('All');
  const [scheduleOpen, setScheduleOpen] = useState(false);
  if (live.loading) return <Loading />;
  if (!live.league) return <Empty title="Join or create a league" to="/create-league" action="Create League" />;

  const played = (m: ApiMatch) => new Date(m.starts_at).getTime() < Date.now();
  const statusLabel = (m: ApiMatch) => m.is_official ? 'Full time'
    : m.has_pending_result ? 'Result ready to finalize'
      : m.has_pending_lineup ? 'Lineup awaiting review'
        : m.revision_state === 'submitted' ? 'Lineup awaiting review'
      : m.revision_state === 'rejected' ? 'Needs correction'
        : m.revision_state === 'corrected' ? 'Correction in progress'
          : m.revision_state === 'draft' ? 'In progress' : played(m) ? 'Awaiting result' : 'Upcoming';
  const visible = live.matches.filter((m) =>
    filter === 'All' ? true : filter === 'Played' ? played(m) : !played(m));

  return (
    <>
      <PageTitle eyebrow="MATCHDAY" title="Fixtures" description="Matches scheduled for this league.">
        {live.isLeader && <button className="button button-primary" onClick={() => setScheduleOpen(v => !v)}>{t('Schedule match')}</button>}
        <button className="button button-outline" onClick={() => void live.refreshMatches()}><RefreshCw size={15}/> {t('Refresh')}</button>
      </PageTitle>
      {scheduleOpen && live.isLeader && live.leagueId && <ScheduleMatchForm leagueId={live.leagueId} gameweeks={live.gameweeks} members={live.members} onCancel={() => setScheduleOpen(false)} onCreated={async () => { await live.refreshMatches(); setScheduleOpen(false); }} />}

      {/* Same shape as the demo fixtures screen: filter tabs over a fixture list of
          rows that link to the match centre. Live showed a bare panel of rows with
          no filtering and no way through to a match. */}
      {live.matches.length === 0 ? (
        <Empty title="No fixtures yet" description={live.isLeader ? 'Schedule the first match for this league.' : 'Your league leader schedules the matches.'} />
      ) : (
        <>
          <div className="tabs">
            {['All', 'Upcoming', 'Played'].map((f) => (
              <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                {t(f)}
              </button>
            ))}
          </div>
          <div className="fixture-list">
            {visible.map((m) => (
              <Link to={`/match-center/${m.id}`} aria-label={`${t('Show match')}: ${m.team_a} versus ${m.team_b}`} className="fixture-row panel" key={m.id}>
                <div>
                  <div className="eyebrow">
                    {m.gameweek_id ? `${t('GAMEWEEK')} ${live.gameweeks.find((g) => g.id === m.gameweek_id)?.number ?? '—'}` : t('No gameweek link')}
                  </div>
                  <small>{new Date(m.starts_at).toLocaleString()} · {m.venue}</small>
                </div>
                <div className="fixture-score">
                  <strong>{m.team_a}</strong>
                  <span className="mini-crest c0"><Shield size={17} /></span>
                  <b>{m.team_a_score == null ? 'vs' : `${m.team_a_score} – ${m.team_b_score}`}</b>
                  <span className="mini-crest c1"><Zap size={17} /></span>
                  <strong>{m.team_b}</strong>
                </div>
                <Badge kind={m.revision_state === 'approved' ? 'lime' : m.revision_state === 'submitted' ? 'orange' : 'neutral'}>
                  {t(statusLabel(m))}
                </Badge>
                <span className="fixture-show-link">{t('Show match')} <ArrowRight size={17} /></span>
              </Link>
            ))}
          </div>
        </>
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
    case 'match_finalized': return t('A match result is now official');
    default: return kind.replace(/_/g, ' ');
  }
}
