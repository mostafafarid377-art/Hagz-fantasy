/**
 * Temporary, in-memory diagnostics for ff_bootstrap.
 *
 * Reports deliberately exclude URLs, request/response bodies, headers, tokens,
 * cookies, and account/league identifiers. A fetch invocation or visible Response
 * is not proof that Supabase received the request. Browser-generated CORS
 * preflights are not observable from a page fetch wrapper.
 */

export type BootstrapErrorCategory =
  | 'none'
  | 'timeout'
  | 'authentication'
  | 'authorization'
  | 'network'
  | 'other';

export type FetchInvocationObservation =
  | 'fetch-invoked'
  | 'not-observed'
  | 'not-observable-from-page-fetch'
  | 'ambiguous';

export type BootstrapFetchErrorClass = 'AbortError' | 'TypeError' | 'Other';
export type BootstrapFetchOutcome = 'pending' | 'resolved' | 'rejected';
export type BootstrapFetchAttribution = 'single-active-attempt' | 'ambiguous' | 'no-active-attempt';
export type BootstrapAuthEventName =
  | 'INITIAL_SESSION'
  | 'SIGNED_IN'
  | 'SIGNED_OUT'
  | 'PASSWORD_RECOVERY'
  | 'TOKEN_REFRESHED'
  | 'USER_UPDATED'
  | 'MFA_CHALLENGE_VERIFIED'
  | 'OTHER';

export interface BootstrapDiagnostic {
  diagnosticId: string;
  startedAtUtc: string;
  endedAtUtc: string | null;
  elapsedMs: number | null;
  outcome: 'pending' | 'success' | 'error';
  timedOut: boolean;
  errorCategory: BootstrapErrorCategory;
  maxConcurrentBootstrapAttempts: number;
  fetchInvocations: {
    OPTIONS: FetchInvocationObservation;
    POST: FetchInvocationObservation;
  };
  networkReceipt: 'not-confirmed-by-page-instrumentation';
}

export interface BootstrapFetchDiagnostic {
  fetchId: string;
  /** Local attempt ID only when exactly one attempt was active at fetch start. */
  diagnosticId: string | null;
  attribution: BootstrapFetchAttribution;
  activeBootstrapAttempts: number;
  startedAtUtc: string;
  completedAtUtc: string | null;
  elapsedMs: number | null;
  outcome: BootstrapFetchOutcome;
  httpStatus: number | null;
  errorClass: BootstrapFetchErrorClass | null;
}

export interface BootstrapAuthEvent {
  occurredAtUtc: string;
  event: BootstrapAuthEventName;
}

const MAX_ATTEMPTS = 10;
const MAX_FETCH_OBSERVATIONS = 40;
const MAX_AUTH_EVENTS = 40;
const endpointPath = '/rest/v1/rpc/ff_bootstrap';
const AUTH_EVENT_NAMES = new Set<BootstrapAuthEventName>([
  'INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT', 'PASSWORD_RECOVERY',
  'TOKEN_REFRESHED', 'USER_UPDATED', 'MFA_CHALLENGE_VERIFIED', 'OTHER',
]);

let attempts: BootstrapDiagnostic[] = [];
let fetchObservations: BootstrapFetchDiagnostic[] = [];
let authEvents: BootstrapAuthEvent[] = [];
const startedAtMonotonic = new Map<string, number>();
const fetchStartedAtMonotonic = new Map<string, number>();
const activeAttempts = new Set<string>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function createDiagnosticId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function monotonicNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function classifyError(error: unknown): BootstrapErrorCategory {
  if (!error || typeof error !== 'object') return 'other';
  const value = error as { code?: unknown; detail?: unknown; message?: unknown; name?: unknown };
  const code = typeof value.code === 'string' ? value.code : '';
  const detail = typeof value.detail === 'string' ? value.detail : '';
  const message = typeof value.message === 'string' ? value.message : '';
  const name = typeof value.name === 'string' ? value.name : '';

  if (detail === 'timeout' || /did not respond within \d+ ms/i.test(message)) return 'timeout';
  if (['notAuthenticated', '401', 'PGRST301'].includes(code) || /authentication required|invalid jwt|jwt expired/i.test(message)) {
    return 'authentication';
  }
  if (['forbidden', '42501'].includes(code)) return 'authorization';
  if (code === 'network' || name === 'TypeError' || /fetch|network|abort/i.test(message)) return 'network';
  return 'other';
}

function updateAttempt(diagnosticId: string, update: (current: BootstrapDiagnostic) => BootstrapDiagnostic) {
  attempts = attempts.map((attempt) => attempt.diagnosticId === diagnosticId ? update(attempt) : attempt);
  notify();
}

function fetchErrorClass(error: unknown): BootstrapFetchErrorClass {
  const name = error && typeof error === 'object' && 'name' in error
    ? (error as { name?: unknown }).name
    : undefined;
  if (name === 'AbortError') return 'AbortError';
  if (name === 'TypeError') return 'TypeError';
  return 'Other';
}

