import { projectRefMismatch } from '../lib/supabase';

/**
 * Visible failure for a misdirected deployment (G5, runtime half).
 *
 * `scripts/check-pages-env.mjs` stops a Pages build that is pointed at the wrong
 * Supabase project. This covers the bundle that was built somewhere else, or with
 * a stale variable, and then served: `getSupabase()` refuses to create a client, so
 * the app falls back to Demo mode, and this banner says why. A silent fallback to
 * demo would be worse than a loud one — it looks like the app "has no data".
 *
 * Empty compiles to nothing when the project is the approved one, in dev builds,
 * and in Demo mode, so it never appears in normal operation or in the test suites.
 */
export function ProjectRefNotice() {
  if (!projectRefMismatch) return null;
  const configured = projectRefMismatch.configured ?? 'unrecognised';
  return (
    <div className="project-ref-banner" role="alert" data-testid="project-ref-mismatch">
      <strong>This build is connected to the wrong database, so live data is disabled.</strong>{' '}
      It points at Supabase project <code>{configured}</code>, but this build is only approved for{' '}
      <code>{projectRefMismatch.expected}</code>. Nothing can be read or written until
      the deployment&apos;s <code>VITE_SUPABASE_URL</code> is fixed and the site is rebuilt.
      <span className="project-ref-banner-ar" dir="rtl" lang="ar">
        هذا الإصدار متصل بقاعدة بيانات غير مصرّح بها، لذلك تم تعطيل البيانات المباشرة.
      </span>
    </div>
  );
}
