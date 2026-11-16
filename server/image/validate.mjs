// Trusted-side primitive, not an HTTP handler. Call only in an isolated worker
// with request, CPU, memory and wall-clock limits; never trust client MIME.
import sharp from 'sharp';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PIXELS = 20_000_000;
const MAX_DIMENSION = 8192;

export class InvalidImageError extends Error {
  constructor(message = 'Invalid or unsupported image') { super(message); this.name = 'InvalidImageError'; }
}

// magic is an early rejection, NOT validation: the decoder must also succeed.
function signature(data) {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// Returns a fresh, metadata-stripped PNG: never store or serve the input bytes.
// Reading a request into memory must itself be bounded BEFORE calling this.
export async function validateAndReencodeImage(data) {
  if (!Buffer.isBuffer(data) || !data.length || data.length > MAX_IMAGE_BYTES) throw new InvalidImageError();
  const expected = signature(data);
  if (!expected) throw new InvalidImageError();
  try {
    const options = { failOn: 'warning', limitInputPixels: MAX_PIXELS, animated: true };
    const metadata = await sharp(data, options).metadata();
    if (metadata.format !== expected || !metadata.width || !metadata.height ||
        metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION ||
        metadata.width * metadata.height > MAX_PIXELS || (metadata.pages ?? 1) !== 1)
      throw new InvalidImageError();
    const output = await sharp(data, options).rotate().png().toBuffer();
    // Re-encoding can expand compressed input considerably. Cap output too.
    if (output.length > MAX_IMAGE_BYTES) throw new InvalidImageError();
    return { bytes: output, mime: 'image/png', extension: 'png' };
  } catch (error) {
    if (error instanceof InvalidImageError) throw error;
    throw new InvalidImageError();
  }
}