function updateFetchObservation(fetchId: string, update: (current: BootstrapFetchDiagnostic) => BootstrapFetchDiagnostic) {
  fetchObservations = fetchObservations.map((observation) =>
    observation.fetchId === fetchId ? update(observation) : observation);
  // getBootstrapDiagnostics() is the panel's useSyncExternalStore snapshot; replace
  // its array too so fetch-only changes trigger a render of the combined report.
  attempts = [...attempts];
  notify();
}

/** Starts one diagnostic record and keeps it active until its bootstrap settles. */
export async function withBootstrapDiagnostics<T>(operation: () => Promise<T>): Promise<T> {
  const diagnosticId = createDiagnosticId();
  const startWallClock = Date.now();
  const startMonotonic = monotonicNow();
  const record: BootstrapDiagnostic = {
    diagnosticId,
    startedAtUtc: new Date(startWallClock).toISOString(),
    endedAtUtc: null,
    elapsedMs: null,
    outcome: 'pending',
    timedOut: false,
    errorCategory: 'none',
    maxConcurrentBootstrapAttempts: 1,
    fetchInvocations: {
      OPTIONS: 'not-observable-from-page-fetch',
      POST: 'not-observed',
    },
    networkReceipt: 'not-confirmed-by-page-instrumentation',
  };
  attempts = [...attempts, record].slice(-MAX_ATTEMPTS);
  startedAtMonotonic.set(diagnosticId, startMonotonic);
  activeAttempts.add(diagnosticId);

  const concurrentCount = activeAttempts.size;
  attempts = attempts.map((attempt) => activeAttempts.has(attempt.diagnosticId)
    ? { ...attempt, maxConcurrentBootstrapAttempts: Math.max(attempt.maxConcurrentBootstrapAttempts, concurrentCount) }
    : attempt);
  notify();

  try {
    const result = await operation();
    finishAttempt(diagnosticId, 'success', 'none');
    return result;
  } catch (error) {
    const category = classifyError(error);
    finishAttempt(diagnosticId, 'error', category);
    throw error;
  } finally {
    activeAttempts.delete(diagnosticId);
    startedAtMonotonic.delete(diagnosticId);
  }
}

function finishAttempt(diagnosticId: string, outcome: 'success' | 'error', errorCategory: BootstrapErrorCategory) {
  const start = startedAtMonotonic.get(diagnosticId);
  const startRecord = attempts.find((attempt) => attempt.diagnosticId === diagnosticId);
  if (!startRecord) return;
  const now = Date.now();
  const elapsedMs = start === undefined
    ? Math.max(0, now - Date.parse(startRecord.startedAtUtc))
    : Math.max(0, Math.round(monotonicNow() - start));
  updateAttempt(diagnosticId, (current) => ({
    ...current,
    endedAtUtc: new Date(now).toISOString(),
    elapsedMs,
    outcome,
    timedOut: errorCategory === 'timeout',
    errorCategory,
  }));
}

/**
 * Called by the Supabase client's fetch wrapper. It records only the method for
 * the exact bootstrap RPC path and a local fetch event; request metadata is
 * examined only to match the route and is never retained in diagnostics.
 */
export function observeBootstrapFetchInvocation(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  configuredSupabaseUrl: string,
): string | null {
  try {
    const requestUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : typeof Request !== 'undefined' && input instanceof Request
          ? input.url
          : '';
    const target = new URL(requestUrl, configuredSupabaseUrl);
    const configuredOrigin = new URL(configuredSupabaseUrl).origin;
    if (target.origin !== configuredOrigin || target.pathname !== endpointPath) return null;

    const requestMethod = init?.method ?? (
      typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET'
    );
    const method = requestMethod.toUpperCase();
    if (method !== 'OPTIONS' && method !== 'POST') return null;

    const active = [...activeAttempts];
    const observation: FetchInvocationObservation = active.length === 1 ? 'fetch-invoked' : 'ambiguous';
    for (const diagnosticId of active) {
      updateAttempt(diagnosticId, (current) => ({
        ...current,
        fetchInvocations: { ...current.fetchInvocations, [method]: observation },
      }));
    }

    if (method !== 'POST') return null;

    const fetchId = createDiagnosticId();
    const startedAtUtc = new Date().toISOString();
    const attribution: BootstrapFetchAttribution = active.length === 1
      ? 'single-active-attempt'
      : active.length > 1 ? 'ambiguous' : 'no-active-attempt';
    const fetchObservation: BootstrapFetchDiagnostic = {
      fetchId,
      diagnosticId: active.length === 1 ? active[0]! : null,
      attribution,
      activeBootstrapAttempts: active.length,
      startedAtUtc,
      completedAtUtc: null,
      elapsedMs: null,
      outcome: 'pending',
      httpStatus: null,
      errorClass: null,
    };
    fetchObservations = [...fetchObservations, fetchObservation].slice(-MAX_FETCH_OBSERVATIONS);
    fetchStartedAtMonotonic.set(fetchId, monotonicNow());
    attempts = [...attempts];
    notify();
    return fetchId;
  } catch {
    // Diagnostics must never prevent the underlying request from proceeding.
    return null;
  }
}

