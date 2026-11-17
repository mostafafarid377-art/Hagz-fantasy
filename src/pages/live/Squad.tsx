// Live squad builder and transfer market.
//
// Roster limits, exact slot assignments, format rules, budget and authorization are
// enforced server-side. This screen reads the durable slot field, keeps null-slot
// players explicitly unassigned, and never reconstructs a lineup from response order.

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AlertCircle, Shield, UserMinus, UserPlus } from 'lucide-react';
import { Avatar, Badge, Empty, PageTitle, SectionHead } from '../../components/UI';
import { formatCompactMoney } from '../../utils/format';
import { useLive } from '../../hooks/useLive';
import { ErrorNote, Loading, PartialDataNote, Success } from './League';
import { Pitch } from '../Dashboard';
import { formatRules, deriveFormation, lineupIssues, type MatchFormat } from '../../services/squadFormats';
import { lastGamePointsForPlayer } from '../../services/points';
import { LivePlayerSheet } from './LivePlayerSheet';
import { AddLivePlayerSheet } from './AddLivePlayerSheet';
import type { Formation, Player, Position } from '../../types';

export function LiveSquad({ builder = false, transfers = false }: { builder?: boolean; transfers?: boolean }) {
  const { t } = useTranslation();
  const live = useLive();
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  // Captaincy is managed from each player's detail sheet and stored independently
  // from full-lineup saves, so it also works while the squad is being assembled.
  const [captain, setCaptain] = useState<string | null>(live.squad?.captain_id ?? null);
  const [vice, setVice] = useState<string | null>(live.squad?.vice_captain_id ?? null);

  useEffect(() => {
    setCaptain(live.squad?.captain_id ?? null);
    setVice(live.squad?.vice_captain_id ?? null);
  }, [live.leagueId, live.squad?.captain_id, live.squad?.vice_captain_id]);
  const [selectedId, setSelectedId] = useState('');
  const [swapSource, setSwapSource] = useState('');
  const [outPlayer, setOutPlayer] = useState('');
  const [inPlayer, setInPlayer] = useState('');
  /** Which position's "+" opened the picker; undefined when it is closed. */
  const [addPosition, setAddPosition] = useState<Position>();
  /** "Edit squad" / "View squad": builder mode for an existing squad. */
  const [editing, setEditing] = useState(builder);
  const initializedLeague = useRef<string | null>(null);
  const previousBuilder = useRef(builder);
  useEffect(() => {
    if (live.loading || !live.leagueId) return;
    const leagueChanged = initializedLeague.current !== live.leagueId;
    const builderChanged = previousBuilder.current !== builder;
    if (!leagueChanged && !builderChanged) return;
    initializedLeague.current = live.leagueId;
    previousBuilder.current = builder;
    setEditing(builder || (live.squad?.players.length ?? 0) === 0);
    setSelectedId(''); setSwapSource(''); setAddPosition(undefined); setBusy('');
  }, [builder, live.leagueId, live.loading, live.squad?.players.length]);

  const squad = live.squad;
  const players = squad?.players ?? [];
  const identityHint = (marketPlayerId: string | null | undefined) => {
    const match = live.players.find((player) => player.id === marketPlayerId);
    return match && live.players.some((player) => player.id !== match.id
      && player.name.trim().toLocaleLowerCase() === match.name.trim().toLocaleLowerCase())
      ? ` · #${match.id.slice(0, 8)}` : '';
  };

  const spent = squad?.spent ?? 0;
  const budget = squad?.budget ?? 0;
  const remaining = budget - spent;

  if (live.loading) return <Loading />;
  if (!live.league) return <Empty title="Join or create a league" to="/create-league" action="Create League" />;

  // Saved slot numbers are authoritative. Players without an explicitly saved slot
  // remain unassigned; stable IDs only make their display order repeatable and never
  // decide whether they are starters or substitutes.
  const matchFormat = (live.league.match_format ?? squad?.match_format ?? '11-a-side') as MatchFormat;
  const format = formatRules(matchFormat);
  const ordered = [...players].sort((a, b) => {
    if (a.slot == null && b.slot != null) return 1;
    if (a.slot != null && b.slot == null) return -1;
    return (a.slot ?? Number.MAX_SAFE_INTEGER) - (b.slot ?? Number.MAX_SAFE_INTEGER)
      || a.league_player_id.localeCompare(b.league_player_id);
  });

  async function run(key: string, action: () => Promise<void>, success?: string) {
    setBusy(key); setError(''); setNotice('');
    try { await action(); if (success) setNotice(t(success)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : t('That did not work')); }
    finally { setBusy(''); }
  }

  // ---- transfers -----------------------------------------------------------
  if (transfers) {
    const outOptions = players;
    const outgoing = outOptions.find((p) => p.league_player_id === outPlayer);
    const inOptions = live.players.filter((p) => p.active && !!outgoing
      && p.position === outgoing.position
      && !players.some((s) => s.league_player_id === p.id));

    return (
      <>
        <PageTitle eyebrow="THE TRANSFER MARKET" title="Transfers"
          description="Replace a player with another in the same position." />
        {live.error && <ErrorNote message={live.error} />}
        <PartialDataNote failures={live.partialFailures} onRetry={() => void live.reload()} />
        {error && <p className="error" role="alert"><AlertCircle size={14} /> {error}</p>}
        <Success message={notice} />

        {!live.league.market_open && <p className="notice">{t('The market is closed.')}</p>}

        <div className="panel form-panel">
          <label>{t('Player to transfer out')}
            <select value={outPlayer} onChange={(e) => { setOutPlayer(e.target.value); setInPlayer(''); }}>
              <option value="">{t('Select a player')}</option>
              {outOptions.map((p) => (
                <option key={p.league_player_id} value={p.league_player_id}>
                  {p.name} · {p.position} · {formatCompactMoney(p.price)}{identityHint(p.league_player_id)}
                </option>
              ))}
            </select>
          </label>
          <label>{t('Replacement player')}
            <select value={inPlayer} onChange={(e) => setInPlayer(e.target.value)} disabled={!outgoing}>
              <option value="">{t('Select a player')}</option>
              {inOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.name} · {formatCompactMoney(p.price)}{identityHint(p.id)}</option>
              ))}
            </select>
          </label>
          {outgoing && (
            <div className="transfer-preview">
              <span>{t('After transfer')}: {formatCompactMoney(remaining + outgoing.price - (inOptions.find((p) => p.id === inPlayer)?.price ?? 0))}</span>
            </div>
          )}
          <button className="button" disabled={!outPlayer || !inPlayer || !live.league.market_open || busy === 'transfer'}
            onClick={() => void run('transfer', async () => {
              await live.transfer(outPlayer, inPlayer);
              setOutPlayer(''); setInPlayer('');
            }, 'Transfer confirmed.')}>
            {busy === 'transfer' ? t('Transferring…') : t('Confirm transfer')}
          </button>
          <Link className="text-link" to="/market">{t('Explore the player market')} →</Link>
        </div>

        <section className="panel section-spacer transfer-history" aria-labelledby="transfer-history-title">
          <SectionHead eyebrow="YOUR ACTIVITY" title="Transfer history" />
          {live.transfers.length === 0 ? <p className="muted">{t('No transfers have been recorded yet.')}</p> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>{t('Gameweek')}</th><th>{t('Manager')}</th><th>{t('Transfer')}</th><th>{t('Date')}</th></tr></thead>
                <tbody>{live.transfers.map((item) => (
                  <tr key={item.id}>
                    <td>{item.gameweek_number}</td>
                    <td>{item.manager_name ?? item.team_name}</td>
                    <td>{item.out_name ? <>{item.out_name}{identityHint(item.out_player_id)} <span aria-label={t('out')}>→</span> </> : null}{item.in_name}{identityHint(item.in_player_id)}</td>
                    <td><time dateTime={item.created_at}>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.created_at))}</time></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
      </>
    );
  }

  // ---- squad / builder -----------------------------------------------------
  //
  // Layout follows the demo squad screen: the pitch is the page. The roster list
  // that used to sit under it is gone - it repeated every player the pitch already
  // shows. Captain and vice-captain actions live in each player's detail sheet;
  // selling remains in the compact panel below the pitch.
  const hasSquad = ordered.length > 0;
  // The pitch is the starting XI. Rendering `ordered` drew all 15 on the pitch and
  // then drew the last 4 again in the bench strip below it, so the same players
  // appeared twice and "11 starters / 4 substitutes" was not visible anywhere.
  // Builder/edit mode is the exception: it shows the whole squad and hides the bench.
  const allPlayers: Player[] = ordered.map((p) => ({
    id: p.league_player_id,
    leagueId: '',
    name: p.name,
    position: p.position,
    price: p.price,
    rating: p.rating,
    attributes: { pace: 0, shooting: 0, passing: 0, defending: 0, physical: 0 },
    image: p.image_url ?? undefined,
    active: p.active,
    points: 0,
    color: '#a9b9a5',
  }));
  const starterEntries = ordered.filter((player) => player.slot !== null && player.slot <= format.starters);
  const benchPlayers = ordered.filter((player) => player.slot !== null && player.slot > format.starters);
  const unassignedPlayers = ordered.filter((player) => player.slot === null);
  const starterIds = starterEntries.map((player) => player.league_player_id);
  const benchIds = benchPlayers.map((player) => player.league_player_id);
  const unassignedIds = unassignedPlayers.map((player) => player.league_player_id);
  const pitchPlayers = allPlayers.filter((player) => starterIds.includes(player.id));
  const formation = deriveFormation(starterEntries, matchFormat) as Formation | null;
  const captainId = starterIds.includes(captain ?? '') ? (captain ?? undefined) : undefined;
  /** Last-game points for a squad entry, or undefined when there is no valid score. */
  const lastGamePointsFor = (p: { league_player_id: string }) =>
    lastGamePointsForPlayer(live.points, p.league_player_id);
  const viceId = starterIds.includes(vice ?? '') ? (vice ?? undefined) : undefined;
  const ids = ordered.map((p) => p.league_player_id);
  const targets = starterIds.includes(swapSource)
    ? benchIds
    : benchIds.includes(swapSource) ? starterIds : [];
  const selected = allPlayers.find(p => p.id === selectedId);
  const marketPlayers: Player[] = live.players.map(p => ({ id: p.id, leagueId: '', name: p.name, position: p.position, price: p.price, rating: p.rating, image: p.image_url ?? undefined, active: p.active, points: 0, color: '#a9b9a5', attributes: { pace: 0, shooting: 0, passing: 0, defending: 0, physical: 0 } }));
  const saveAssignments = async (
    starters: string[], bench: string[], unassigned: string[], captainId: string | null,
    viceCaptainId: string | null, saveGameweek = false,
  ) => {
    const gameweekId = saveGameweek ? squad?.gameweek_id ?? live.gameweeks[0]?.id ?? null : null;
    await live.saveSquadAssignments({
      starters, bench, unassigned, captainId, viceCaptainId, gameweekId,
      expectedRevision: squad?.assignment_revision ?? null,
    });
  };
  const pitchFormation = formation ?? ([...format.formations][0] as Formation);
  const rawPositionalIssues = lineupIssues(starterEntries, ordered, matchFormat);
  const formatValidationMessage = rawPositionalIssues.find((issue) => issue.startsWith('Formation '));
  const formationIssue = starterEntries.length === format.starters && formatValidationMessage
    ? formatValidationMessage
    : '';
  const positionalIssues = rawPositionalIssues.map((issue) => {
    let match = /^Squad needs (\d+) players; currently (\d+)\.$/.exec(issue);
    if (match) return t('Squad needs {{required}} players; currently {{actual}}.', { required: match[1], actual: match[2] });
    match = /^Starting lineup needs (\d+) players; currently (\d+)\.$/.exec(issue);
    if (match) return t('Starting lineup needs {{required}} players; currently {{actual}}.', { required: match[1], actual: match[2] });
    match = /^Squad needs (\d+) (GK|DEF|MID|FWD); currently (\d+)\.$/.exec(issue);
    if (match) return t('Squad needs {{required}} {{position}}; currently {{actual}}.', { required: match[1], position: match[2], actual: match[3] });
    match = /^Starting lineup needs at least (\d+) (GK|DEF|MID|FWD); currently (\d+)\.$/.exec(issue);
    if (match) return t('Starting lineup needs at least {{required}} {{position}}; currently {{actual}}.', { required: match[1], position: match[2], actual: match[3] });
    match = /^Starting lineup needs exactly 1 GK; currently (\d+)\.$/.exec(issue);
    if (match) return t('Starting lineup needs exactly 1 GK; currently {{actual}}.', { actual: match[1] });
    match = /^Formation (.+) is not legal for (.+)\.$/.exec(issue);
    if (match) return t('Formation {{shape}} is not legal for {{format}}.', { shape: match[1], format: match[2] });
    return issue;
  });
  const visibleFormationIssue = formationIssue
    ? positionalIssues[rawPositionalIssues.indexOf(formationIssue)]
    : '';
  const lineupSaveBlockers = [
    ...positionalIssues,
    ...(benchPlayers.length !== format.bench ? [t('Bench needs {{required}} assigned players; currently {{actual}}.', { required: format.bench, actual: benchPlayers.length })] : []),
    ...(unassignedPlayers.length ? [t('Assign all {{count}} remaining squad players to a starter or ordered bench slot.', { count: unassignedPlayers.length })] : []),
  ];
  function selectPlayer(p: Player) {
    if (!swapSource) { setError(''); setSelectedId(p.id); return; }
    if (!targets.includes(p.id)) return;
    // The RPC contract is role-based, not click-order-based: p_out must always be
    // the current starter and p_in the current bench player. The editor allows a
    // manager to begin from either side, so normalize the selected IDs before the
    // request. Sending bench->starter looked like an already-applied retry to the
    // server's idempotency guard and therefore returned without swapping anything.
    const starterId = starterIds.includes(swapSource) ? swapSource : p.id;
    const benchId = benchIds.includes(swapSource) ? swapSource : p.id;
    void run('substitute', async () => {
      await live.substituteSquadPlayer(starterId, benchId, squad?.assignment_revision);
      setSwapSource('');
    }, 'Players swapped.');
  }
  function moveUnassigned(playerId: string, destination: 'starter' | 'bench') {
    if (!unassignedIds.includes(playerId)) return;
    if (destination === 'starter' && starterIds.length >= format.starters) return;
    if (destination === 'bench' && benchIds.length >= format.bench) return;
    const nextUnassigned = unassignedIds.filter((id) => id !== playerId);
    const nextStarters = destination === 'starter' ? [...starterIds, playerId] : starterIds;
    const nextBench = destination === 'bench' ? [...benchIds, playerId] : benchIds;
    void run('assign', () => saveAssignments(nextStarters, nextBench, nextUnassigned, captain, vice), 'Squad assignment saved.');
  }
  function moveBenchPlayer(playerId: string, direction: -1 | 1) {
    const index = benchIds.indexOf(playerId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= benchIds.length) return;
    const next = [...benchIds];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    void run('assign', () => saveAssignments(starterIds, next, unassignedIds, captain, vice), 'Bench order saved.');
  }
  function buyIntoSquad(playerId: string) {
    return run('add', () => live.buy(playerId), 'Player added to your squad.');
  }

  return (
    <>
      <PageTitle eyebrow="YOUR TEAM" title={editing ? 'Squad Builder' : 'My Squad'}
        description={t('{{format}} squad · {{total}} players · {{starters}} starters · {{bench}} bench · {{budget}} budget.', {
          format: matchFormat, total: format.total, starters: format.starters, bench: format.bench,
          budget: formatCompactMoney(budget),
        })} />

      {/* Same 7-cell strip as the demo squad screen: size, value, budget, then the
          four position counts. */}
      <div className="squad-summary">
        <div><small>{t('Squad')}</small><strong>{ordered.length}<span>/{format.total}</span></strong></div>
        <div><small>{t('Squad value')}</small><strong>{formatCompactMoney(spent)}</strong></div>
        <div><small>{t('Budget remaining')}</small><strong className="lime">{formatCompactMoney(remaining)}</strong></div>
        {(['GK', 'DEF', 'MID', 'FWD'] as Position[]).map((pos) => (
          <div key={pos}>
            <small>{pos}</small>
            {/* Format-specific roster cap. Formation is never used to reorder or
                assign players; it is derived from the exact saved starters. */}
            <strong>
              {ordered.filter((p) => p.position === pos).length}
              <span>/{format.positionLimits[pos]}</span>
            </strong>
          </div>
        ))}
      </div>

      {live.error && <ErrorNote message={live.error} />}
      {error && <p className="error" role="alert"><AlertCircle size={14} /> {error}</p>}
      <Success message={notice} />
      {!live.league.market_open && <p className="notice">{t('The market is closed.')}</p>}

      {swapSource && <div className="swap-banner" role="status"><strong>{t('Choose a player to swap')}</strong><button type="button" className="button button-outline" onClick={() => setSwapSource('')}>{t('Cancel swap')}</button></div>}
      {selected && <LivePlayerSheet key={selected.id} player={selected} players={marketPlayers} ownedIds={ids} starter={starterIds.includes(selected.id)} captainId={captain} viceId={vice} editing={editing} remaining={remaining} marketOpen={live.league.market_open} canSwap={editing && ((starterIds.includes(selected.id) && benchIds.length > 0) || (benchIds.includes(selected.id) && starterIds.length > 0))} busy={!!busy} points={lastGamePointsForPlayer(live.points, selected.id)} error={error} close={() => { setSelectedId(''); setError(''); }} startSwap={() => { setSwapSource(selected.id); setSelectedId(''); }} setCaptain={type => {
        const nextCaptain = type === 'captain'
          ? (captain === selected.id ? null : selected.id)
          : (captain === selected.id ? null : captain);
        const nextVice = type === 'vice'
          ? (vice === selected.id ? null : selected.id)
          : (vice === selected.id ? null : vice);
        if (nextCaptain && nextVice && nextCaptain === nextVice) {
          setError(t('Captain and vice captain must be different players.'));
          return;
        }
        void run('captaincy', async () => {
          await live.setSquadCaptains(nextCaptain, nextVice);
          setCaptain(nextCaptain);
          setVice(nextVice);
        }, 'Captaincy updated.');
      }} transfer={id => void run('transfer', async () => { await live.transfer(selected.id, id); setSelectedId(''); }, 'Transfer confirmed.')} remove={() => void run('sell', async () => { await live.sell(selected.id); setSelectedId(''); }, 'Player removed from your squad.')} />}
      <div className="squad-layout">
        <div className="panel">
          <SectionHead eyebrow="YOUR TEAM" title={hasSquad && !editing ? 'Starting XI' : 'Your squad'} />
          {(!hasSquad || editing) && (
            <p className="section-description">
              {t('Players enter the squad unassigned. Place each one explicitly in a Starting XI slot or on the ordered bench.')}
            </p>
          )}
          <p className="section-description">
            {t('{{format}} · {{starters}} starters · {{bench}} ordered substitutes', {
              format: matchFormat, starters: format.starters, bench: format.bench,
            })}
          </p>
          <div className="panel-subline"><span>{t('Derived formation')}</span><strong>{formation ?? t('Not a legal formation')}</strong></div>
          {visibleFormationIssue && <p className="notice formation-validation" role="status"><AlertCircle size={15} aria-hidden="true"/><span>{visibleFormationIssue}</span></p>}

          {/* The pitch only receives players whose saved slot is a starter. A
              legal formation is derived from that group; the editor never moves a
              player just to satisfy the layout. */}
          <Pitch players={pitchPlayers} formation={pitchFormation}
            captainId={captainId} viceCaptainId={viceId}
            onPlayerClick={selectPlayer} swapSource={swapSource} swapTargets={targets}
            onAddPosition={editing && ordered.length < format.total ? setAddPosition : undefined}
            squadSlots={!hasSquad}
            canAddStarting={editing && ordered.length < format.total}
            pointsFor={(p) => lastGamePointsFor({ league_player_id: p.id })}
            pointsLabel={t('Last game points')} />

          {(hasSquad || editing) && <div className="bench-strip">
            <div className="bench-head"><h3>{t('Bench')}</h3></div>
            <div className="bench-players">
              {benchPlayers.length === 0 && <small>{t('No substitutes yet.')}</small>}
              {benchPlayers.map((p, index) => (
                <div className="bench-player-item" key={p.league_player_id}>
                  <button type="button" className={`bench-player ${targets.includes(p.league_player_id) ? 'swap-target' : ''} ${swapSource && !targets.includes(p.league_player_id) ? 'swap-dim' : ''}`} disabled={!!swapSource && !targets.includes(p.league_player_id)} aria-label={`${t(swapSource ? 'Select swap player' : 'Player details')}: ${p.name}`} onClick={() => { const player = allPlayers.find(x => x.id === p.league_player_id); if (player) selectPlayer(player); }}>
                    <Avatar name={p.name} image={p.image_url ?? undefined} size="sm" />
                    <strong>{p.name}</strong>
                    <small>{p.position} · {lastGamePointsFor(p) != null ? `${lastGamePointsFor(p)} ${t('pts')}` : '—'}</small>
                  </button>
                  {editing && !swapSource && <div className="bench-order-controls">
                    <button type="button" aria-label={`${t('Move up')}: ${p.name}`} disabled={index===0 || busy==='assign'} onClick={() => moveBenchPlayer(p.league_player_id,-1)}>↑</button>
                    <button type="button" aria-label={`${t('Move down')}: ${p.name}`} disabled={index===benchPlayers.length-1 || busy==='assign'} onClick={() => moveBenchPlayer(p.league_player_id,1)}>↓</button>
                  </div>}
                </div>
              ))}
              {editing && ordered.length >= format.starters && ordered.length < format.total && (['GK', 'DEF', 'MID', 'FWD'] as Position[]).flatMap(pos => {
                const remainingAtPosition = Math.max(0, format.positionLimits[pos] - ordered.filter(p => p.position === pos).length);
                const slots = Math.min(remainingAtPosition, format.total - ordered.length, format.bench - benchPlayers.length);
                return Array.from({ length: slots }, (_, index) => (
                  <button type="button" className="bench-player bench-add" key={`${pos}-${index}`} aria-label={`${t('Add bench player')}: ${pos}`} disabled={!!swapSource || !live.league?.market_open} onClick={() => setAddPosition(pos)}>
                    <span>+</span><strong>{pos}</strong>
                  </button>
                ));
              })}
            </div>
          </div>}
          {editing && unassignedPlayers.length > 0 && <div className="bench-strip unassigned-strip">
            <div className="bench-head"><h3>{t('Unassigned players')}</h3></div>
            <p className="section-description">{t('These players have no saved slot yet. Assign them explicitly; opening or refreshing this page will not move them.')}</p>
            <div className="unassigned-players">
              {unassignedPlayers.map((player) => <div className="unassigned-player" key={player.league_player_id}>
                <Avatar name={player.name} image={player.image_url ?? undefined} size="sm" />
                <div><strong>{player.name}</strong><small>{player.position} · {formatCompactMoney(player.price)}</small></div>
                <button type="button" className="button button-outline" disabled={busy==='assign' || starterIds.length>=format.starters}
                  onClick={() => moveUnassigned(player.league_player_id,'starter')}>{t('Add to starters')}</button>
                <button type="button" className="button button-outline" disabled={busy==='assign' || benchIds.length>=format.bench}
                  onClick={() => moveUnassigned(player.league_player_id,'bench')}>{t('Add to bench')}</button>
              </div>)}
            </div>
          </div>}
        </div>
      </div>

      {/* Mode switches never change the saved order: they only enable or hide edit
          controls. The market action is therefore unavailable in read-only View mode. */}
      <div className="squad-actions">
        <button type="button" className="button button-outline" onClick={() => {
          const next = !editing;
          setEditing(next);
          if (!next) {
            setSelectedId(''); setSwapSource(''); setAddPosition(undefined);
          }
        }}>
          {t(editing ? 'View squad' : 'Edit squad')}
        </button>
        {editing && live.league.market_open && <Link className="button" to="/market"><UserPlus size={15} /> {t('Add players')}</Link>}
      </div>
      {editing && (
        <section className="panel section-spacer lineup-save-panel">
          <SectionHead eyebrow="THE LINEUP" title="Squad assignments" />
          {lineupSaveBlockers.length > 0 && <ul className="lineup-save-blockers" role="status">{lineupSaveBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
          <div className="button-row">
            <button type="button" className="button button-outline" disabled={busy === 'assign'}
              onClick={() => void run('assign', () => saveAssignments(starterIds, benchIds, unassignedIds, captain, vice), 'Squad assignments saved.')}>
              {busy === 'assign' ? t('Saving…') : t('Save assignments')}
            </button>
            {(squad?.gameweek_id || live.gameweeks.length > 0) && <button type="button" className="button" disabled={busy === 'lineup-save' || lineupSaveBlockers.length > 0}
              onClick={() => void run('lineup-save', () => saveAssignments(starterIds, benchIds, unassignedIds, captain, vice, true), 'Lineup saved.')}>
              {busy === 'lineup-save' ? t('Saving…') : t('Save gameweek lineup')}
            </button>}
          </div>
        </section>
      )}

      {/* Formation is derived from the exact saved Starting XI. The remaining
          panel carries squad status and transfer controls. */}
      {hasSquad && editing && (
        <div className="panel section-spacer">
          <SectionHead eyebrow="THE LINEUP" title="Squad status" />
          <div className="validation-panel" role="status">
            <span>{badgeText(squad?.status, t)}</span>
          </div>

          <div className="formation-select">
            <label>{t('Sell a player')}
              <select aria-label={t('Sell a player')} value={outPlayer}
                onChange={(e) => setOutPlayer(e.target.value)}>
                <option value="">{t('Select a player')}</option>
                {ordered.map((p) => (
                  <option key={p.league_player_id} value={p.league_player_id}>
                    {p.name} · {p.position} · {formatCompactMoney(p.price)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {outPlayer && (
            <div className="confirm-lineup">
              <button className="button button-outline" disabled={busy === 'sell'}
                onClick={() => void run('sell', async () => {
                  await live.sell(outPlayer);
                  setOutPlayer('');
                }, 'Player sold.')}>
                <UserMinus size={15} /> {busy === 'sell' ? t('Selling…') : t('Sell selected player')}
              </button>
            </div>
          )}
        </div>
      )}

      {addPosition && (
        <AddLivePlayerSheet
          position={addPosition}
          market={live.players}
          ownedIds={ordered.map((p) => p.league_player_id)}
          remaining={remaining}
          marketOpen={live.league.market_open}
          busy={busy === 'add'}
          onPick={(player) => buyIntoSquad(player.id)}
          close={() => setAddPosition(undefined)}
        />
      )}
    </>
  );
}

function badgeText(status: string | undefined, t: (key: string) => string): string {
  switch (status) {
    case 'confirmed': return t('Squad confirmed');
    case 'draft': return t('Draft lineup');
    case 'superseded': return t('This lineup was replaced by a newer one.');
    default: return t('No lineup saved yet.');
  }
}

/** Standings / statistics in live mode. */
export function LiveStandings() {
  const { t } = useTranslation();
  const live = useLive();
  if (live.loading) return <Loading />;
  if (!live.league) return <Empty title="Join or create a league" to="/create-league" action="Create League" />;

  // ONE ranking, by fantasy points. Head-to-head is not a ranking input at all:
  // mixing the two produced a table ordered by h2h_points where fantasy points
  // only broke ties, which is not the game this league plays. `h2h_points` is
  // still shown where the server provides it, purely for reference.
  //
  // Sorted here rather than trusting the RPC order, so the table is correct even
  // if it is built against a database that predates the matching SQL change.
  const ranked = [...live.standings].sort((a, b) =>
    (b.fantasy_points ?? 0) - (a.fantasy_points ?? 0)
    || a.team_name.localeCompare(b.team_name));

  return (
    <>
      <PageTitle eyebrow="THE TABLE" title="League Standings"
        description="The race is on" />
      {live.error && <ErrorNote message={live.error} onRetry={() => void live.reload()} />}
      <PartialDataNote failures={live.partialFailures} onRetry={() => void live.reload()} />

      {ranked.length === 0 ? (
        <Empty title="No standings yet"
          description="Standings are calculated from approved results. No result has been approved in this league yet." />
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('Rank')}</th><th>{t('TEAM')}</th><th>{t('Manager')}</th>
                <th>{t('Fantasy points')}</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((row, index) => {
                // Equal totals share a rank, matching the demo table.
                const rank = ranked.findIndex((r) => r.fantasy_points === row.fantasy_points) + 1;
                // Your row is the one you manage. Matching on team name would depend on a
                // squad being loaded, which is not guaranteed on this screen.
                const isMine = !!live.myUserId && row.manager_id === live.myUserId;
                return (
                  <tr key={row.team_id} className={isMine ? 'highlight-row' : ''}>
                    <td>{String(rank).padStart(2, '0')}</td>
                    <td>
                      <div className="table-team">
                        <div className={`mini-crest c${index % 4}`}><Shield size={14} /></div>
                        <span>
                          <strong>{row.team_name}</strong>
                          <small>{row.manager_name}</small>
                        </span>
                      </div>
                    </td>
                    <td>{row.manager_name}</td>
                    <td><strong className="lime">{row.fantasy_points}</strong></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** Season setup: without a gameweek, no lineup can be pinned and no transfer recorded. */
export function LiveSeason() {
  const { t } = useTranslation();
  const live = useLive();
  const [name, setName] = useState('Season 2025/26');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [count, setCount] = useState('18');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  if (live.loading) return <Loading />;
  if (!live.league) return <Empty title="Join or create a league" to="/create-league" action="Create League" />;

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      await live.createSeason(name.trim(), new Date(start).toISOString(), new Date(end).toISOString(), Number(count));
      setNotice(t('Season created.'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('That did not work'));
    } finally { setBusy(false); }
  }

  return (
    <>
      <PageTitle eyebrow="THE NUMBERS" title="Season and gameweeks"
        description="A lineup is pinned to a gameweek, so your league needs a season before squads can be confirmed." />
      {error && <p className="error" role="alert"><AlertCircle size={14} /> {error}</p>}
      <Success message={notice} />

      <div className="panel table-wrap">
        <table>
          <thead><tr><th>{t('Gameweek')}</th><th>{t('Season')}</th><th>{t('Deadline')}</th><th>{t('Rules pinned')}</th></tr></thead>
          <tbody>
            {live.gameweeks.length === 0 && <tr><td colSpan={4}><small>{t('No gameweeks yet.')}</small></td></tr>}
            {live.gameweeks.map((g) => (
              <tr key={g.id}>
                <td>{String(g.number).padStart(2, '0')}</td>
                <td>{g.season_name}</td>
                <td>{new Date(g.deadline).toLocaleString()}</td>
                <td>{g.rules_pinned ? <Badge kind="lime">{t('Yes')}</Badge> : <Badge>{t('No')}</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {live.isLeader && live.gameweeks.length === 0 && (
        <form className="panel form-panel section-spacer" onSubmit={submit}>
          <SectionHead eyebrow="LEADER TOOLS" title="Create a season" />
          <label>{t('Season name')}<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
          <div className="form-row">
            <label>{t('Starts')}<input type="date" value={start} onChange={(e) => setStart(e.target.value)} required /></label>
            <label>{t('Ends')}<input type="date" value={end} onChange={(e) => setEnd(e.target.value)} required /></label>
          </div>
          <label>{t('Number of gameweeks')}
            <input type="number" min="1" max="60" value={count} onChange={(e) => setCount(e.target.value)} required />
          </label>
          <button className="button" disabled={busy || !start || !end}>
            <UserPlus size={15} /> {busy ? t('Creating…') : t('Create season')}
          </button>
        </form>
      )}
    </>
  );
}

/**
 * Player statistics in live mode.
 *
 * Mirrors the demo table: rank, player, position, rating, price. The demo's final
 * column is FANTASY POINTS, which the live schema does not carry per player, so it
 * is replaced with OVR as the sort key - the same substitution the dashboard pitch
 * already makes - rather than rendering a column of zeros.
 */
export function LiveStatistics() {
  const { t } = useTranslation();
  const live = useLive();
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState('');

  if (live.loading) return <Loading />;
  if (!live.league) return <Empty title="Join or create a league" to="/create-league" action="Create League" />;

  const ranked = live.players
    .filter((p) => (position ? p.position === position : true))
    .filter((p) => (query ? p.name.toLowerCase().includes(query.toLowerCase()) : true))
    .sort((a, b) => b.rating - a.rating || b.price - a.price);

  return (
    <>
      <PageTitle eyebrow="THE NUMBERS" title="Player statistics"
        description="How the players in your league market rate this season" />
      {live.error && <ErrorNote message={live.error} />}

      <div className="filter-bar">
        <div className="search-box">
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Search players')} aria-label={t('Search players')} />
        </div>
        <div className="filters">
          <select value={position} onChange={(e) => setPosition(e.target.value)} aria-label={t('Position')}>
            <option value="">{t('All positions')}</option>
            {['GK', 'DEF', 'MID', 'FWD'].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      </div>

      {ranked.length === 0 ? (
        <Empty title="No players yet"
          description="Your league leader publishes the market players." />
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('Rank')}</th><th>{t('PLAYER')}</th><th>{t('Position')}</th>
                <th>{t('Rating')}</th><th>{t('Price')}</th><th>{t('Managers')}</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((p, i) => (
                <tr key={p.id}>
                  <td>{String(i + 1).padStart(2, '0')}</td>
                  <td>
                    <Link to={`/players/${p.id}`} className="table-team">
                      <Avatar name={p.name} image={p.image_url ?? undefined} size="sm" />
                      <strong>{p.name}</strong>
                    </Link>
                  </td>
                  <td>{p.position}</td>
                  <td>{p.rating}</td>
                  <td>{formatCompactMoney(p.price)}</td>
                  <td>{p.owned_by ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
