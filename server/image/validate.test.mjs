import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { MAX_IMAGE_BYTES, InvalidImageError, validateAndReencodeImage } from './validate.mjs';

const pixel = () => sharp({ create: { width: 2, height: 2, channels: 3, background: '#bada55' } });
for (const format of ['jpeg', 'png', 'webp']) {
  test(`decodes ${format} bytes and emits canonical PNG`, async () => {
    const input = await pixel()[format]().withMetadata({ exif: { IFD0: { Artist: 'private' } } }).toBuffer();
    const output = await validateAndReencodeImage(input);
    assert.equal(output.mime, 'image/png');
    const meta = await sharp(output.bytes).metadata();
    assert.equal(meta.format, 'png'); assert.equal(meta.exif, undefined);
  });
}
test('rejects SVG, executable, malformed signatures and oversized input', async () => {
  const samples = [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('MZ executable'),
    Buffer.from([137,80,78,71,13,10,26,10,0]), Buffer.alloc(MAX_IMAGE_BYTES + 1)];
  for (const sample of samples) await assert.rejects(validateAndReencodeImage(sample), InvalidImageError);
});
test('re-encoding does not preserve appended attacker-controlled payload', async () => {
  const payload = Buffer.from('<script>malicious payload</script>');
  const input = Buffer.concat([await pixel().png().toBuffer(), payload]);
  const output = await validateAndReencodeImage(input);
  assert.equal(output.bytes.includes(payload), false);
});
test('rejects excessive decoded dimensions and truncated JPEG', async () => {
  const large = await sharp({ create: { width: 8193, height: 1, channels: 3, background: 'red' } }).png().toBuffer();
  await assert.rejects(validateAndReencodeImage(large), InvalidImageError);
  const jpeg = await pixel().jpeg().toBuffer();
  await assert.rejects(validateAndReencodeImage(jpeg.subarray(0, Math.floor(jpeg.length / 2))), InvalidImageError);
});