function finishFetchObservation(
  fetchId: string,
  result: { outcome: 'resolved'; httpStatus: number } | { outcome: 'rejected'; errorClass: BootstrapFetchErrorClass },
) {
  const start = fetchStartedAtMonotonic.get(fetchId);
  const now = Date.now();
  const elapsedMs = start === undefined ? null : Math.max(0, Math.round(monotonicNow() - start));
  updateFetchObservation(fetchId, (current) => ({
    ...current,
    completedAtUtc: new Date(now).toISOString(),
    elapsedMs,
    outcome: result.outcome,
    httpStatus: result.outcome === 'resolved' ? result.httpStatus : null,
    errorClass: result.outcome === 'rejected' ? result.errorClass : null,
  }));
  fetchStartedAtMonotonic.delete(fetchId);
}

/** Wraps fetch without reading or modifying its URL, headers, or body. */
export function createBootstrapDiagnosticFetch(
  configuredSupabaseUrl: string,
  fetchImplementation: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  return (input, init) => {
    const fetchId = observeBootstrapFetchInvocation(input, init, configuredSupabaseUrl);
    if (!fetchId) return fetchImplementation(input, init);

    try {
      return fetchImplementation(input, init).then(
        (response) => {
          // Status is the only Response property retained; the body is untouched.
          finishFetchObservation(fetchId, { outcome: 'resolved', httpStatus: response.status });
          return response;
        },
        (error: unknown) => {
          finishFetchObservation(fetchId, { outcome: 'rejected', errorClass: fetchErrorClass(error) });
          throw error;
        },
      );
    } catch (error) {
      finishFetchObservation(fetchId, { outcome: 'rejected', errorClass: fetchErrorClass(error) });
      return Promise.reject(error);
    }
  };
}

const AUTH_EVENT_ALLOWLIST = new Set<string>([
  'INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT', 'PASSWORD_RECOVERY',
  'TOKEN_REFRESHED', 'USER_UPDATED', 'MFA_CHALLENGE_VERIFIED',
]);

/** Records an allow-listed Supabase auth event name and timestamp only. */
export function recordBootstrapAuthEvent(event: string): void {
  const safeEvent: BootstrapAuthEventName = AUTH_EVENT_ALLOWLIST.has(event)
    ? event as BootstrapAuthEventName
    : 'OTHER';
  // Keep this reference to the allow-list union to make accidental additions explicit.
  if (!AUTH_EVENT_NAMES.has(safeEvent)) return;
  authEvents = [...authEvents, { occurredAtUtc: new Date().toISOString(), event: safeEvent }].slice(-MAX_AUTH_EVENTS);
  // Auth-only updates also need to invalidate the snapshot used by the report panel.
  attempts = [...attempts];
  notify();
}

export function subscribeBootstrapDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getBootstrapDiagnostics(): readonly BootstrapDiagnostic[] {
  return attempts;
}

export function getBootstrapFetchDiagnostics(): readonly BootstrapFetchDiagnostic[] {
  return fetchObservations;
}

export function getBootstrapAuthEvents(): readonly BootstrapAuthEvent[] {
  return authEvents;
}

/** Creates an allow-listed JSON report; raw errors and request metadata are never included. */
export function makeSanitizedBootstrapReport(): string {
  return JSON.stringify({
    reportVersion: 2,
    generatedAtUtc: new Date().toISOString(),
    note: 'Fetch records show only page-observed fetch outcomes and numeric response status. They do not prove Supabase receipt; browser-generated OPTIONS preflights are not observable. Bootstrap fetch attribution is ambiguous when multiple attempts were active.',
    attempts: attempts.map((attempt) => ({
      diagnosticId: attempt.diagnosticId,
      startedAtUtc: attempt.startedAtUtc,
      endedAtUtc: attempt.endedAtUtc,
      elapsedMs: attempt.elapsedMs,
      outcome: attempt.outcome,
      timedOut: attempt.timedOut,
      errorCategory: attempt.errorCategory,
      maxConcurrentBootstrapAttempts: attempt.maxConcurrentBootstrapAttempts,
      fetchInvocations: { ...attempt.fetchInvocations },
      networkReceipt: attempt.networkReceipt,
    })),
    fetches: fetchObservations.map((observation) => ({ ...observation })),
    authEvents: authEvents.map((event) => ({ ...event })),
  }, null, 2);
}
