// Player image upload to Supabase Storage.
//
// THE STORAGE POLICY IS READ-ONLY BY DESIGN. Migration 003 creates a private
// bucket with exactly one policy: SELECT for authenticated league members. There
// is deliberately NO insert/update/delete policy, because no secure upload design
// has been reviewed yet. That means an upload from the browser WILL be refused by
// Storage until such a policy exists.
//
// This module therefore does not pretend to upload. It validates the file fully
// (type, magic bytes, size), reports precisely what is missing, and tells the
// caller to fall back to a URL or no image. Claiming an upload succeeded when the
// policy forbids it would be the worst possible behaviour: the leader would think
// the player has a photo and it would silently vanish.
//
// When an upload policy is reviewed and applied, only `uploadBlocked` changes.

import { getSupabase, PLAYER_IMAGES_BUCKET } from '../lib/supabase';
import { imageSignature, MAX_UPLOAD_BYTES, validImageFile } from '../utils/image';

export type UploadBlockedReason = 'notConfigured' | 'policyNotReviewed' | 'invalidFile' | 'tooLarge' | 'failed';

export class StorageError extends Error {
  constructor(public code: UploadBlockedReason, message: string) { super(message); this.name = 'StorageError'; }
}

/** Read the first bytes of a file so the extension cannot lie about the type. */
async function head(file: File, count = 12): Promise<Uint8Array> {
  const buffer = await file.slice(0, count).arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Validate and inspect an image without uploading it. Used by the picker to show
 * a preview and by the upload path to refuse a mislabelled file.
 */
export async function inspectImage(file: File): Promise<{ mime: string; ext: string }> {
  if (!validImageFile(file)) {
    throw new StorageError(file.size > MAX_UPLOAD_BYTES ? 'tooLarge' : 'invalidFile',
      'Choose a JPG, PNG or WebP image up to 5 MB');
  }
  const signature = imageSignature(await head(file));
  if (!signature || signature !== file.type) {
    throw new StorageError('invalidFile', 'This file is not a valid image of the declared type');
  }
  const ext = signature === 'image/jpeg' ? 'jpg' : signature === 'image/png' ? 'png' : 'webp';
  return { mime: signature, ext };
}

/**
 * Object path. The bucket stores league-scoped paths:
 *   <league uuid>/players/<random uuid>.<ext>
 * The regex in ff_private.can_read_image() enforces exactly this shape, and the RPC
 * rejects any image_path outside the current league prefix - so a crafted path
 * cannot point at another league's objects.
 */
export function objectPath(leagueId: string, ext: string): string {
  return `${leagueId}/players/${crypto.randomUUID()}.${ext}`;
}

export const uploadBlocked = true;

/**
 * Attempt an upload. Throws StorageError('policyNotReviewed') before touching the
 * network, so the caller gets a deterministic answer instead of an opaque 403.
 */
export async function uploadPlayerImage(leagueId: string, file: File): Promise<string> {
  await inspectImage(file);
  if (uploadBlocked) {
    throw new StorageError('policyNotReviewed',
      'Image upload is not enabled: no upload policy has been reviewed for this bucket. ' +
      'Use an image URL instead, or ask for the upload design to be approved.');
  }
  const supabase = getSupabase();
  if (!supabase) throw new StorageError('notConfigured', 'Supabase is not configured');
  const { ext } = await inspectImage(file);
  const path = objectPath(leagueId, ext);
  const { error } = await supabase.storage.from(PLAYER_IMAGES_BUCKET).upload(path, file, {
    contentType: file.type, upsert: false, cacheControl: '3600',
  });
  if (error) throw new StorageError('failed', error.message);
  return path;
}

/**
 * A short-lived signed URL for a private object. Returns null (never throws) when
 * the object is unreadable, so a missing image degrades to the initials avatar.
 */
export async function imageUrl(path: string | null): Promise<string | null> {
  if (!path) return null;
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase.storage.from(PLAYER_IMAGES_BUCKET).createSignedUrl(path, 3600);
  if (error || !data) return null;
  return data.signedUrl;
}
