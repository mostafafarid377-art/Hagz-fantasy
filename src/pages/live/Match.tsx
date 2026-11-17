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

export const MATCH_WORKFLOW_TIMEOUT_MS = 30_000;
const MATCH_REFRESH_TIMEOUT_MS = 8_000;

type MatchDiagnostic = { operation: string; matchId: string; revisionId: string; teamIds: string[] };
type MatchRunOptions = { diagnostic?: MatchDiagnostic; verifyMatches?: (matches: ApiMatch[]) => void };

function withDeadline<T>(task: (signal: AbortSignal) => Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve().then(() => task(controller.signal)), timeout])
    .finally(() => {
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort();
    });
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[\w-]*\.[\w-]*\.[\w-]*\b/g, '[redacted-token]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[redacted-id]');
}

function logLineupStage(stage: string, diagnostic: MatchDiagnostic, startedAt: number, outcome: string, error?: unknown) {
  const details: Record<string, unknown> = {
    operation: diagnostic.operation,
    stage,
    outcome,
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    matchId: diagnostic.matchId,
    revisionId: diagnostic.revisionId,
    teamIds: diagnostic.teamIds,
  };
  if (error) {
    details.errorCode = error instanceof Error && 'detail' in error ? (error as Error & { detail?: unknown }).detail : undefined;
    details.errorMessage = redactDiagnostic(error instanceof Error ? error.message : String(error));
  }
  console.info('[fantasy-friends] live lineup save', details);
}

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
    {createOpen && live.isLeader && live.leagueId && <ScheduleMatchForm leagueId={live.leagueId} matchFormat={live.league?.match_format ?? '11-a-side'} gameweeks={live.gameweeks} members={live.members} onCancel={() => setCreateOpen(false)} onCreated={async (matchId) => { const persisted = await live.refreshMatches(); if (!persisted.some((match) => match.id === matchId)) throw new Error('The match was created but could not be verified. Refresh the match list before scheduling another.'); setCreateOpen(false); }} />}

    {sorted.length === 0 ? <Empty title="No matches yet" description={live.isLeader ? 'Schedule the first match for this league.' : 'A League Leader schedules matches and appoints an organizer.'} /> : <>
      {featured && <div className="match-center-hero panel">
        <Badge kind={featured.is_official ? 'lime' : featured.is_cancelled ? 'orange' : 'neutral'}>{t(featured.is_official ? 'Full time' : featured.is_cancelled ? 'Cancelled' : 'Scheduled')}</Badge>
        <div className="center-teams"><div><div className="team-crest crest-lime"><Shield size={30} /></div><strong>{featured.team_a}</strong></div><div><small>{featured.is_official ? t('Final score') : t('Upcoming')}</small><b>{featured.is_official ? `${featured.team_a_score} : ${featured.team_b_score}` : 'VS'}</b></div><div><div className="team-crest crest-orange"><Zap size={30} /></div><strong>{featured.team_b}</strong></div></div>
        <div className="match-info"><span><CalendarDays size={16} /> {new Date(featured.starts_at).toLocaleString()}</span><span><MapPin size={16} /> {featured.venue}</span>{featured.gameweek_id && <span>{t('GAMEWEEK')} {live.gameweeks.find((g) => g.id === featured.gameweek_id)?.number ?? '—'}</span>}</div>
      </div>}
      <div className="panel table-wrap"><table><thead><tr><th>{t('MATCH')}</th><th>{t('Kick-off')}</th><th>{t('Venue')}</th><th>{t('Score')}</th><th>{t('Status')}</th><th /></tr></thead><tbody>
        {sorted.map((m) => <tr key={m.id}><td><strong>{m.team_a}</strong> <span className="muted">vs</span> <strong>{m.team_b}</strong></td><td>{new Date(m.starts_at).toLocaleString()}</td><td>{m.venue}</td><td>{m.is_official ? `${m.team_a_score} – ${m.team_b_score}` : '—'}</td><td><Badge kind={m.is_official ? 'lime' : m.is_cancelled ? 'orange' : 'neutral'}>{t(m.is_official ? 'Full time' : m.is_cancelled ? 'Cancelled' : m.revision_state ?? 'scheduled')}</Badge></td><td><button className="button button-small button-outline" onClick={() => setSelectedId(m.id)}>{t('Open')}</button></td></tr>)}
      </tbody></table></div>
    </>}
    {selected && <dialog ref={matchDialog} className="player-sheet match-detail-sheet" aria-labelledby="match-title"
      onClose={closeMatch} onClick={(event) => { if (event.target === event.currentTarget) closeMatch(); }}>
      <div className="sheet-handle" aria-hidden="true" />
      <button type="button" className="sheet-close" aria-label={t('Close')} onClick={closeMatch}><X size={20} /></button>
      <div className="eyebrow">{t('MATCHDAY')}</div><h2 id="match-title">{selected.team_a} vs {selected.team_b}</h2>
      <p className="sheet-note"><CalendarDays size={14} /> {new Date(selected.starts_at).toLocaleString()} · <MapPin size={14} /> {selected.venue}</p>
      {/* A match keeps its identity across immutable revisions, but its editor must not.
          Remounting on the active revision prevents selections or request state from
          the prior correction attempt being submitted against the newly active one. */}
      <MatchWorkflow key={`${selected.id}:${selected.revision_id ?? 'scheduled'}`} match={selected} />
      <div className="sheet-actions"><button type="button" className="button button-outline" onClick={closeMatch}>{t('Close')}</button></div>
    </dialog>}
  </>;
}

