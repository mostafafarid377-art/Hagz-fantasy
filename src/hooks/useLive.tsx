// Live, Supabase-backed data for the current league.
//
// This provider is the real counterpart to useDemo(). It deliberately exposes the
// same *concepts* the screens already use (league, players, squad, suggestions,
// members, role) so the UI does not fork into two implementations that drift.
//
// Design decisions worth stating:
//   * Every mutation calls the API and then reloads the affected slice. The server
//     is the source of truth; we never optimistically invent state the database
//     has not confirmed, because the database is where the rules are enforced.
//   * Errors are kept, not swallowed: a refused action surfaces in the UI instead
//     of silently doing nothing.
//   * The selected league persists in localStorage so a reload keeps context.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '../services/api';
import { leaguePoints, EMPTY_POINTS, type PointsSnapshot } from '../services/points';
import { ApiError } from '../services/api';
import type { ApiMatch, ApiMember, ApiNotification, ApiPlayer, ApiSquad, ApiStanding, ApiSuggestion, ApiTransfer, MatchFormat } from '../types/api';
import type { Bootstrap } from '../services/api';

const LEAGUE_KEY = 'ff-live-league';

export interface LiveState {
  loading: boolean;
  leagueId: string | null;
  leagues: Bootstrap['leagues'];
  members: ApiMember[];
  players: ApiPlayer[];
  squad: ApiSquad | null;
  suggestions: ApiSuggestion[];
  gameweeks: Array<{ id: string; number: number; deadline: string; season_id: string; season_name: string; rules_pinned: boolean }>;
  matches: ApiMatch[];
  transfers: ApiTransfer[];
  standings: ApiStanding[];
  notifications: ApiNotification[];
  /**
   * Official points, kept as TWO separate figures. `lastGame` is the latest
   * approved match only; `season` is the approved season total. The UI must use the
   * matching one and never substitute. See services/points.ts for why a deployment
   * without the read API reports 'unavailable' instead of zeros.
   */
  points: PointsSnapshot;
  error: string | null;
  /**
   * Reads that failed while the rest of the screen loaded. Non-empty means the
   * numbers on screen are incomplete - the UI must say so rather than imply the
   * league is empty. See the `safe()` comment in load().
   */
  partialFailures: string[];
}

interface LiveContextValue extends LiveState {
  league: Bootstrap['leagues'][number] | null;
  isLeader: boolean;
  isOrganizer: boolean;
  myUserId: string | null;
  selectLeague: (id: string) => void;
  reload: () => Promise<void>;
  /** League actions */
  createLeague: (name: string, format?: MatchFormat) => Promise<void>;
  joinLeague: (code: string) => Promise<void>;
  setMarketOpen: (open: boolean) => Promise<void>;
  /** Archive the current league; it disappears from every screen. Leader-only. */
  archiveLeague: () => Promise<void>;
  setMember: (userId: string, role?: 'leader' | 'manager', status?: 'active' | 'inactive') => Promise<void>;
  setOrganizer: (userId: string, enabled: boolean) => Promise<void>;
  transferLeadership: (userId: string) => Promise<void>;
  /** Market + suggestions */
  savePlayer: (input: api.UpsertPlayerInput) => Promise<void>;
  setSquadCaptains: (captainId: string | null, viceCaptainId: string | null) => Promise<void>;
  suggestPlayer: (input: Parameters<typeof api.submitSuggestion>[1]) => Promise<void>;
  suggestPlayers: (items: api.SuggestionInput[]) => Promise<void>;
  reviewSuggestion: (id: string, decision: 'approved' | 'rejected', opts?: Parameters<typeof api.reviewSuggestion>[3]) => Promise<void>;
  /** Squad */
  buy: (marketPlayerId: string) => Promise<void>;
  sell: (marketPlayerId: string) => Promise<void>;
  transfer: (outId: string, inId: string) => Promise<void>;
  saveLineup: (input: Omit<Parameters<typeof api.saveLineup>[1], 'gameweekId'> & { gameweekId?: string }) => Promise<void>;
  saveSquadAssignments: (input: api.SquadAssignmentsInput) => Promise<void>;
  substituteSquadPlayer: (outId: string, inId: string, expectedRevision?: number | null) => Promise<void>;
  confirmLineup: (lineupId: string) => Promise<void>;
  /** Competition + matches */
  createSeason: (name: string, startsAt: string, endsAt: string, count: number) => Promise<void>;
  refreshMatches: (signal?: AbortSignal) => Promise<ApiMatch[]>;
  markNotificationRead: (id: string) => Promise<void>;
}

