import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ reserve: vi.fn(), cancel: vi.fn(), set: vi.fn(), validate: vi.fn(), signed: vi.fn(), remove: vi.fn(), session: vi.fn() }));
vi.mock('./api', () => ({ reserveImage: f.reserve, cancelImage: f.cancel, setImage: f.set }));
vi.mock('./image', () => ({ validateImage: f.validate }));
vi.mock('../lib/supabase', () => ({
  PLAYER_IMAGES_BUCKET: 'player-images', getPublishableKey: () => 'publishable-key', getStorageBaseUrl: () => 'https://example.test/storage/v1',
  getSupabase: () => ({ auth: { getSession: f.session }, storage: { from: () => ({ createSignedUploadUrl: f.signed, remove: f.remove }) } }),
}));
import { inspectImage, removePlayerImage, uploadPlayerImage } from './storage';
import { MAX_UPLOAD_BYTES } from '../utils/image';
const bytes = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
const file = () => new File([bytes], 'file.png', { type: 'image/png' });
const target = { leagueId: 'league', kind: 'player' as const, targetId: 'player', previousPath: 'old-path' };
class MockXHR {
  static status = 200;
  status = MockXHR.status; upload: { onprogress?: (e: {lengthComputable: boolean; loaded: number; total: number}) => void } = {};
  onload?: () => void; onerror?: () => void; onabort?: () => void;
  open = vi.fn(); setRequestHeader = vi.fn();
  send() { this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 }); queueMicrotask(() => this.onload?.()); }
}
beforeEach(() => {
  vi.stubGlobal('XMLHttpRequest', MockXHR); MockXHR.status=200;
  f.reserve.mockResolvedValue({ path: 'new-path' }); f.cancel.mockResolvedValue(undefined); f.set.mockResolvedValue({ path: 'new-path' });
  f.validate.mockResolvedValue(undefined); f.signed.mockResolvedValue({ data: { signedUrl: 'https://example.test/upload' }, error: null });
  f.remove.mockResolvedValue({ error: null }); f.session.mockResolvedValue({ data: { session: { access_token: 'token' } } });
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
describe('authenticated private image uploads', () => {
  it('uploads with real progress, attaches the path and cleans up the previous object', async () => {
    const progress=vi.fn();
    expect(await uploadPlayerImage(target,file(),progress)).toBe('new-path');
    expect(f.reserve).toHaveBeenCalledWith('league','player','player','png');
    expect(f.set).toHaveBeenCalledWith('league','player','player','old-path','new-path');
    expect(progress.mock.calls.map(c=>c[0])).toEqual([0,50,100]);
    expect(f.remove).toHaveBeenCalledWith(['old-path']);
  });
  it('rejects invalid MIME and files larger than 5 MB before reserving', async () => {
    await expect(inspectImage(new File([bytes], 'x.svg', {type:'image/svg+xml'}))).rejects.toMatchObject({code:'invalidFile'});
    await expect(inspectImage(new File([new Uint8Array(MAX_UPLOAD_BYTES+1)], 'x.png', {type:'image/png'}))).rejects.toMatchObject({code:'tooLarge'});
    expect(f.reserve).not.toHaveBeenCalled();
  });
  it('does not bind an object on upload failure and attempts to clean the draft', async () => {
    MockXHR.status=403;
    await expect(uploadPlayerImage(target,file(),vi.fn())).rejects.toThrow('Image upload was rejected');
    expect(f.set).not.toHaveBeenCalled(); expect(f.cancel).toHaveBeenCalledWith('league','player','player','new-path'); expect(f.remove).toHaveBeenCalledWith(['new-path']);
  });
  it('does not delete a possibly bound object if cancellation fails', async () => {
    MockXHR.status=403; f.cancel.mockRejectedValueOnce(new Error('already bound'));
    await expect(uploadPlayerImage(target,file(),vi.fn())).rejects.toThrow('Image upload was rejected');
    expect(f.cancel).toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
  });
  it('unlinks the record before attempting safe orphan cleanup', async () => {
    await removePlayerImage(target);
    expect(f.set).toHaveBeenCalledWith('league','player','player','old-path',null);
    expect(f.remove).toHaveBeenCalledWith(['old-path']);
    expect(f.set.mock.invocationCallOrder[0]).toBeLessThan(f.remove.mock.invocationCallOrder[0]);
  });
});
