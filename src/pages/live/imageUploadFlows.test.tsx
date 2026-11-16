/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../../translations';
const f = vi.hoisted(() => ({ live: {} as Record<string, unknown>, upload: vi.fn(), remove: vi.fn(), inspect: vi.fn(), market: vi.fn() }));
vi.mock('../../hooks/useLive', () => ({ useLive: () => f.live }));
vi.mock('../../services/storage', () => ({ inspectImage: f.inspect, uploadPlayerImage: f.upload, removePlayerImage: f.remove, imageUrl: vi.fn().mockResolvedValue(null) }));
vi.mock('../../services/api', () => ({ marketPlayers: f.market }));
import { LiveApprovals, LiveManagement, LiveSuggestPlayer } from './Market';
const player = { id:'lp', player_id:'profile', name:'Player One', league_id:'league', position:'MID', rating:75, price:5000000, active:true, image_path:'old', image_url:null };
const suggestion = { id:'suggestion', name:'Proposed', position:'MID', notes:null, status:'pending', image_path:null, image_url:null, submitted_by:'bob', submitted_by_name:'Bob' };
const file = () => new File(['picture'], 'picture.png', {type:'image/png'});
beforeAll(() => { HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open',''); }; URL.createObjectURL = vi.fn(()=>'blob:preview'); URL.revokeObjectURL = vi.fn(); });
beforeEach(() => {
  f.inspect.mockResolvedValue({ mime:'image/png', ext:'png' }); f.upload.mockResolvedValue('new'); f.remove.mockResolvedValue(undefined); f.market.mockResolvedValue([player]);
  f.live = { leagueId:'league', loading:false, league:{market_open:true}, isLeader:true, myUserId:'leader', players:[player], suggestions:[suggestion], reload:vi.fn().mockResolvedValue(undefined), savePlayer:vi.fn().mockResolvedValue(player), suggestPlayer:vi.fn().mockResolvedValue(suggestion), reviewSuggestion:vi.fn().mockResolvedValue({league_player_id:'lp'}) };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const mount=(node:React.ReactElement)=>render(<MemoryRouter>{node}</MemoryRouter>);
async function choose(scope: HTMLElement) {
  fireEvent.change(within(scope).getByLabelText('Choose an image'), {target:{files:[file()]}});
  await waitFor(() => expect(within(scope).getByAltText('Image preview')).toBeTruthy());
}
describe('live upload workflows (mocked storage)', () => {
  it('replaces a player image after saving the player', async () => {
    mount(<LiveManagement />); fireEvent.click(screen.getByRole('button',{name:'Edit'}));
    const dialog=screen.getByRole('dialog'); await choose(dialog);
    fireEvent.click(within(dialog).getByRole('button',{name:'Save'}));
    await waitFor(() => expect(f.upload).toHaveBeenCalledWith(expect.objectContaining({kind:'player', targetId:'profile', previousPath:'old'}), expect.any(File), expect.any(Function)));
    expect(f.live.reload).toHaveBeenCalled();
  });
  it('creates the suggestion before uploading its file', async () => {
    mount(<LiveSuggestPlayer />); fireEvent.change(screen.getByLabelText('Player name'),{target:{value:'New Player'}});
    await choose(screen.getByRole('button',{name:'Submit suggestion'}).closest('form')!);
    fireEvent.click(screen.getByRole('button',{name:'Submit suggestion'}));
    await waitFor(() => expect(f.upload).toHaveBeenCalledWith(expect.objectContaining({kind:'suggestion', targetId:'suggestion'}),expect.any(File),expect.any(Function)));
    expect((f.live.suggestPlayer as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(f.upload.mock.invocationCallOrder[0]);
  });
  // SECURITY FINDING: approval publishes first, then removes the image. This
  // exposes the original image during the gap; the mock only establishes ordering.
  it('SECURITY FINDING: approval occurs before a requested image removal', async () => {
    f.live.suggestions=[{...suggestion, image_url:'https://example.test/private.png'}];
    mount(<LiveApprovals />); fireEvent.click(screen.getByRole('button',{name:'Review'}));
    const dialog=screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button',{name:'Remove image'}));
    fireEvent.click(within(dialog).getByRole('button',{name:'Approve and publish'}));
    await waitFor(() => expect(f.remove).toHaveBeenCalled());
    expect((f.live.reviewSuggestion as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(f.remove.mock.invocationCallOrder[0]);
  });
  it('uploads a leader-selected replacement after approval', async () => {
    mount(<LiveApprovals />); fireEvent.click(screen.getByRole('button',{name:'Review'}));
    const dialog=screen.getByRole('dialog'); await choose(dialog);
    fireEvent.click(within(dialog).getByRole('button',{name:'Approve and publish'}));
    await waitFor(() => expect(f.upload).toHaveBeenCalledWith(expect.objectContaining({kind:'player',targetId:'profile',previousPath:'old'}),expect.any(File),expect.any(Function)));
  });
});
