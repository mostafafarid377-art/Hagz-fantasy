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

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '../services/api';
import { reserveOperation, readOperation, clearOperation, submitOperation, inspectOperation, cancelOperation, liveReceiptTransport, type PendingOperation, type Receipt } from '../services/operationReceipts';
import { leaguePoints, EMPTY_POINTS, type PointsSnapshot } from '../services/points';
import { ApiError } from '../services/api';
import type { ApiMatch, ApiMember, ApiNotification, ApiPlayer, ApiSquad, ApiStanding, ApiSuggestion, ApiTransfer } from '../types/api';
import type { Bootstrap, BootstrapSession } from '../services/api';

const LEAGUE_KEY = 'ff-live-league';
const EMPTY_LEAGUES: Bootstrap['leagues'] = [];
type SquadChange = 'saving' | 'verifying' | 'refreshing' | 'refreshRequired' | 'reviewRequired';
type SquadAttempt = { phase: SquadChange; operation?: PendingOperation; terminal?: Receipt };

type Directory = Bootstrap['leagues'];
type LeagueChangeKind = 'create' | 'join' | 'archive' | 'settings';
interface LeagueChange {
  kind: LeagueChangeKind;
  phase: 'saving' | 'verifying' | 'verificationRequired';
  acknowledged: boolean;
}
interface LeagueProof {
  leagueId: string;
  check: (entry: Directory[number] | undefined) => boolean;
  checkMembers?: (members: ApiMember[]) => boolean;
}
interface LeagueAttempt extends LeagueChange {
  operation?: PendingOperation;
  proof: LeagueProof | null;
}

const membershipProof = (id: string | undefined): LeagueProof | null => typeof id === 'string' && id.length > 0
  ? { leagueId: id, check: Boolean }
  : null;
const createKey = (userId: string) => `ff-live-pending-create:${userId}`;

// A create has no server idempotency key. Keep only its pending marker and, if
// acknowledged, its returned league ID across reloads in this account's tab.
// Never store an invite code, credentials, or a user's form values here.
function saveCreateReceipt(userId: string, proof?: LeagueProof | null) {
  try {
    if (proof === undefined) sessionStorage.removeItem(createKey(userId));
    else sessionStorage.setItem(createKey(userId), JSON.stringify(proof?.leagueId ?? null));
  } catch { /* In-memory guard still works if storage is unavailable. */ }
}

function restoreCreate(userId: string): LeagueAttempt | null {
  try {
    const stored = sessionStorage.getItem(createKey(userId));
    if (stored === null) return null;
    const proof = membershipProof(JSON.parse(stored));
    return { kind: 'create', phase: 'verificationRequired', acknowledged: Boolean(proof), proof };
  } catch { return null; }
}

const squadReadFailed = (failure: string) => failure.startsWith('squad:');

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
  leagueChange: LeagueChange | null;
  verifyLeagueChange: () => Promise<boolean>;
  retryLeagueReceipt: () => Promise<boolean>;
  cancelLeagueReceipt: () => Promise<boolean>;
  hasLeagueReceipt: boolean;
  /** `false` means the write needs verification, not a failed submission. */
  createLeague: (name: string) => Promise<boolean>;
  joinLeague: (code: string) => Promise<boolean>;
  setMarketOpen: (open: boolean) => Promise<void>;
  /** Archive the current league; it disappears from every screen. Leader-only. */
  archiveLeague: () => Promise<boolean>;
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
  squadChange: SquadChange | null;
  refreshSquad: () => Promise<void>;
  retrySquadReceipt: () => Promise<void>;
  cancelSquadReceipt: () => Promise<void>;
  hasSquadReceipt: boolean;
  acknowledgeSquadRefresh: () => void;
  buy: (marketPlayerId: string) => Promise<void>;
  sell: (marketPlayerId: string) => Promise<void>;
  transfer: (outId: string, inId: string) => Promise<void>;
  saveLineup: (input: Omit<Parameters<typeof api.saveLineup>[1], 'gameweekId'> & { gameweekId?: string }) => Promise<void>;
  confirmLineup: (lineupId: string) => Promise<void>;
  /** Competition + matches */
  createSeason: (name: string, startsAt: string, endsAt: string, count: number) => Promise<void>;
  refreshMatches: (signal?: AbortSignal) => Promise<ApiMatch[]>;
  markNotificationRead: (id: string) => Promise<void>;
}

const LiveContext = createContext<LiveContextValue | null>(null);

const message = (error: unknown): string =>
  error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'Something went wrong';

