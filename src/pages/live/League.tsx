// Live dashboard, league overview, and league management.
//
// Everything here renders from server data (useLive). Loading, empty and error
// states are explicit: a leader with no league must see "create one", not a
// blank panel, and a refused action must say why.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertCircle, ArrowUpRight, CalendarDays, Check, Copy, Loader2, Share2, Shield, Trash2, Trophy, UsersRound, X, Zap,
} from 'lucide-react';
import { Avatar, Badge, Empty, PageTitle, SectionHead } from '../../components/UI';
import { Pitch } from '../Dashboard';
import { formatCompactMoney } from '../../utils/format';
import { useLive } from '../../hooks/useLive';
import { useAuth } from '../../hooks/useAuth';
import type { Formation } from '../../types';

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
  const squadSize = live.squad?.players?.length ?? 0;
  const budgetLeft = (live.squad?.budget ?? 0) - (live.squad?.spent ?? 0);

  // The demo's four cards are LEAGUE RANK / SQUAD VALUE / IN THE BANK / total points.
  // The first three are all derivable from live data, so the live cards use the same
  // labels and order instead of SQUAD / BUDGET LEFT / MEMBERS / MATCHES.
  //
  // The fourth is the exception: demo shows LAST GAME POINTS, but a live squad player
  // has no points field, so there is no honest per-gameweek figure to show. The card
  // reports the season fantasy total where the standings provide one and renders an
  // em dash otherwise, rather than inventing a number.
  const myStanding = live.myUserId
    ? live.standings.find((row) => row.manager_id === live.myUserId)
    : undefined;

  // LAST GAME POINTS and TOTAL SEASON POINTS are deliberately separate figures read
  // from separate fields of the points snapshot (services/points.ts). The last-game
  // figure only ever describes the most recent officially approved match; the season
  // figure sums every approved match. Neither falls back to the other.
  const points = live.points;
  const lastGamePoints = points.state === 'ready' ? points.lastGame : null;
  const seasonPoints = points.state === 'ready' ? points.season : null;
  const myTeamForPoints = live.squad?.team?.id;
  const myLastGame = myTeamForPoints ? lastGamePoints?.byTeam[myTeamForPoints] : undefined;
  const mySeasonPoints = myTeamForPoints && seasonPoints?.byTeam[myTeamForPoints] !== undefined
    ? seasonPoints.byTeam[myTeamForPoints]
    : myStanding?.fantasy_points;
  /**
   * Top performers ranks the SQUAD by total season points. It previously showed the
   * three most expensive... no: the three first players in the market, labelled
   * "IN FORM", ranked by nothing at all, with the RATING printed where the points
   * belong. Ranking is by season points, and a player without an official score is
   * excluded rather than shown as 0.
   */
  const topPerformers = (seasonPoints
    ? [...(live.squad?.players ?? [])]
        .map((p) => ({ player: p, points: seasonPoints.byPlayer[p.league_player_id] }))
        .filter((row): row is { player: typeof row.player; points: number } => row.points !== undefined)
        .sort((a, b) => b.points - a.points)
        .slice(0, 3)
    : []);
  const myRank = myStanding
    ? [...live.standings].sort((a, b) => (b.fantasy_points ?? 0) - (a.fantasy_points ?? 0))
        .findIndex((row) => row.team_id === myStanding.team_id) + 1
    : 0;
  const squadValue = live.squad?.spent ?? 0;

  // The table, ranked by fantasy points only - the same rule as /standings.
  const ranked = [...live.standings].sort((a, b) =>
    (b.fantasy_points ?? 0) - (a.fantasy_points ?? 0) || a.team_name.localeCompare(b.team_name));
  const myTeamId = live.squad?.team?.id;

  // The pitch takes the demo Pitch component, which is typed against the demo
  // Player shape. Map the live squad onto it, using league_player_id as the id so
  // click handlers keep referring to the market row.
  const pitchPlayers = (live.squad?.players ?? []).slice(0, 11).map((p) => ({
    id: p.league_player_id, leagueId: live.leagueId ?? '', name: p.name,
    position: p.position, price: p.price, rating: p.rating,
    attributes: { pace: 0, shooting: 0, passing: 0, defending: 0, physical: 0 },
    image: p.image_url ?? undefined, active: p.active, points: 0, color: '#a9b9a5',
  }));

  /**
   * The home page mirrors the demo dashboard's structure deliberately.
   *
   * Live and demo previously looked like different products: live was four bare
   * stat cards plus a text panel, demo was a welcome row, a hero, a pitch and a
   * two-column dashboard. A user switching between the two should see the same
   * page with different data, so the layout, section order and headings now match.
   *
   * Where live has no data for a panel, the panel is omitted or says so - it is
   * never filled with placeholder figures.
   */
  return (
    <>
      <PartialDataNote failures={live.partialFailures} onRetry={() => void live.reload()} />

      <div className="welcome-row">
        <div>
          <div className="eyebrow"><span className="live-dot" /> {t('YOUR LEAGUE')} <span className="slash">/</span> {live.league.name}</div>
          <h1>{t('Welcome back')}, {(auth.profile?.display_name ?? '').split(' ')[0] || t('there')} <span>✌</span></h1>
          <p>{t('Ready for another gameweek?')}</p>
        </div>
        <Link to="/league" className="button button-outline desktop-only">
          <Shield size={16} /> {t('View league')} <ArrowUpRight size={15} />
        </Link>
      </div>

      {/* The demo home shows a hero between the welcome row and the notice; live
          went straight from the greeting to a paragraph, which is a large part of
          why the two home pages did not feel like the same product. */}
      <section className="hero">
        <div className="hero-content">
          <div className="hero-kicker"><span /> {t('THE GAME IS BETTER TOGETHER')}</div>
          <h2>{t('Your friends.')}<br />{t('Your team.')} <em>{t('Your league.')}</em></h2>
          <p>{t('Build your dream squad from the friends you play with. The bragging rights are real.')}</p>
          <Link to="/squad" className="button">{t('Build your squad')} <ArrowUpRight size={16} /></Link>
        </div>
        <div className="hero-index">01 / 03 <span>━━━━</span></div>
        <div className="hero-watermark">FF.</div>
      </section>

      <p className="notice dashboard-notice">
        {t('Live data from your league. Only approved results count towards points.')}
      </p>

      <div className="overview-heading">
        <SectionHead eyebrow="YOUR LEAGUE" title="Team overview" />
        <span>{t('Your season at a glance')}</span>
      </div>
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-top"><span>{t('LEAGUE RANK')}</span><div className="stat-icon"><Trophy size={17} /></div></div>
          <div className="stat-number">{myRank ? String(myRank).padStart(2, '0') : '—'}</div>
          <div className="stat-foot">{myRank ? `${t('of')} ${live.standings.length} ${t('teams')}` : t('No standings yet')}</div>
          <div className="stat-number-bg">01</div>
        </div>
        <div className="stat-card">
          <div className="stat-top"><span>{t('SQUAD VALUE')}</span><div className="stat-icon"><UsersRound size={17} /></div></div>
          <div className="stat-number">{formatCompactMoney(squadValue)}</div>
          <div className="stat-foot">{squadSize}/15 {t('players')}</div>
          <div className="stat-number-bg">02</div>
        </div>
        <div className="stat-card">
          <div className="stat-top"><span>{t('IN THE BANK')}</span><div className="stat-icon"><Shield size={17} /></div></div>
          <div className="stat-number">{formatCompactMoney(budgetLeft)}</div>
          <div className="stat-foot">{t('Budget remaining')}</div>
          <div className="stat-number-bg">03</div>
        </div>
        <div className="stat-card">
          {/* LAST GAME POINTS: the latest APPROVED match only, never a season total. */}
          <div className="stat-top"><span>{t('LAST GAME POINTS')}</span><div className="stat-icon"><Zap size={17} /></div></div>
          <div className="stat-number">
            {points.state === 'no-approved-match' || (points.state === 'ready' && !lastGamePoints)
              ? '—'
              : myLastGame !== undefined
                ? <>{myLastGame} <small>{t('pts')}</small></>
                : '—'}
          </div>
          <div className="stat-foot">
            {points.state === 'unavailable' && t('Scoring is not available yet')}
            {points.state === 'no-approved-match' && t('No approved match yet')}
            {/* An approved result exists but no official scores have been produced for
                it. Saying so is the only honest option: a dash would read as "no
                match", and a 0 would read as "played, scored nothing". */}
            {points.state === 'ready' && points.awaitingScoring
              && t('Result approved · scores pending')}
            {points.state === 'ready' && !points.awaitingScoring && lastGamePoints?.matchLabel
              && <>{lastGamePoints.matchLabel}</>}
          </div>
          <div className="stat-number-bg">04</div>
        </div>
        <div className="stat-card">
          {/* TOTAL POINTS: the whole approved season. This is the ranking input. */}
          <div className="stat-top"><span>{t('TOTAL POINTS')}</span><div className="stat-icon"><Trophy size={17} /></div></div>
          <div className="stat-number">{mySeasonPoints !== undefined ? <>{mySeasonPoints} <small>{t('pts')}</small></> : '—'}</div>
          <div className="stat-foot">
            {points.state === 'unavailable'
              ? t('Scoring is not available yet')
              : t('Season total from approved matches')}
          </div>
          <div className="stat-number-bg">05</div>
        </div>
      </div>

      <div className="dashboard-grid">
        <section className="panel squad-panel">
          {/* Editing a live squad means going to the market to add players. It used to
              link to /squad-builder, which in live mode re-rendered the squad screen
              itself, so the button appeared to do nothing. */}
          <SectionHead eyebrow="YOUR TEAM" title="Your starting XI" action="Edit squad" to="/market" />
          <div className="panel-subline">
            <span>{t(live.squad?.status === 'confirmed' ? 'Confirmed lineup' : 'Draft lineup')}</span>
            <span className="formation">{t('FORMATION')} <strong>{live.squad?.formation ?? '—'}</strong></span>
          </div>
          {pitchPlayers.length > 0 ? (
            // showPoints is off: a live squad player carries no points field, so the
            // pitch would print "0 pts" for everyone, which reads as a real zero.
            <Pitch players={pitchPlayers} formation={(live.squad?.formation ?? '4-3-3') as Formation}
              showPoints={false} />
          ) : (
            <Empty title="Your squad is empty"
              description="Add players from the league market to build your 15."
              to="/market" action="Player Market" />
          )}
          <div className="pitch-footer">
            <span><i /> {t('Starting XI')}</span>
            <Link to="/squad">{t('View squad')} <ArrowUpRight size={15} /></Link>
          </div>
        </section>

        <div className="dashboard-right">
          <section className="panel fixture-panel">
            <SectionHead eyebrow="UP NEXT" title="Next fixture" action="View fixtures" to="/fixtures" />
            {nextMatch ? (
              <div className="match-card">
                <div className="match-tag"><span className="live-dot" /> {new Date(nextMatch.starts_at).toLocaleString()}</div>
                <div className="match-teams">
                  <div>
                    <div className="team-crest crest-lime"><Shield size={26} /></div>
                    <strong>{nextMatch.team_a}</strong>
                  </div>
                  <div className="versus">VS</div>
                  <div>
                    <div className="team-crest crest-orange"><Shield size={26} /></div>
                    <strong>{nextMatch.team_b}</strong>
                  </div>
                </div>
                {nextMatch.venue && (
                  <div className="match-info"><span>{nextMatch.venue}</span></div>
                )}
              </div>
            ) : (
              <Empty title="No fixtures yet" description="Fixtures appear here once a match is scheduled."
                to="/fixtures" action="View fixtures" />
            )}
          </section>

          <section className="panel standings-panel">
            <SectionHead eyebrow="THE TABLE" title="League standings" action="View all" to="/standings" />
            {ranked.length > 0 ? (
              <div className="mini-table">
                <div className="mini-head"><span>#</span><span>{t('TEAM')}</span><span>{t('Fantasy pts')}</span></div>
                {ranked.slice(0, 4).map((row, i) => (
                  <div className={`mini-row ${row.team_id === myTeamId ? 'my-row' : ''}`} key={row.team_id}>
                    <span className="rank">{String(i + 1).padStart(2, '0')}</span>
                    <div className="mini-team">
                      <div className={`mini-crest c${i}`}><Shield size={14} /></div>
                      <strong>{row.team_name}</strong>
                    </div>
                    <strong>{row.fantasy_points}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <Empty title="No standings yet"
                description="Standings are calculated from approved results." to="/standings" action="View all" />
            )}
          </section>
        </div>
      </div>

      <div className="lower-grid">
        <section className="panel performers">
          <SectionHead eyebrow="TOP PERFORMANCE" title="Top performers" action="See all" to="/statistics" />
          <p className="section-description">{t('Ranked by total season points')}</p>
          {topPerformers.length > 0 ? (
            <div className="performer-list">
              {topPerformers.map(({ player, points }, i) => (
                <Link to={`/players/${player.league_player_id}`} className="performer" key={player.league_player_id}>
                  <span className="rank">0{i + 1}</span>
                  <Avatar name={player.name} image={player.image_url ?? undefined} size="sm" />
                  <div><strong>{player.name}</strong><small>{player.position} · {formatCompactMoney(player.price)}</small></div>
                  <div className="performer-points"><strong>{points}</strong><small>{t('pts')}</small></div>
                  <ArrowUpRight size={16} />
                </Link>
              ))}
            </div>
          ) : (
            /* No approved results yet - or no points API on this deployment. Either
               way there is no ranking to show, and printing rating here instead would
               be passing off a different number as a points total. */
            <Empty title="No season points yet"
              description={live.points.state === 'unavailable'
                ? t('Season points appear once official scoring is enabled.')
                : t('Season points appear once a match result is approved.')}
              to="/statistics" action="Statistics" />
          )}
        </section>

        <section className="panel">
          <SectionHead eyebrow="QUICK LINKS" title="Quick actions" />
          {[['Player Market', '/market'], ['Suggest Player', '/suggest'], ['My Squad', '/squad'],
            ['Standings', '/standings'], ['Match Center', '/match-center']].map(([label, to]) => (
            <Link className="settings-row" to={to} key={to}>{t(label)}<ArrowUpRight size={16} /></Link>
          ))}
        </section>
      </div>
    </>
  );
}

/**
 * The league's real invite code, read from the server on mount.
 *
 * Why this is a standalone card and not a row in a "Quick links" panel:
 *   - it is the single most important piece of information on this screen for a
 *     leader trying to get friends in, and it sat at the bottom of a link list
 *     behind a "Show code" button, so on a phone it was below the fold and one tap
 *     of friction away;
 *   - the code is not in the bootstrap payload by design, so it is fetched with
 *     ff_league_code(), which is member-scoped (ff_private.require_member). A
 *     non-member gets 42501 and is shown that refusal - never a placeholder code.
 *
 * Share is offered when the platform supports the Web Share API; the button is not
 * rendered otherwise rather than silently doing nothing.
 */
function InviteCodeCard() {
  const { t } = useTranslation();
  const live = useLive();
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed' | 'denied'>('idle');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setCode('');
    setStatus('idle');
    const leagueId = live.leagueId;
    if (!leagueId) { setLoading(false); return; }
    (async () => {
      try {
        const { leagueCode } = await import('../../services/api');
        const value = await leagueCode(leagueId);
        if (!cancelled) setCode(value);
      } catch (caught) {
        if (!cancelled) {
          // api.ts normalises 42501 (insufficient_privilege) into ApiError('forbidden'),
          // so the SQLSTATE is no longer on the error. Treat both shapes as a refusal:
          // the caller is not allowed to see this code.
          const error = caught as { code?: string; detail?: string; message?: string };
          const refused = error.code === 'forbidden' || error.code === '42501'
            || error.detail === '42501';
          setStatus(refused ? 'denied' : 'failed');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [live.leagueId]);

  async function copy() {
    if (!code) return;
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(code);
      setStatus('copied');
    } catch { setStatus('failed'); }
  }

  async function share() {
    if (!code) return;
    try {
      await navigator.share({
        title: live.league?.name ?? t('Join my league'),
        text: `${t('Join my league on Fantasy Friends with this code')}: ${code}`,
      });
    } catch { /* the user dismissed the share sheet - not an error */ }
  }

  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  return (
    <section className="invite-card panel" aria-labelledby="invite-code-heading">
      <div className="invite-card-head">
        <div>
          <div className="eyebrow">{t('YOUR COMMUNITY')}</div>
          <h2 id="invite-code-heading">{t('Invite your friends')}</h2>
        </div>
        <UsersRound size={20} />
      </div>
      <p className="section-description">
        {t('Share this code so friends can join your league as managers.')}
      </p>

      {loading && <p className="invite-code-loading">{t('Reading the invite code…')}</p>}

      {!loading && status === 'denied' && (
        <p className="error" role="alert">{t('You do not have access to this league\'s invite code.')}</p>
      )}

      {!loading && status !== 'denied' && code && (
        <>
          <div className="invite-code">
            <strong aria-label={t('League code')}>{code}</strong>
            <div className="invite-code-actions">
              <button type="button" className="button button-outline" onClick={() => void copy()}>
                <Copy size={15} /> {t(status === 'copied' ? 'Copied!' : 'Copy code')}
              </button>
              {canShare && (
                <button type="button" className="button button-outline" onClick={() => void share()}>
                  <Share2 size={15} /> {t('Share invitation')}
                </button>
              )}
            </div>
          </div>
          {status === 'failed' && (
            <p className="error" role="alert">{t('Copy failed. Please copy the code manually.')}</p>
          )}
          <p className="notice">{t('This league has its own independent player market.')}</p>
        </>
      )}
    </section>
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
          <p>{live.members.length} {t('Members')} · {formatCompactMoney(live.league.budget)} {t('budget')}</p>
        </div>
        <Badge kind="lime">{live.league.market_open ? t('Market open') : t('Market closed')}</Badge>
      </div>

      {/* Directly under the hero: this is the reason a leader opens this screen, and
          on a phone it must be the first thing below the league name. */}
      <InviteCodeCard />

      <div className="overview-cards">
        <div className="panel"><UsersRound /><small>{t('Members')}</small><strong>{live.members.length}</strong></div>
        <div className="panel"><Trophy /><small>{t('Your role')}</small><strong>{t(live.isLeader ? 'League Leader' : 'Manager')}</strong></div>
        <div className="panel"><CalendarDays /><small>{t('Gameweeks')}</small><strong>{live.gameweeks.length}</strong></div>
        <div className="panel"><Shield /><small>{t('Budget')}</small><strong>{formatCompactMoney(live.league.budget)}</strong></div>
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
  const [format, setFormat] = useState<'11-a-side' | '7-a-side' | '5-a-side'>('11-a-side');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(''); setBusy(true);
    try {
      if (join) await live.joinLeague(code.trim());
      else await live.createLeague(name.trim(), format);
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
        {!join && (
          <label>{t('Match format')}
            <select aria-label={t('Match format')} value={format}
              onChange={(event) => setFormat(event.target.value as typeof format)}>
              <option value="11-a-side">{t('11-a-side')}</option>
              <option value="7-a-side">{t('7-a-side')}</option>
              <option value="5-a-side">{t('5-a-side')}</option>
            </select>
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
