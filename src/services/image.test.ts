import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitLocalImage, discardDraftImage, loadLocalImage, saveLocalImage, validateImage } from './image';
import { MAX_UPLOAD_BYTES, imageSignature, validImageValue } from '../utils/image';

const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
const jpeg = new Uint8Array([255,216,255,224,0,0,0,0,0,0,0,0]);
const webp = new TextEncoder().encode('RIFF0000WEBP');
class DecodedImage { naturalWidth=10; naturalHeight=10; onload?:()=>void; onerror?:()=>void; set src(_value: string) { queueMicrotask(()=>this.onload?.()); } }
beforeEach(()=>vi.stubGlobal('Image',DecodedImage));
afterEach(()=>vi.unstubAllGlobals());
describe('image service',()=>{
  it('detects JPEG, PNG and WebP signatures',()=>{
    expect(imageSignature(png)).toBe('image/png'); expect(imageSignature(jpeg)).toBe('image/jpeg'); expect(imageSignature(webp)).toBe('image/webp');
    expect(imageSignature(new TextEncoder().encode('<svg/>'))).toBeUndefined();
  });
  it('validates actual bytes as well as the claimed MIME type and size',async()=>{
    await expect(validateImage(new File([png],'photo.png',{type:'image/png'}))).resolves.toBeUndefined();
    await expect(validateImage(new File([jpeg],'photo.jpg',{type:'image/jpeg'}))).resolves.toBeUndefined();
    await expect(validateImage(new File([webp],'photo.webp',{type:'image/webp'}))).resolves.toBeUndefined();
    await expect(validateImage(new File(['<svg/>'],'fake.png',{type:'image/png'}))).rejects.toMatchObject({code:'invalid'});
    await expect(validateImage(new File([png],'fake.png',{type:'image/jpeg'}))).rejects.toMatchObject({code:'invalid'});
    await expect(validateImage(new File(['x'],'bad.svg',{type:'image/svg+xml'}))).rejects.toMatchObject({code:'invalid'});
    await expect(validateImage(new File([new Uint8Array(MAX_UPLOAD_BYTES+1)],'large.jpg',{type:'image/jpeg'}))).rejects.toMatchObject({code:'tooLarge'});
  });
  it('rejects a corrupt file after checking its header and revokes its temporary preview', async()=>{
    class BadImage { onload?:()=>void; onerror?:()=>void; set src(_value:string){queueMicrotask(()=>this.onerror?.());} }
    vi.stubGlobal('Image', BadImage); const revoke=vi.spyOn(URL,'revokeObjectURL');
    await expect(validateImage(new File([png],'corrupt.png',{type:'image/png'}))).rejects.toMatchObject({code:'invalid'});
    expect(revoke).toHaveBeenCalled(); revoke.mockRestore();
  });
  it('stores byte buffers rather than Blob values and preserves image bytes and MIME type', async () => {
    const file = new File([png], 'photo.png', { type: 'image/png' });
    const ref = await saveLocalImage(file);
    const raw = await new Promise<unknown>((resolve, reject) => {
      const open = indexedDB.open('fantasy-friends-images', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result; const tx = db.transaction('images', 'readonly');
        const get = tx.objectStore('images').get(ref);
        get.onerror = () => reject(get.error);
        tx.oncomplete = () => { db.close(); resolve(get.result); };
      };
    });
    expect(raw).toMatchObject({ bytes: expect.any(ArrayBuffer), type: 'image/png' });
    const loaded = await loadLocalImage(ref);
    expect(loaded?.type).toBe('image/png');
    expect(new Uint8Array(await loaded!.arrayBuffer())).toEqual(png);
    await discardDraftImage(ref);
  });
  it('reads Blob records saved by older versions without migrating or deleting them', async () => {
    const ref = 'local-image:00000000-0000-4000-8000-000000000001';
    const old = new Blob([png], { type: 'image/png' });
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('fantasy-friends-images', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result; const tx = db.transaction('images', 'readwrite');
        tx.objectStore('images').put(old, ref);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
    const loaded = await loadLocalImage(ref);
    expect(loaded?.type).toBe('image/png');
    expect(new Uint8Array(await loaded!.arrayBuffer())).toEqual(png);
  });
  it('falls back to FileReader when Blob.arrayBuffer is unavailable', async () => {
    class Reader {
      result: ArrayBuffer | null = null; error = null;
      onload?: () => void; onerror?: () => void; onabort?: () => void;
      readAsArrayBuffer() { this.result = png.slice().buffer; queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('FileReader', Reader);
    const file = new File([png], 'photo.png', { type: 'image/png' });
    Object.defineProperty(file, 'arrayBuffer', { value: undefined });
    const ref = await saveLocalImage(file);
    expect(new Uint8Array(await (await loadLocalImage(ref))!.arrayBuffer())).toEqual(png);
    await discardDraftImage(ref);
  });
  it('persists opaque references and deletes abandoned drafts without deleting committed images',async()=>{
    const file=new File([png],'photo.png',{type:'image/png'}); const ref=await saveLocalImage(file);
    expect(validImageValue(ref)).toBe(true); expect((await loadLocalImage(ref))?.size).toBe(file.size);
    await discardDraftImage(ref); expect(await loadLocalImage(ref)).toBeUndefined();
    const saved=await saveLocalImage(file); commitLocalImage(saved); await discardDraftImage(saved);
    expect((await loadLocalImage(saved))?.size).toBe(file.size);
  });
});
