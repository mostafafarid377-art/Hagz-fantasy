/**
 * UI-component regression tests (jsdom, mocked Supabase RPC boundary). These
 * verify the Fixtures screen and shared scheduling form, not hosted behaviour.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LiveFixtures, LiveMatchCenter } from './Match';
import { LivePlayerSheet } from './LivePlayerSheet';
import { PlayerSheet } from '../../components/PlayerSheet';
import * as api from '../../services/api';
import { useLive } from '../../hooks/useLive';

vi.mock('react-i18next', async importOriginal => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../hooks/useLive', () => ({ useLive: vi.fn() }));
vi.mock('../../services/api', () => ({
  realTeams: vi.fn(), createRealTeam: vi.fn(), createMatch: vi.fn(), matches: vi.fn(), setMatchLineup: vi.fn(), setMatchScore: vi.fn(),
}));
vi.mock('./League', () => ({
  ErrorNote: () => null, Loading: () => <div>loading</div>, PartialDataNote: () => null,
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });
const showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
beforeEach(() => { HTMLDialogElement.prototype.showModal = showModal; });

const mockLive = (isLeader = true) => ({
  loading: false, league: { league_id: 'league-1', name: 'League', role: 'leader', status: 'active', is_leader: isLeader, is_organizer: false },
  leagueId: 'league-1', isLeader, members: [{ user_id: 'organizer-1', name: 'Organizer', role: 'manager', status: 'active', is_organizer: true }],
  players: [], gameweeks: [], matches: [{ id: 'match-1', gameweek_id: null, starts_at: '2026-11-17T19:00:00Z', venue: 'Cage',
    team_a_id: 'a', team_a: 'North', team_b_id: 'b', team_b: 'South', organizer_id: 'organizer-1',
    starters_per_side: 7, max_substitutes: 5, revision_id: null, revision_version: null,
    revision_state: null, team_a_score: null, team_b_score: null, events: [], history: [] }],
  error: null, partialFailures: [], refreshMatches: vi.fn().mockResolvedValue(undefined), reload: vi.fn(),
});

function renderFixtures(value = mockLive()) {
  vi.mocked(useLive).mockReturnValue(value as never);
  return render(<MemoryRouter><LiveFixtures /></MemoryRouter>);
}

describe('Live fixtures and scheduling', () => {
  it('shows match details/navigation and exposes scheduling to the Leader without Gameweek setup', () => {
    renderFixtures();
    expect(screen.getByText('North')).toBeTruthy();
    expect(screen.getByText('South')).toBeTruthy();
    expect(screen.getByText('No gameweek link')).toBeTruthy();
    expect(screen.getByText('Show match').closest('a')?.getAttribute('href')).toBe('/match-center/match-1');
    expect(screen.getByRole('button', { name: 'Schedule match' })).toBeTruthy();
  });

  it('opens a persistent match URL directly to match details and revision history', async () => {
    const live: any = mockLive();
    live.matches[0].revision_state = 'approved';
    live.matches[0].team_a_score = 2; live.matches[0].team_b_score = 1;
    live.matches[0].history = [{ revision_id: 'revision-1', version: 1, state: 'approved', team_a_score: 2, team_b_score: 1,
      submissions: [], events: [], correction: null, lineups: [] } as never];
    vi.mocked(useLive).mockReturnValue(live as never);
    render(<MemoryRouter initialEntries={['/match-center/match-1']}><Routes>
      <Route path="/match-center" element={<LiveMatchCenter />} />
      <Route path="/match-center/:matchId" element={<LiveMatchCenter />} />
    </Routes></MemoryRouter>);
    const dialog = await screen.findByRole('dialog') as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(showModal).toHaveBeenCalledOnce();
    expect(screen.getByText('North vs South')).toBeTruthy();
    expect(screen.getByText(/Revision 1 · approved/)).toBeTruthy();
    const workflow = dialog.querySelector('.match-workflow');
    const closeBar = dialog.querySelector('.sheet-actions');
    expect(workflow).not.toBeNull();
    expect(closeBar?.parentElement).toBe(dialog);
    expect(workflow?.contains(closeBar)).toBe(false);

    fireEvent.click(closeBar!.querySelector('button')!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('creates and verifies a standalone match through the shared Fixtures workflow', async () => {
    const live = mockLive();
    vi.mocked(api.realTeams).mockResolvedValue([
      { id: 'real-a', name: 'North', active: true }, { id: 'real-b', name: 'South', active: true },
    ]);
    vi.mocked(api.createMatch).mockResolvedValue({ id: 'new-match', starts_at: '2026-11-20T18:00:00Z', organizer_id: 'organizer-1' });
    vi.mocked(api.matches).mockResolvedValue([{ ...live.matches[0], id: 'new-match', starts_at: '2026-11-20T18:00:00Z' }] as never);

    renderFixtures(live);
    fireEvent.click(screen.getByRole('button', { name: 'Schedule match' }));
    await screen.findByText('Schedule a real match');
    expect(screen.getByRole('option', { name: 'No gameweek' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Team A'), { target: { value: 'real-a' } });
    fireEvent.change(screen.getByLabelText('Team B'), { target: { value: 'real-b' } });
    fireEvent.change(screen.getByLabelText('Assigned Organizer'), { target: { value: 'organizer-1' } });
    fireEvent.change(screen.getByLabelText('Date & kick-off'), { target: { value: '2026-11-20T18:00' } });
    fireEvent.change(screen.getByLabelText('Venue'), { target: { value: 'Community Ground' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create match' }));

    await waitFor(() => expect(api.createMatch).toHaveBeenCalledWith('league-1', expect.objectContaining({
      gameweekId: null, teamA: 'real-a', teamB: 'real-b', organizerId: 'organizer-1', venue: 'Community Ground',
    })));
    await waitFor(() => expect(api.matches).toHaveBeenCalledWith('league-1'));
    await waitFor(() => expect(live.refreshMatches).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Schedule a real match')).toBeNull());
  });

  it('saves both lineups, then confirms the exact server-persisted selections before showing success', async () => {
    const live: any = mockLive();
    live.players = [
      { player_id: 'player-a', name: 'A Player', position: 'DEF', active: true },
      { player_id: 'player-b', name: 'B Player', position: 'MID', active: true },
    ];
    live.matches[0].revision_id = 'lineup-draft';
    live.matches[0].revision_state = 'draft';
    live.matches[0].history = [{ revision_id: 'lineup-draft', version: 1, state: 'draft', team_a_score: null, team_b_score: null,
      submissions: [], events: [], correction: null, lineups: [] }];
    const savedLineups = [
      { team_id: 'a', players: [{ player_id: 'player-a', selection: 'starter' }] },
      { team_id: 'b', players: [{ player_id: 'player-b', selection: 'starter' }] },
    ];
    vi.mocked(useLive).mockReturnValue(live as never);
    vi.mocked(api.setMatchLineup).mockResolvedValue({} as never);
    vi.mocked(api.matches).mockResolvedValue([{ ...live.matches[0], history: [{ ...live.matches[0].history[0], lineups: savedLineups }] }] as never);
    render(<MemoryRouter><LiveMatchCenter /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const choices = await screen.findAllByRole('checkbox');
    fireEvent.click(choices[0]);
    fireEvent.click(choices[3]);
    fireEvent.click(screen.getByRole('button', { name: 'Save both lineups' }));
    await waitFor(() => expect(api.setMatchLineup).toHaveBeenCalledTimes(2));
    expect(api.matches).toHaveBeenCalledWith('league-1');
    expect((await screen.findByRole('status')).textContent).toContain('Both lineups saved and verified on the server.');
    expect(api.setMatchLineup).toHaveBeenNthCalledWith(1, 'league-1', 'lineup-draft', 'a', [expect.objectContaining({ player_id: 'player-a', selection: 'starter' })]);
    expect(api.setMatchLineup).toHaveBeenNthCalledWith(2, 'league-1', 'lineup-draft', 'b', [expect.objectContaining({ player_id: 'player-b', selection: 'starter' })]);
  });

  it('keeps score input empty while cleared and only saves a valid edited value', async () => {
    const live: any = mockLive();
    live.matches[0].history = [
      { revision_id: 'result-draft', version: 2, state: 'draft', team_a_score: null, team_b_score: null,
        submissions: [], events: [], correction: null,
        lineups: [{ team_id: 'a', players: [] }, { team_id: 'b', players: [] }] },
      { revision_id: 'lineup-approved', version: 1, state: 'approved', team_a_score: null, team_b_score: null,
        submissions: [{ kind: 'lineup', approval: { decision: 'approved', id: 'lineup-approval' } }], events: [], correction: null, lineups: [] },
    ];
    vi.mocked(useLive).mockReturnValue(live as never);
    vi.mocked(api.setMatchScore).mockResolvedValue({} as never);
    render(<MemoryRouter><LiveMatchCenter /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const score = await screen.findByRole('spinbutton', { name: 'North score' }) as HTMLInputElement;
    const save = screen.getByRole('button', { name: 'Save score' });
    fireEvent.change(score, { target: { value: '' } });
    expect(score.value).toBe('');
    expect(save).toHaveProperty('disabled', true);
    fireEvent.change(score, { target: { value: '2' } });
    expect(score.value).toBe('2');
    fireEvent.click(save);
    await waitFor(() => expect(api.setMatchScore).toHaveBeenCalledWith('league-1', 'result-draft', 2, 0));
  });

  it('does not expose scheduling to a non-Leader', () => {
    renderFixtures(mockLive(false));
    expect(screen.queryByRole('button', { name: 'Schedule match' })).toBeNull();
  });

  it('places the player Remove action beside Select Replacement in the Live player sheet', () => {
    const player = { id: 'market-player', leagueId: 'league-1', name: 'A Player', position: 'MID', price: 5, rating: 80,
      active: true, points: 0, color: '#a9b9a5', attributes: { pace: 0, shooting: 0, passing: 0, defending: 0, physical: 0 } } as never;
    const remove = vi.fn();
    render(<MemoryRouter><LivePlayerSheet player={player} players={[player]} ownedIds={['market-player']} starter editing
      captainId={null} viceId={null} remaining={10} marketOpen canSwap={false} busy={false} error="" points={undefined}
      close={vi.fn()} startSwap={vi.fn()} setCaptain={vi.fn()} transfer={vi.fn()} remove={remove} /></MemoryRouter>);
    const removeButton = screen.getByRole('button', { name: 'Remove' });
    const replacementButton = screen.getByRole('button', { name: 'Select replacement' });
    expect(removeButton.parentElement).toBe(replacementButton.parentElement);
    fireEvent.click(removeButton);
    expect(remove).toHaveBeenCalledOnce();
  });

  it('keeps Demo player removal available beside replacement in the builder sheet', () => {
    if (!HTMLDialogElement.prototype.showModal) HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
    const player = { id: 'demo-player', leagueId: 'demo-league', name: 'Demo Player', position: 'MID', price: 5, rating: 80,
      active: true, points: 0, color: '#a9b9a5', attributes: { pace: 70, shooting: 70, passing: 70, defending: 70, physical: 70 } } as never;
    const remove = vi.fn();
    render(<MemoryRouter><PlayerSheet player={player} players={[player]} squad={{ playerIds: ['demo-player'], captainId: null, viceCaptainId: null } as never}
      budget={100} marketOpen builder close={vi.fn()} startSwap={vi.fn()} canSwap={false} transfer={() => null} remove={remove} setCaptain={vi.fn()} /></MemoryRouter>);
    const removeButton = screen.getByRole('button', { name: 'Remove' });
    expect(removeButton.parentElement).toBe(screen.getByRole('button', { name: 'Select replacement' }).parentElement);
    fireEvent.click(removeButton);
    expect(remove).toHaveBeenCalledOnce();
  });
});
