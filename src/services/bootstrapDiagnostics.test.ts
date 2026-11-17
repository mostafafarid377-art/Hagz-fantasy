import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBootstrapDiagnosticFetch,
  getBootstrapAuthEvents,
  getBootstrapDiagnostics,
  getBootstrapFetchDiagnostics,
  makeSanitizedBootstrapReport,
  recordBootstrapAuthEvent,
  subscribeBootstrapDiagnostics,
  withBootstrapDiagnostics,
} from './bootstrapDiagnostics';

const endpoint = 'https://project.example/rest/v1/rpc/ff_bootstrap';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function lastFetch() {
  const observations = getBootstrapFetchDiagnostics();
  return observations[observations.length - 1]!;
}

describe('privacy-safe bootstrap fetch observations', () => {
  it('records fetch start, completion, and numeric status for a successful HTTP 200', async () => {
    const fakeFetch = vi.fn(async () => new Response('sensitive response body', { status: 200 }));
    const diagnosticFetch = createBootstrapDiagnosticFetch('https://project.example', fakeFetch as typeof fetch);
    const request = new Request(`${endpoint}?key=PRIVATE_API_KEY`, {
      method: 'POST',
      headers: { Authorization: 'Bearer PRIVATE_JWT', Cookie: 'PRIVATE_COOKIE' },
      body: 'private@example.test request body',
    });

    await withBootstrapDiagnostics(() => diagnosticFetch(request));

    const observation = lastFetch();
    expect(observation.attribution).toBe('single-active-attempt');
    const attempts = getBootstrapDiagnostics();
    expect(observation.diagnosticId).toBe(attempts[attempts.length - 1]?.diagnosticId);
    expect(observation.startedAtUtc).toMatch(/Z$/);
    expect(observation.completedAtUtc).toMatch(/Z$/);
    expect(observation.elapsedMs).toEqual(expect.any(Number));
    expect(observation.outcome).toBe('resolved');
    expect(observation.httpStatus).toBe(200);
    expect(observation.errorClass).toBeNull();
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it.each([400, 503])('records an HTTP %i response as resolved with status only', async (status) => {
    const diagnosticFetch = createBootstrapDiagnosticFetch(
      'https://project.example',
      (async () => new Response('do not retain this body', { status })) as typeof fetch,
    );

    await withBootstrapDiagnostics(() => diagnosticFetch(endpoint, { method: 'POST' }));

    expect(lastFetch()).toMatchObject({ outcome: 'resolved', httpStatus: status, errorClass: null });
    expect(lastFetch().completedAtUtc).toMatch(/Z$/);
  });

  it('records a rejected fetch as TypeError without retaining its message', async () => {
    const diagnosticFetch = createBootstrapDiagnosticFetch(
      'https://project.example',
      (async () => { throw new TypeError('PRIVATE_JWT private@example.test'); }) as typeof fetch,
    );

    await expect(withBootstrapDiagnostics(() => diagnosticFetch(endpoint, { method: 'POST' }))).rejects.toBeInstanceOf(TypeError);

    expect(lastFetch()).toMatchObject({ outcome: 'rejected', httpStatus: null, errorClass: 'TypeError' });
  });

  it('records an AbortError rejection using only its allow-listed class', async () => {
    const diagnosticFetch = createBootstrapDiagnosticFetch(
      'https://project.example',
      (async () => { throw Object.assign(new Error('sensitive abort detail'), { name: 'AbortError' }); }) as typeof fetch,
    );

    await expect(withBootstrapDiagnostics(() => diagnosticFetch(endpoint, { method: 'POST' }))).rejects.toMatchObject({ name: 'AbortError' });

    expect(lastFetch()).toMatchObject({ outcome: 'rejected', httpStatus: null, errorClass: 'AbortError' });
  });

  it('leaves fetch pending when the bootstrap times out, then records its later completion', async () => {
    vi.useFakeTimers();
    let resolveFetch!: (response: Response) => void;
    const diagnosticFetch = createBootstrapDiagnosticFetch(
      'https://project.example',
      (() => new Promise<Response>((resolve) => { resolveFetch = resolve; })) as typeof fetch,
    );
    const timeoutError = Object.assign(new Error('ff_bootstrap did not respond within 15000 ms'), {
      code: 'network', detail: 'timeout',
    });
    const bootstrap = withBootstrapDiagnostics(() => Promise.race([
      diagnosticFetch(endpoint, { method: 'POST' }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(timeoutError), 15_000)),
    ]));

    const bootstrapFailure = expect(bootstrap).rejects.toMatchObject({ detail: 'timeout' });
    await vi.advanceTimersByTimeAsync(15_000);
    await bootstrapFailure;
    const attempts = getBootstrapDiagnostics();
    expect(attempts[attempts.length - 1]).toMatchObject({ outcome: 'error', timedOut: true, elapsedMs: expect.any(Number) });
    expect(lastFetch()).toMatchObject({ outcome: 'pending', completedAtUtc: null, httpStatus: null, errorClass: null });

    resolveFetch(new Response('still not retained', { status: 200 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(lastFetch()).toMatchObject({ outcome: 'resolved', httpStatus: 200 });
  });

  it('reports concurrent bootstrap fetch attribution as ambiguous instead of guessing', async () => {
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = withBootstrapDiagnostics(() => new Promise<void>((resolve) => { finishFirst = resolve; }));
    const second = withBootstrapDiagnostics(() => new Promise<void>((resolve) => { finishSecond = resolve; }));
    const diagnosticFetch = createBootstrapDiagnosticFetch(
      'https://project.example',
      (async () => new Response(null, { status: 200 })) as typeof fetch,
    );

    await diagnosticFetch(endpoint, { method: 'POST' });

    expect(lastFetch()).toMatchObject({
      diagnosticId: null,
      attribution: 'ambiguous',
      activeBootstrapAttempts: 2,
      outcome: 'resolved',
      httpStatus: 200,
    });
    expect(getBootstrapDiagnostics().slice(-2).every((attempt) => attempt.maxConcurrentBootstrapAttempts === 2)).toBe(true);
    finishFirst();
    finishSecond();
    await Promise.all([first, second]);
  });

  it('records only allow-listed Supabase auth event names and invalidates the report snapshot', () => {
    const previousSnapshot = getBootstrapDiagnostics();
    const listener = vi.fn();
    const unsubscribe = subscribeBootstrapDiagnostics(listener);
    recordBootstrapAuthEvent('TOKEN_REFRESHED');
    recordBootstrapAuthEvent('SIGNED_OUT');
    recordBootstrapAuthEvent('unexpected event with private@example.test');
    unsubscribe();

    expect(getBootstrapDiagnostics()).not.toBe(previousSnapshot);
    expect(listener).toHaveBeenCalled();
    expect(getBootstrapAuthEvents().slice(-3).map((event) => event.event)).toEqual([
      'TOKEN_REFRESHED', 'SIGNED_OUT', 'OTHER',
    ]);
  });

  it('ignores other endpoints and excludes request, response, and exception details from the report', async () => {
    const fakeFetch = vi.fn(async () => new Response('sensitive response body', { status: 200 }));
    const diagnosticFetch = createBootstrapDiagnosticFetch('https://project.example', fakeFetch as typeof fetch);
    await withBootstrapDiagnostics(() => diagnosticFetch('https://project.example/rest/v1/rpc/ff_market_players', { method: 'POST' }));

    const report = makeSanitizedBootstrapReport();
    for (const secret of [
      'PRIVATE_API_KEY', 'PRIVATE_JWT', 'PRIVATE_COOKIE', 'private@example.test',
      'sensitive response body', 'do not retain this body', 'sensitive abort detail',
      'unexpected event with private@example.test', 'https://project.example',
    ]) {
      expect(report).not.toContain(secret);
    }
    expect(report).not.toContain('Authorization');
    expect(report).not.toContain('Cookie');
    expect(report).toContain('fetches');
    expect(report).toContain('authEvents');
    expect(report).toContain('networkReceipt');
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });
});