function MatchWorkflow({ match }: { match: ApiMatch }) {
  const { t } = useTranslation();
  const live = useLive();
  const [busy, setBusy] = useState(false);
  const actionLock = useRef(false);
  const [forkRequestId, setForkRequestId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reason, setReason] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [playersBySide, setPlayersBySide] = useState<Record<string, Record<string, 'starter' | 'substitute'>>>({});
  const playersBySideRef = useRef(playersBySide);
  const [scoreA, setScoreA] = useState('0'); const [scoreB, setScoreB] = useState('0');
  const [eventPlayer, setEventPlayer] = useState(''); const [eventType, setEventType] = useState('goal');
  const [eventMinute, setEventMinute] = useState(''); const [relatedPlayer, setRelatedPlayer] = useState('');
  const history = match.history ?? [];
  const current: ApiMatchRevision | undefined = history[0];
  const canOrganize = live.isLeader || (match.organizer_id === live.myUserId && live.members.some((member) => member.user_id === live.myUserId && member.status === 'active' && member.is_organizer));
  const approvedLineups = history.flatMap((r) => r.submissions.filter((s) => s.kind === 'lineup' && s.approval?.decision === 'approved').map((s) => ({ revision: r, approval: s.approval! })));
  const approvedLineup = approvedLineups[0];
  const currentLineups = current?.lineups ?? [];
  // The match read model stores an immutable lineup snapshot on each result or
  // correction revision. Prefer the active revision when it has both sides; when
  // an empty/new draft is active, show only the current official result's snapshot.
  // Never derive this read-only display from the fantasy squad or market.
  const officialRevision = match.official_revision_id
    ? history.find((revision) => revision.revision_id === match.official_revision_id)
    : undefined;
  const displayRevision = current?.lineups.length === 2 ? current : officialRevision ?? current;
  const displayLineups = displayRevision?.lineups ?? [];
  const hasCompleteDisplayLineups = !!match.team_a_id && !!match.team_b_id && match.team_a_id !== match.team_b_id
    && displayLineups.length === 2 && [match.team_a_id, match.team_b_id].every((teamId) =>
      displayLineups.filter((lineup) => lineup.team_id === teamId).length === 1);
  const selectedPlayers = playersBySide;
  const otherSideId = (teamId: string) => teamId === match.team_a_id ? match.team_b_id : match.team_a_id;
  const availablePlayers = (teamId: string) => live.players.filter((player) => player.active
    && (!selectedPlayers[otherSideId(teamId)]?.[player.player_id] || !!selectedPlayers[teamId]?.[player.player_id]));
  const eventPlayers = currentLineups.flatMap((l) => l.players);
  const identityHint = (id: string) => {
    const player = live.players.find((candidate) => candidate.player_id === id);
    return player && live.players.some((candidate) => candidate.player_id !== id
      && candidate.name.trim().toLocaleLowerCase() === player.name.trim().toLocaleLowerCase())
      ? ` · #${id.slice(0, 8)}` : '';
  };

  useEffect(() => {
    const seeded: Record<string, Record<string, 'starter' | 'substitute'>> = {};
    for (const l of current?.lineups ?? []) seeded[l.team_id] = Object.fromEntries(l.players.map((p) => [p.player_id, p.selection]));
    playersBySideRef.current = seeded;
    setPlayersBySide(seeded);
    setScoreA(String(current?.team_a_score ?? 0)); setScoreB(String(current?.team_b_score ?? 0));
  }, [current?.revision_id]);

  async function run(action: (signal: AbortSignal) => Promise<unknown>, success: string, options: MatchRunOptions = {}) {
    if (!live.leagueId || actionLock.current) return;
    actionLock.current = true;
    const startedAt = performance.now();
    const { diagnostic } = options;
    let stage = diagnostic ? 'rpc' : 'action';
    setBusy(true); setError(''); setNotice('');
    if (diagnostic) logLineupStage(stage, diagnostic, startedAt, 'started');
    try {
      await withDeadline(async (signal) => {
        await action(signal);
        if (diagnostic) {
          logLineupStage(stage, diagnostic, startedAt, 'succeeded');
          stage = 'server_read_model_verification';
          logLineupStage(stage, diagnostic, startedAt, 'started');
        }
        const refreshed = await live.refreshMatches(signal);
        options.verifyMatches?.(refreshed);
        if (diagnostic) logLineupStage(stage, diagnostic, startedAt, 'succeeded');
      }, MATCH_WORKFLOW_TIMEOUT_MS, diagnostic?.operation === 'lineup_save'
        ? 'Lineup save timed out. Refresh the match to verify whether the server saved your selections before retrying.'
        : 'This match action timed out. Refresh the match before retrying.');
      setNotice(success);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'The server refused this action';
      setError(message);
      if (diagnostic) logLineupStage(stage, diagnostic, startedAt, 'failed', e);
      // Refresh after failure because a timed-out/failed request may have reached
      // the server. Bound this recovery read too, so it cannot hold loading
      // forever or hide the original, visible error.
      try {
        await withDeadline((signal) => live.refreshMatches(signal), MATCH_REFRESH_TIMEOUT_MS,
          'Refreshing the match after the failed action timed out.');
      } catch { /* retain the original action error */ }
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }
  function requireActiveMatch(rows: ApiMatch[], diagnostic: MatchDiagnostic): ApiMatch {
    if (!diagnostic.matchId || diagnostic.teamIds.some((id) => !id) || diagnostic.teamIds[0] === diagnostic.teamIds[1]) {
      throw new Error(t('Cannot continue: this match is missing distinct Home and Away team IDs. Refresh the match details and try again.'));
    }
    const latest = rows.find((row) => row.id === diagnostic.matchId);
    if (!latest) throw new Error(t('The active match is no longer available. Refresh Match Details and try again.'));
    if (latest.revision_id !== diagnostic.revisionId
      || latest.team_a_id !== diagnostic.teamIds[0] || latest.team_b_id !== diagnostic.teamIds[1]) {
      throw new Error(t('This match changed while you were editing. Refresh Match Details before continuing.'));
    }
    return latest;
  }

  function requireBothSavedSides(row: ApiMatch, diagnostic: MatchDiagnostic) {
    const revision = row.history.find((item) => item.revision_id === diagnostic.revisionId);
    const savedSides = revision?.lineups ?? [];
    const exactSides = savedSides.length === 2 && diagnostic.teamIds.every((teamId) =>
      savedSides.filter((side) => side.team_id === teamId).length === 1);
    if (!exactSides || !revision) {
      throw new Error(t('The saved lineups do not match the active match. Refresh and verify both sides before approving.'));
    }
    return revision;
  }

  function verifySavedSelection(row: ApiMatch, diagnostic: MatchDiagnostic,
    selection: Record<string, Record<string, 'starter' | 'substitute'>>) {
    const revision = requireBothSavedSides(row, diagnostic);
    const savedSides = revision.lineups;
    const exactPlayers = diagnostic.teamIds.every((teamId) => {
      const actual = savedSides.find((side) => side.team_id === teamId)?.players ?? [];
      const expected = Object.entries(selection[teamId] ?? {}).map(([playerId, role]) => `${playerId}:${role}`).sort();
      const persisted = actual.map((player) => `${player.player_id}:${player.selection}`).sort();
      return expected.length === persisted.length && expected.every((item, index) => item === persisted[index]);
    });
    if (!exactPlayers) {
      throw new Error(t('The saved lineups do not match the active match. Refresh and verify both sides before approving.'));
    }
    return revision;
  }

  async function saveAndVerifyActiveLineups(signal: AbortSignal,
    selection: Record<string, Record<string, 'starter' | 'substitute'>>, diagnostic: MatchDiagnostic) {
    if (!live.leagueId) throw new Error(t('Select a league before saving match lineups.'));
    const startedAt = performance.now();
    let stage = 'active_match_preflight';
    logLineupStage(stage, diagnostic, startedAt, 'started');
    const active = requireActiveMatch(await api.matches(live.leagueId, { signal }), diagnostic);
    logLineupStage(stage, diagnostic, startedAt, 'succeeded');
    if (active.revision_state === 'submitted' || active.revision_state === 'approved') {
      const persistedRevision = requireBothSavedSides(active, diagnostic);
      if (!persistedRevision.submissions.some((submission) => submission.kind === 'lineup')) {
        throw new Error(t('The server shows a submitted match without a lineup submission. Refresh Match Details before retrying.'));
      }
      logLineupStage('reuse_existing_match_submission', diagnostic, startedAt, 'succeeded');
      return;
    }
    if (active.revision_state !== 'draft' && active.revision_state !== 'corrected') {
      throw new Error(t('This match revision is no longer editable. Refresh Match Details before continuing.'));
    }

    const rowsFor = (sideId: string) => Object.entries(selection[sideId] ?? {}).map(([player_id, role]) => ({
      player_id, selection: role,
      actual_position: (live.players.find((player) => player.player_id === player_id)?.position ?? 'MID') as Position,
      eligibility_kind: 'market' as const, eligibility_evidence: { source: 'league_market' },
    }));
    stage = 'save_both_active_match_sides';
    logLineupStage(stage, diagnostic, startedAt, 'started');
    await api.saveMatchLineups(live.leagueId, active.revision_id!,
      rowsFor(active.team_a_id), rowsFor(active.team_b_id), { signal });
    logLineupStage(stage, diagnostic, startedAt, 'succeeded');

    stage = 'verify_persisted_active_match_sides';
    logLineupStage(stage, diagnostic, startedAt, 'started');
    const persisted = requireActiveMatch(await api.matches(live.leagueId, { signal }), diagnostic);
    verifySavedSelection(persisted, diagnostic, selection);
    logLineupStage(stage, diagnostic, startedAt, 'succeeded');
  }

  function verifySubmittedMatch(rows: ApiMatch[], diagnostic: MatchDiagnostic) {
    const active = requireActiveMatch(rows, diagnostic);
    const revision = requireBothSavedSides(active, diagnostic);
    const hasSubmission = revision.submissions.some((submission) => submission.kind === 'lineup');
    const stateMatches = live.isLeader ? revision.state === 'approved' : revision.state === 'submitted';
    if (!hasSubmission || !stateMatches) {
      throw new Error(t('The server did not confirm the expected lineup submission state. Refresh Match Details before retrying.'));
    }
  }

  async function openResultRevision(approvalId: string) {
    if (!live.leagueId) return;
    if (actionLock.current) return;
    actionLock.current = true;
    const requestId = forkRequestId ?? crypto.randomUUID();
    setForkRequestId(requestId); setBusy(true); setError(''); setNotice('');
    try {
      const opened = await api.forkResult(live.leagueId, approvalId, requestId);
      const persisted = await live.refreshMatches();
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
    } finally { actionLock.current = false; setBusy(false); }
  }
  const togglePlayer = (team: string, id: string, checked: boolean) => {
    const next = { ...playersBySideRef.current, [team]: { ...(playersBySideRef.current[team] ?? {}) } };
    if (checked) next[team][id] = 'starter'; else delete next[team][id];
    playersBySideRef.current = next;
    setPlayersBySide(next);
  };
  const setSelection = (team: string, id: string, selection: 'starter' | 'substitute') => {
    const next = { ...playersBySideRef.current, [team]: { ...(playersBySideRef.current[team] ?? {}), [id]: selection } };
    playersBySideRef.current = next;
    setPlayersBySide(next);
  };
  const pending = history.flatMap((r) => r.submissions.filter((s) => s.kind === 'lineup' && !s.approval).map((s) => ({ revision: r, submission: s })));
  const pendingResult = current?.submissions.find((s) => s.kind === 'result' && !s.approval);
  // A result fork has its own immutable revision, but its lineups are sourced
  // from the approved lineup revision. Only the source revision is editable for
  // player selection; allowing edits on the result child submits against a stale
  // correction generation and is correctly rejected by PostgreSQL.
  const isResultDraft = !!current && current.state === 'draft'
    && current.based_on_lineup_revision_id != null && current.lineups.length === 2;
  const canEditDraft = canOrganize && !!current && (current.state === 'draft' || current.state === 'corrected');
  const canEditLineup = canEditDraft && current.based_on_lineup_revision_id === null;

  return <div className="match-workflow">
    <div className="sheet-stats"><div><small>A</small><strong>{match.team_a_score ?? '—'}</strong></div><div><small>Workflow</small><strong>{current?.state ?? 'Scheduled'}</strong></div><div><small>B</small><strong>{match.team_b_score ?? '—'}</strong></div></div>
    {error && <p className="error-text" role="alert">{error}</p>}{notice && <p className="success-text" role="status">{notice}</p>}
    {canOrganize && <p className="notice">{t('League Leader and assigned active Organizer can manage this match. Organizer results publish immediately when complete; the Leader may also finalize them. Fantasy scoring remains pending until scoring rules are approved.')}</p>}
    {hasCompleteDisplayLineups && displayRevision && <section className="workflow-section saved-match-lineups" aria-label={t('Saved match lineups')}>
      <h3>{t('Saved match lineups')} · {t('Revision')} {displayRevision.version}</h3>
      <div className="saved-lineup-sides">{[{ id: match.team_a_id, name: match.team_a }, { id: match.team_b_id, name: match.team_b }].map((side) => {
        const lineup = displayLineups.find((item) => item.team_id === side.id)!;
        const uniquePlayers = (selection: 'starter' | 'substitute') => {
          const seen = new Set<string>();
          return lineup.players.filter((player) => {
            if (player.selection !== selection || seen.has(player.player_id)) return false;
            seen.add(player.player_id);
            return true;
          });
        };
        return <section className="saved-lineup-side" key={side.id} aria-label={side.name}>
          <h4>{side.name}</h4>
          {([{ selection: 'starter' as const, label: 'Starters' }, { selection: 'substitute' as const, label: 'Bench' }]).map((group) => <div className="saved-lineup-group" key={group.selection}>
            <h5>{t(group.label)}</h5>
            {uniquePlayers(group.selection).length > 0
              ? <ul>{uniquePlayers(group.selection).map((player) => <li key={player.player_id}><span>{player.name}</span><small>{t(player.actual_position)}</small></li>)}</ul>
              : <p className="muted">{t('No selected players.')}</p>}
          </div>)}
        </section>;
      })}</div>
    </section>}
    {canOrganize && !current && !match.is_cancelled && <button className="button button-primary" disabled={busy} onClick={() => void run(() => api.openRevision(live.leagueId!, match.id), 'Match record opened.')}>{t('Open match record')}</button>}
    {match.is_cancelled && <p className="notice" role="status">{t('Match cancelled')}{match.cancel_reason ? ` · ${match.cancel_reason}` : ''}</p>}
    {canOrganize && !current && !match.is_cancelled && <section className="workflow-section match-cancel-panel"><h3>{t('Cancel scheduled match')}</h3><p className="muted">{t('A match can be cancelled before its record is opened. Cancellation keeps the match and audit history.')}</p><label>{t('Cancellation reason')}<input maxLength={500} value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} /></label><button className="button button-danger" disabled={busy || !cancelReason.trim()} onClick={() => void run(() => api.cancelMatch(live.leagueId!, match.id, cancelReason.trim()), t('Match cancelled successfully.'))}>{t('Cancel match')}</button></section>}
    {canOrganize && current?.state === 'rejected' && <button className="button button-primary" disabled={busy} onClick={() => void run(() => api.openRevision(live.leagueId!, match.id), 'A new immutable revision is open for correction.')}>Open new revision</button>}
    {canEditLineup && <section className="workflow-section"><h3>{t('Lineups · published League Market')}</h3><p className="muted">{t('Choose players independently for both sides. Selection uses Market player identity, not fantasy ownership. The server checks active same-league Market membership, duplicate selection, and lineup limits.')}</p>
      {[{id:match.team_a_id,name:match.team_a},{id:match.team_b_id,name:match.team_b}].map((side) => <fieldset className="match-side-picker" key={side.id}><legend>{side.name} · {Object.values(selectedPlayers[side.id] ?? {}).filter((x) => x === 'starter').length}/{match.starters_per_side} {t('starters')} · {Object.values(selectedPlayers[side.id] ?? {}).filter((x) => x === 'substitute').length}/{match.max_substitutes} {t('substitutes')}</legend>
        {availablePlayers(side.id).map((player) => <label className={`match-player-choice${selectedPlayers[side.id]?.[player.player_id] ? ' is-selected' : ''}`} key={player.player_id}><input type="checkbox" checked={!!selectedPlayers[side.id]?.[player.player_id]} disabled={busy || !!playersBySide[side.id === match.team_a_id ? match.team_b_id : match.team_a_id]?.[player.player_id]} onChange={(e) => togglePlayer(side.id, player.player_id, e.target.checked)} /><span dir="auto">{player.name}{identityHint(player.player_id)} <small>{t(player.position)}</small></span>{selectedPlayers[side.id]?.[player.player_id] && <select aria-label={`${player.name} ${t('lineup role')}`} value={selectedPlayers[side.id][player.player_id]} onChange={(e) => setSelection(side.id, player.player_id, e.target.value as 'starter' | 'substitute')}><option value="starter">{t('Starter')}</option><option value="substitute">{t('Substitute')}</option></select>}</label>)}
        {availablePlayers(side.id).length === 0 && <p className="muted">{t('No active published Market players are available.')}</p>}
      </fieldset>)}
      <button className="button button-outline" aria-busy={busy} disabled={busy || match.is_cancelled} onClick={() => {
        const diagnostic: MatchDiagnostic = {
          operation: 'lineup_save', matchId: match.id, revisionId: current!.revision_id,
          teamIds: [match.team_a_id, match.team_b_id],
        };
        const selection = structuredClone(playersBySideRef.current);
        void run((signal) => saveAndVerifyActiveLineups(signal, selection, diagnostic),
          t('Both lineups saved and verified on the server.'), {
            diagnostic,
            verifyMatches: (persisted) => {
              const active = requireActiveMatch(persisted, diagnostic);
              verifySavedSelection(active, diagnostic, selection);
            },
          });
      }}>
        {busy ? <><RefreshCw size={15} className="spin" /> {t('Saving lineups…')}</> : t('Save both lineups')}
      </button>
      <button className="button button-primary" disabled={busy || match.is_cancelled} onClick={() => {
        const diagnostic: MatchDiagnostic = {
          operation: 'lineup_approval', matchId: match.id, revisionId: current.revision_id,
          teamIds: [match.team_a_id, match.team_b_id],
        };
        const selection = structuredClone(playersBySideRef.current);
        void run(async (signal) => {
          await saveAndVerifyActiveLineups(signal, selection, diagnostic);
          await api.submitMatchLineup(live.leagueId!, diagnostic.revisionId, { signal });
        }, t(live.isLeader ? 'Lineup saved and approved.' : 'Lineup submitted for Leader review.'), {
          diagnostic,
          verifyMatches: (persisted) => verifySubmittedMatch(persisted, diagnostic),
        });
      }}>{t(live.isLeader ? 'Save and approve lineups' : 'Submit lineups for review')}</button>
    </section>}
    {live.isLeader && pending.length > 0 && <section className="workflow-section"><h3>Review queue</h3>{pending.map(({revision,submission}) => <div className="review-row" key={submission.id}><span>{submission.kind} · revision {revision.version} · submitted {new Date(submission.submitted_at).toLocaleString()}</span><div><input aria-label="Review reason" placeholder="Reason required when rejecting" value={reason} onChange={(e) => setReason(e.target.value)} /><button className="button button-small button-primary" disabled={busy} onClick={() => void run(() => api.reviewMatchSubmission(live.leagueId!, submission.id, 'approved'), `${submission.kind} approved.`)}>Approve</button><button className="button button-small button-outline" disabled={busy || !reason.trim()} onClick={() => void run(() => api.reviewMatchSubmission(live.leagueId!, submission.id, 'rejected', reason), `${submission.kind} rejected.`)}>Reject</button></div></div>)}</section>}
    {canOrganize && approvedLineup && current?.state === 'approved' && current.revision_id === approvedLineup.revision.revision_id && !current.submissions.some((s) => s.kind === 'result' && s.approval?.decision === 'approved') && <button className="button button-primary" disabled={busy} onClick={() => void openResultRevision(approvedLineup.approval.id)}>{t('Record match result')}</button>}
    {canOrganize && pendingResult && approvedLineup && current && <section className="workflow-section"><h3>{t('Saved result')}</h3><p className="muted">{t('A previously submitted result can be finalized here. Only complete saved match details will be published.')}</p><button className="button button-primary" disabled={busy} onClick={() => void run(() => api.submitMatchResult(live.leagueId!, current.revision_id, approvedLineup.approval.id), t('Result finalized and published to the league.'))}>{t('Finalize saved result')}</button></section>}
    {canEditDraft && isResultDraft && <section className="workflow-section"><h3>{t('Score and match events')}</h3><p className="muted">{t('This result revision uses the approved match lineup. To change selected players, open a new correction.')}</p><div className="score-editor"><label>{match.team_a}<input aria-label={`${match.team_a} score`} type="number" inputMode="numeric" min={0} step={1} value={scoreA} onChange={(e) => setScoreA(e.target.value)} /></label><span aria-hidden="true">–</span><label>{match.team_b}<input aria-label={`${match.team_b} score`} type="number" inputMode="numeric" min={0} step={1} value={scoreB} onChange={(e) => setScoreB(e.target.value)} /></label><button className="button button-outline" disabled={busy || scoreA === '' || scoreB === '' || !Number.isInteger(Number(scoreA)) || !Number.isInteger(Number(scoreB)) || Number(scoreA) < 0 || Number(scoreB) < 0} onClick={() => void run(() => api.setMatchScore(live.leagueId!, current.revision_id, Number(scoreA), Number(scoreB)), 'Score saved.')}>{t('Save score')}</button></div>
      <div className="event-editor"><label>Player<select value={eventPlayer} onChange={(e) => setEventPlayer(e.target.value)}><option value="">Select lineup player</option>{eventPlayers.map((p) => <option key={p.player_id} value={p.player_id}>{p.name}{identityHint(p.player_id)}</option>)}</select></label><label>Event<select value={eventType} onChange={(e) => setEventType(e.target.value)}>{['appearance','goal','assist','clean_sheet','yellow_card','red_card','own_goal','mvp','penalty_saved','penalty_missed','substitution_out','substitution_in'].map((x) => <option key={x} value={x}>{x.replace(/_/g, ' ')}</option>)}</select></label><label>Minute<input type="number" min={0} max={130} value={eventMinute} onChange={(e) => setEventMinute(e.target.value)} /></label>{eventType.startsWith('substitution_') && <label>Related player<select value={relatedPlayer} onChange={(e) => setRelatedPlayer(e.target.value)}><option value="">Optional related player</option>{eventPlayers.filter((p) => p.player_id !== eventPlayer).map((p) => <option key={p.player_id} value={p.player_id}>{p.name}{identityHint(p.player_id)}</option>)}</select></label>}<button className="button button-outline" disabled={busy || !eventPlayer} onClick={() => void run(() => api.recordMatchEvent(live.leagueId!, current.revision_id, eventPlayer, eventType, { minute: eventMinute ? Number(eventMinute) : null, relatedPlayerId: relatedPlayer || null }), 'Event recorded.')}>Record event</button></div>
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
  const statusLabel = (m: ApiMatch) => m.is_cancelled ? 'Cancelled' : m.is_official ? 'Full time'
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
      {scheduleOpen && live.isLeader && live.leagueId && <ScheduleMatchForm leagueId={live.leagueId} matchFormat={live.league?.match_format ?? '11-a-side'} gameweeks={live.gameweeks} members={live.members} onCancel={() => setScheduleOpen(false)} onCreated={async (matchId) => { const persisted = await live.refreshMatches(); if (!persisted.some((match) => match.id === matchId)) throw new Error('The match was created but could not be verified. Refresh the match list before scheduling another.'); setScheduleOpen(false); }} />}

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
                  <b>{m.is_cancelled ? t('Cancelled') : m.team_a_score == null ? 'vs' : `${m.team_a_score} – ${m.team_b_score}`}</b>
                  <span className="mini-crest c1"><Zap size={17} /></span>
                  <strong>{m.team_b}</strong>
                </div>
                <Badge kind={m.is_cancelled || m.revision_state === 'submitted' ? 'orange' : m.revision_state === 'approved' ? 'lime' : 'neutral'}>
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
