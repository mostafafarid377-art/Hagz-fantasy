import type { ComponentProps } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Keep the in-app origin on detail links, including query and hash. A direct
// visit has no origin, so the destination's safe fallback is used instead.
export function useOrigin() {
  const location = useLocation();
  return location.pathname + location.search + location.hash;
}
export function DetailLink({to,...props}: Omit<ComponentProps<typeof Link>,'state'>) {
  const from=useOrigin();
  return <Link {...props} to={to} state={{from}}/>;
}
export function BackLink({fallback}:{fallback:string}) {
  const {t}=useTranslation();const location=useLocation();
  const from:unknown=location.state?.from;
  const destination=typeof from==='string' && from.startsWith('/') && !from.startsWith('//') && from!==location.pathname ? from : fallback;
  return <Link className="back-link" to={destination}><ArrowLeft size={16}/>{t('Back')}</Link>;
}
