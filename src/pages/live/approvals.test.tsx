/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '../../translations';

const mocks = vi.hoisted(() => ({ reviewSuggestion: vi.fn() }));
vi.mock('../../hooks/useLive', () => ({
  useLive: () => ({
    loading: false,
    league: { league_id: 'league-1', name: 'League', market_open: true },
    isLeader: true,
    myUserId: 'leader-1',
    suggestions: [{
      id: 'suggestion-1', name: 'Samir ahemd', position: 'FWD', notes: null,
      status: 'pending', image_path: null, image_url: null, submitted_by: 'manager-1',
      submitted_by_name: 'Farid', league_player_id: null, created_at: '2026-11-16T10:00:00Z',
      rejection_reason: null,
    }],
    error: null,
    reviewSuggestion: mocks.reviewSuggestion,
  }),
}));
vi.mock('./League', () => ({
  ErrorNote: () => null,
  Loading: () => <div>Loading</div>,
  PartialDataNote: () => null,
  Success: () => null,
}));

import { LiveApprovals } from './Market';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
beforeEach(() => { HTMLDialogElement.prototype.showModal = showModal; });

describe('live suggestion approval sheet', () => {
  it('opens as a modal and presents usable, labeled review fields', async () => {
    mocks.reviewSuggestion.mockResolvedValue(undefined);
    render(<LiveApprovals />);

    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const dialog = await screen.findByRole('dialog') as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(showModal).toHaveBeenCalledOnce();
    expect((screen.getByLabelText('Final price (millions)') as HTMLInputElement).type).toBe('number');
    expect((screen.getByLabelText('Final rating') as HTMLInputElement).max).toBe('99');
    expect(screen.getByLabelText('Rejection reason (required to reject)').tagName).toBe('TEXTAREA');
  });

  it('requires a rejection reason and closes after the decision succeeds', async () => {
    mocks.reviewSuggestion.mockResolvedValue(undefined);
    render(<LiveApprovals />);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    await screen.findByRole('dialog');

    const reject = screen.getByRole('button', { name: 'Reject suggestion' });
    expect((reject as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Rejection reason (required to reject)'), {
      target: { value: 'Not a fit for this league' },
    });
    expect((reject as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(reject);

    await waitFor(() => expect(mocks.reviewSuggestion).toHaveBeenCalledWith(
      'suggestion-1', 'rejected', { reason: 'Not a fit for this league' },
    ));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
