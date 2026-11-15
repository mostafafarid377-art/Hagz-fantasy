// Live squad builder and transfer market.
//
// The position distribution (2 GK / 5 DEF / 5 MID / 3 FWD), the 15-player cap,
// the budget and the formation rules are all enforced by the database. This screen
// shows the same checks *before* the user acts, but it never assumes they passed:
// a refused save is displayed with the server's own message.
//
// Starters are the first 11 entries of the lineup array and the bench is the last
// 4 - the same convention ff_lineup_save() validates server-side.

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AlertCircle, Check, Star, UserMinus, UserPlus } from 'lucide-react';
import { Avatar, Badge, Empty, PageTitle, SectionHead } from '../../components/UI';
import { formatMoney } from '../../utils/format';
import { useLive } from '../../hooks/useLive';
import { ErrorNote, Loading, PartialDataNote, Success } from './League';
import { formations, limits } from '../../services/rules';
import type { ApiSquadPlayer } from '../../types/api';
import type { Formation, Position } from '../../types';

const FORMATIONS = Object.keys(formations) as Formation[];

export function LiveSquad({ builder = false, transfers = false }: { builder?: boolean; transfers?: boolean }) {
  const { t } = useTranslation();
  const live = useLive();
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

  const counts = useMemo(() => {
    const result: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    for (const p of players) result[p.position] += 1;
    return result;
  }, [players]);

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
  const starters = ordered.slice(0, 11);
  const bench = ordered.slice(11);

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
  return (
    <>
      <PageTitle eyebrow="YOUR TEAM" title={builder ? 'Squad Builder' : 'My Squad'}
        description={`${ordered.length}/15 · ${formatMoney(remaining)} ${t('remaining')}`}>
        <Link className="button button-outline" to="/transfers">{t('Make a transfer')}</Link>
      </PageTitle>

      {live.error && <ErrorNote message={live.error} />}
      {error && <p className="error" role="alert"><AlertCircle size={14} /> {error}</p>}
      <Success message={notice} />

      <div className="stat-grid">
        {(['GK', 'DEF', 'MID', 'FWD'] as Position[]).map((position) => (
          <div className="stat-card" key={position}>
            <div className="stat-top"><span>{position}</span></div>
            <div className="stat-number">{counts[position]}<small>/{limits[position]}</small></div>
            <div className="stat-foot">{t('Position limit')}</div>
          </div>
        ))}
      </div>

      {ordered.length === 0 ? (
        <Empty title="Your squad is empty" description="Add players from the league market to build your 15."
          to="/market" action="Player Market" />
      ) : (
        <>
          <div className="panel section-spacer">
            <SectionHead eyebrow="THE LINEUP" title="Starting XI and bench"
              action="Player Market" to="/market" />
            <div className="validation-panel" role="status">
              <span>{badgeText(squad?.status, t)}</span>
            </div>

            <h3 className="roster-heading">{t('Starting lineup')}</h3>
            <div className="roster">
              {starters.map((p) => (
                <RosterRow key={p.league_player_id} player={p} t={t}
                  isCaptain={captain === p.league_player_id}
                  isVice={vice === p.league_player_id}
                  onCaptain={() => setCaptain(p.league_player_id === captain ? null : p.league_player_id)}
                  onVice={() => setVice(p.league_player_id === vice ? null : p.league_player_id)}
                  onSell={() => void run(`sell-${p.league_player_id}`, () => live.sell(p.league_player_id), 'Player sold.')}
                  busy={busy === `sell-${p.league_player_id}`} />
              ))}
            </div>

            <h3 className="roster-heading">{t('Substitutes')} ({bench.length}/4)</h3>
            <div className="roster">
              {bench.length === 0 && <small>{t('No substitutes yet.')}</small>}
              {bench.map((p) => (
                <RosterRow key={p.league_player_id} player={p} t={t}
                  isCaptain={captain === p.league_player_id}
                  isVice={vice === p.league_player_id}
                  onCaptain={() => setCaptain(p.league_player_id === captain ? null : p.league_player_id)}
                  onVice={() => setVice(p.league_player_id === vice ? null : p.league_player_id)}
                  onSell={() => void run(`sell-${p.league_player_id}`, () => live.sell(p.league_player_id), 'Player sold.')}
                  busy={busy === `sell-${p.league_player_id}`} />
              ))}
            </div>
          </div>

          <div className="panel section-spacer">
            <SectionHead eyebrow="THE FORMATION" title="Formation and captaincy" />
            <div className="formation-select">
              <label>{t('Formation')}
                <select value={formation} onChange={(e) => setFormation(e.target.value as Formation)}>
                  {FORMATIONS.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </label>
            </div>
            <p className="section-description">
              {t('Captain and vice captain must be different players from your squad.')}
            </p>
            <div className="sheet-captains">
              <div className={`button button-outline ${captain ? 'is-selected' : ''}`}>
                {t('Captain')}: {ordered.find((p) => p.league_player_id === captain)?.name ?? t('Not set')}
              </div>
              <div className={`button button-outline ${vice ? 'is-selected' : ''}`}>
                {t('Vice captain')}: {ordered.find((p) => p.league_player_id === vice)?.name ?? t('Not set')}
              </div>
            </div>
            <p className="sheet-note">
              {t('Use the star buttons on each player row to set the captain (C) and vice captain (V).')}
            </p>
            <div className="confirm-lineup">
              <button className="button button-outline" disabled={busy === 'save'} onClick={() => void save()}>
                {busy === 'save' ? t('Saving…') : t('Save draft lineup')}
              </button>
              <button className="button" disabled={busy === 'confirm' || !squad?.lineup_id} onClick={() => void confirm()}>
                <Check size={15} /> {busy === 'confirm' ? t('Confirming…') : t('Confirm lineup')}
              </button>
            </div>
          </div>
        </>
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

function RosterRow({ player, t, isCaptain, isVice, onCaptain, onVice, onSell, busy }: {
  player: ApiSquadPlayer; t: (key: string) => string;
  isCaptain: boolean; isVice: boolean;
  onCaptain: () => void; onVice: () => void; onSell: () => void; busy: boolean;
}) {
  return (
    <div className="roster-row">
      <Avatar name={player.name} image={player.image_url ?? undefined} size="sm" />
      <div>
        <strong>{player.name}</strong>
        <small>{player.position} · {formatMoney(player.price)}</small>
      </div>
      <div className="roster-buttons">
        <button className={`captain-button ${isCaptain ? 'is-selected' : ''}`} title={t('Captain')}
          aria-label={`${t('Captain')}: ${player.name}`} onClick={onCaptain}>
          <Star size={14} fill={isCaptain ? 'currentColor' : 'none'} />
        </button>
        <button className={`captain-button ${isVice ? 'is-selected' : ''}`} title={t('Vice captain')}
          aria-label={`${t('Vice captain')}: ${player.name}`} onClick={onVice}>
          V
        </button>
        <button className="tiny-button" title={t('Sell player')} aria-label={`${t('Sell player')}: ${player.name}`}
          disabled={busy} onClick={onSell}>
          <UserMinus size={14} />
        </button>
      </div>
      {(isCaptain || isVice) && <Badge kind="lime">{isCaptain ? 'C' : 'V'}</Badge>}
    </div>
  );
}

/** Standings / statistics in live mode. */
export function LiveStandings() {
  const { t } = useTranslation();
  const live = useLive();
  if (live.loading) return <Loading />;
  if (!live.league) return <Empty title="Join or create a league" to="/create-league" action="Create League" />;

  const h2h = live.standings.filter((s) => s.mode === 'head_to_head');
  const totals = live.standings.filter((s) => s.mode === 'fantasy_total');

  return (
    <>
      <PageTitle eyebrow="THE TABLE" title="League Standings"
        description="Head-to-head points decide the table; fantasy points break ties." />
      {live.error && <ErrorNote message={live.error} />}

      {live.standings.length === 0 ? (
        <Empty title="No standings yet"
          description="Standings are calculated from approved results. No result has been approved in this league yet." />
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('Rank')}</th><th>{t('TEAM')}</th><th>{t('Manager')}</th>
                <th>{t('H2H points')}</th><th>{t('Fantasy points')}</th>
              </tr>
            </thead>
            <tbody>
              {(h2h.length ? h2h : totals).map((row, index) => (
                <tr key={`${row.team_id}-${row.mode}`}>
                  <td>{String(index + 1).padStart(2, '0')}</td>
                  <td><strong>{row.team_name}</strong></td>
                  <td>{row.manager_name}</td>
                  <td>{row.h2h_points ?? '—'}</td>
                  <td><strong className="lime">{row.fantasy_points}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="notice">
        {t('Win = 3 points, draw = 1, loss = 0. Fantasy points are a tie-break, never the ranking itself.')}
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
