/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '../../translations';

const mocks = vi.hoisted(() => ({ suggestPlayers: vi.fn() }));
vi.mock('../../hooks/useLive', () => ({
  useLive: () => ({
    loading: false,
    league: { league_id: 'league-1', name: 'League', market_open: true },
    suggestions: [],
    suggestPlayers: mocks.suggestPlayers,
  }),
}));
vi.mock('./League', () => ({
  ErrorNote: () => null,
  Loading: () => <div>Loading</div>,
  PartialDataNote: () => null,
  Success: () => null,
}));

import { LiveSuggestPlayer } from './Market';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Live suggestion batches', () => {
  it('submits multiple same-name candidates in one batch with independent fields', async () => {
    mocks.suggestPlayers.mockResolvedValue(undefined);
    render(<LiveSuggestPlayer />);
    fireEvent.change(screen.getAllByLabelText('Player name')[0], { target: { value: 'Same Name' } });
    fireEvent.click(screen.getByRole('button', { name: /add another player/i }));
    const names = screen.getAllByLabelText('Player name');
    fireEvent.change(names[1], { target: { value: 'Same Name' } });
    fireEvent.change(screen.getAllByLabelText('Position')[1], { target: { value: 'FWD' } });
    fireEvent.click(screen.getByRole('button', { name: /submit all suggestions/i }));

    await waitFor(() => expect(mocks.suggestPlayers).toHaveBeenCalledWith([
      { name: 'Same Name', position: 'MID', notes: undefined, imageUrl: null },
      { name: 'Same Name', position: 'FWD', notes: undefined, imageUrl: null },
    ]));
    expect(screen.getByRole('status').textContent).toBeTruthy();
  });

  it('keeps an invalid batch intact and displays the server error without claiming success', async () => {
    mocks.suggestPlayers.mockRejectedValue(new Error('Batch rejected'));
    render(<LiveSuggestPlayer />);
    fireEvent.change(screen.getByLabelText('Player name'), { target: { value: 'Candidate One' } });
    fireEvent.click(screen.getByRole('button', { name: /submit all suggestions/i }));
    expect((await screen.findByRole('alert')).textContent).toContain('Batch rejected');
    expect((screen.getByLabelText('Player name') as HTMLInputElement).value).toBe('Candidate One');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
