/** @vitest-environment jsdom
 * Live player editor dialog regression: modal stacking/closing and a successful
 * save. The API boundary and browser <dialog> implementation are mocked here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '../../translations';

const mocks = vi.hoisted(() => ({ savePlayer: vi.fn() }));
vi.mock('../../hooks/useLive', () => ({
  useLive: () => ({
    loading: false,
    league: { league_id: 'league-1', name: 'League', market_open: true },
    isLeader: true,
    players: [],
    error: null,
    savePlayer: mocks.savePlayer,
  }),
}));
vi.mock('./League', () => ({
  ErrorNote: () => null,
  Loading: () => <div>Loading</div>,
  PartialDataNote: () => null,
  Success: () => null,
}));

import { LiveManagement } from './Market';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
beforeEach(() => {
  // jsdom does not put dialogs in the browser top layer. Model showModal so the
  // test can assert the app uses the modal path instead of only the open attribute.
  HTMLDialogElement.prototype.showModal = showModal;
});

describe('Live market player dialog', () => {
  it('opens modally and closes after a successful save', async () => {
    mocks.savePlayer.mockResolvedValue(undefined);
    render(<LiveManagement />);

    fireEvent.click(screen.getByRole('button', { name: /add player/i }));
    const dialog = await screen.findByRole('dialog') as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(showModal).toHaveBeenCalledOnce();

    fireEvent.change(screen.getByLabelText('Player name'), { target: { value: 'New Market Player' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocks.savePlayer).toHaveBeenCalledWith(expect.objectContaining({
      name: 'New Market Player', position: 'MID', price: 5_000_000, rating: 75, active: true,
    })));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes cleanly on Escape so the sheet cannot remain detached from its parent state', async () => {
    render(<LiveManagement />);
    fireEvent.click(screen.getByRole('button', { name: /add player/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent(dialog, new Event('close'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
