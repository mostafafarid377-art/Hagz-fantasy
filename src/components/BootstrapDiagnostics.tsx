import { useState, useSyncExternalStore } from 'react';
import {
  getBootstrapDiagnostics, makeSanitizedBootstrapReport, subscribeBootstrapDiagnostics,
} from '../services/bootstrapDiagnostics';

/** Temporary report UI; displayed only alongside a login/dashboard error. */
export function BootstrapDiagnosticsPanel() {
  const attempts = useSyncExternalStore(
    subscribeBootstrapDiagnostics,
    getBootstrapDiagnostics,
    getBootstrapDiagnostics,
  );
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'unavailable'>('idle');
  if (attempts.length === 0) return null;

  const report = makeSanitizedBootstrapReport();
  async function copyReport() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(report);
      setCopyState('copied');
    } catch {
      setCopyState('unavailable');
    }
  }

  return (
    <details className="panel bootstrap-diagnostics">
      <summary>Temporary bootstrap diagnostics</summary>
      <p>
        This report contains diagnostic IDs and request timing only. The ID is local to this browser;
        use UTC timestamps to correlate logs. Fetch invocation does not prove delivery or Supabase receipt,
        and browser-generated OPTIONS preflights are not visible here.
      </p>
      <button type="button" className="button button-small button-outline" onClick={() => void copyReport()}>
        {copyState === 'copied' ? 'Report copied' : 'Copy sanitized report'}
      </button>
      {copyState === 'unavailable' && <p role="status">Copy is unavailable; select and copy the report below.</p>}
      <pre aria-label="Sanitized bootstrap diagnostic report">{report}</pre>
    </details>
  );
}
