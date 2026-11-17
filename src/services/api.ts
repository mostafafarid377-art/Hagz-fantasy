// Typed access to the reviewed database API.
//
// Every function here maps to exactly one SECURITY DEFINER RPC created by
// migration 012 (supabase/design/api/012_application_api.sql). There is no direct
// table DML anywhere in the client, because `authenticated` holds SELECT only -
// writes that skipped these functions would simply be refused by PostgreSQL.
//
// Two rules this module enforces so callers cannot get them wrong:
//   1. Error normalisation. PostgREST surfaces the SQLSTATE and message; we turn
//      them into a typed ApiError with a stable code so the UI can translate it.
//   2. Idempotency keys. Actions that can be double-submitted from a flaky phone
//      take a request id that the caller generates once and reuses on retry.

import { getSupabase } from '../lib/supabase';
import { withBootstrapDiagnostics } from './bootstrapDiagnostics';
import type {
  ApiLeague, ApiMatch, ApiMember, ApiNotification, ApiPlayer, ApiSquad, ApiStanding, ApiSuggestion, ApiTransfer, MatchFormat,
} from '../types/api';

/** Stable, translatable error codes. `message` is a developer fallback only. */
export type ApiErrorCode =
  | 'notConfigured' | 'notAuthenticated' | 'forbidden' | 'invalidState'
  | 'network' | 'unknown';

