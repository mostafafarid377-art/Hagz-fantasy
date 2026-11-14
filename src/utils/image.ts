// Local images are kept in browser storage in demo mode, not uploaded.
export const MAX_IMAGE_BYTES = 256 * 1024;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const dataPattern = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
export function validImageValue(value: string): boolean {
  if (!value) return true;
  if (value.startsWith('data:')) return value.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 40 && dataPattern.test(value);
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:'; } catch { return false; }
}
export function validImageFile(file: Pick<File, 'type' | 'size'>): boolean {
  return (IMAGE_TYPES as readonly string[]).includes(file.type) && file.size > 0 && file.size <= MAX_UPLOAD_BYTES;
}
