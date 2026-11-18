/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import { reserveOperation, readOperation, clearOperation, submitOperation, inspectOperation, cancelOperation, type ReceiptTransport } from './operationReceipts';

const transport = (): ReceiptTransport => ({
  register: vi.fn(async () => ({ state: 'pending' as const })),
  execute: vi.fn(async () => ({ state: 'committed' as const, result: { id: 'ok' } })),
  status: vi.fn(async () => ({ state: 'unknown' as const })),
  cancel: vi.fn(async () => ({ state: 'cancelled' as const })),
});

describe('durable receipt primitives', () => {
  it('atomically reserves a per-account scope across concurrent callers and restores it', async () => {
    const results = await Promise.allSettled([reserveOperation('user-a', 'league-create', 'league_create', {}), reserveOperation('user-a', 'league-create', 'league_create', {})]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const op = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof reserveOperation>>>).value;
    expect(op.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await readOperation('user-a', 'league-create')).toEqual(op);
    expect(await readOperation('user-b', 'league-create')).toBeUndefined();
    await expect(clearOperation(op, { state: 'unknown' })).rejects.toThrow(/unresolved/);
    await clearOperation(op, { state: 'cancelled' });
  });
  it('keeps the same ID after an ambiguous write and recovery never executes', async () => {
    const op = await reserveOperation('user-a', 'team-a', 'lineup_save', {}); const api = transport();
    vi.mocked(api.execute).mockRejectedValueOnce(new TypeError('lost response'));
    await expect(submitOperation(op, api, () => true)).rejects.toThrow();
    const restored = await readOperation('user-a', 'team-a');
    expect(restored).toEqual(op);
    expect(restored?.operationId).toBe(op.operationId);
    expect(await inspectOperation(op, api, () => true)).toEqual({ state: 'unknown' });
    expect(api.execute).toHaveBeenCalledTimes(1);
    expect(await cancelOperation(op, api, () => true)).toEqual({ state: 'cancelled' });
    expect(vi.mocked(api.cancel).mock.calls[0][0].operationId).toBe(op.operationId);
    await clearOperation(op, { state: 'cancelled' });
  });
  it('does not execute after an account switch during registration', async () => {
    const op = await reserveOperation('old-user', 'league-create', 'league_create', {}); const api = transport();
    let active = true;
    vi.mocked(api.register).mockImplementationOnce(async () => { active = false; return { state: 'pending' }; });
    await expect(submitOperation(op, api, () => active)).rejects.toThrow(/Account changed/);
    expect(api.execute).not.toHaveBeenCalled();
    expect(await readOperation('old-user', 'league-create')).toEqual(op);
    expect(await readOperation('new-user', 'league-create')).toBeUndefined();
    await clearOperation(op, { state: 'cancelled' });
  });
  it('does not clear a newer operation when a stale completion arrives', async () => {
    const old = await reserveOperation('user-a', 'team-b', 'squad_buy', {});
    await clearOperation(old, { state: 'cancelled' });
    const next = await reserveOperation('user-a', 'team-b', 'squad_sell', {});
    await clearOperation(old, { state: 'committed' });
    expect(await readOperation('user-a', 'team-b')).toEqual(next);
    await clearOperation(next, { state: 'cancelled' });
  });
});
