// Points: two DIFFERENT numbers that must never be confused.
//
//   lastGamePoints    - what a player's owners earned in the most recently
//                       COMPLETED, officially APPROVED match of the selected
//                       league/season. Nothing else qualifies: not a pending
//                       result, not an unapproved submission, not a future fixture.
//   totalSeasonPoints - the sum of official points across every approved match in
//                       the season. This backs the Top Performance ranking.
//
// They are loaded by separate queries and stored in separate fields, so a display
// bug cannot silently substitute one for the other.
//
// Why this reads tables instead of calling an RPC
// -----------------------------------------------
// The database deliberately exposes no scoring RPC: migration 014 asserts that no
// client-callable function may produce fantasy points, and writes to
// match_player_performances / fantasy_score_items / fantasy_scores are blocked
// outright ("scoring calculation not implemented; writes blocked"). That is a
// WRITE restriction only.
//
// The READ path already exists and needs no backend change:
//   * 002_security.sql grants members `league_read` SELECT policies on
//     official_match_results, match_player_performances, fantasy_scores and gameweeks;
//   * 009_ownership_and_grants.sql re-grants `select` to authenticated on all of them.
// So the client can read approved results and any points rows that exist, and RLS
// guarantees it only ever sees its own league. No new SQL is required, and none was
// applied.
//
// Consequence: until positional scoring values are approved and a run produces rows,
// an approved match has no score items. That state is reported as
// `awaitingScoring` - an honest "the result is approved, scores are not calculated
// yet" - never as a zero and never as a season total.

import { getSupabase } from '../lib/supabase';

export interface PlayerPoints {
  /** league_player_id -> points */
  byPlayer: Record<string, number>;
  /** fantasy_team_id -> points */
  byTeam: Record<string, number>;
  /** The match the figures came from. */
  matchId: string;
  /** Human label, e.g. "Gameweek 3". */
  matchLabel: string | null;
  /** ISO timestamp of the match, when known. */
  playedAt: string | null;
}

export type PointsState =
  /** No client, or the reads failed. Nothing is shown and nothing is faked. */
  | 'unavailable'
  /** The league/season has no officially approved match yet. */
  | 'no-approved-match'
  /** Real figures. `lastGame.byPlayer` may be empty while scoring is pending. */
  | 'ready';

export interface PointsSnapshot {
  state: PointsState;
  /** Latest officially approved match only. */
  lastGame: PlayerPoints | null;
  /** Official season totals, summed over approved matches only. */
  season: PlayerPoints | null;
  /**
   * True when an approved match exists but no official scores have been produced for
   * it yet. The UI must say so rather than render a dash that looks like a zero.
   */
  awaitingScoring: boolean;
  /** Populated when state === 'unavailable'. */
  error: string | null;
}

export const EMPTY_POINTS: PointsSnapshot = {
  state: 'unavailable', lastGame: null, season: null, awaitingScoring: false, error: null,
};

interface OfficialRow { id: string; match_id: string; revision_id: string }
interface MatchRow { id: string; gameweek_id: string; starts_at: string }
interface GameweekRow { id: string; season_id: string; number: number }
interface PerformanceRow { id: string; player_id: string; played: boolean }
interface ScoreItemRow { performance_id: string; points: number | string; fantasy_lineup_id: string }
interface LineupRow { id: string; fantasy_team_id: string }
interface LeaguePlayerRow { id: string; player_id: string }

const num = (value: number | string | null | undefined): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Sum official score items into per-league-player and per-fantasy-team totals.
 *
 * `items` is keyed by performance; a performance maps to the real-life player, and a
 * league_player row maps that player into this league. Points are summed as stored -
 * the captain x2 multiplier is already baked into `points` by the scoring run
 * (check constraint: points = base_points * multiplier), so applying it again here
 * would double-count it.
 */
