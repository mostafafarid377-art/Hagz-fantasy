// Live squad builder and transfer market.
//
// The position distribution (2 GK / 5 DEF / 5 MID / 3 FWD), the 15-player cap,
// the budget and the formation rules are all enforced by the database. This screen
// shows the same checks *before* the user acts, but it never assumes they passed:
// a refused save is displayed with the server's own message.
//
// Starters are the first 11 entries of the lineup array and the bench is the last
// 4 - the same convention ff_lineup_save() validates server-side.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { AlertCircle, Check, Shield, Trophy, UserMinus, UserPlus } from 'lucide-react';
import { Avatar, Badge, Empty, PageTitle, SectionHead } from '../../components/UI';
import { formatMoney } from '../../utils/format';
import { useLive } from '../../hooks/useLive';
import { ErrorNote, Loading, PartialDataNote, Success } from './League';
import { Pitch } from '../Dashboard';
import { formations } from '../../services/rules';
import type { Formation, Player, Position } from '../../types';

const FORMATIONS = Object.keys(formations) as Formation[];

export function LiveSquad({ builder = false, transfers = false }: { builder?: boolean; transfers?: boolean }) {
  const { t } = useTranslation();
  const live = useLive();
  const navigate = useNavigate();
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [formation, setFormation] = useState<Formation>(live.squad?.formation ?? '4-3-3');
  const [captain, setCaptain] = useState<string | null>(live.squad?.captain_id ?? null);
  const [vice, setVice] = useState<string | null>(live.squad?.vice_captain_id ?? null);
  const [outPlayer, setOutPlayer] = useState('');
  const [inPlayer, setInPlayer] = useState('');

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

  async function save() {
    if (ordered.length !== 15) { setError(t('Select exactly 15 players.')); return; }
    await run('save', () => live.saveLineup({
      formation, playerIds: ordered.map((p) => p.league_player_id),
      captainId: captain, viceCaptainId: vice,
    }), 'Draft lineup saved.');
  }

  async function confirm() {
    const lineupId = squad?.lineup_id;
    if (!lineupId) { setError(t('Save a draft lineup before confirming it.')); return; }
    if (captain && vice && captain === vice) { setError(t('Captain and vice captain must be different players.')); return; }
    await run('confirm', () => live.confirmLineup(lineupId), 'Lineup confirmed.');
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
                  {p.name} · {p.position} · {formatMoney(p.price)}
                </option>
              ))}
            </select>
          </label>
          <label>{t('Replacement player')}
            <select value={inPlayer} onChange={(e) => setInPlayer(e.target.value)} disabled={!outgoing}>
              <option value="">{t('Select a player')}</option>
              {inOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.name} · {formatMoney(p.price)}</option>
              ))}
            </select>
          </label>
          {outgoing && (
            <div className="transfer-preview">
              <span>{t('After transfer')}: {formatMoney(remaining + outgoing.price - (inOptions.find((p) => p.id === inPlayer)?.price ?? 0))}</span>
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
  // shows. Captain, vice captain and selling moved into a compact panel below the
  // pitch so no control was lost with the list.
  const hasSquad = ordered.length > 0;
  const pitchPlayers: Player[] = ordered.map((p) => ({
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
  const captainId = ordered.find((p) => p.league_player_id === captain) ? (captain ?? undefined) : undefined;
  const viceId = ordered.find((p) => p.league_player_id === vice) ? (vice ?? undefined) : undefined;
  const benchPlayers = ordered.slice(11);

  return (
    <>
      <PageTitle eyebrow="YOUR TEAM" title={builder ? 'Squad Builder' : 'My Squad'}
        description={`${ordered.length}/15 · ${formatMoney(remaining)} ${t('remaining')}`} />

      {live.error && <ErrorNote message={live.error} />}
      {error && <p className="error" role="alert"><AlertCircle size={14} /> {error}</p>}
      <Success message={notice} />
      {!live.league.market_open && <p className="notice">{t('The market is closed.')}</p>}

      <div className="squad-layout">
        <div className="panel">
          <SectionHead eyebrow="YOUR TEAM" title={hasSquad && !builder ? 'Starting XI' : 'Your squad'} />
          {(!hasSquad || builder) && (
            <p className="section-description">
              {t('Tap an empty position to add a player. The first 11 players are starters.')}
            </p>
          )}
          <label className="formation-select">{t('Formation')}
            <select aria-label={t('Formation')} value={formation}
              onChange={(e) => setFormation(e.target.value as Formation)}>
              {FORMATIONS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>

          <Pitch players={pitchPlayers} formation={formation}
            captainId={captainId} viceCaptainId={viceId}
            onAddPosition={() => navigate('/market')}
            squadSlots={!hasSquad || builder}
            canAddStarting={builder || ordered.length < 11}
            showPoints={false} />

          {!builder && <div className="bench-strip">
            <div className="bench-head"><h3>{t('Bench')}</h3></div>
            <div className="bench-players">
              {benchPlayers.length === 0 && <small>{t('No substitutes yet.')}</small>}
              {benchPlayers.map((p) => (
                <div className="bench-player" key={p.league_player_id}>
                  <Avatar name={p.name} image={p.image_url ?? undefined} size="sm" />
                  <strong>{p.name}</strong>
                  <small>{p.position} · {formatMoney(p.price)}</small>
                </div>
              ))}
            </div>
          </div>}
        </div>
      </div>

      {/* Actions BELOW the pitch, as on the demo squad screen. */}
      <div className="squad-actions">
        <Link className="button button-outline" to="/transfers">{t('Make a transfer')}</Link>
        <Link className="button" to="/market"><UserPlus size={15} /> {t('Add players')}</Link>
      </div>

      {hasSquad && (
        <div className="panel section-spacer">
          <SectionHead eyebrow="THE LINEUP" title="Formation and captaincy" />
          <div className="validation-panel" role="status">
            <span>{badgeText(squad?.status, t)}</span>
          </div>

          {/* Captaincy and selling live here now that the roster list is gone. */}
          <div className="formation-select">
            <label>{t('Captain')}
              <select aria-label={t('Captain')} value={captain ?? ''}
                onChange={(e) => setCaptain(e.target.value || null)}>
                <option value="">{t('Not set')}</option>
                {ordered.map((p) => (
                  <option key={p.league_player_id} value={p.league_player_id}>{p.name} · {p.position}</option>
                ))}
              </select>
            </label>
            <label>{t('Vice captain')}
              <select aria-label={t('Vice captain')} value={vice ?? ''}
                onChange={(e) => setVice(e.target.value || null)}>
                <option value="">{t('Not set')}</option>
                {ordered.filter((p) => p.league_player_id !== captain).map((p) => (
                  <option key={p.league_player_id} value={p.league_player_id}>{p.name} · {p.position}</option>
                ))}
              </select>
            </label>
            <label>{t('Sell a player')}
              <select aria-label={t('Sell a player')} value={outPlayer}
                onChange={(e) => setOutPlayer(e.target.value)}>
                <option value="">{t('Select a player')}</option>
                {ordered.map((p) => (
                  <option key={p.league_player_id} value={p.league_player_id}>
                    {p.name} · {p.position} · {formatMoney(p.price)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="confirm-lineup">
            {outPlayer && (
              <button className="button button-outline" disabled={busy === 'sell'}
                onClick={() => void run('sell', async () => {
                  await live.sell(outPlayer);
                  setOutPlayer('');
                }, 'Player sold.')}>
                <UserMinus size={15} /> {busy === 'sell' ? t('Selling…') : t('Sell selected player')}
              </button>
            )}
            <button className="button button-outline" disabled={busy === 'save'} onClick={() => void save()}>
              {busy === 'save' ? t('Saving…') : t('Save draft lineup')}
            </button>
            <button className="button" disabled={busy === 'confirm' || !squad?.lineup_id} onClick={() => void confirm()}>
              <Check size={15} /> {busy === 'confirm' ? t('Confirming…') : t('Confirm lineup')}
            </button>
          </div>
        </div>
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

      {/* The demo standings open with a scoring strip that states the ranking rule.
          Live explained it in a notice at the BOTTOM of the page, where nobody
          reads it before interpreting the table. */}
      <div className="scoring-strip">
        <Trophy size={20} />
        <strong>{t('Ranked by fantasy points')}</strong>
        <small>{t('Equal fantasy points share a rank.')}</small>
      </div>

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

      <p className="notice">
        {t('The table is ranked by fantasy points. Head-to-head results are not part of the ranking.')}
      </p>
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
