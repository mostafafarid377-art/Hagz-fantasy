import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ getSupabase: () => ({ rpc }) }));

import { bootstrap, matches, saveMatchLineups, submitSuggestionBatch, transfers } from './api';

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
    await expect(pending).rejects.toThrow('aborted');
  });

  it('times out a read that never settles and aborts its request', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    rpc.mockReturnValue({ abortSignal: (signal: AbortSignal) => {
      requestSignal = signal;
      return new Promise(() => {});
    } });
    const pending = expect(bootstrap(undefined, { timeoutMs: 25 })).rejects.toMatchObject({
      code: 'network', detail: 'timeout',
    });

    await vi.advanceTimersByTimeAsync(25);
    await pending;
    expect(requestSignal?.aborted).toBe(true);
  });

  it('requests transfer history only for the selected league and bounded page size', async () => {
    const result = [{ id: 't1' }];
    rpc.mockResolvedValue({ data: result, error: null });
    await expect(transfers('league-2', 40)).resolves.toBe(result);
    expect(rpc).toHaveBeenCalledWith('ff_transfers', { p_league: 'league-2', p_limit: 40 });
  });
});
