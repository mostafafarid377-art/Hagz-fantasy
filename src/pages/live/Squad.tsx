// Live squad builder and transfer market.
//
// The position distribution (2 GK / 5 DEF / 5 MID / 3 FWD), the 15-player cap,
// the budget and the formation rules are all enforced by the database. This screen
// shows the same checks *before* the user acts, but it never assumes they passed:
// a refused save is displayed with the server's own message.
//
// Starters are the first 11 entries of the lineup array and the bench is the last
// 4 - the same convention ff_lineup_save() validates server-side.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AlertCircle, Shield, UserMinus, UserPlus } from 'lucide-react';
import { Avatar, Badge, Empty, PageTitle, SectionHead } from '../../components/UI';
import { formatCompactMoney } from '../../utils/format';
import { useLive } from '../../hooks/useLive';
import { ApiError } from '../../services/api';
import { ErrorNote, Loading, PartialDataNote, Success } from './League';
import { Pitch } from '../Dashboard';
import { formations, limits, substitutionTargets } from '../../services/rules';
import { lastGamePointsForPlayer } from '../../services/points';
import { LivePlayerSheet } from './LivePlayerSheet';
import { AddLivePlayerSheet } from './AddLivePlayerSheet';
import type { Formation, Player, Position } from '../../types';

const SQUAD_ORDER_STORAGE_PREFIX = 'ff_live_squad_order:';

function readSavedSquadOrder(leagueId: string): string[] | null {
  try {
    const stored = window.localStorage.getItem(`${SQUAD_ORDER_STORAGE_PREFIX}${leagueId}`);
    if (!stored) return null;
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) && parsed.every((id): id is string => typeof id === 'string')
      ? parsed : null;
  } catch {
    return null;
  }
}

function saveSquadOrder(leagueId: string, ids: string[]) {
  try {
    window.localStorage.setItem(`${SQUAD_ORDER_STORAGE_PREFIX}${leagueId}`, JSON.stringify(ids));
  } catch {
    // Keep the in-memory order working when browser storage is unavailable.
  }
}

function clearSavedSquadOrder(leagueId: string) {
  try {
    window.localStorage.removeItem(`${SQUAD_ORDER_STORAGE_PREFIX}${leagueId}`);
  } catch {
    // In-memory order still applies for this session.
  }
}

/**
 * Reconcile a remembered order against the authoritative roster.
 * - Unchanged roster: returns the exact saved order (preserves GK slot,
 *   captain/vice positions that depend on order).
 * - Changed roster: keeps survivors in saved order, drops departed IDs,
 *   appends new IDs in server order (new bench players stay benched).
 * - No saved order: returns [] so the formation fallback applies.
 */
function reconcileSquadOrder(ids: string[] | null | undefined, players: Array<{ league_player_id: string }>): string[] {
  if (!ids?.length) return [];
  const current = new Set(players.map((player) => player.league_player_id));
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const id of ids) {
    if (current.has(id) && !seen.has(id)) { seen.add(id); kept.push(id); }
  }
  for (const player of players) {
    if (!seen.has(player.league_player_id)) kept.push(player.league_player_id);
  }
  return kept;
}

export function SquadChangeNotice({ onReview }: { onReview?: () => void }) {
  const { t } = useTranslation();
  const { squadChange, refreshSquad, hasSquadReceipt, retrySquadReceipt, cancelSquadReceipt } = useLive();
  if (!squadChange) return null;
  if (squadChange === 'saving' || squadChange === 'refreshing' || squadChange === 'verifying') {
    return <p className="swap-banner notice" role="status">
      {t(squadChange === 'saving' ? 'Saving squad change…' : 'Refreshing squad…')}
    </p>;
  }
  return (
    <div className="swap-banner">
      {squadChange === 'refreshRequired' ? <>
        <span role="alert">{t('Your squad operation is unresolved. Checking does not submit it again.')}</span>
        <button type="button" className="button button-outline" onClick={() => void refreshSquad()}>{t('Check operation')}</button>
        {hasSquadReceipt && <>
          <button type="button" className="button button-outline" onClick={() => void retrySquadReceipt()}>{t('Retry same operation')}</button>
          <button type="button" className="button button-outline" onClick={() => void cancelSquadReceipt()}>{t('Cancel operation')}</button>
        </>}
      </> : <>
        <span role="status">{t('Your squad was refreshed. Review it and select players again to retry.')}</span>
        {onReview
          ? <button type="button" className="button button-outline" onClick={onReview}>{t('Choose players again')}</button>
          : <Link className="button button-outline" to="/squad">{t('Review squad')}</Link>}
      </>}
    </div>
  );
}

