// Authenticated uploads to the private player-images bucket. A server-issued
// reservation restricts each immutable object to one authorized player/suggestion.
import { getPublishableKey, getStorageBaseUrl, getSupabase, PLAYER_IMAGES_BUCKET } from '../lib/supabase';
import { reserveImage, setImage } from './api';
import { validateImage } from './image';
import { imageSignature, MAX_UPLOAD_BYTES, validImageFile } from '../utils/image';

export type UploadBlockedReason = 'notConfigured' | 'invalidFile' | 'tooLarge' | 'failed';
export class StorageError extends Error {
  constructor(public code: UploadBlockedReason, message: string) { super(message); this.name = 'StorageError'; }
}
export async function inspectImage(file: File): Promise<{ mime: string; ext: string }> {
  if (!validImageFile(file)) throw new StorageError(file.size > MAX_UPLOAD_BYTES ? 'tooLarge' : 'invalidFile', 'Choose a JPG, PNG or WebP image up to 5 MB');
  const signature = imageSignature(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
  if (!signature || signature !== file.type) throw new StorageError('invalidFile', 'This file is not a valid image of the declared type');
  try { await validateImage(file); } catch { throw new StorageError('invalidFile', 'Choose a valid JPG, JPEG, PNG or WebP image.'); }
  return { mime: signature, ext: signature === 'image/jpeg' ? 'jpg' : signature === 'image/png' ? 'png' : 'webp' };
}

type Target = { leagueId: string; kind: 'player' | 'suggestion'; targetId: string; previousPath: string | null };
function uploadAuthenticated(url: string, file: File, apikey: string, token: string, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('apikey', apikey);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.min(99, Math.round(event.loaded / event.total * 100))); };
    xhr.onerror = () => reject(new StorageError('failed', 'Image upload failed. Check your connection and try again.'));
    xhr.onabort = () => reject(new StorageError('failed', 'Image upload was cancelled.'));
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new StorageError('failed', 'Image upload was rejected. Check storage permissions and try again.'));
    const form = new FormData(); form.append('cacheControl', '3600'); form.append('file', file);
    xhr.send(form);
  });
}
async function cleanup(path: string | null) {
  if (!path) return;
  try { await getSupabase()?.storage.from(PLAYER_IMAGES_BUCKET).remove([path]); } catch { /* Orphan cleanup is best effort; never remove a referenced object. */ }
}
export async function uploadPlayerImage(target: Target, file: File, onProgress: (percent: number) => void): Promise<string> {
  const { ext } = await inspectImage(file);
  const client = getSupabase(), key = getPublishableKey(), base = getStorageBaseUrl();
  if (!client || !key || !base) throw new StorageError('notConfigured', 'Supabase is not configured');
  const { data: session } = await client.auth.getSession();
  if (!session.session?.access_token) throw new StorageError('failed', 'Please sign in before uploading an image.');
  const { path } = await reserveImage(target.leagueId, target.kind, target.targetId, ext);
  try {
    onProgress(0);
    const objectUrl = `${base}/object/${PLAYER_IMAGES_BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;
    await uploadAuthenticated(objectUrl, file, key, session.session.access_token, onProgress);
    await setImage(target.leagueId, target.kind, target.targetId, target.previousPath, path);
    onProgress(100);
  } catch (error) { await cleanup(path); throw error; }
  await cleanup(target.previousPath);
  return path;
}
export async function removePlayerImage(target: Target): Promise<void> {
  await setImage(target.leagueId, target.kind, target.targetId, target.previousPath, null);
  await cleanup(target.previousPath);
}
export async function imageUrl(path: string | null): Promise<string | null> {
  if (!path) return null;
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase.storage.from(PLAYER_IMAGES_BUCKET).createSignedUrl(path, 3600);
  return error || !data ? null : data.signedUrl;
}
