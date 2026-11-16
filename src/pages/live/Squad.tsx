// Live squad builder and transfer market.
//
// The position distribution (2 GK / 5 DEF / 5 MID / 3 FWD), the 15-player cap,
// the budget and the formation rules are all enforced by the database. This screen
// shows the same checks *before* the user acts, but it never assumes they passed:
// a refused save is displayed with the server's own message.
//
// Starters are the first 11 entries of the lineup array and the bench is the last
// 4 - the same convention ff_lineup_save() validates server-side.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AlertCircle, Shield, UserMinus, UserPlus } from 'lucide-react';
import { Avatar, Badge, Empty, PageTitle, SectionHead } from '../../components/UI';
import { formatCompactMoney } from '../../utils/format';
import { useLive } from '../../hooks/useLive';
import { ErrorNote, Loading, PartialDataNote, Success } from './League';
import { Pitch } from '../Dashboard';
import { formations, limits, substitutionTargets } from '../../services/rules';
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
    if (saved) setFormation(saved);
    setCaptain(live.squad?.captain_id ?? null);
    setVice(live.squad?.vice_captain_id ?? null);
  }, [live.leagueId, live.squad?.formation, live.squad?.captain_id, live.squad?.vice_captain_id]);
  const [selectedId, setSelectedId] = useState('');
  const [swapSource, setSwapSource] = useState('');
  const [outPlayer, setOutPlayer] = useState('');
  const [inPlayer, setInPlayer] = useState('');
  /** Which position's "+" opened the picker; undefined when it is closed. */
  const [addPosition, setAddPosition] = useState<Position>();
  /** "Edit squad" / "View squad": builder mode for an existing squad. */
  const [editing, setEditing] = useState(builder);

  const squad = live.squad;
  const players = squad?.players ?? [];

  const spent = squad?.spent ?? 0;
  const budget = squad?.budget ?? 0;
  const remaining = budget - spent;

  if (live.loading) return <Loading />;
  if (!live.league) return <Empty title="Join or create a league" to="/create-league" action="Create League" />;

  /** Ordered by slot when a lineup exists, otherwise grouped by position. */
  const ordered = [...players].sort((a, b) => {
    if (a.slot != null && b.slot != null) return a.slot - b.slot;
    const order: Position[] = ['GK', 'DEF', 'MID', 'FWD'];
    return order.indexOf(a.position) - order.indexOf(b.position) || a.name.localeCompare(b.name);
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
    const inOptions = live.players.filter((p) => p.active && !outgoing
      ? live.players.some((q) => q.id === p.id)
      : true).filter((p) => outgoing && p.position === outgoing.position
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
                  {p.name} · {p.position} · {formatCompactMoney(p.price)}
                </option>
              ))}
            </select>
          </label>
          <label>{t('Replacement player')}
            <select value={inPlayer} onChange={(e) => setInPlayer(e.target.value)} disabled={!outgoing}>
              <option value="">{t('Select a player')}</option>
              {inOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.name} · {formatCompactMoney(p.price)}</option>
              ))}
            </select>
          </label>
          {outgoing && (
            <div className="transfer-preview">
              <span>{t('After transfer')}: {formatCompactMoney(remaining + outgoing.price - (inOptions.find((p) => p.id === inPlayer)?.price ?? 0))}</span>
            </div>
          )}
          <button className="button" disabled={!outPlayer || !inPlayer || busy === 'transfer'}
            onClick={() => void run('transfer', async () => {
              await live.transfer(outPlayer, inPlayer);
              setOutPlayer(''); setInPlayer('');
            }, 'Transfer confirmed.')}>
            {busy === 'transfer' ? t('Transferring…') : t('Confirm transfer')}
          </button>
          <Link className="text-link" to="/market">{t('Explore the player market')} →</Link>
        </div>
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
  const pitchPlayers = builder || editing ? allPlayers : allPlayers.slice(0, 11);
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
  const save = (playerIds: string[], captainId: string | null, viceCaptainId: string | null) => live.saveLineup({ gameweekId: squad?.gameweek_id, formation, playerIds, captainId, viceCaptainId });
  function selectPlayer(p: Player) {
    if (!swapSource) { setError(''); setSelectedId(p.id); return; }
    if (!targets.includes(p.id)) return;
    const next = [...ids]; const a = next.indexOf(swapSource), b = next.indexOf(p.id);
    [next[a], next[b]] = [next[b], next[a]];
    // Captaincy must belong to the starting XI.
    void run('lineup', async () => { await save(next, next.slice(0, 11).includes(captain ?? '') ? captain : null, next.slice(0, 11).includes(vice ?? '') ? vice : null); setSwapSource(''); }, 'Players swapped.');
  }

  return (
    <>
      <PageTitle eyebrow="YOUR TEAM" title={builder ? 'Squad Builder' : 'My Squad'}
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
      {!live.league.market_open && <p className="notice">{t('The market is closed.')}</p>}

      {swapSource && <div className="swap-banner" role="status"><strong>{t('Choose a player to swap')}</strong><button type="button" className="button button-outline" onClick={() => setSwapSource('')}>{t('Cancel swap')}</button></div>}
      {selected && <LivePlayerSheet key={selected.id} player={selected} players={marketPlayers} ownedIds={ids} starter={ids.indexOf(selected.id) < 11} captainId={captain} viceId={vice} editing={builder || editing} remaining={remaining} marketOpen={live.league.market_open} canSwap={substitutionTargets(ruleSquad, allPlayers, selected.id).length > 0} busy={!!busy} points={lastGamePointsForPlayer(live.points, selected.id)} error={error} close={() => { setSelectedId(''); setError(''); }} startSwap={() => { setSwapSource(selected.id); setSelectedId(''); }} setCaptain={type => {
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
      }} transfer={id => void run('transfer', async () => { await live.transfer(selected.id, id); setSelectedId(''); }, 'Transfer confirmed.')} />}
      <div className="squad-layout">
        <div className="panel">
          <SectionHead eyebrow="YOUR TEAM" title={hasSquad && !builder ? 'Starting XI' : 'Your squad'} />
          {(!hasSquad || builder) && (
            <p className="section-description">
              {t('Tap an empty position to add a player. The first 11 players are starters.')}
            </p>
          )}
          {/* The formation selector lives in the BUILDER only, matching the demo. It
              was removed from the My Squad tab on request; there the SAVED formation
              still decides the pitch shape and which players are the starting XI. */}
          {builder && (
            <label className="formation-select">{t('Formation')}
              <select aria-label={t('Formation')} value={formation}
                onChange={(e) => setFormation(e.target.value as Formation)}>
                {(Object.keys(formations) as Formation[]).map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
          )}

          {/* An empty squad (or edit mode) shows all 15 capacity places, so every
              position can be filled; otherwise the pitch is the starting XI in the
              saved formation, which still drives the shape server-side. */}
          <Pitch players={pitchPlayers} formation={formation}
            captainId={captainId} viceCaptainId={viceId}
            onPlayerClick={selectPlayer} swapSource={swapSource} swapTargets={targets}
            onAddPosition={setAddPosition}
            squadSlots={!hasSquad || builder || editing}
            canAddStarting={builder || editing || ordered.length < 11}
            pointsFor={(p) => lastGamePointsFor({ league_player_id: p.id })}
            pointsLabel={t('Last game points')} />

          {!builder && !editing && <div className="bench-strip">
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
            </div>
          </div>}
        </div>
      </div>

      {/* Actions BELOW the pitch, as on the demo squad screen.
          "Edit squad" toggles builder mode rather than linking to another route: in
          live mode /squad-builder rendered this same screen, so the button looked
          dead. Builder mode is what makes the pitch span the whole squad (below), so
          the two buttons now do what they say and nothing is lost - /squad-builder
          still works as a direct link. */}
      <div className="squad-actions">
        <button type="button" className="button button-outline" onClick={() => setEditing((value) => !value)}>
          {t(editing ? 'View squad' : 'Edit squad')}
        </button>
        <Link className="button" to="/market"><UserPlus size={15} /> {t('Add players')}</Link>
      </div>

      {/* The standalone formation selector and extra captaincy panel are not on this
          screen. Formation is still stored server-side; captaincy is available from
          each player's detail sheet and can be saved before the squad is complete.
          The remaining panel carries status and selling controls. */}
      {hasSquad && (
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
          onPick={(player) => run('add', () => live.buy(player.id), 'Player added to your squad.')}
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
