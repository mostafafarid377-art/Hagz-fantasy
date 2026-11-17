/**
 * Temporary, in-memory diagnostics for ff_bootstrap.
 *
 * Reports deliberately exclude URLs, request/response bodies, headers, tokens,
 * cookies, and account/league identifiers. A fetch invocation is not proof that
 * the browser sent the bytes or that Supabase received the request. Browser-
 * generated CORS preflights are not observable from a page fetch wrapper.
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

export interface BootstrapDiagnostic {
  diagnosticId: string;
  startedAtUtc: string;
  endedAtUtc: string | null;
  elapsedMs: number | null;
  outcome: 'pending' | 'success' | 'error';
  timedOut: boolean;
  errorCategory: BootstrapErrorCategory;
  fetchInvocations: {
    OPTIONS: FetchInvocationObservation;
    POST: FetchInvocationObservation;
  };
  networkReceipt: 'not-confirmed-by-page-instrumentation';
}

const MAX_ATTEMPTS = 10;
const endpointPath = '/rest/v1/rpc/ff_bootstrap';
let attempts: BootstrapDiagnostic[] = [];
const startedAtMonotonic = new Map<string, number>();
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

/** Starts one diagnostic record and keeps it active until its bootstrap settles. */
export async function withBootstrapDiagnostics<T>(operation: () => Promise<T>): Promise<T> {
  const diagnosticId = createDiagnosticId();
  const startWallClock = Date.now();
  const startMonotonic = typeof performance !== 'undefined' ? performance.now() : startWallClock;
  const record: BootstrapDiagnostic = {
    diagnosticId,
    startedAtUtc: new Date(startWallClock).toISOString(),
    endedAtUtc: null,
    elapsedMs: null,
    outcome: 'pending',
    timedOut: false,
    errorCategory: 'none',
    fetchInvocations: {
      OPTIONS: 'not-observable-from-page-fetch',
      POST: 'not-observed',
    },
    networkReceipt: 'not-confirmed-by-page-instrumentation',
  };
  attempts = [...attempts, record].slice(-MAX_ATTEMPTS);
  startedAtMonotonic.set(diagnosticId, startMonotonic);
  activeAttempts.add(diagnosticId);
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
  const monotonicNow = typeof performance !== 'undefined' ? performance.now() : now;
  const elapsedMs = start === undefined ? Math.max(0, now - Date.parse(startRecord.startedAtUtc)) : Math.max(0, Math.round(monotonicNow - start));
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
 * Called by the Supabase client's fetch wrapper. It records only the HTTP method
 * for the exact bootstrap RPC path, and only while an app bootstrap is active.
 */
export function observeBootstrapFetchInvocation(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  configuredSupabaseUrl: string,
): void {
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
    if (target.origin !== configuredOrigin || !target.pathname.endsWith(endpointPath)) return;

    const requestMethod = init?.method ?? (
      typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET'
    );
    const method = requestMethod.toUpperCase();
    if (method !== 'OPTIONS' && method !== 'POST') return;

    const active = [...activeAttempts];
    const observation: FetchInvocationObservation = active.length === 1 ? 'fetch-invoked' : 'ambiguous';
    for (const diagnosticId of active) {
      updateAttempt(diagnosticId, (current) => ({
        ...current,
        fetchInvocations: { ...current.fetchInvocations, [method]: observation },
      }));
    }
  } catch {
    // Diagnostics must never prevent the underlying request from proceeding.
  }
}

/** Wraps fetch without reading or modifying its URL, headers, or body. */
export function createBootstrapDiagnosticFetch(
  configuredSupabaseUrl: string,
  fetchImplementation: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  return (input, init) => {
    observeBootstrapFetchInvocation(input, init, configuredSupabaseUrl);
    return fetchImplementation(input, init);
  };
}

export function subscribeBootstrapDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getBootstrapDiagnostics(): readonly BootstrapDiagnostic[] {
  return attempts;
}

/** Creates an allow-listed JSON report; raw error text and request metadata are never included. */
export function makeSanitizedBootstrapReport(): string {
  return JSON.stringify({
    reportVersion: 1,
    generatedAtUtc: new Date().toISOString(),
    note: 'The diagnostic ID is browser-local and is not sent to Supabase; correlate by UTC timestamps. Fetch invocation does not prove network delivery or Supabase receipt. Browser-generated OPTIONS preflights are not observable by this page fetch hook.',
    attempts: attempts.map((attempt) => ({
      diagnosticId: attempt.diagnosticId,
      startedAtUtc: attempt.startedAtUtc,
      endedAtUtc: attempt.endedAtUtc,
      elapsedMs: attempt.elapsedMs,
      outcome: attempt.outcome,
      timedOut: attempt.timedOut,
      errorCategory: attempt.errorCategory,
      fetchInvocations: { ...attempt.fetchInvocations },
      networkReceipt: attempt.networkReceipt,
    })),
  }, null, 2);
}