function aggregate(
  items: ScoreItemRow[],
  perfs: PerformanceRow[],
  lineups: LineupRow[],
  leaguePlayers: LeaguePlayerRow[],
): { byPlayer: Record<string, number>; byTeam: Record<string, number> } {
  const perfById = new Map(perfs.map((row) => [row.id, row]));
  const lineupTeam = new Map(lineups.map((row) => [row.id, row.fantasy_team_id]));
  const leaguePlayerByPlayer = new Map(leaguePlayers.map((row) => [row.player_id, row.id]));

  const byPlayer: Record<string, number> = {};
  const byTeam: Record<string, number> = {};

  for (const item of items) {
    const perf = perfById.get(item.performance_id);
    if (!perf) continue;
    const points = num(item.points);
    const leaguePlayerId = leaguePlayerByPlayer.get(perf.player_id);
    if (leaguePlayerId) byPlayer[leaguePlayerId] = (byPlayer[leaguePlayerId] ?? 0) + points;
    const teamId = lineupTeam.get(item.fantasy_lineup_id);
    if (teamId) byTeam[teamId] = (byTeam[teamId] ?? 0) + points;
  }
  return { byPlayer, byTeam };
}

/**
 * Load official points for one league (optionally one season).
 *
 * Every query is RLS-scoped to leagues the caller belongs to; a non-member simply
 * receives no rows. Failures throw, so a permission or network problem surfaces as
 * an error on screen instead of looking like "no points".
 */
