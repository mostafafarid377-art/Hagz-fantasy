import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { discardDraftImage, ImageServiceError, saveLocalImage, validateImage } from '../services/image';
import { useImageSource } from '../hooks/useImageSource';
import { validImageValue } from '../utils/image';

type Props = { value: string; onChange: (value: string) => void; onBusyChange: (busy: boolean) => void };
export function ImagePicker({ value, onChange, onBusyChange }: Props) {
  const { t } = useTranslation();
  const [error, setError] = useState('');
  const [broken, setBroken] = useState(false);
  const version = useRef(0); const current = useRef(value); current.current = value;
  const input = useRef<HTMLInputElement>(null);
  const source = useImageSource(value && validImageValue(value) ? value : undefined);
  useEffect(() => { setBroken(false); }, [source]);
  useEffect(() => () => { version.current++; void discardDraftImage(current.current); }, []);
  function replace(value: string) { const old = current.current; current.current = value; onChange(value); if (old !== value) void discardDraftImage(old); }
  async function chooseFile(file?: File) {
    const request = ++version.current; setError('');
    if (!file) return;
    onBusyChange(true);
    try {
      await validateImage(file);
      if (version.current !== request) return;
      const ref = await saveLocalImage(file);
      if (version.current !== request) { void discardDraftImage(ref); return; }
      replace(ref);
    } catch (err) {
      if (version.current === request) setError(err instanceof ImageServiceError && err.code === 'tooLarge' ? 'The image is larger than 5 MB.' : err instanceof ImageServiceError && err.code === 'storage' ? 'Could not store the image in this browser.' : 'Choose a valid JPG, JPEG, PNG or WebP image.');
    } finally { if (version.current === request) { onBusyChange(false); if (input.current) input.current.value = ''; } }
  }
  function clear() { version.current++; onBusyChange(false); setError(''); if(input.current) input.current.value=''; replace(''); }
  return <div className="image-picker">
    <label className="button button-outline image-file-button">{t('Choose a local image')}<input className="image-file-input" ref={input} type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" onChange={e => void chooseFile(e.target.files?.[0])}/></label>
    <small>{t('JPG, JPEG, PNG or WebP up to 5 MB. Stored only in this browser.')}</small>
    <label>{t('Image URL (optional)')}<input type="url" value={value.startsWith('data:') || value.startsWith('local-image:') ? '' : value} onChange={e => { version.current++; onBusyChange(false); setError(''); replace(e.target.value); }} placeholder="https://"/></label>
    {value && <div className="image-preview">{source && !broken && <img src={source} alt={t('Image preview')} onError={() => { setBroken(true); setError('Could not preview this image.'); }}/>}<button className="button button-outline" type="button" onClick={clear}>{t('Remove image')}</button></div>}
    {error && <p className="error" role="alert">{t(error)}</p>}
  </div>;
}
