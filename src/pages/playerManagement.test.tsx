/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { initialState } from '../data/demo';
import { DemoProvider } from '../hooks/useDemo';
import { Management } from './Players';
import '../translations';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function mountManagement() {
  const state = { ...initialState, role: 'leader' as const };
  localStorage.setItem('fantasy-friends-demo-v1', JSON.stringify(state));
  return render(<DemoProvider><MemoryRouter><Management /></MemoryRouter></DemoProvider>);
}

describe('player management form actions', () => {
  it('keeps Save changes in the sticky form action bar', () => {
    mountManagement();
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);

    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save.closest('.player-editor-actions')).toBeTruthy();
    expect(save.closest('form')?.classList.contains('player-editor-form')).toBe(true);
  });

  it('requires confirmation and removes an edited player from the active market', () => {
    mountManagement();
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete player' }));

    expect(screen.getByText(/removes the player from the active market/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));

    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Activate' }).length).toBeGreaterThan(0);
  });
});