export async function leaguePoints(leagueId: string, seasonId?: string | null, signal?: AbortSignal): Promise<PointsSnapshot> {
  const supabase = getSupabase();
  if (!supabase) return { ...EMPTY_POINTS, error: 'Supabase is not configured' };

  const fail = (message: string): PointsSnapshot => ({ ...EMPTY_POINTS, error: message });
  const cancellable = <T extends { abortSignal(signal: AbortSignal): T }>(query: T) => signal
    ? query.abortSignal(signal) : query;

  // --- 1. Officially approved, current results ------------------------------
  const officials = await cancellable(supabase
    .from('official_match_results')
    .select('id,match_id,revision_id')
    .eq('league_id', leagueId)
    .eq('is_current', true));
  if (officials.error) return fail(officials.error.message);
  const officialRows = (officials.data ?? []) as OfficialRow[];
  if (officialRows.length === 0) {
    return { state: 'no-approved-match', lastGame: null, season: null, awaitingScoring: false, error: null };
  }

  // --- 2. Their matches (for the real kick-off time) and gameweeks ----------
  const matchIds = [...new Set(officialRows.map((row) => row.match_id))];
  const matches = await cancellable(supabase
    .from('real_matches')
    .select('id,gameweek_id,starts_at')
    .eq('league_id', leagueId)
    .in('id', matchIds));
  if (matches.error) return fail(matches.error.message);
  const matchRows = (matches.data ?? []) as MatchRow[];
  if (matchRows.length === 0) {
    return { state: 'no-approved-match', lastGame: null, season: null, awaitingScoring: false, error: null };
  }

  const gameweekIds = [...new Set(matchRows.map((row) => row.gameweek_id))];
  const gameweeks = await cancellable(supabase
    .from('gameweeks')
    .select('id,season_id,number')
    .eq('league_id', leagueId)
    .in('id', gameweekIds));
  if (gameweeks.error) return fail(gameweeks.error.message);
  const gameweekRows = (gameweeks.data ?? []) as GameweekRow[];
  const gameweekById = new Map(gameweekRows.map((row) => [row.id, row]));

  // A match only counts once it has actually happened. An approved result for a
  // future kick-off would be a data error; excluding it here means a last-game
  // figure can never describe a match that has not been played.
  const now = Date.now();
  const completed = matchRows.filter((row) => {
    const at = Date.parse(row.starts_at);
    return Number.isFinite(at) ? at <= now : false;
  });
  if (completed.length === 0) {
    return { state: 'no-approved-match', lastGame: null, season: null, awaitingScoring: false, error: null };
  }

  // Season scoping uses the gameweek, which is where season membership lives.
  const inSeason = seasonId
    ? completed.filter((row) => gameweekById.get(row.gameweek_id)?.season_id === seasonId)
    : completed;
  const scoped = inSeason.length > 0 ? inSeason : (seasonId ? [] : completed);

  const latest = [...scoped].sort((a, b) => Date.parse(b.starts_at) - Date.parse(a.starts_at))[0];
  if (!latest) {
    return { state: 'no-approved-match', lastGame: null, season: null, awaitingScoring: false, error: null };
  }

  const officialForMatch = new Map(officialRows.map((row) => [row.match_id, row]));

  // --- 3. Score items, for the latest match and for the whole season --------
  type ItemBatch = { items: ScoreItemRow[]; perfs: PerformanceRow[]; error: string | null };
  const loadItems = async (resultIds: string[]): Promise<ItemBatch> => {
    if (resultIds.length === 0) return { items: [], perfs: [], error: null };

    const { data: perfs, error: perfError } = await cancellable(supabase
      .from('match_player_performances')
      .select('id,player_id,played')
      .eq('league_id', leagueId)
      .in('official_result_id', resultIds));
    if (perfError) return { items: [], perfs: [], error: perfError.message };
    const perfRows = (perfs ?? []) as PerformanceRow[];
    if (perfRows.length === 0) return { items: [], perfs: [], error: null };

    const { data: items, error: itemError } = await cancellable(supabase
      .from('fantasy_score_items')
      .select('performance_id,points,fantasy_lineup_id')
      .eq('league_id', leagueId)
      .in('performance_id', perfRows.map((row) => row.id)));
    if (itemError) return { items: [], perfs: [], error: itemError.message };
    return { items: (items ?? []) as ScoreItemRow[], perfs: perfRows, error: null };
  };

  const NO_ITEMS: ItemBatch = { items: [], perfs: [], error: null };

  const latestOfficial = officialForMatch.get(latest.id);
  const lastItems = latestOfficial ? await loadItems([latestOfficial.id]) : NO_ITEMS;
  if (lastItems.error) return fail(lastItems.error);

  const seasonResultIds = scoped
    .map((row) => officialForMatch.get(row.id)?.id)
    .filter((value): value is string => typeof value === 'string');
  const seasonItems = seasonResultIds.length > 1 ? await loadItems(seasonResultIds) : lastItems;
  if (seasonItems.error) return fail(seasonItems.error);

  // --- 4. Resolve lineups -> teams, and real players -> league players ------
  const allItems = [...lastItems.items, ...seasonItems.items];
  const lineupIds = [...new Set(allItems.map((row) => row.fantasy_lineup_id))];
  let lineupRows: LineupRow[] = [];
  if (lineupIds.length > 0) {
    const { data, error } = await cancellable(supabase
      .from('fantasy_lineups')
      .select('id,fantasy_team_id')
      .eq('league_id', leagueId)
      .in('id', lineupIds));
    if (error) return fail(error.message);
    lineupRows = (data ?? []) as LineupRow[];
  }

  const playerIds = [...new Set([
    ...lastItems.perfs.map((row) => row.player_id),
    ...seasonItems.perfs.map((row) => row.player_id),
  ])];
  let leaguePlayerRows: LeaguePlayerRow[] = [];
  if (playerIds.length > 0) {
    const { data, error } = await cancellable(supabase
      .from('league_players')
      .select('id,player_id')
      .eq('league_id', leagueId)
      .in('player_id', playerIds));
    if (error) return fail(error.message);
    leaguePlayerRows = (data ?? []) as LeaguePlayerRow[];
  }

  const lastAggregate = aggregate(lastItems.items, lastItems.perfs, lineupRows, leaguePlayerRows);
  const seasonAggregate = aggregate(seasonItems.items, seasonItems.perfs, lineupRows, leaguePlayerRows);

  const gameweek = gameweekById.get(latest.gameweek_id);
  return {
    state: 'ready',
    lastGame: {
      ...lastAggregate,
      matchId: latest.id,
      matchLabel: gameweek ? `Gameweek ${gameweek.number}` : null,
      playedAt: latest.starts_at,
    },
    season: { ...seasonAggregate, matchId: latest.id, matchLabel: null, playedAt: null },
    // An approved result with no score items means the run has not happened yet.
    awaitingScoring: lastItems.items.length === 0,
    error: null,
  };
}

/** Points for one league player in the latest approved match, or undefined. */
export function lastGamePointsForPlayer(
  snapshot: PointsSnapshot | null, leaguePlayerId: string,
): number | undefined {
  if (snapshot?.state !== 'ready') return undefined;
  return snapshot.lastGame?.byPlayer[leaguePlayerId];
}

/** Points for one league player across approved matches, or undefined. */
export function seasonPointsForPlayer(
  snapshot: PointsSnapshot | null, leaguePlayerId: string,
): number | undefined {
  if (snapshot?.state !== 'ready') return undefined;
  return snapshot.season?.byPlayer[leaguePlayerId];
}
