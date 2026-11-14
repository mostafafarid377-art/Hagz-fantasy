// Legacy data URLs remain readable so existing demo images can be migrated.
export const MAX_IMAGE_BYTES = 256 * 1024;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const dataPattern = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
export function validImageValue(value: string): boolean {
  if (!value) return true;
  if (/^local-image:[0-9a-f-]{36}$/i.test(value)) return true;
  if (value.startsWith('data:')) return value.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 40 && dataPattern.test(value);
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:'; } catch { return false; }
}
export function validImageFile(file: Pick<File, 'type' | 'size'>): boolean {
  return (IMAGE_TYPES as readonly string[]).includes(file.type) && file.size > 0 && file.size <= MAX_UPLOAD_BYTES;
}
export function imageSignature(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b)) return 'image/png';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0,4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8,12)) === 'WEBP') return 'image/webp';
  return undefined;
}
