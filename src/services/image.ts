import { imageSignature, MAX_UPLOAD_BYTES, validImageFile } from '../utils/image';

// The app stores an opaque reference in player records, never the blob itself.
// This boundary can later be replaced with Supabase Storage without changing consumers.
const prefix = 'local-image:';
const drafts = new Set<string>();
const DB = 'fantasy-friends-images';
const STORE = 'images';
export type ImageError = 'tooLarge' | 'invalid' | 'storage';
export class ImageServiceError extends Error { constructor(public code: ImageError) { super(code); } }
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Image database blocked'));
  });
}
async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode); const request = action(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error || request.error); };
  });
}
export function isLocalImage(value?: string): boolean { return !!value?.startsWith(prefix); }
export async function validateImage(file: File): Promise<void> {
  if (file.size > MAX_UPLOAD_BYTES) throw new ImageServiceError('tooLarge');
  if (!validImageFile(file)) throw new ImageServiceError('invalid');
  const signature = imageSignature(new Uint8Array(await file.slice(0,12).arrayBuffer()));
  if (signature !== file.type) throw new ImageServiceError('invalid');
  // Decoding rejects truncated, corrupted, or mislabeled files even when their header matches.
  const url = URL.createObjectURL(file);
  try {
    await new Promise<void>((resolve, reject) => {
      const image = new Image();
      image.onload = () => image.naturalWidth && image.naturalHeight && image.naturalWidth * image.naturalHeight <= 50_000_000 ? resolve() : reject(new Error('Invalid dimensions'));
      image.onerror = () => reject(new Error('Invalid image'));
      image.src = url;
    });
  } catch { throw new ImageServiceError('invalid'); } finally { URL.revokeObjectURL(url); }
}
export async function saveLocalImage(blob: Blob): Promise<string> {
  const ref = prefix + crypto.randomUUID();
  try { await transaction('readwrite', store => store.put(blob, ref)); }
  catch { throw new ImageServiceError('storage'); }
  drafts.add(ref); return ref;
}
export async function loadLocalImage(ref: string): Promise<Blob | undefined> {
  if (!isLocalImage(ref)) return undefined;
  try { return await transaction('readonly', store => store.get(ref)); } catch { return undefined; }
}
export async function deleteLocalImage(ref: string) {
  if (!isLocalImage(ref) || drafts.has(ref)) return;
  try { await transaction('readwrite', store => store.delete(ref)); } catch { /* Best effort if browser storage is unavailable. */ }
}
export function commitLocalImage(ref?: string) { if (ref) drafts.delete(ref); }
export async function discardDraftImage(ref?: string) {
  if (!ref || !drafts.delete(ref)) return;
  try { await transaction('readwrite', store => store.delete(ref)); } catch { /* Best effort; never delete a committed image. */ }
}