export class ApiError extends Error {
  constructor(public code: ApiErrorCode, message: string, public detail?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Map a PostgREST/PostgreSQL failure onto a UI-facing code.
 *   42501 (insufficient_privilege) -> forbidden: the caller is not allowed.
 *   23514 (check_violation)        -> invalidState: the request is not valid now.
 *   42883/42P01                    -> unknown: a function/table is missing, which
 *                                    means the migrations are not applied.
 */
function normalise(error: { code?: string; message?: string } | null): ApiError {
  const message = error?.message ?? 'unknown error';
  const code = error?.code;
  switch (code) {
    case '42501': return new ApiError('forbidden', message, code);
    case '23514': return new ApiError('invalidState', message, code);
    case 'PGRST301':
    case '401': return new ApiError('notAuthenticated', message, code);
    default:
      if (/jwt|token|session/i.test(message)) return new ApiError('notAuthenticated', message, code);
      if (/fetch|network|Failed to fetch/i.test(message)) return new ApiError('network', message, code);
      return new ApiError('unknown', message, code);
  }
}

/**
 * Call one RPC. `fn` is the database function name; arguments are passed
 * positionally by name so a signature change fails loudly rather than silently
 * binding the wrong value.
 */
type RpcOptions = { signal?: AbortSignal };
type ReadOptions = RpcOptions & { timeoutMs?: number };

/** Bound reads so a stalled mobile/network request cannot leave the app on a spinner forever. */
const DEFAULT_READ_TIMEOUT_MS = 15_000;

async function read<T>(fn: string, args: Record<string, unknown> = {}, options: ReadOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ApiError('network', `${fn} did not respond within ${timeoutMs} ms`, 'timeout'));
    }, timeoutMs);
  });
  try {
    // The race is intentional as a final guard even if an underlying fetch
    // implementation ignores AbortSignal. Supabase receives the signal too, so
    // supported clients also cancel the stalled network request itself.
    return await Promise.race([call<T>(fn, args, { signal: controller.signal }), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

async function call<T>(fn: string, args: Record<string, unknown> = {}, options: RpcOptions = {}): Promise<T> {
  const supabase = getSupabase();
  if (!supabase) throw new ApiError('notConfigured', 'Supabase is not configured');

  const request = supabase.rpc(fn, args);
  const query = options.signal && typeof request.abortSignal === 'function'
    ? request.abortSignal(options.signal)
    : request;
  const { data, error } = await query;
  if (error) {
    const normalised = normalise(error);
    if (normalised.code === 'unknown') {
      console.error(`[fantasy-friends] ${fn} failed:`, error);
    }
    throw normalised;
  }
  return data as T;
}

/** As `call`, but rewrites SQLSTATEs into the codes the UI translates. */
export const rpc = call;

// ---------------------------------------------------------------------------
// Session / profiles
// ---------------------------------------------------------------------------

export interface Bootstrap {
  profile: { id: string; display_name: string };
  leagues: Array<{
    league_id: string; name: string; role: 'leader' | 'manager'; status: string;
    budget: number; market_open: boolean; archived: boolean; match_format?: MatchFormat;
    is_leader: boolean; is_organizer: boolean;
  }>;
}

export const bootstrap = (displayName?: string, options: ReadOptions = {}) =>
  withBootstrapDiagnostics(() => read<Bootstrap>('ff_bootstrap', { p_display_name: displayName ?? null }, options));

export const updateProfile = (displayName: string) =>
  call<{ id: string; display_name: string }>('ff_update_profile', { p_display_name: displayName });

// ---------------------------------------------------------------------------
// Leagues
// ---------------------------------------------------------------------------

export const createLeague = (name: string, budget = 100000000, format: MatchFormat = '11-a-side') =>
  call<{ id: string; name: string; budget: number; market_open: boolean; code: string; match_format: MatchFormat }>(
    'ff_league_create', { p_name: name, p_budget: budget, p_format: format });

export const leagueCode = (leagueId: string) =>
  call<string>('ff_league_code', { p_league: leagueId });

export const joinLeague = (code: string) =>
  call<ApiLeague>('ff_league_join', { p_code: code });

export const leagueMembers = (leagueId: string, options: ReadOptions = {}) =>
  read<ApiMember[]>('ff_league_members', { p_league: leagueId }, options);

export const setMember = (leagueId: string, userId: string, role?: 'leader' | 'manager', status?: 'active' | 'inactive') =>
  call<{ user_id: string; role: string; status: string; team_id: string | null }>(
    'ff_league_set_member',
    { p_league: leagueId, p_user: userId, p_role: role ?? null, p_status: status ?? null });

export const transferLeadership = (leagueId: string, to: string) =>
  call<{ leader_id: string }>('ff_league_transfer_leadership', { p_league: leagueId, p_to: to });

/**
 * Archive ("delete") a league. Leader-only, checked server-side.
 *
 * This is an archive, not a row delete: every FK to `leagues` is `on delete
 * restrict`, so a hard delete would have to cascade across ~15 tables and destroy
 * other managers' squads and audit history. `ff_bootstrap` reports `archived`, and
 * useLive filters archived leagues out, so from the app's point of view the league
 * is gone - while an operator can still recover it.
 */
export const archiveLeague = (leagueId: string) =>
  call<{ id: string; archived: boolean }>('ff_league_archive', { p_league: leagueId });

export const setMarket = (leagueId: string, open: boolean) =>
  call<{ market_open: boolean }>('ff_league_set_market', { p_league: leagueId, p_open: open });

export const setOrganizer = (leagueId: string, userId: string, enabled: boolean) =>
  call<{ user_id: string; organizer: boolean }>(
    'ff_league_set_organizer', { p_league: leagueId, p_user: userId, p_enabled: enabled });

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

export interface UpsertPlayerInput {
  name: string; position: 'GK' | 'DEF' | 'MID' | 'FWD'; price: number; rating: number;
  active?: boolean; imagePath?: string | null; imageUrl?: string | null;
  /** player_profiles.id when editing, omitted when creating. */
  playerId?: string | null;
}

export const setSquadCaptains = (leagueId: string, captainId: string | null, viceCaptainId: string | null) =>
  call<{ captain_id: string | null; vice_captain_id: string | null }>('ff_squad_set_captains', {
    p_league: leagueId, p_captain: captainId, p_vice: viceCaptainId,
  });

export const upsertMarketPlayer = (leagueId: string, input: UpsertPlayerInput) =>
  call<ApiPlayer>('ff_market_upsert_player', {
    p_league: leagueId,
    p_name: input.name,
    p_position: input.position,
    p_price: input.price,
    p_rating: input.rating,
    p_active: input.active ?? true,
    p_image_path: input.imagePath ?? null,
    p_image_url: input.imageUrl ?? null,
    p_player_id: input.playerId ?? null,
  });

export const marketPlayers = (leagueId: string, opts: { search?: string; position?: string; includeInactive?: boolean } = {}, options: ReadOptions = {}) =>
  read<ApiPlayer[]>('ff_market_players', {
    p_league: leagueId,
    p_search: opts.search ?? null,
    p_position: opts.position ?? null,
    p_include_inactive: opts.includeInactive ?? false,
  }, options);

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

export const submitSuggestion = (leagueId: string, input: {
  name: string; position: 'GK' | 'DEF' | 'MID' | 'FWD'; notes?: string;
  imagePath?: string | null; imageUrl?: string | null;
}) => call<ApiSuggestion>('ff_suggestion_submit', {
  p_league: leagueId, p_name: input.name, p_position: input.position,
  p_notes: input.notes ?? null, p_image_path: input.imagePath ?? null,
  p_image_url: input.imageUrl ?? null,
});

export type SuggestionInput = {
  name: string; position: 'GK' | 'DEF' | 'MID' | 'FWD'; notes?: string;
  imagePath?: string | null; imageUrl?: string | null;
};

export const submitSuggestionBatch = (leagueId: string, items: SuggestionInput[]) =>
  call<ApiSuggestion[]>('ff_suggestion_submit_batch', {
    p_league: leagueId,
    p_items: items.map((item) => ({
      name: item.name, position: item.position, notes: item.notes ?? null,
      image_path: item.imagePath ?? null, image_url: item.imageUrl ?? null,
    })),
  });

export const transfers = (leagueId: string, limit = 100, options: ReadOptions = {}) =>
  read<ApiTransfer[]>('ff_transfers', { p_league: leagueId, p_limit: limit }, options);

export const suggestions = (leagueId: string, status?: 'pending' | 'approved' | 'rejected', options: ReadOptions = {}) =>
  read<ApiSuggestion[]>('ff_suggestions', { p_league: leagueId, p_status: status ?? null }, options);

export const reviewSuggestion = (leagueId: string, suggestionId: string, decision: 'approved' | 'rejected', opts: {
  reason?: string; price?: number; rating?: number; imagePath?: string | null;
} = {}) => call<ApiSuggestion>('ff_suggestion_review', {
  p_league: leagueId, p_suggestion: suggestionId, p_decision: decision,
  p_reason: opts.reason ?? null, p_price: opts.price ?? null,
  p_rating: opts.rating ?? null, p_image_path: opts.imagePath ?? null,
});

// ---------------------------------------------------------------------------
// Squad
// ---------------------------------------------------------------------------

export const squad = (leagueId: string, options: ReadOptions = {}) => read<ApiSquad>('ff_squad', { p_league: leagueId }, options);

export interface SquadAssignmentsInput {
  starters: string[];
  bench: string[];
  unassigned: string[];
  captainId: string | null;
  viceCaptainId: string | null;
  gameweekId?: string | null;
  expectedRevision?: number | null;
}

export const saveSquadAssignments = (leagueId: string, input: SquadAssignmentsInput) =>
  call<{ squad: ApiSquad; lineup: Record<string, unknown> | null; assignment_revision: number }>(
    'ff_squad_save_assignments', {
      p_league: leagueId,
      p_starters: input.starters,
      p_bench: input.bench,
      p_unassigned: input.unassigned,
      p_captain: input.captainId,
      p_vice: input.viceCaptainId,
      p_gameweek: input.gameweekId ?? null,
      p_expected_revision: input.expectedRevision ?? null,
    });

export const substituteSquadPlayer = (leagueId: string, outId: string, inId: string, expectedRevision?: number | null) =>
  call<{ squad: ApiSquad; assignment_revision: number; replayed?: boolean }>(
    'ff_squad_substitute', {
      p_league: leagueId, p_out: outId, p_in: inId, p_expected_revision: expectedRevision ?? null,
    });

export const buyPlayer = (leagueId: string, marketPlayerId: string) =>
  call<{ league_player_id: string; price: number; squad_size: number; spent: number }>(
    'ff_squad_buy', { p_league: leagueId, p_league_player: marketPlayerId });

export const sellPlayer = (leagueId: string, marketPlayerId: string) =>
  call<{ league_player_id: string; refund: number }>(
    'ff_squad_sell', { p_league: leagueId, p_league_player: marketPlayerId });

export const transferPlayer = (leagueId: string, outId: string, inId: string) =>
  call<{ out: string; in: string; spent: number }>(
    'ff_squad_transfer', { p_league: leagueId, p_out: outId, p_in: inId });

export const saveLineup = (leagueId: string, input: {
  gameweekId: string; formation: string; playerIds: string[];
  captainId: string | null; viceCaptainId: string | null;
}) => call<{ lineup_id: string; version: number; formation: string; status: string }>('ff_lineup_save', {
  p_league: leagueId, p_gameweek: input.gameweekId, p_formation: input.formation,
  p_player_ids: input.playerIds, p_captain: input.captainId, p_vice: input.viceCaptainId,
});

export const confirmLineup = (leagueId: string, lineupId: string) =>
  call<{ lineup_id: string; status: string }>('ff_lineup_confirm', { p_league: leagueId, p_lineup: lineupId });

// ---------------------------------------------------------------------------
// Competition
// ---------------------------------------------------------------------------

export const gameweeks = (leagueId: string, options: ReadOptions = {}) =>
  read<Array<{ id: string; number: number; deadline: string; season_id: string; season_name: string; rules_pinned: boolean }>>(
    'ff_gameweeks', { p_league: leagueId }, options);

export const createSeason = (leagueId: string, name: string, startsAt: string, endsAt: string, gameweekCount: number) =>
  call<{ id: string; name: string; gameweeks: Array<{ id: string; number: number; deadline: string }> }>(
    'ff_season_create',
    { p_league: leagueId, p_name: name, p_starts: startsAt, p_ends: endsAt, p_gameweeks: gameweekCount });

export const createFixture = (leagueId: string, gameweekId: string, home: string, away: string) =>
  call<{ id: string; home_team_id: string; away_team_id: string }>(
    'ff_fixture_create', { p_league: leagueId, p_gameweek: gameweekId, p_home: home, p_away: away });

export const standings = (leagueId: string, seasonId?: string, options: ReadOptions = {}) =>
  read<ApiStanding[]>('ff_standings', { p_league: leagueId, p_season: seasonId ?? null }, options);

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const notifications = (leagueId?: string, limit = 50, options: ReadOptions = {}) =>
  read<ApiNotification[]>('ff_notifications', { p_league: leagueId ?? null, p_limit: limit }, options);

export const markNotificationRead = (id: string) =>
  call<{ id: string; read_at: string }>('ff_notification_read', { p_notification: id });

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

export const createRealTeam = (leagueId: string, name: string) =>
  call<{ id: string; name: string }>('ff_tournament_create', { p_league: leagueId, p_name: name });

export const realTeams = (leagueId: string) =>
  call<Array<{ id: string; name: string; active: boolean }>>('ff_real_teams', { p_league: leagueId });

export const createMatch = (leagueId: string, input: {
  gameweekId?: string | null; teamA: string; teamB: string; organizerId: string;
  startsAt: string; venue: string; startersPerSide?: number; maxSubstitutes?: number;
}) => call<{ id: string; starts_at: string; organizer_id: string }>('ff_match_create', {
  p_league: leagueId, p_gameweek: input.gameweekId ?? null, p_team_a: input.teamA, p_team_b: input.teamB,
  p_organizer: input.organizerId, p_starts_at: input.startsAt, p_venue: input.venue,
  p_starters_per_side: input.startersPerSide ?? 11, p_max_substitutes: input.maxSubstitutes ?? 4,
});

export const matches = (leagueId: string, options: ReadOptions = {}) =>
  read<ApiMatch[]>('ff_matches', { p_league: leagueId }, options);

export const openRevision = (leagueId: string, matchId: string) =>
  call<{ id: string; version: number; state: string }>('ff_match_open_revision', { p_league: leagueId, p_match: matchId });

export const saveMatchLineups = (leagueId: string, revisionId: string, teamAPlayers: Array<{
  player_id: string; selection: 'starter' | 'substitute'; actual_position: 'GK' | 'DEF' | 'MID' | 'FWD';
  eligibility_kind?: 'registered' | 'temporary' | 'market'; eligibility_evidence?: Record<string, unknown>;
}>, teamBPlayers: Array<{
  player_id: string; selection: 'starter' | 'substitute'; actual_position: 'GK' | 'DEF' | 'MID' | 'FWD';
  eligibility_kind?: 'registered' | 'temporary' | 'market'; eligibility_evidence?: Record<string, unknown>;
}>, options: RpcOptions = {}) => call<{ revision_id: string; team_a: { lineup_id: string; players: number }; team_b: { lineup_id: string; players: number }; saved: true }>(
  'ff_match_save_lineups', { p_league: leagueId, p_revision: revisionId, p_team_a_players: teamAPlayers, p_team_b_players: teamBPlayers }, options);

export const cancelMatch = (leagueId: string, matchId: string, reason: string) =>
  call<{ id: string; cancelled: true; cancelled_at: string; reason: string }>(
    'ff_match_cancel', { p_league: leagueId, p_match: matchId, p_reason: reason });

export const setMatchLineup = (leagueId: string, revisionId: string, teamId: string, players: Array<{
  player_id: string; selection: 'starter' | 'substitute'; actual_position: 'GK' | 'DEF' | 'MID' | 'FWD';
  eligibility_kind?: 'registered' | 'temporary' | 'market'; eligibility_evidence?: Record<string, unknown>;
}>) => call<{ lineup_id: string; players: number }>(
  'ff_match_set_lineup', { p_league: leagueId, p_revision: revisionId, p_team: teamId, p_players: players });

export const submitMatchLineup = (leagueId: string, revisionId: string, options: RpcOptions = {}) =>
  call<{ submission_id: string; approval_id?: string; state: 'submitted' | 'approved' | 'rejected' }>(
    'ff_match_submit_lineup', { p_league: leagueId, p_revision: revisionId }, options);

export const forkResult = (leagueId: string, approvalId: string, requestId: string) =>
  call<{ revision_id: string; request_id: string }>(
    'ff_match_fork_result', { p_league: leagueId, p_approval: approvalId, p_request_id: requestId });

export const setMatchScore = (leagueId: string, revisionId: string, a: number, b: number) =>
  call<{ revision_id: string; team_a_score: number; team_b_score: number }>(
    'ff_match_set_score', { p_league: leagueId, p_revision: revisionId, p_a: a, p_b: b });

export const recordMatchEvent = (leagueId: string, revisionId: string, playerId: string, type: string, opts: {
  minute?: number | null; relatedPlayerId?: string | null; quantity?: number; details?: Record<string, unknown>;
} = {}) => call<{ event_id: string; type: string }>('ff_match_record_event', {
  p_league: leagueId, p_revision: revisionId, p_player: playerId, p_type: type,
  p_minute: opts.minute ?? null, p_related: opts.relatedPlayerId ?? null,
  p_quantity: opts.quantity ?? 1, p_details: opts.details ?? {},
});

export const submitMatchResult = (leagueId: string, revisionId: string, lineupApprovalId: string) =>
  call<{ submission_id: string; official_result_id: string; revision_id: string; state: 'official'; finalized_by: string; finalized_at: string }>('ff_match_submit_result',
    { p_league: leagueId, p_revision: revisionId, p_lineup_approval: lineupApprovalId });

export const reviewMatchSubmission = (leagueId: string, submissionId: string, decision: 'approved' | 'rejected', reason?: string) =>
  call<{ approval_id: string; decision: string }>('ff_match_review_submission',
    { p_league: leagueId, p_submission: submissionId, p_decision: decision, p_reason: reason ?? null });

export const openCorrection = (leagueId: string, matchId: string, reason: string) =>
  call<{ draft_revision_id: string }>('ff_match_open_correction',
    { p_league: leagueId, p_match: matchId, p_reason: reason });
