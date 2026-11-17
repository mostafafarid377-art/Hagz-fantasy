/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BootstrapDiagnosticsPanel } from './BootstrapDiagnostics';
import { withBootstrapDiagnostics } from '../services/bootstrapDiagnostics';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('temporary bootstrap diagnostics panel', () => {
  it('shows and copies the sanitized report from an error state', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    await expect(withBootstrapDiagnostics(() => Promise.reject(new Error('private raw error')))).rejects.toThrow();

    render(<BootstrapDiagnosticsPanel />);
    expect(screen.getByText('Temporary bootstrap diagnostics')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy sanitized report' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain('diagnosticId');
    expect(copied).toContain('errorCategory');
    expect(copied).not.toContain('private raw error');
    expect(screen.getByRole('button', { name: 'Report copied' })).toBeTruthy();
  });
});