export function LiveSquad({ builder = false, transfers = false }: { builder?: boolean; transfers?: boolean }) {
  const { t } = useTranslation();
  const live = useLive();
  const [busy, setBusy] = useState('');
  const pending = useRef<symbol | null>(null);
  const locked = Boolean(busy || live.squadChange);
  // A successful write is briefly 'verifying' too; do not discard the user's
  // selection unless recovery is actually required.
  const recovering = live.squadChange === 'refreshRequired' || live.squadChange === 'refreshing' || live.squadChange === 'reviewRequired';
  // Completion of an old route/league action must not edit the new screen or
  // persist its captured lineup order. The provider owns the underlying write.
  useLayoutEffect(() => {
    setBusy('');
    return () => { pending.current = null; };
  }, [live.leagueId, live.loading, builder, transfers]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [formation, setFormation] = useState<Formation>((live.squad?.formation as Formation) ?? '4-3-3');
  // Captaincy is managed from each player's detail sheet and stored independently
  // from full-lineup saves, so it also works while the squad is being assembled.
  const [captain, setCaptain] = useState<string | null>(live.squad?.captain_id ?? null);
  const [vice, setVice] = useState<string | null>(live.squad?.vice_captain_id ?? null);

  /**
   * useState only reads its initial value on the FIRST render, and on that render
   * `live.squad` is still null because the RPC has not resolved. Without this the
   * saved formation was ignored: the pitch always opened as 4-3-3 and the database's
   * formation only appeared after a reload. Keyed on the league so switching leagues
   * re-syncs instead of carrying the previous league's shape over.
   */
  useEffect(() => {
    const saved = live.squad?.formation as Formation | undefined;
    setFormation(saved ?? '4-3-3');
  }, [live.leagueId, live.squad?.formation, recovering]);
  useEffect(() => {
    setCaptain(live.squad?.captain_id ?? null);
    setVice(live.squad?.vice_captain_id ?? null);
  }, [live.leagueId, live.squad?.captain_id, live.squad?.vice_captain_id, recovering]);
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
  // Buying a bench player invalidates an unsaved server draft. Until the next
  // lineup save, keep the current client-side order so a newly purchased player
  // cannot sort ahead of a starter and push that starter onto the bench.
  const [orderHint, setOrderHint] = useState<{ leagueId: string; ids: string[] } | null>(null);
  const rememberOrder = (ids: string[]) => {
    if (!live.leagueId) return;
    const hint = { leagueId: live.leagueId, ids };
    setOrderHint(hint);
    saveSquadOrder(hint.leagueId, ids);
  };
  useEffect(() => {
    if (live.loading || !live.leagueId) return;
    const leagueChanged = initializedLeague.current !== live.leagueId;
    const builderChanged = previousBuilder.current !== builder;
    if (!leagueChanged && !builderChanged) return;
    initializedLeague.current = live.leagueId;
    previousBuilder.current = builder;
    if (leagueChanged) setOrderHint(null);
    setEditing(builder || (live.squad?.players.length ?? 0) === 0);
    setSelectedId(''); setSwapSource(''); setAddPosition(undefined);
    setOutPlayer(''); setInPlayer(''); setError(''); setNotice('');
  }, [builder, live.leagueId, live.loading, live.squad?.players.length]);
  useEffect(() => {
    if (!recovering || !live.leagueId) return;
    setSelectedId(''); setSwapSource(''); setAddPosition(undefined);
    setOutPlayer(''); setInPlayer(''); setError(''); setNotice('');
    // Preserve the exact remembered order when the roster is unchanged so the
    // starting keeper, captain and vice-captain stay put. Only reconcile
    // (drop departed, append new) when the authoritative roster changed, and
    // persist that reconciliation so stale IDs do not linger in storage.
    if (!live.squad || live.partialFailures.some((failure) => failure.startsWith('squad:'))) return;
    const currentPlayers = live.squad.players;
    const saved = orderHint?.leagueId === live.leagueId
      ? orderHint.ids : readSavedSquadOrder(live.leagueId);
    if (saved?.length) {
      const reconciled = reconcileSquadOrder(saved, currentPlayers);
      if (reconciled.length) {
        setOrderHint({ leagueId: live.leagueId, ids: reconciled });
        saveSquadOrder(live.leagueId, reconciled);
      } else {
        setOrderHint({ leagueId: live.leagueId, ids: [] });
        clearSavedSquadOrder(live.leagueId);
      }
    }
    // No remembered order: leave the hint alone so the formation fallback
    // (and any server slots) drive the layout.
  }, [recovering, live.leagueId, live.squad, live.partialFailures]);
  // Outside recovery, drop departed IDs from persisted order so stale state
  // from a previous roster does not linger. New IDs are not appended here:
  // server slots (or the next explicit save/buy) own their placement.
  useEffect(() => {
    // A failed read is not an authoritative empty roster. Never delete a
    // remembered order based on a missing or stale squad snapshot.
    if (!live.leagueId || live.loading || recovering || !live.squad
        || live.partialFailures.some((failure) => failure.startsWith('squad:'))) return;
    const saved = readSavedSquadOrder(live.leagueId);
    if (!saved?.length) return;
    const current = new Set((live.squad?.players ?? []).map((player) => player.league_player_id));
    const cleaned = saved.filter((id) => current.has(id));
    if (cleaned.length === saved.length) return;
    if (cleaned.length) saveSquadOrder(live.leagueId, cleaned);
    else clearSavedSquadOrder(live.leagueId);
  }, [live.leagueId, live.loading, live.squad, live.partialFailures, recovering]);

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

  /** Saved slots, remembered order, then a formation-balanced fallback. */
  const rawOrder = orderHint?.leagueId === live.leagueId
    ? orderHint.ids
    : live.leagueId ? readSavedSquadOrder(live.leagueId) ?? [] : [];
  const preferredOrder = reconcileSquadOrder(rawOrder, players);
  const orderIndex = new Map(preferredOrder.map((id, index) => [id, index]));
  const fallbackFormation = formations[formation] ?? formations['4-3-3'];
  const fallbackPositions: Position[] = ['GK', 'DEF', 'MID', 'FWD'];
  const byPosition = fallbackPositions.map((position) =>
    players.filter((player) => player.position === position)
      .sort((a, b) => a.name.localeCompare(b.name)));
  // With no saved slots or locally remembered order, allocate the required number
  // at each position to the XI first; only surplus players go to the bench. This
  // also repairs existing rosters whose old draft was invalidated before ordering
  // could be persisted, instead of sorting two keepers/five defenders onto the XI.
  const fallbackIds = [
    ...byPosition.flatMap((group, index) => group.slice(0, fallbackFormation[fallbackPositions[index]])),
    ...byPosition.flatMap((group, index) => group.slice(fallbackFormation[fallbackPositions[index]])),
  ].map((player) => player.league_player_id);
  const fallbackIndex = new Map(fallbackIds.map((id, index) => [id, index]));
  const ordered = [...players].sort((a, b) => {
    // Persisted lineup slots are authoritative. If buying a player invalidates an
    // unsaved draft, use remembered order until the next save rather than letting
    // a new name sort ahead of a starter and push that starter onto the bench.
    if (a.slot != null || b.slot != null) return (a.slot ?? 100) - (b.slot ?? 100);
    const aIndex = orderIndex.get(a.league_player_id), bIndex = orderIndex.get(b.league_player_id);
    if (aIndex != null || bIndex != null) return (aIndex ?? 100) - (bIndex ?? 100);
    return (fallbackIndex.get(a.league_player_id) ?? 100) - (fallbackIndex.get(b.league_player_id) ?? 100);
  });

  async function run(key: string, action: () => Promise<void>, success: string, onSuccess?: () => void) {
    if (locked || pending.current) return;
    const token = Symbol();
    pending.current = token;
    setBusy(key); setError(''); setNotice('');
    try {
      await action();
      if (pending.current !== token) return;
      onSuccess?.();
      setNotice(t(success));
    } catch (caught) {
      // Recoverable failures use the shared panel, not the obsolete selection.
      if (pending.current !== token || (caught instanceof ApiError && ['conflict', 'network'].includes(caught.code))) return;
      setError(caught instanceof Error ? caught.message : t('That did not work'));
    } finally {
      if (pending.current === token) {
        pending.current = null;
        setBusy('');
      }
    }
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
        <SquadChangeNotice onReview={live.acknowledgeSquadRefresh} />

        {!live.league.market_open && <p className="notice">{t('The market is closed.')}</p>}

        <div className="panel form-panel">
          <label>{t('Player to transfer out')}
            <select value={outPlayer} disabled={locked} onChange={(e) => { setOutPlayer(e.target.value); setInPlayer(''); }}>
              <option value="">{t('Select a player')}</option>
              {outOptions.map((p) => (
                <option key={p.league_player_id} value={p.league_player_id}>
                  {p.name} · {p.position} · {formatCompactMoney(p.price)}{identityHint(p.league_player_id)}
                </option>
              ))}
            </select>
          </label>
          <label>{t('Replacement player')}
            <select value={inPlayer} onChange={(e) => setInPlayer(e.target.value)} disabled={!outgoing || locked}>
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
          <button className="button" disabled={locked || !outPlayer || !inPlayer || !live.league.market_open}
            onClick={() => void run('transfer', () => live.transfer(outPlayer, inPlayer), 'Transfer confirmed.', () => {
              setOutPlayer(''); setInPlayer('');
            })}>
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
  // The pitch is always the Starting XI, including in Edit Squad. Bench entries
  // remain in their own strip so toggling editor state can never move them onto the
  // pitch or hide the controls needed to replace them.
  const pitchPlayers = allPlayers.slice(0, 11);
  const captainId = ordered.find((p) => p.league_player_id === captain) ? (captain ?? undefined) : undefined;
  /** Last-game points for a squad entry, or undefined when there is no valid score. */
  const lastGamePointsFor = (p: { league_player_id: string }) =>
    lastGamePointsForPlayer(live.points, p.league_player_id);
  const viceId = ordered.find((p) => p.league_player_id === vice) ? (vice ?? undefined) : undefined;
  const benchPlayers = ordered.slice(11);
  const ids = ordered.map(p => p.league_player_id);
  const ruleSquad = { leagueId: '', managerId: '', playerIds: ids, formation };
  const targets = swapSource ? substitutionTargets(ruleSquad, allPlayers, swapSource) : [];
  const selected = allPlayers.find(p => p.id === selectedId);
  const marketPlayers: Player[] = live.players.map(p => ({ id: p.id, leagueId: '', name: p.name, position: p.position, price: p.price, rating: p.rating, image: p.image_url ?? undefined, active: p.active, points: 0, color: '#a9b9a5', attributes: { pace: 0, shooting: 0, passing: 0, defending: 0, physical: 0 } }));
  const save = (playerIds: string[]) => live.saveLineup({
    gameweekId: squad?.gameweek_id, formation, playerIds, captainId: captain, viceCaptainId: vice,
  });
  const formationCounts = (selected: typeof ordered) => ({
    GK: selected.filter(p => p.position === 'GK').length,
    DEF: selected.filter(p => p.position === 'DEF').length,
    MID: selected.filter(p => p.position === 'MID').length,
    FWD: selected.filter(p => p.position === 'FWD').length,
  });
  const actualStarters = formationCounts(ordered.slice(0, 11));
  const requiredStarters = formations[formation] ?? formations['4-3-3'];
  const formationMatches = (['GK', 'DEF', 'MID', 'FWD'] as Position[]).every(pos => actualStarters[pos] === requiredStarters[pos]);
  const formationCountsText = (counts: Record<Position, number>) => `GK ${counts.GK}, DEF ${counts.DEF}, MID ${counts.MID}, FWD ${counts.FWD}`;
  const formationIssue = !formationMatches
    ? t('Formation requires: {{required}}. Starting XI currently has: {{current}}.', {
      required: formationCountsText(requiredStarters), current: formationCountsText(actualStarters),
    })
    : '';
  const lineupSaveBlockers = [
    ...(ordered.length !== 15 ? [t('Select exactly 15 players to save a lineup.')] : []),
    ...(!formationMatches ? [formationIssue] : []),
    ...(!captain ? [t('Select a captain from your squad.')] : []),
    ...(!vice ? [t('Select a vice captain from your squad.')] : []),
    ...(!squad?.gameweek_id && (live.gameweeks?.length ?? 0) === 0 ? [t('A season with a gameweek is required to save a lineup.')] : []),
  ];
  function selectPlayer(p: Player) {
    if (locked || pending.current) return;
    if (!swapSource) { setError(''); setSelectedId(p.id); return; }
    if (!targets.includes(p.id)) return;
    const next = [...ids]; const a = next.indexOf(swapSource), b = next.indexOf(p.id);
    if (a < 0 || b < 0) return;
    [next[a], next[b]] = [next[b], next[a]];
    // Captaincy belongs to the squad; the server validates that both selected IDs
    // remain in the submitted 15-player lineup.
    void run('lineup', () => save(next), 'Players swapped.', () => {
      rememberOrder(next); setSwapSource('');
    });
  }
  function buyIntoSquad(playerId: string) {
    return run('add', () => {
      rememberOrder([...ids.filter((id) => id !== playerId), playerId]);
      return live.buy(playerId);
    }, 'Player added to your squad.');
  }

  return (
    <>
      <PageTitle eyebrow="YOUR TEAM" title={editing ? 'Squad Builder' : 'My Squad'}
        description={t('Maximum 15 players, with a 100M budget.')} />

      {/* Same 7-cell strip as the demo squad screen: size, value, budget, then the
          four position counts. */}
      <div className="squad-summary">
        <div><small>{t('Squad')}</small><strong>{ordered.length}<span>/15</span></strong></div>
        <div><small>{t('Squad value')}</small><strong>{formatCompactMoney(spent)}</strong></div>
        <div><small>{t('Budget remaining')}</small><strong className="lime">{formatCompactMoney(remaining)}</strong></div>
        {(['GK', 'DEF', 'MID', 'FWD'] as Position[]).map((pos) => (
          <div key={pos}>
            <small>{pos}</small>
            {/* The denominator is the FORMATION's requirement for that band plus
                the bench allowance, i.e. the squad's real capacity: 2/5/5/3. When a
                formation asks for more in one band than the capacity allows (never
                happens with the supported shapes) the larger number wins. */}
            <strong>
              {ordered.filter((p) => p.position === pos).length}
              <span>/{Math.max(limits[pos], (formations[formation] ?? formations['4-3-3'])[pos])}</span>
            </strong>
          </div>
        ))}
      </div>

      {live.error && <ErrorNote message={live.error} />}
      {error && <p className="error" role="alert"><AlertCircle size={14} /> {error}</p>}
      <Success message={notice} />
      <SquadChangeNotice onReview={live.acknowledgeSquadRefresh} />
      {!live.league.market_open && <p className="notice">{t('The market is closed.')}</p>}

      {swapSource && <div className="swap-banner" role="status"><strong>{t('Choose a player to swap')}</strong><button type="button" className="button button-outline" disabled={locked} onClick={() => setSwapSource('')}>{t('Cancel swap')}</button></div>}
      {selected && <LivePlayerSheet key={selected.id} player={selected} players={marketPlayers} ownedIds={ids} starter={ids.indexOf(selected.id) < 11} captainId={captain} viceId={vice} editing={editing} remaining={remaining} marketOpen={live.league.market_open} canSwap={substitutionTargets(ruleSquad, allPlayers, selected.id).length > 0} busy={locked} points={lastGamePointsForPlayer(live.points, selected.id)} error={error} close={() => { setSelectedId(''); setError(''); }} startSwap={() => { setSwapSource(selected.id); setSelectedId(''); }} setCaptain={type => {
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
        void run('captaincy', () => live.setSquadCaptains(nextCaptain, nextVice), 'Captaincy updated.', () => {
          setCaptain(nextCaptain);
          setVice(nextVice);
        });
      }} transfer={id => void run('transfer', () => live.transfer(selected.id, id), 'Transfer confirmed.', () => setSelectedId(''))} remove={() => void run('sell', () => live.sell(selected.id), 'Player removed from your squad.', () => setSelectedId(''))} />}
      <fieldset className="squad-layout min-w-0" disabled={locked}>
        <div className="panel">
          <SectionHead eyebrow="YOUR TEAM" title={hasSquad && !editing ? 'Starting XI' : 'Your squad'} />
          {(!hasSquad || editing) && (
            <p className="section-description">
              {t('Tap an empty position to add a player. The first 11 players are starters.')}
            </p>
          )}
          {/* View mode reflects the saved formation; the editor lets a manager preview
              every supported shape before explicitly saving the lineup. */}
          {editing && (
            <label className="formation-select">{t('Formation')}
              <select aria-label={t('Formation')} value={formation}
                onChange={(e) => setFormation(e.target.value as Formation)}>
                {(Object.keys(formations) as Formation[]).map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
          )}
          {!formationMatches && <p className="notice formation-validation" role="status"><AlertCircle size={15} aria-hidden="true"/><span>{formationIssue}</span></p>}

          {/* An empty squad (or edit mode) shows all 15 capacity places, so every
              position can be filled; otherwise the pitch is the starting XI in the
              saved formation, which still drives the shape server-side. */}
          <Pitch players={pitchPlayers} formation={formation}
            captainId={captainId} viceCaptainId={viceId}
            onPlayerClick={selectPlayer} swapSource={swapSource} swapTargets={targets}
            onAddPosition={editing && ordered.length < 15 ? setAddPosition : undefined}
            squadSlots={!hasSquad}
            canAddStarting={editing && ordered.length < 15}
            pointsFor={(p) => lastGamePointsFor({ league_player_id: p.id })}
            pointsLabel={t('Last game points')} />

          {(hasSquad || editing) && <div className="bench-strip">
            <div className="bench-head"><h3>{t('Bench')}</h3></div>
            <div className="bench-players">
              {benchPlayers.length === 0 && <small>{t('No substitutes yet.')}</small>}
              {benchPlayers.map((p) => (
                <button type="button" className={`bench-player ${targets.includes(p.league_player_id) ? 'swap-target' : ''} ${swapSource && !targets.includes(p.league_player_id) ? 'swap-dim' : ''}`} key={p.league_player_id} disabled={!!swapSource && !targets.includes(p.league_player_id)} aria-label={`${t(swapSource ? 'Select swap player' : 'Player details')}: ${p.name}`} onClick={() => { const player = allPlayers.find(x => x.id === p.league_player_id); if (player) selectPlayer(player); }}>
                  <Avatar name={p.name} image={p.image_url ?? undefined} size="sm" />
                  <strong>{p.name}</strong>
                  <small>{p.position} · {lastGamePointsFor(p) != null ? `${lastGamePointsFor(p)} ${t('pts')}` : '—'}</small>
                </button>
              ))}
              {editing && ordered.length >= 11 && ordered.length < 15 && (['GK', 'DEF', 'MID', 'FWD'] as Position[]).flatMap(pos => {
                const remainingAtPosition = Math.max(0, limits[pos] - ordered.filter(p => p.position === pos).length);
                const slots = Math.min(remainingAtPosition, 15 - ordered.length, 4 - benchPlayers.length);
                return Array.from({ length: slots }, (_, index) => (
                  <button type="button" className="bench-player bench-add" key={`${pos}-${index}`} aria-label={`${t('Add bench player')}: ${pos}`} disabled={!!swapSource || !live.league?.market_open} onClick={() => setAddPosition(pos)}>
                    <span>+</span><strong>{pos}</strong>
                  </button>
                ));
              })}
            </div>
          </div>}
        </div>
      </fieldset>

      {/* Mode switches never change the saved order: they only enable or hide edit
          controls. The market action is therefore unavailable in read-only View mode. */}
      <div className="squad-actions">
        <button type="button" className="button button-outline" disabled={locked} onClick={() => {
          const next = !editing;
          setEditing(next);
          if (!next) {
            setSelectedId(''); setSwapSource(''); setAddPosition(undefined);
            setFormation((squad?.formation as Formation) ?? '4-3-3');
          }
        }}>
          {t(editing ? 'View squad' : 'Edit squad')}
        </button>
        {editing && live.league.market_open && <Link className="button" to="/market"><UserPlus size={15} /> {t('Add players')}</Link>}
      </div>
      {editing && (
        <section className="panel section-spacer lineup-save-panel">
          <SectionHead eyebrow="THE LINEUP" title="Save lineup changes" />
          {lineupSaveBlockers.length > 0 && <ul className="lineup-save-blockers" role="status">{lineupSaveBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
          <button type="button" className="button" disabled={locked || lineupSaveBlockers.length > 0}
            onClick={() => void run('lineup-save', () => save(ids), 'Lineup saved.', () => rememberOrder(ids))}>
            {busy === 'lineup-save' ? t('Saving…') : t('Save lineup')}
          </button>
        </section>
      )}

      {/* The standalone formation selector and extra captaincy panel are not on this
          screen. Formation is still stored server-side; captaincy is available from
          each player's detail sheet and can be saved before the squad is complete.
          The remaining panel carries status and selling controls. */}
      {hasSquad && editing && (
        <div className="panel section-spacer">
          <SectionHead eyebrow="THE LINEUP" title="Squad status" />
          <div className="validation-panel" role="status">
            <span>{badgeText(squad?.status, t)}</span>
          </div>

          <div className="formation-select">
            <label>{t('Sell a player')}
              <select aria-label={t('Sell a player')} value={outPlayer} disabled={locked}
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
              <button className="button button-outline" disabled={locked}
                onClick={() => void run('sell', () => live.sell(outPlayer), 'Player sold.', () => setOutPlayer(''))}>
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
          busy={locked}
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
      {live.error && <ErrorNote message={live.error} />}

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
