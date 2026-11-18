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
  ApiLeague, ApiMatch, ApiMember, ApiNotification, ApiPlayer, ApiSquad, ApiStanding, ApiSuggestion, ApiTransfer,
} from '../types/api';

/** Stable, translatable error codes. `message` is a developer fallback only. */
export type ApiErrorCode =
  | 'notConfigured' | 'notAuthenticated' | 'forbidden' | 'invalidState'
  | 'conflict' | 'outcomeUnknown' | 'network' | 'unknown';

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

/** Bound a request even when its underlying transport does not observe the signal. */
export const REQUEST_DEADLINE_MS = 15_000;

export async function withDeadline<T>(label: string, run: (signal: AbortSignal) => Promise<T>,
  options: ReadOptions = {}, timeoutCode: 'network' | 'outcomeUnknown' = 'network'): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? REQUEST_DEADLINE_MS;
  let rejectCancellation!: (error: ApiError) => void;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
  const abortFromCaller = () => {
    // A cancelled write can still have committed. Never imply rollback.
    rejectCancellation(new ApiError(timeoutCode, `${label} was cancelled.`, 'cancelled'));
    controller.abort();
  };
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // An abort or a missed deadline is not proof that a write rolled back.
      reject(new ApiError(timeoutCode, `${label} did not respond within ${timeoutMs} ms`, 'timeout'));
      controller.abort();
    }, timeoutMs);
  });
  try {
    // Don't start a new operation if it was cancelled before invocation.
    const work = options.signal?.aborted ? cancelled : run(controller.signal);
    return await Promise.race([work, timeout, cancelled]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

const SQUAD_WRITES = new Set([
  'ff_lineup_save', 'ff_lineup_confirm', 'ff_squad_substitute', 'ff_squad_set_captains',
  'ff_squad_buy', 'ff_squad_sell', 'ff_squad_transfer',
]);
const LEAGUE_WRITES = new Set([
  'ff_league_create', 'ff_league_join', 'ff_league_archive', 'ff_league_set_market',
  'ff_league_set_member', 'ff_league_set_organizer', 'ff_league_transfer_leadership',
  'ff_operation_for_actor',
]);
const isGuardedWrite = (fn: string) => SQUAD_WRITES.has(fn) || LEAGUE_WRITES.has(fn);
const gatewayFailure = (status?: number) => status === 502 || status === 503 || status === 504;

async function requestRpc<T>(fn: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const supabase = getSupabase();
  if (!supabase) throw new ApiError('notConfigured', 'Supabase is not configured');
  const write = isGuardedWrite(fn);
  const request = supabase.rpc(fn, args);
  // The locked SDK already doesn't replay RPC POSTs; keep this explicit for
  // write recovery and for bootstrap, which may initialize a profile.
  if ((write || fn === 'ff_bootstrap') && typeof request.retry === 'function') request.retry(false);
  const query = signal && typeof request.abortSignal === 'function' ? request.abortSignal(signal) : request;
  let response: Awaited<typeof query>;
  try {
    response = await query;
  } catch (error) {
    // Normally the SDK reports transport failures as status 0, but a fetch or
    // alternate transport can also reject. Its write outcome is not known.
    if (write) throw new ApiError('outcomeUnknown', 'The server could not confirm the change.', 'transport');
    throw error;
  }
  const { data, error, status } = response;
  if (fn === 'ff_bootstrap' && (status === 504 || error?.code === 'PGRST003')) {
    throw new ApiError('network', 'The server did not respond in time.', error?.code === 'PGRST003' ? error.code : '504');
  }
  if (write && (status === 0 || gatewayFailure(status) || error?.code === 'PGRST003')) {
    throw new ApiError('outcomeUnknown', 'The server could not confirm the change.',
      error?.code === 'PGRST003' ? error.code : status ? String(status) : 'transport');
  }
  if ((SQUAD_WRITES.has(fn) || (fn === 'ff_operation_for_actor' && args.p_action === 'execute')) && error?.code === '40001') {
    throw new ApiError('conflict', error.message, '40001');
  }
  if (error) {
    const normalised = normalise(error);
    if (normalised.code === 'unknown') console.error(`[fantasy-friends] ${fn} failed:`, error);
    throw normalised;
  }
  return data as T;
}

function read<T>(fn: string, args: Record<string, unknown> = {}, options: ReadOptions = {}): Promise<T> {
  return withDeadline(fn, (signal) => requestRpc<T>(fn, args, signal), options);
}

function call<T>(fn: string, args: Record<string, unknown> = {}, options: RpcOptions = {}): Promise<T> {
  return isGuardedWrite(fn)
    ? withDeadline(fn, (signal) => requestRpc<T>(fn, args, signal), options, 'outcomeUnknown')
    : requestRpc<T>(fn, args, options.signal);
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
    budget: number; market_open: boolean; archived: boolean;
    is_leader: boolean; is_organizer: boolean;
  }>;
}

type BootstrapOptions = {
  /** Set only in response to a user's retry action. */
  retry?: boolean;
  /** A membership write just succeeded; an already-running read may predate it. */
  afterPending?: boolean;
};

export interface BootstrapSession {
  load(options?: BootstrapOptions): Promise<Bootstrap>;
  close(): void;
}

/** One shared bootstrap flight and retry gate per sign-in, not per access token. */
export function createBootstrapSession(
  userId: string, { displayName, timeoutMs }: { displayName?: string; timeoutMs?: number } = {},
): BootstrapSession {
  const controller = new AbortController();
  const { signal } = controller;
  let initialName = displayName;
  let inFlight: Promise<Bootstrap> | null = null;
  let nextFlight: Promise<Bootstrap> | null = null;
  let retryRequired: ApiError | null = null;

  // `aborted` works throughout the browser target range; `reason` and
  // `throwIfAborted` are not present on some of those browsers.
  const superseded = () => new ApiError('notAuthenticated', 'The session changed while loading your profile.');
  const load = ({ retry = false, afterPending = false }: BootstrapOptions = {}): Promise<Bootstrap> => {
    if (signal.aborted) return Promise.reject(superseded());
    if (nextFlight) return nextFlight;
    if (inFlight) {
      if (!afterPending) return inFlight;
      // After a successful write, coalesce on the next read, not on a snapshot
      // taken before the write. Do not replay at all if the current read fails.
      nextFlight = inFlight.then(
        () => { nextFlight = null; return load(); },
        (error: unknown) => { nextFlight = null; throw error; },
      );
      return nextFlight;
    }
    if (retryRequired && !retry) return Promise.reject(retryRequired);

    // Publish the flight before calling the SDK or notifying diagnostics. The
    // auth listener does not wait for Supabase work inside its callback.
    inFlight = Promise.resolve().then(async () => {
      if (signal.aborted) throw superseded();
      try {
        const data = await withBootstrapDiagnostics(async () => {
          const result = await read<Bootstrap>(
            'ff_bootstrap', { p_display_name: initialName ?? null }, { signal, timeoutMs },
          );
          if (signal.aborted) throw superseded();
          if (result?.profile?.id !== userId) {
            throw superseded();
          }
          return result;
        });
        initialName = undefined; // Directory refreshes must not reapply signup metadata.
        retryRequired = null;
        return data;
      } catch (error) {
        if (signal.aborted) throw superseded();
        if (error instanceof ApiError && ['PGRST003', '504', 'timeout'].includes(error.detail ?? '')) {
          retryRequired = error;
        }
        throw error;
      }
    }).finally(() => { inFlight = null; });
    return inFlight;
  };

  return { load, close: () => controller.abort() };
}

export const updateProfile = (displayName: string) =>
  call<{ id: string; display_name: string }>('ff_update_profile', { p_display_name: displayName });

// ---------------------------------------------------------------------------
// Leagues
// ---------------------------------------------------------------------------

export const createLeague = (name: string, budget = 100000000) =>
  call<{ id: string; name: string; budget: number; market_open: boolean; code: string }>(
    'ff_league_create', { p_name: name, p_budget: budget });

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
