import { useEffect, useState } from 'react';
import { isLocalImage, loadLocalImage } from '../services/image';
import { STORAGE_IMAGE_PREFIX } from '../services/playerImage';
import { imageUrl } from '../services/storage';

// Each consumer owns and revokes its own URL, including on reference changes.
// Storage paths are resolved with the current authenticated client, not made public.
export function useImageSource(reference?: string) {
  const [resolved, setResolved] = useState<{reference:string; url:string}>();
  useEffect(() => {
    if (!reference) return;
    let active = true; let url: string | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    if (isLocalImage(reference)) {
      loadLocalImage(reference).then(blob => {
        if (active && blob) { url = URL.createObjectURL(blob); setResolved({reference, url}); }
      });
    } else if (reference.startsWith(STORAGE_IMAGE_PREFIX)) {
      const refresh = async () => {
        try {
          const signed = await imageUrl(reference.slice(STORAGE_IMAGE_PREFIX.length));
          if (!active) return;
          if (signed) setResolved({ reference, url: signed });
          else setResolved(undefined);
        } catch { if (active) setResolved(undefined); }
        if (active) timer = setTimeout(refresh, 45 * 60 * 1000);
      };
      void refresh();
    }
    return () => { active = false; if (url) URL.revokeObjectURL(url); if (timer) clearTimeout(timer); };
  }, [reference]);
  if (!reference) return undefined;
  return isLocalImage(reference) || reference.startsWith(STORAGE_IMAGE_PREFIX)
    ? (resolved?.reference === reference ? resolved.url : undefined) : reference;
}
