import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ getSupabase: () => ({ rpc }) }));

import { createBootstrapSession, matches, saveMatchLineups, submitSuggestionBatch, transfers } from './api';
import {
  createBootstrapDiagnosticFetch, getBootstrapDiagnostics, getBootstrapFetchDiagnostics,
  makeSanitizedBootstrapReport,
} from './bootstrapDiagnostics';

const boot = { profile: { id: 'u1', display_name: 'Player' }, leagues: [] };

describe('Phase 4 Live RPC adapters', () => {
  beforeEach(() => { rpc.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('sends a suggestion batch in one RPC while preserving each independent item', async () => {
    const result = [{ id: 's1', name: 'Same Name' }, { id: 's2', name: 'Same Name' }];
    rpc.mockResolvedValue({ data: result, error: null });
    await expect(submitSuggestionBatch('league-1', [
      { name: 'Same Name', position: 'MID', notes: 'First person', imageUrl: 'https://one.example/a.png' },
      { name: 'Same Name', position: 'FWD' },
    ])).resolves.toBe(result);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('ff_suggestion_submit_batch', {
      p_league: 'league-1',
      p_items: [
        { name: 'Same Name', position: 'MID', notes: 'First person', image_path: null, image_url: 'https://one.example/a.png' },
        { name: 'Same Name', position: 'FWD', notes: null, image_path: null, image_url: null },
      ],
    });
  });

  it('calls the atomic two-lineup RPC with named arguments and propagates cancellation', async () => {
    const response = { revision_id: 'revision-1', team_a: { lineup_id: 'la', players: 1 }, team_b: { lineup_id: 'lb', players: 1 }, saved: true };
    const signal = new AbortController().signal;
    const abortSignal = vi.fn().mockResolvedValue({ data: response, error: null });
    rpc.mockReturnValue({ abortSignal });
    const sideA = [{ player_id: 'player-a', selection: 'starter' as const, actual_position: 'DEF' as const,
      eligibility_kind: 'market' as const, eligibility_evidence: { source: 'league_market' } }];
    const sideB = [{ player_id: 'player-b', selection: 'substitute' as const, actual_position: 'FWD' as const,
      eligibility_kind: 'market' as const, eligibility_evidence: { source: 'league_market' } }];

    await expect(saveMatchLineups('league-1', 'revision-1', sideA, sideB, { signal })).resolves.toBe(response);
    expect(rpc).toHaveBeenCalledWith('ff_match_save_lineups', {
      p_league: 'league-1', p_revision: 'revision-1', p_team_a_players: sideA, p_team_b_players: sideB,
    });
    expect(abortSignal).toHaveBeenCalledWith(signal);
  });

  it('passes a combined abort signal to the match read-model RPC', async () => {
    const caller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const abortSignal = vi.fn((signal: AbortSignal) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    rpc.mockReturnValue({ abortSignal });

    const pending = matches('league-1', { signal: caller.signal });
    expect(rpc).toHaveBeenCalledWith('ff_matches', { p_league: 'league-1' });
    expect(abortSignal).toHaveBeenCalledTimes(1);
    expect(requestSignal).not.toBe(caller.signal);
    caller.abort();
    expect(requestSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: 'network', detail: 'cancelled' });
  });

  it('shares a single bootstrap promise, POST, deadline, and diagnostic record', async () => {
    let resolve!: (response: { data: typeof boot; error: null }) => void;
    const pending = new Promise<{ data: typeof boot; error: null }>(
      (done) => { resolve = done; },
    );
    const retry = vi.fn();
    const abortSignal = vi.fn().mockReturnValue(pending);
    rpc.mockReturnValueOnce({ retry, abortSignal }).mockResolvedValue({ data: boot, error: null });
    const bootstrap = createBootstrapSession('u1', { displayName: 'Player' });
    const first = bootstrap.load();
    expect(bootstrap.load()).toBe(first);
    expect(bootstrap.load({ retry: true })).toBe(first);

    await Promise.resolve();
    expect(rpc.mock.calls).toEqual([['ff_bootstrap', { p_display_name: 'Player' }]]);
    expect(retry.mock.calls).toEqual([[false]]);
    expect(abortSignal).toHaveBeenCalledTimes(1);
    resolve({ data: boot, error: null });
    await expect(first).resolves.toBe(boot);
    expect(getBootstrapDiagnostics().slice(-1)[0]).toMatchObject({
      maxConcurrentBootstrapAttempts: 1, outcome: 'success',
    });

    await expect(bootstrap.load()).resolves.toBe(boot);
    expect(rpc).toHaveBeenLastCalledWith('ff_bootstrap', { p_display_name: null });
  });

  it('requires user recovery after PGRST003 and does not replay a queued directory refresh', async () => {
    rpc.mockResolvedValueOnce({ data: null, status: 504, error: { code: 'PGRST003', message: 'pool timeout' } });
    rpc.mockResolvedValueOnce({ data: boot, error: null });
    const bootstrap = createBootstrapSession('u1');

    const failed = expect(bootstrap.load()).rejects.toMatchObject({ detail: 'PGRST003' });
    const queued = expect(bootstrap.load({ afterPending: true })).rejects.toMatchObject({ detail: 'PGRST003' });
    await Promise.all([failed, queued]);
    await expect(bootstrap.load()).rejects.toMatchObject({ detail: 'PGRST003' });
    expect(rpc).toHaveBeenCalledTimes(1);

    await expect(bootstrap.load({ retry: true })).resolves.toBe(boot);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('times out a read that never settles and aborts its request', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    rpc.mockReturnValue({ abortSignal: (signal: AbortSignal) => {
      requestSignal = signal;
      return new Promise(() => {});
    } });
    const pending = expect(createBootstrapSession('u1', { timeoutMs: 25 }).load()).rejects.toMatchObject({
      code: 'network', detail: 'timeout',
    });

    await vi.advanceTimersByTimeAsync(25);
    await pending;
    expect(requestSignal?.aborted).toBe(true);
  });

  it('shows a matching fetch still pending when the real bootstrap read timeout fires', async () => {
    vi.useFakeTimers();
    const pendingFetch = new Promise<Response>(() => {});
    const diagnosticFetch = createBootstrapDiagnosticFetch(
      'https://project.example',
      (() => pendingFetch) as typeof fetch,
    );
    rpc.mockReturnValue({
      abortSignal: (signal: AbortSignal) => diagnosticFetch(new Request(
        'https://project.example/rest/v1/rpc/ff_bootstrap',
        { method: 'POST', signal },
      )),
    });

    const pendingBootstrap = createBootstrapSession('u1').load();
    const bootstrapFailure = expect(pendingBootstrap).rejects.toMatchObject({ code: 'network', detail: 'timeout' });
    await vi.advanceTimersByTimeAsync(15_000);
    await bootstrapFailure;

    const observations = getBootstrapFetchDiagnostics();
    expect(observations[observations.length - 1]).toMatchObject({
      outcome: 'pending', completedAtUtc: null, elapsedMs: null, httpStatus: null, errorClass: null,
    });
    const attempts = getBootstrapDiagnostics();
    expect(attempts[attempts.length - 1]).toMatchObject({ outcome: 'error', timedOut: true });
  });

  it('records a successful bootstrap attempt with UTC timestamps and elapsed time', async () => {
    rpc.mockResolvedValue({ data: boot, error: null });

    await createBootstrapSession('u1').load();

    const attempt = getBootstrapDiagnostics()[getBootstrapDiagnostics().length - 1]!;
    expect(attempt.diagnosticId).toMatch(/^[0-9a-f-]{32,36}$/i);
    expect(attempt.startedAtUtc).toMatch(/Z$/);
    expect(attempt.endedAtUtc).toMatch(/Z$/);
    expect(attempt.elapsedMs).toEqual(expect.any(Number));
    expect(attempt.outcome).toBe('success');
    expect(attempt.timedOut).toBe(false);
    expect(attempt.errorCategory).toBe('none');
  });

  it('records timeout and successful retry as distinct attempts', async () => {
    vi.useFakeTimers();
    rpc.mockReturnValueOnce({ abortSignal: () => new Promise(() => {}) });
    rpc.mockResolvedValueOnce({ data: boot, error: null });

    const bootstrap = createBootstrapSession('u1', { timeoutMs: 25 });
    const first = bootstrap.load();
    const firstFailure = expect(first).rejects.toMatchObject({ code: 'network', detail: 'timeout' });
    await vi.advanceTimersByTimeAsync(25);
    await firstFailure;
    await expect(bootstrap.load()).rejects.toMatchObject({ detail: 'timeout' });
    expect(rpc).toHaveBeenCalledTimes(1);

    await expect(bootstrap.load({ retry: true })).resolves.toBe(boot);
    expect(rpc).toHaveBeenCalledTimes(2);

    const [timedOut, retried] = getBootstrapDiagnostics().slice(-2);
    expect(timedOut.diagnosticId).not.toBe(retried.diagnosticId);
    expect(timedOut.outcome).toBe('error');
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.errorCategory).toBe('timeout');
    expect(retried.outcome).toBe('success');
    expect(retried.errorCategory).toBe('none');
  });

  it('distinguishes authentication failures and keeps raw error text out of reports', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST301', message: 'JWT expired for private@example.test' } });
    const bootstrap = createBootstrapSession('u1');
    await expect(bootstrap.load()).rejects.toMatchObject({ code: 'notAuthenticated' });
    expect(getBootstrapDiagnostics()[getBootstrapDiagnostics().length - 1]?.errorCategory).toBe('authentication');

    rpc.mockRejectedValueOnce(new TypeError('Bearer private-token-value user@example.test'));
    await expect(bootstrap.load()).rejects.toThrow();
    const report = makeSanitizedBootstrapReport();
    expect(report).not.toContain('private-token-value');
    expect(report).not.toContain('user@example.test');
    expect(report).not.toContain('JWT expired');
    expect(report).toContain('networkReceipt');
  });

  it('requests transfer history only for the selected league and bounded page size', async () => {
    const result = [{ id: 't1' }];
    rpc.mockResolvedValue({ data: result, error: null });
    await expect(transfers('league-2', 40)).resolves.toBe(result);
    expect(rpc).toHaveBeenCalledWith('ff_transfers', { p_league: 'league-2', p_limit: 40 });
  });
});