export function LiveProvider({
  userId, children, initialLeagues = EMPTY_LEAGUES, directoryReady = true,
  initialDirectoryLoaded = false, directoryError = null, bootstrapSession, retryInitialBootstrap,
}: {
  userId: string; children: ReactNode;
  initialLeagues?: Bootstrap['leagues']; directoryReady?: boolean; initialDirectoryLoaded?: boolean; directoryError?: string | null;
  bootstrapSession?: BootstrapSession; retryInitialBootstrap?: () => Promise<void>;
}) {
  const bootstrap = useMemo(() => bootstrapSession ?? api.createBootstrapSession(userId), [bootstrapSession, userId]);
  const [state, setState] = useState<LiveState>({
    loading: true, leagueId: null, leagues: [], members: [], players: [], squad: null,
    suggestions: [], gameweeks: [], matches: [], transfers: [], standings: [], notifications: [],
    points: EMPTY_POINTS,
    error: null, partialFailures: [],
  });
  const generation = useRef(0);
  const matchesRefreshGeneration = useRef(0);
  const directoryLoaded = useRef(false);
  const squadRefreshVersion = useRef(0);
  const selectionVersion = useRef(0);
  const liveSession = useRef<BootstrapSession | null>(null);
  // A lease belongs to the exact attempt, not just the selected league. Keep it
  // in the provider across routes (one team per league for this identity).
  const [squadChanges, setSquadChanges] = useState(() => new Map<string, SquadChange>());
  const squadAttempts = useRef(new Map<string, SquadAttempt>());
  const leagueAttempt = useRef<LeagueAttempt | null>(null);
  const createReady = useRef(false);
  const squadReady = useRef(new Set<string>());
  const [leagueChange, setLeagueChange] = useState<LeagueChange | null>(null);
  const publishLeagueChange = useCallback((attempt: LeagueAttempt | null) => {
    leagueAttempt.current = attempt;
    setLeagueChange(attempt ? { kind: attempt.kind, phase: attempt.phase, acknowledged: attempt.acknowledged } : null);
  }, []);
  useLayoutEffect(() => {
    let active = true;
    liveSession.current = bootstrap;
    squadAttempts.current = new Map();
    setSquadChanges((previous) => previous.size ? new Map() : previous);
    createReady.current = false;
    squadReady.current = new Set();
    const legacy = restoreCreate(userId);
    // Until IndexedDB has been read, fail closed even if a component submits.
    publishLeagueChange(legacy ?? { kind: 'create', phase: 'verifying', acknowledged: false, proof: null });
    void readOperation(userId, 'league-create').then((operation) => {
      if (!active || liveSession.current !== bootstrap) return;
      createReady.current = true;
      // A pre-receipt legacy marker must never be mistaken for a receipt.
      if (legacy) publishLeagueChange(legacy);
      else publishLeagueChange(operation ? { kind: 'create', phase: 'verificationRequired', acknowledged: false, proof: null, operation } : null);
    }).catch(() => {
      if (active && liveSession.current === bootstrap) publishLeagueChange(legacy ?? { kind: 'create', phase: 'verificationRequired', acknowledged: false, proof: null });
    });
    return () => { active = false; liveSession.current = null; };
  }, [bootstrap, publishLeagueChange, userId]);

  const publishSquadChange = useCallback((id: string, attempt: SquadAttempt | null) => {
    if (attempt) squadAttempts.current.set(id, attempt);
    else squadAttempts.current.delete(id);
    setSquadChanges((previous) => {
      const next = new Map(previous);
      if (attempt) next.set(id, attempt.phase);
      else next.delete(id);
      return next;
    });
  }, []);

  const stateRef = useRef(state);
  const commit = useCallback((next: LiveState | ((previous: LiveState) => LiveState)) => {
    stateRef.current = typeof next === 'function' ? next(stateRef.current) : next;
    setState(stateRef.current);
  }, []);

  const load = useCallback(async (leagueId: string | null, {
    retryDirectory = false, directory, knownMembers, keepVerifiedSquad = false,
  }: {
    retryDirectory?: boolean; directory?: Directory;
    knownMembers?: { leagueId: string; members: ApiMember[] }; keepVerifiedSquad?: boolean;
  } = {}) => {
    const mine = ++generation.current;
    matchesRefreshGeneration.current += 1;
    const before = stateRef.current;
    const loading = !before.leagueId || before.leagueId !== leagueId;
    if (loading) selectionVersion.current += 1;
    const isCurrent = () => liveSession.current === bootstrap && mine === generation.current;
    commit((s) => ({ ...s, loading, error: null }));
    try {
      // The league directory is already authoritative in memory after the first
      // bootstrap. Do not serialize every league switch behind another global
      // ff_bootstrap call; refresh that directory only when requested or when the
      // target is not present in the current user's cached memberships.
      const cachedLeagues = before.leagues.filter((l) => !l.archived);
      const targetKnown = !!leagueId && cachedLeagues.some((l) => l.league_id === leagueId);
      const needsBootstrap = !directory && (retryDirectory || !directoryLoaded.current || (!!leagueId && !targetKnown));
      let usable = directory ?? cachedLeagues;
      if (needsBootstrap) {
        const boot = await bootstrap.load({ retry: retryDirectory });
        // Other callers may have joined the bootstrap while we were waiting.
        // Only the latest selection should fan out into league reads.
        if (!isCurrent()) return null;
        directoryLoaded.current = true;
        usable = boot.leagues.filter((l) => !l.archived);
      }
      const chosen = leagueId && usable.some((l) => l.league_id === leagueId)
        ? leagueId
        : usable[0]?.league_id ?? null;

      if (!loading && chosen !== before.leagueId) selectionVersion.current += 1;
      if (directory) directoryLoaded.current = true;
      if (!chosen) {
        if (!isCurrent()) return null;
        commit({
          loading: false, leagueId: null, leagues: usable, members: [], players: [], squad: null,
          suggestions: [], gameweeks: [], matches: [], transfers: [], standings: [], notifications: [],
          points: EMPTY_POINTS,
          error: null, partialFailures: [],
        });
        return { leagueId: null };
      }

      // Load the league slice in parallel. One slow or broken read must not blank
      // the entire screen, so each slice falls back to an empty value - BUT the
      // failure is recorded and surfaced. Swallowing these silently is dangerous:
      // if RLS or a grant is wrong, every read returns "permission denied", and a
      // silent fallback renders "0 players / 0 members / no fixtures" - the UI then
      // states as fact that the user has an empty league. Live mode must never
      // present fake emptiness as real data.
      const sameLeague = before.leagueId === chosen;
      const squadVersion = squadRefreshVersion.current;
      const failures: string[] = [];
      const safe = async <T,>(label: string, promise: Promise<T>, fallback: T, previous: T): Promise<T> => {
        try {
          return await promise;
        } catch (error) {
          failures.push(`${label}: ${error instanceof Error ? error.message : 'failed'}`);
          // A failed refresh is not an empty result. Keep the last server-confirmed
          // value for this same league; never reuse a different league's data.
          return sameLeague ? previous : fallback;
        }
      };
      const [members, players, squad, suggestions, gameweeks, matches, transfers, standings, notifications] =
        await Promise.all([
          knownMembers?.leagueId === chosen ? knownMembers.members
            : safe('members', api.leagueMembers(chosen), [], sameLeague ? before.members : []),
          safe('players', api.marketPlayers(chosen, { includeInactive: true }), [], sameLeague ? before.players : []),
          keepVerifiedSquad && sameLeague ? before.squad
            : safe('squad', api.squad(chosen), null, sameLeague ? before.squad : null),
          safe('suggestions', api.suggestions(chosen), [], sameLeague ? before.suggestions : []),
          safe('gameweeks', api.gameweeks(chosen), [], sameLeague ? before.gameweeks : []),
          safe('matches', api.matches(chosen), [], sameLeague ? before.matches : []),
          safe('transfers', api.transfers(chosen), [], sameLeague ? before.transfers : []),
          safe('standings', api.standings(chosen), [], sameLeague ? before.standings : []),
          safe('notifications', api.notifications(chosen), [], sameLeague ? before.notifications : []),
        ]);

      if (!isCurrent()) return null;
      // An older full-league refresh must not overwrite conflict recovery.
      const keepSquad = stateRef.current.leagueId === chosen && squadVersion !== squadRefreshVersion.current;
      commit({
        loading: false, leagueId: chosen, leagues: usable, members, players,
        squad: keepSquad ? stateRef.current.squad : squad,
        suggestions, gameweeks, matches, transfers, standings, notifications,
        points: sameLeague ? before.points : EMPTY_POINTS,
        error: null,
        partialFailures: keepSquad ? failures.filter((failure) => !squadReadFailed(failure)) : failures,
      });
      try { localStorage.setItem(LEAGUE_KEY, chosen); } catch { /* private mode */ }

      // Points are a secondary read, not proof of a squad or directory write.
      // Bound them independently so even a stuck table query cannot hold a guard.
      void api.withDeadline('League points', (signal) => leaguePoints(chosen, undefined, signal)).then((snapshot) => {
        if (isCurrent()) commit((current) => ({ ...current, points: snapshot }));
      }, (error: unknown) => {
        if (isCurrent()) commit((current) => ({ ...current, points: { ...EMPTY_POINTS, error: message(error) } }));
      });
      return { leagueId: chosen };
    } catch (error) {
      if (!isCurrent()) return null;
      commit((s) => ({ ...s, loading: false, error: message(error) }));
      return null;
    }
  }, [bootstrap, commit]);

  useEffect(() => {
    if (!directoryReady) return;
    const usable = initialLeagues.filter((league) => !league.archived);
    directoryLoaded.current = initialDirectoryLoaded && !directoryError;
    if (initialDirectoryLoaded) commit((current) => ({ ...current, leagues: usable }));
    if (directoryError) {
      commit((current) => ({ ...current, loading: false, error: directoryError }));
      return;
    }
    let initial: string | null = null;
    try { initial = localStorage.getItem(LEAGUE_KEY); } catch { /* ignore */ }
    // The initial directory is already server-confirmed. A stale saved league
    // (e.g. from a different login or an archive) is not a reason to read it again.
    if (initialDirectoryLoaded && !usable.some((l) => l.league_id === initial)) initial = null;
    void load(initial);
    return () => { generation.current += 1; matchesRefreshGeneration.current += 1; };
  }, [commit, directoryError, directoryReady, initialDirectoryLoaded, initialLeagues, load]);

  const leagueId = state.leagueId;

  useEffect(() => {
    if (!leagueId || liveSession.current !== bootstrap || squadReady.current.has(leagueId)) return;
    const existing = squadAttempts.current.get(leagueId);
    if (existing) return;
    const checking: SquadAttempt = { phase: 'verifying' };
    publishSquadChange(leagueId, checking);
    void readOperation(userId, `squad:${leagueId}`).then((operation) => {
      if (liveSession.current !== bootstrap || squadAttempts.current.get(leagueId) !== checking) return;
      squadReady.current.add(leagueId);
      if (operation) { checking.operation = operation; checking.phase = 'refreshRequired'; publishSquadChange(leagueId, checking); }
      else publishSquadChange(leagueId, null);
    }).catch(() => {
      if (liveSession.current === bootstrap && squadAttempts.current.get(leagueId) === checking) {
        checking.phase = 'refreshRequired'; publishSquadChange(leagueId, checking);
      }
    });
  }, [bootstrap, leagueId, publishSquadChange, userId]);

  // `stateRef` and `commit` live above `load` so selection callbacks and request
  // completions always consult the latest directory and league slice.
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

  const ownsLeagueAttempt = useCallback((attempt: LeagueAttempt) =>
    liveSession.current === bootstrap && leagueAttempt.current === attempt, [bootstrap]);

  const verifyLeagueAttempt = useCallback(async (attempt: LeagueAttempt, retry: boolean) => {
    if (!ownsLeagueAttempt(attempt) || attempt.phase !== 'verificationRequired') return false;
    attempt.phase = 'verifying';
    publishLeagueChange(attempt);
    try {
      // A read in flight before the write cannot verify it. A user retry opts
      // into another directory read, never another ff_league_* mutation.
      const boot = await bootstrap.load({ retry, afterPending: true });
      if (!ownsLeagueAttempt(attempt)) return false;
      const directory = boot.leagues.filter((entry) => !entry.archived);
      const proof = attempt.proof;
      let confirmed = Boolean(proof?.check(directory.find((entry) => entry.league_id === proof.leagueId)));
      let knownMembers: { leagueId: string; members: ApiMember[] } | undefined;
      if (confirmed && proof?.checkMembers) {
        const members = await api.leagueMembers(proof.leagueId);
        if (!ownsLeagueAttempt(attempt)) return false;
        confirmed = proof.checkMembers(members);
        knownMembers = { leagueId: proof.leagueId, members };
      }
      // Without a receipt, a new directory entry could be an unrelated join or
      // create from another session. It cannot prove this particular write.
      const membership = attempt.kind === 'create' || attempt.kind === 'join';
      const target = membership && confirmed && proof ? proof.leagueId : stateRef.current.leagueId;
      const loaded = await load(target, { directory, knownMembers });
      if (!ownsLeagueAttempt(attempt) || !confirmed || !loaded || (membership && loaded.leagueId !== target)) return false;
      // With no create receipt we must not guess based on a non-unique name or
      // falsely conclude that a late commit cannot still appear in the directory.
      if (attempt.operation) await clearOperation(attempt.operation, { state: 'committed' });
      else if (attempt.kind === 'create') saveCreateReceipt(userId);
      if (!ownsLeagueAttempt(attempt)) return false;
      publishLeagueChange(null);
      return true;
    } catch {
      return false; // The preserved receipt/intent can be checked again without a write.
    } finally {
      if (ownsLeagueAttempt(attempt)) {
        attempt.phase = 'verificationRequired';
        publishLeagueChange(attempt);
      }
    }
  }, [bootstrap, load, ownsLeagueAttempt, publishLeagueChange, userId]);

  const changeLeague = useCallback(async <T,>(kind: LeagueChangeKind, write: () => Promise<T>,
    proofForReceipt: (receipt: T) => LeagueProof | null, proofWithoutReceipt: LeagueProof | null = null) => {
    if (liveSession.current !== bootstrap) return false;
    const pending = leagueAttempt.current;
    if (pending) throw new ApiError('invalidState', pending.kind === 'create' && pending.phase === 'saving'
      ? 'A league is already being created. Please wait.'
      : 'Verify the previous league change before submitting another.');
    const attempt: LeagueAttempt = { kind, phase: 'saving', acknowledged: false, proof: proofWithoutReceipt };
    if (kind === 'create') saveCreateReceipt(userId, null);
    publishLeagueChange(attempt);
    commit((current) => ({ ...current, error: null }));
    let receipt: T;
    try {
      receipt = await write();
    } catch (error) {
      if (!ownsLeagueAttempt(attempt)) return false;
      if (error instanceof ApiError && error.code === 'outcomeUnknown') {
        attempt.phase = 'verificationRequired';
        publishLeagueChange(attempt);
        return false;
      }
      if (kind === 'create') saveCreateReceipt(userId);
      publishLeagueChange(null);
      commit((current) => ({ ...current, error: message(error) }));
      throw error;
    }
    if (!ownsLeagueAttempt(attempt)) return false;
    // Save the receipt's identity before *any* view refresh. Subsequent retries
    // confirm the original operation, even after a reload in this tab.
    attempt.acknowledged = true;
    attempt.proof = proofForReceipt(receipt);
    if (kind === 'create') saveCreateReceipt(userId, attempt.proof);
    attempt.phase = 'verificationRequired';
    return verifyLeagueAttempt(attempt, false);
  }, [bootstrap, commit, ownsLeagueAttempt, publishLeagueChange, userId, verifyLeagueAttempt]);

  const resolveLeagueReceipt = useCallback(async (attempt: LeagueAttempt, action: 'status' | 'retry' | 'cancel') => {
    const op = attempt.operation;
    if (!op || !ownsLeagueAttempt(attempt) || attempt.phase !== 'verificationRequired') return false;
    attempt.phase = 'verifying'; publishLeagueChange(attempt);
    const active = () => ownsLeagueAttempt(attempt);
    try {
      const receipt = action === 'retry' ? await submitOperation(op, liveReceiptTransport, active)
        : action === 'cancel' ? await cancelOperation(op, liveReceiptTransport, active)
        : await inspectOperation(op, liveReceiptTransport, active);
      if (!active()) return false;
      if (receipt.state === 'cancelled') {
        await clearOperation(op, receipt);
        if (active()) publishLeagueChange(null);
        return false;
      }
      if (receipt.state === 'committed') {
        const result = receipt.result as { id?: string } | undefined;
        const proof = membershipProof(result?.id);
        if (!proof) throw new Error('Invalid committed league receipt');
        attempt.acknowledged = true; attempt.proof = proof;
        attempt.phase = 'verificationRequired'; publishLeagueChange(attempt);
        return await verifyLeagueAttempt(attempt, true);
      }
      return false; // unknown and pending are never finality
    } catch (error) {
      if (active()) commit(current => ({ ...current, error: message(error) }));
      return false;
    } finally {
      if (active()) { attempt.phase = 'verificationRequired'; publishLeagueChange(attempt); }
    }
  }, [commit, ownsLeagueAttempt, publishLeagueChange, verifyLeagueAttempt]);

  const createLeagueWithReceipt = useCallback(async (name: string) => {
    if (liveSession.current !== bootstrap || !createReady.current || leagueAttempt.current)
      throw new ApiError('invalidState', leagueAttempt.current?.kind === 'create' && leagueAttempt.current.phase === 'saving'
        ? 'A league is already being created. Please wait.'
        : 'Verify the previous league change before submitting another.');
    const attempt: LeagueAttempt = { kind: 'create', phase: 'saving', acknowledged: false, proof: null };
    publishLeagueChange(attempt); commit(current => ({ ...current, error: null }));
    try {
      const op = await reserveOperation(userId, 'league-create', 'league_create', { name, budget: 100000000 });
      if (!ownsLeagueAttempt(attempt)) return false;
      attempt.operation = op;
      const receipt = await submitOperation(op, liveReceiptTransport, () => ownsLeagueAttempt(attempt));
      if (!ownsLeagueAttempt(attempt)) return false;
      if (receipt.state === 'committed') {
        const result = receipt.result as { id?: string } | undefined;
        attempt.proof = membershipProof(result?.id);
        if (!attempt.proof) throw new Error('Invalid committed league receipt');
        attempt.acknowledged = true; attempt.phase = 'verificationRequired';
        return await verifyLeagueAttempt(attempt, false);
      }
      if (receipt.state === 'cancelled') {
        await clearOperation(op, receipt);
        if (ownsLeagueAttempt(attempt)) publishLeagueChange(null);
        return false;
      }
    } catch (error) {
      if (!ownsLeagueAttempt(attempt)) return false;
      // An existing reservation or a storage failure is not proof of non-arrival.
      if (!attempt.operation) {
        try { attempt.operation = await readOperation(userId, 'league-create'); } catch { /* fail closed */ }
      }
      if (ownsLeagueAttempt(attempt)) commit(current => ({ ...current, error: message(error) }));
    }
    if (ownsLeagueAttempt(attempt)) { attempt.phase = 'verificationRequired'; publishLeagueChange(attempt); }
    return false;
  }, [bootstrap, commit, ownsLeagueAttempt, publishLeagueChange, userId, verifyLeagueAttempt]);

  const changeLeagueSettings = useCallback(async (action: () => Promise<unknown>, proof: LeagueProof) => {
    await changeLeague('settings', action, () => proof, proof);
  }, [changeLeague]);

  const isActiveSquad = useCallback((id: string) => liveSession.current === bootstrap
    && stateRef.current.leagueId === id && !stateRef.current.loading, [bootstrap]);
  const ownsSquadAttempt = useCallback((id: string, attempt: SquadAttempt) => liveSession.current === bootstrap
    && squadAttempts.current.get(id) === attempt, [bootstrap]);

  const verifySquad = useCallback(async (id: string, attempt: SquadAttempt, review: boolean) => {
    if (!ownsSquadAttempt(id, attempt) || !isActiveSquad(id)) return false;
    const selection = selectionVersion.current;
    attempt.phase = review ? 'refreshing' : 'verifying';
    publishSquadChange(id, attempt);
    let verified = false;
    try {
      // Only this read, started after this attempt's write settled, can release
      // its lease. Reloads, retained snapshots and points never do so.
      const squad = await api.squad(id);
      if (!ownsSquadAttempt(id, attempt) || !isActiveSquad(id)
          || selection !== selectionVersion.current || !Array.isArray(squad?.players)) return false;
      if (attempt.operation && attempt.terminal) await clearOperation(attempt.operation, attempt.terminal);
      if (!ownsSquadAttempt(id, attempt) || !isActiveSquad(id) || selection !== selectionVersion.current) return false;
      squadRefreshVersion.current += 1;
      commit((current) => ({ ...current, squad,
        partialFailures: current.partialFailures.filter((failure) => !squadReadFailed(failure)),
      }));
      verified = true;
      return true;
    } catch {
      return false;
    } finally {
      if (ownsSquadAttempt(id, attempt)) {
        attempt.phase = verified ? 'reviewRequired' : 'refreshRequired';
        publishSquadChange(id, verified && !review ? null : attempt);
      }
    }
  }, [commit, isActiveSquad, ownsSquadAttempt, publishSquadChange]);

  const resolveSquadReceipt = useCallback(async (id: string, attempt: SquadAttempt, action: 'status' | 'retry' | 'cancel') => {
    if (!attempt.operation || !ownsSquadAttempt(id, attempt) || !isActiveSquad(id) || attempt.phase !== 'refreshRequired') return;
    const op = attempt.operation;
    attempt.phase = 'verifying'; publishSquadChange(id, attempt);
    const active = () => ownsSquadAttempt(id, attempt);
    try {
      const receipt = action === 'retry' ? await submitOperation(op, liveReceiptTransport, active)
        : action === 'cancel' ? await cancelOperation(op, liveReceiptTransport, active)
        : await inspectOperation(op, liveReceiptTransport, active);
      if (!active()) return;
      if (receipt.state === 'committed' || receipt.state === 'cancelled') {
        attempt.terminal = receipt;
        await verifySquad(id, attempt, true);
      }
    } catch (error) {
      if (active() && isActiveSquad(id)) commit(current => ({ ...current, error: message(error) }));
    } finally {
      if (active() && attempt.phase === 'verifying') { attempt.phase = 'refreshRequired'; publishSquadChange(id, attempt); }
    }
  }, [commit, isActiveSquad, ownsSquadAttempt, publishSquadChange, verifySquad]);

  const changeSquad = useCallback(async (id: string, kind: string, payload: Record<string, unknown>) => {
    if (!isActiveSquad(id) || !squadReady.current.has(id)) throw new ApiError('invalidState', 'Check the previous squad operation before making another change.');
    const phase = squadAttempts.current.get(id)?.phase;
    if (phase) throw new ApiError('invalidState', phase === 'saving' || phase === 'verifying' || phase === 'refreshing'
      ? 'A squad change is already in progress. Please wait.' : 'Refresh and review your squad before making another change.');
    const attempt: SquadAttempt = { phase: 'saving' };
    publishSquadChange(id, attempt); commit(current => ({ ...current, error: null }));
    try {
      const op = await reserveOperation(userId, `squad:${id}`, kind, { league: id, ...payload });
      if (!ownsSquadAttempt(id, attempt)) return;
      attempt.operation = op;
      const receipt = await submitOperation(op, liveReceiptTransport, () => ownsSquadAttempt(id, attempt));
      if (!ownsSquadAttempt(id, attempt)) return;
      if (receipt.state === 'committed' || receipt.state === 'cancelled') {
        attempt.terminal = receipt;
        const beforeVerify = generation.current;
        if (await verifySquad(id, attempt, false)) {
          if (receipt.state === 'cancelled') throw new ApiError('invalidState', 'The squad change was cancelled.', 'receipt-cancelled');
          if (beforeVerify === generation.current && isActiveSquad(id)) void load(id, { keepVerifiedSquad: true });
          return;
        }
        if (!isActiveSquad(id)) {
          attempt.phase = 'refreshRequired'; publishSquadChange(id, attempt);
          return;
        }
      }
    } catch (error) {
      if (error instanceof ApiError && error.detail === 'receipt-cancelled') {
        if (liveSession.current === bootstrap) throw error;
        return;
      }
      if (!ownsSquadAttempt(id, attempt)) return;
      if (!attempt.operation) {
        try { attempt.operation = await readOperation(userId, `squad:${id}`); } catch { /* fail closed */ }
      }
      if (error instanceof ApiError && error.code === 'conflict' && attempt.operation) {
        // A delayed duplicate could still arrive: serialize cancellation before
        // releasing the guard, even though this execution definitely rolled back.
        let terminal: Receipt | undefined;
        try { terminal = await cancelOperation(attempt.operation, liveReceiptTransport, () => ownsSquadAttempt(id, attempt)); }
        catch { /* keep the receipt unresolved */ }
        if (terminal?.state === 'committed' || terminal?.state === 'cancelled') {
          attempt.terminal = terminal;
          const verified = await verifySquad(id, attempt, true);
          if (terminal.state === 'cancelled') throw error;
          if (verified || !isActiveSquad(id)) return;
        }
      }
      if (isActiveSquad(id)) commit(current => ({ ...current, error: message(error) }));
    }
    if (ownsSquadAttempt(id, attempt)) { attempt.phase = 'refreshRequired'; publishSquadChange(id, attempt); }
    throw new ApiError('outcomeUnknown', 'The squad operation needs reconciliation before another change.');
  }, [bootstrap, commit, isActiveSquad, load, ownsSquadAttempt, publishSquadChange, userId, verifySquad]);

  const selectLeague = useCallback((id: string) => { void load(id); }, [load]);

  const league = state.leagues.find((l) => l.league_id === leagueId) ?? null;
  const isLeader = league?.is_leader ?? false;
  const isOrganizer = league?.is_organizer ?? false;

  const value = useMemo<LiveContextValue>(() => ({
    ...state,
    league, isLeader, isOrganizer, myUserId: userId,
    selectLeague,
    // If startup failed, AuthProvider must receive the recovered profile too.
    reload: async () => {
      if (!initialDirectoryLoaded && retryInitialBootstrap) await retryInitialBootstrap();
      else await load(leagueId, { retryDirectory: true });
    },
    leagueChange,
    verifyLeagueChange: async () => leagueAttempt.current ? (leagueAttempt.current.operation ? resolveLeagueReceipt(leagueAttempt.current, 'status') : verifyLeagueAttempt(leagueAttempt.current, true)) : false,
    retryLeagueReceipt: async () => leagueAttempt.current ? resolveLeagueReceipt(leagueAttempt.current, 'retry') : false,
    cancelLeagueReceipt: async () => leagueAttempt.current ? resolveLeagueReceipt(leagueAttempt.current, 'cancel') : false,
    hasLeagueReceipt: Boolean(leagueAttempt.current?.operation),
    createLeague: createLeagueWithReceipt,
    joinLeague: (code) => changeLeague('join', () => api.joinLeague(code), (joined) => membershipProof(joined?.id)),
    setMarketOpen: (open) => {
      const id = require(leagueId);
      return changeLeagueSettings(() => api.setMarket(id, open), {
        leagueId: id, check: (entry) => entry?.market_open === open,
      });
    },
    archiveLeague: () => {
      const id = require(leagueId);
      const proof: LeagueProof = { leagueId: id, check: (entry) => !entry };
      return changeLeague('archive', () => api.archiveLeague(id), () => proof, proof);
    },
    setMember: (userId2, role, status) => {
      const id = require(leagueId);
      return changeLeagueSettings(() => api.setMember(id, userId2, role, status), {
        leagueId: id, check: Boolean,
        checkMembers: (members) => members.some((member) => member.user_id === userId2
          && (!role || member.role === role) && (!status || member.status === status)),
      });
    },
    setOrganizer: (userId2, enabled) => {
      const id = require(leagueId);
      return changeLeagueSettings(() => api.setOrganizer(id, userId2, enabled), {
        leagueId: id, check: Boolean,
        checkMembers: (members) => members.some((member) => member.user_id === userId2 && member.is_organizer === enabled),
      });
    },
    transferLeadership: (userId2) => {
      const id = require(leagueId);
      return changeLeagueSettings(() => api.transferLeadership(id, userId2), {
        leagueId: id, check: Boolean,
        checkMembers: (members) => members.some((member) => member.user_id === userId2 && member.role === 'leader'),
      });
    },
    savePlayer: (input) => mutate(() => api.upsertMarketPlayer(require(leagueId), input)),
    setSquadCaptains: (captainId, viceCaptainId) => changeSquad(require(leagueId), 'squad_captains', { captain: captainId, vice: viceCaptainId }),
    suggestPlayer: (input) => mutate(() => api.submitSuggestion(require(leagueId), input)),
    suggestPlayers: (items) => mutate(() => api.submitSuggestionBatch(require(leagueId), items)),
    reviewSuggestion: (id, decision, opts) => mutate(() => api.reviewSuggestion(require(leagueId), id, decision, opts)),
    squadChange: leagueId ? squadChanges.get(leagueId) ?? null : null,
    hasSquadReceipt: Boolean(leagueId && squadAttempts.current.get(leagueId)?.operation),
    refreshSquad: async () => {
      const attempt = leagueId ? squadAttempts.current.get(leagueId) : undefined;
      if (leagueId && attempt?.phase === 'refreshRequired') {
        if (attempt.operation) await resolveSquadReceipt(leagueId, attempt, 'status');
        /* A legacy or unavailable-storage operation cannot be proven by a read. */
      }
    },
    retrySquadReceipt: async () => { const attempt = leagueId ? squadAttempts.current.get(leagueId) : undefined; if (leagueId && attempt) await resolveSquadReceipt(leagueId, attempt, 'retry'); },
    cancelSquadReceipt: async () => { const attempt = leagueId ? squadAttempts.current.get(leagueId) : undefined; if (leagueId && attempt) await resolveSquadReceipt(leagueId, attempt, 'cancel'); },
    acknowledgeSquadRefresh: () => {
      if (leagueId && isActiveSquad(leagueId) && squadAttempts.current.get(leagueId)?.phase === 'reviewRequired') {
        publishSquadChange(leagueId, null);
      }
    },
    buy: (id) => changeSquad(require(leagueId), 'squad_buy', { player: id }),
    sell: (id) => changeSquad(require(leagueId), 'squad_sell', { player: id }),
    transfer: (outId, inId) => changeSquad(require(leagueId), 'squad_transfer', { out: outId, in: inId }),
    saveLineup: (input) => changeSquad(require(leagueId), 'lineup_save', {
      gameweek: input.gameweekId ?? state.gameweeks[0]?.id ?? '', formation: input.formation,
      players: input.playerIds, captain: input.captainId, vice: input.viceCaptainId,
    }),
    confirmLineup: (id) => changeSquad(require(leagueId), 'lineup_confirm', { lineup: id }),
    createSeason: (name, startsAt, endsAt, count) =>
      mutate(() => api.createSeason(require(leagueId), name, startsAt, endsAt, count)),
    refreshMatches,
    markNotificationRead: (id) => mutate(() => api.markNotificationRead(id)),
  }), [state, league, isLeader, isOrganizer, userId, selectLeague, load, leagueId, mutate, refreshMatches,
    initialDirectoryLoaded, retryInitialBootstrap, leagueChange, changeLeague, verifyLeagueAttempt, changeLeagueSettings,
    squadChanges, changeSquad, verifySquad, isActiveSquad, publishSquadChange, createLeagueWithReceipt, resolveLeagueReceipt, resolveSquadReceipt]);

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
