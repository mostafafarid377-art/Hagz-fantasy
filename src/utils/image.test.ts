import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES, MAX_UPLOAD_BYTES, validImageFile, validImageValue } from './image';
describe('demo image validation',()=>{
  it('accepts bounded JPEG, PNG and WebP files and rejects unsupported or oversized uploads',()=>{
    expect(validImageFile({type:'image/png',size:100})).toBe(true);
    expect(validImageFile({type:'image/jpeg',size:MAX_IMAGE_BYTES})).toBe(true);
    expect(validImageFile({type:'image/svg+xml',size:100})).toBe(false);
    expect(validImageFile({type:'image/png',size:MAX_UPLOAD_BYTES+1})).toBe(false);
    expect(validImageFile({type:'image/png',size:0})).toBe(false);
  });
  it('accepts local data and http URLs, but rejects unsafe values',()=>{
    expect(validImageValue('data:image/png;base64,aGVsbG8=')).toBe(true);
    expect(validImageValue('https://example.com/photo.png')).toBe(true);
    expect(validImageValue('javascript:alert(1)')).toBe(false);
    expect(validImageValue('data:image/svg+xml;base64,aGVsbG8=')).toBe(false);
    expect(validImageValue('data:image/png;base64,'+'A'.repeat(400000))).toBe(false);
  });
});
