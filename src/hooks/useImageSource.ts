import { useEffect, useState } from 'react';
import { isLocalImage, loadLocalImage } from '../services/image';

// Each consumer owns and revokes its own URL, including on reference changes.
export function useImageSource(reference?: string) {
  const [resolved, setResolved] = useState<{reference:string; url:string}>();
  useEffect(() => {
    if (!reference || !isLocalImage(reference)) return;
    let active = true; let url: string | undefined;
    loadLocalImage(reference).then(blob => {
      if (active && blob) { url = URL.createObjectURL(blob); setResolved({reference, url}); }
    });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [reference]);
  if (!reference) return undefined;
  return isLocalImage(reference) ? (resolved?.reference === reference ? resolved.url : undefined) : reference;
}
