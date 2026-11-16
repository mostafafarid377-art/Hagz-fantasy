/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../../translations';
import type { PointsSnapshot } from '../../services/points';

const { live } = vi.hoisted(() => ({ live: { current: {} as Record<string, unknown> } }));
vi.mock('../../hooks/useLive', () => ({ useLive: () => live.current }));
import { LiveSquad } from './Squad';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
});
afterEach(cleanup);

const player = (id: string, name: string, slot: number) => ({
  league_player_id: id, name, position: 'MID', price: 5, rating: 75,
  image_url: null, active: true, slot,
});
const points = (lastGame: Record<string, number>, season: Record<string, number>): PointsSnapshot => ({
  state: 'ready', awaitingScoring: false, error: null,
  lastGame: { byPlayer: lastGame, byTeam: {}, matchId: 'latest', matchLabel: null, playedAt: null },
  season: { byPlayer: season, byTeam: {}, matchId: 'latest', matchLabel: null, playedAt: null },
});
function mount(snapshot: PointsSnapshot) {
  live.current = {
    loading: false, leagueId: 'league', league: { market_open: true }, players: [], points: snapshot,
    squad: { players: [player('a', 'Alice', 1), player('b', 'Bob', 2)], formation: '4-3-3', captain_id: null, vice_captain_id: null, budget: 100, spent: 10 },
  };
  render(<MemoryRouter><LiveSquad /></MemoryRouter>);
}
function sheetPoints() {
  const dialog = screen.getByRole('dialog');
  const label = within(dialog).getByText('Last game points');
  return label.parentElement?.querySelector('strong')?.textContent;
}
describe('live player sheet last-game points', () => {
  it('shows the latest match score, never the larger season total', () => {
    mount(points({ a: 7 }, { a: 45 }));
    fireEvent.click(screen.getByRole('button', { name: 'Player details: Alice' }));
    expect(sheetPoints()).toBe('7');
  });
  it('shows a dash when the player did not score in the latest approved match', () => {
    mount(points({ a: 7 }, { b: 45 }));
    fireEvent.click(screen.getByRole('button', { name: 'Player details: Bob' }));
    expect(sheetPoints()).toBe('—');
  });
  it('preserves a genuine zero score', () => {
    mount(points({ a: 0 }, { a: 45 }));
    fireEvent.click(screen.getByRole('button', { name: 'Player details: Alice' }));
    expect(sheetPoints()).toBe('0');
  });
});
