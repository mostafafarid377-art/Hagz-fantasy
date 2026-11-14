import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_IMAGE_BYTES, validImageFile, validImageValue } from '../utils/image';

type Props = { value: string; onChange: (value: string) => void; onBusyChange: (busy: boolean) => void };
export function ImagePicker({ value, onChange, onBusyChange }: Props) {
  const { t } = useTranslation();
  const [error, setError] = useState('');
  const reader = useRef<FileReader | null>(null);
  const version = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => { version.current++; reader.current?.abort(); }, []);
  function cancelRead() { version.current++; reader.current?.abort(); reader.current = null; onBusyChange(false); }
  function changeUrl(url: string) { cancelRead(); setError(''); if (fileInput.current) fileInput.current.value = ''; onChange(url); }
  function chooseFile(file?: File) {
    cancelRead(); setError('');
    if (!file) return;
    if (!validImageFile(file)) { setError('Choose a PNG, JPEG or WebP image up to 5 MB.'); if (fileInput.current) fileInput.current.value = ''; return; }
    const request = version.current;
    const nextReader = new FileReader(); reader.current = nextReader; onBusyChange(true);
    const fail = () => { if (version.current !== request) return; setError('Could not read this image.'); reader.current = null; onBusyChange(false); };
    nextReader.onload = () => {
      if (version.current !== request || typeof nextReader.result !== 'string') return;
      const original = nextReader.result;
      const image = new Image();
      image.onload = () => {
        if (version.current !== request) return;
        if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 50_000_000) { fail(); return; }
        let result = original;
        if (file.size > MAX_IMAGE_BYTES) {
          const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
          const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          const context = canvas.getContext('2d'); if (!context) { fail(); return; }
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          result = canvas.toDataURL('image/webp', 0.8);
          if (!validImageValue(result)) result = canvas.toDataURL('image/jpeg', 0.7);
        }
        if (!validImageValue(result)) { fail(); return; }
        onChange(result); reader.current = null; onBusyChange(false);
      };
      image.onerror = fail; image.src = original;
    };
    nextReader.onerror = fail;
    nextReader.readAsDataURL(file);
  }
  return <div className="image-picker">
    <label>{t('Image URL (optional)')}<input type="url" value={value.startsWith('data:') ? '' : value} onChange={e => changeUrl(e.target.value)} placeholder="https://"/></label>
    <label>{t('Choose a local image')}<input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" onChange={e => chooseFile(e.target.files?.[0])}/></label>
    <small>{t('PNG, JPEG or WebP up to 5 MB. Large images are resized and stored only in this browser.')}</small>
    {value && validImageValue(value) && <div className="image-preview"><img src={value} alt={t('Image preview')} onError={() => setError('Could not preview this image.')}/><button className="button button-outline" type="button" onClick={() => { cancelRead(); setError(''); if(fileInput.current)fileInput.current.value=''; onChange(''); }}>{t('Remove image')}</button></div>}
    {error && <p className="error" role="alert">{t(error)}</p>}
  </div>;
}
