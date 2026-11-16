import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ getSupabase: () => ({ rpc }) }));

import { submitSuggestionBatch, transfers } from './api';

describe('Phase 4 Live RPC adapters', () => {
  beforeEach(() => { rpc.mockReset(); });

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

  it('requests transfer history only for the selected league and bounded page size', async () => {
    const result = [{ id: 't1' }];
    rpc.mockResolvedValue({ data: result, error: null });
    await expect(transfers('league-2', 40)).resolves.toBe(result);
    expect(rpc).toHaveBeenCalledWith('ff_transfers', { p_league: 'league-2', p_limit: 40 });
  });
});