const LiveContext = createContext<LiveContextValue | null>(null);

const message = (error: unknown): string =>
  error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'Something went wrong';

export function LiveProvider({ userId, children }: { userId: string | null; children: ReactNode }) {
  const [state, setState] = useState<LiveState>({
    loading: true, leagueId: null, leagues: [], members: [], players: [], squad: null,
    suggestions: [], gameweeks: [], matches: [], transfers: [], standings: [], notifications: [],
    points: EMPTY_POINTS,
    error: null, partialFailures: [],
  });
  const generation = useRef(0);
  const matchesRefreshGeneration = useRef(0);

  const load = useCallback(async (leagueId: string | null) => {
    const mine = ++generation.current;
    matchesRefreshGeneration.current += 1;
    commit((s) => ({ ...s, loading: true, error: null }));
    try {
      const boot = await api.bootstrap();
      const usable = boot.leagues.filter((l) => !l.archived);
      const chosen = leagueId && usable.some((l) => l.league_id === leagueId)
        ? leagueId
        : usable[0]?.league_id ?? null;

      if (!chosen) {
        if (mine !== generation.current) return;
        commit({
          loading: false, leagueId: null, leagues: usable, members: [], players: [], squad: null,
          suggestions: [], gameweeks: [], matches: [], transfers: [], standings: [], notifications: [],
          points: EMPTY_POINTS,
          error: null, partialFailures: [],
        });
        return;
      }

      // Load the league slice in parallel. One slow or broken read must not blank
      // the entire screen, so each slice falls back to an empty value - BUT the
      // failure is recorded and surfaced. Swallowing these silently is dangerous:
      // if RLS or a grant is wrong, every read returns "permission denied", and a
      // silent fallback renders "0 players / 0 members / no fixtures" - the UI then
      // states as fact that the user has an empty league. Live mode must never
      // present fake emptiness as real data.
      const failures: string[] = [];
      const safe = async <T,>(label: string, promise: Promise<T>, fallback: T): Promise<T> => {
        try {
          return await promise;
        } catch (error) {
          failures.push(`${label}: ${error instanceof Error ? error.message : 'failed'}`);
          return fallback;
        }
      };
      const [members, players, squad, suggestions, gameweeks, matches, transfers, standings, notifications] =
        await Promise.all([
          safe('members', api.leagueMembers(chosen), []),
          safe('players', api.marketPlayers(chosen, { includeInactive: true }), []),
          safe('squad', api.squad(chosen), null),
          safe('suggestions', api.suggestions(chosen), []),
          safe('gameweeks', api.gameweeks(chosen), []),
          safe('matches', api.matches(chosen), []),
          safe('transfers', api.transfers(chosen), []),
          safe('standings', api.standings(chosen), []),
          safe('notifications', api.notifications(chosen), []),
        ]);

      if (mine !== generation.current) return;
      commit({
        loading: false, leagueId: chosen, leagues: usable, members, players, squad,
        suggestions, gameweeks, matches, transfers, standings, notifications, points: EMPTY_POINTS,
        error: null,
        partialFailures: failures,
      });
      try { localStorage.setItem(LEAGUE_KEY, chosen); } catch { /* private mode */ }

      // Points load AFTER the rest of the screen. They are the one read that may be
      // slow or absent on a deployment without official scoring, and the dashboard
      // must not sit on a spinner waiting for them. A failure here never clears the
      // data already rendered: it only marks the points figures unavailable.
      try {
        const snapshot = await leaguePoints(chosen);
        if (mine !== generation.current) return;
        commit((current) => ({ ...current, points: snapshot }));
      } catch (error) {
        if (mine !== generation.current) return;
        commit((current) => ({
          ...current,
          points: { ...EMPTY_POINTS, error: error instanceof Error ? error.message : 'points unavailable' },
        }));
      }
    } catch (error) {
      if (mine !== generation.current) return;
      commit((s) => ({ ...s, loading: false, error: message(error) }));
    }
  }, []);

  useEffect(() => {
    let initial: string | null = null;
    try { initial = localStorage.getItem(LEAGUE_KEY); } catch { /* ignore */ }
    void load(initial);
  }, [load, userId]);

  const leagueId = state.leagueId;

  // The latest state, readable from callbacks created in an earlier render (the
  // context memo closes over `state` and would otherwise compare the newly created
  // league against a stale list).
  //
  // The ref is written by `commit` at the moment state is set, NOT mirrored in a
  // useEffect: an effect runs after the render, so `createLeague`'s post-reload
  // check would read the list from before the reload - precisely the stale read
  // the check exists to avoid.
  const stateRef = useRef(state);
  const commit = useCallback((next: LiveState | ((previous: LiveState) => LiveState)) => {
    stateRef.current = typeof next === 'function' ? next(stateRef.current) : next;
    setState(stateRef.current);
  }, []);

  // Refresh just the match slice after match actions. Calling `load()` here sets
  // the provider-wide loading flag, unmounting MatchWorkflow and discarding its
  // inline success/error state. Keep the open workflow mounted while replacing
  // matches with the server-confirmed read model.
  const refreshMatches = useCallback(async (signal?: AbortSignal): Promise<ApiMatch[]> => {
    const selectedLeague = leagueId;
    if (!selectedLeague) return [];
    const request = ++matchesRefreshGeneration.current;
    const matches = await api.matches(selectedLeague, { signal });
    // Match reads cover the whole league. If responses arrive out of order, an
    // older in-flight request must not replace newer match details or make an
    // action verify against a different/stale match snapshot.
    if (request !== matchesRefreshGeneration.current) {
      return stateRef.current.leagueId === selectedLeague ? stateRef.current.matches : matches;
    }
    if (stateRef.current.leagueId !== selectedLeague) return matches;
    commit((current) => ({ ...current, matches }));
    return matches;
  }, [leagueId, commit]);

  /**
   * Run a mutation, then refresh. `failure` is returned rather than thrown so
   * callers can render inline errors; the refresh still happens because a partial
   * server-side change is possible for some actions (e.g. a correction).
   */
  const mutate = useCallback(async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
      await load(leagueId);
    } catch (error) {
      commit((s) => ({ ...s, error: message(error) }));
      throw error;
    }
  }, [leagueId, load]);

  const selectLeague = useCallback((id: string) => { void load(id); }, [load]);

  const league = state.leagues.find((l) => l.league_id === leagueId) ?? null;
  const isLeader = league?.is_leader ?? false;
  const isOrganizer = league?.is_organizer ?? false;

  const value = useMemo<LiveContextValue>(() => ({
    ...state,
    league, isLeader, isOrganizer, myUserId: userId,
    selectLeague,
    reload: () => load(leagueId),
    createLeague: async (name, format = '11-a-side') => {
      const created = await api.createLeague(name, undefined, format);
      // Reload, then VERIFY. The RPC can succeed while the league never becomes
      // visible - a missing league_members row, an archived league, or a bootstrap
      // that does not list it - and the old code reported success regardless, so
      // the form just sat there with no error and no new league. Silence that looks
      // like success is the worst outcome for a create action, so confirm it.
      await load(created.id);
      const visible = stateRef.current.leagues.some((l) => l.league_id === created.id);
      if (!visible) {
        // `invalidState` is the closest existing code: the request succeeded but
        // the resulting state is not usable, which is exactly this case.
        throw new ApiError(
          'invalidState',
          'The league was created but could not be loaded. Please reload the page.',
        );
      }
    },
    joinLeague: async (code) => {
      const joined = await api.joinLeague(code);
      await load(joined.id);
    },
    setMarketOpen: (open) => mutate(() => api.setMarket(require(leagueId), open)),
    archiveLeague: async () => {
      const target = require(leagueId);
      await api.archiveLeague(target);
      // Reload without the archived league and let `load` pick another one; the
      // archived row still appears in bootstrap with archived=true, and `usable`
      // filters it out, so reselecting it is impossible.
      await load(null);
    },
    setMember: (userId2, role, status) => mutate(() => api.setMember(require(leagueId), userId2, role, status)),
    setOrganizer: (userId2, enabled) => mutate(() => api.setOrganizer(require(leagueId), userId2, enabled)),
    transferLeadership: (userId2) => mutate(() => api.transferLeadership(require(leagueId), userId2)),
    savePlayer: (input) => mutate(() => api.upsertMarketPlayer(require(leagueId), input)),
    setSquadCaptains: (captainId, viceCaptainId) => mutate(() => api.setSquadCaptains(require(leagueId), captainId, viceCaptainId)),
    suggestPlayer: (input) => mutate(() => api.submitSuggestion(require(leagueId), input)),
    suggestPlayers: (items) => mutate(() => api.submitSuggestionBatch(require(leagueId), items)),
    reviewSuggestion: (id, decision, opts) => mutate(() => api.reviewSuggestion(require(leagueId), id, decision, opts)),
    buy: (id) => mutate(() => api.buyPlayer(require(leagueId), id)),
    sell: (id) => mutate(() => api.sellPlayer(require(leagueId), id)),
    transfer: (outId, inId) => mutate(() => api.transferPlayer(require(leagueId), outId, inId)),
    saveLineup: (input) => mutate(() => api.saveLineup(require(leagueId), {
      ...input,
      gameweekId: input.gameweekId ?? state.gameweeks[0]?.id ?? '',
    })),
    saveSquadAssignments: (input) => mutate(() => api.saveSquadAssignments(require(leagueId), {
      ...input,
      expectedRevision: input.expectedRevision ?? state.squad?.assignment_revision ?? null,
    })),
    substituteSquadPlayer: (outId, inId, expectedRevision) =>
      mutate(() => api.substituteSquadPlayer(require(leagueId), outId, inId,
        expectedRevision ?? state.squad?.assignment_revision ?? null)),
    confirmLineup: (id) => mutate(() => api.confirmLineup(require(leagueId), id)),
    createSeason: (name, startsAt, endsAt, count) =>
      mutate(() => api.createSeason(require(leagueId), name, startsAt, endsAt, count)),
    refreshMatches,
    markNotificationRead: (id) => mutate(() => api.markNotificationRead(id)),
  }), [state, league, isLeader, isOrganizer, userId, selectLeague, load, leagueId, mutate, refreshMatches]);

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

function require(id: string | null): string {
  if (!id) throw new ApiError('invalidState', 'Select a league first');
  return id;
}

export function useLive(): LiveContextValue {
  const value = useContext(LiveContext);
  if (!value) throw new Error('LiveProvider required');
  return value;
}

/**
 * The live context, or `null` when no `LiveProvider` is mounted.
 *
 * `AppLayout` wraps every route - demo and live - but `LiveProvider` only exists
 * for a signed-in user (see `LiveData` in main.tsx), so the layout cannot call
 * `useLive()`. It still needs the live league list for the sidebar selector,
 * which previously read the DEMO leagues and therefore showed leagues the user
 * never created. This accessor lets chrome shared by both modes read live data
 * when it exists and fall back otherwise, without throwing.
 */
export function useLiveOptional(): LiveContextValue | null {
  return useContext(LiveContext);
}
