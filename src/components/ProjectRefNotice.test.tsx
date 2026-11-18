/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// The banner reads a module-level decision, so the decision is the thing to fake:
// the render must never re-derive it from a different variable.
vi.mock('../lib/supabase', () => ({
  projectRefMismatch: { configured: 'zkrfgdiujpagaddsxbcb', expected: 'ddeojemjbhnxtrgsuicv' },
}));

import { ProjectRefNotice } from './ProjectRefNotice';

afterEach(() => cleanup());

describe('ProjectRefNotice', () => {
  it('names both projects and says live data is off', () => {
    render(<ProjectRefNotice />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('wrong database');
    expect(alert.textContent).toContain('zkrfgdiujpagaddsxbcb');
    expect(alert.textContent).toContain('ddeojemjbhnxtrgsuicv');
    expect(alert.textContent).toContain('VITE_SUPABASE_URL');
  });

  it('is an alert, not a toast: it does not disappear and has no dismiss control', () => {
    render(<ProjectRefNotice />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('project-ref-mismatch')).toBeTruthy();
  });

  it('renders nothing when the deployment is approved', async () => {
    vi.resetModules();
    vi.doMock('../lib/supabase', () => ({ projectRefMismatch: null }));
    const fresh = await import('./ProjectRefNotice');
    const { container } = render(<fresh.ProjectRefNotice />);
    expect(container.innerHTML).toBe('');
    vi.doUnmock('../lib/supabase');
  });
});
