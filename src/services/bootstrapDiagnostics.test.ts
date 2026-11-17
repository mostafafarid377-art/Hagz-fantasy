import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBootstrapDiagnosticFetch,
  getBootstrapDiagnostics,
  makeSanitizedBootstrapReport,
  withBootstrapDiagnostics,
} from './bootstrapDiagnostics';

afterEach(() => { vi.restoreAllMocks(); });

describe('privacy-safe bootstrap fetch observations', () => {
  it('records a POST fetch invocation without retaining URL, headers, body, or response data', async () => {
    let finish!: (value: string) => void;
    const pending = withBootstrapDiagnostics(() => new Promise<string>((resolve) => { finish = resolve; }));
    const fakeFetch = vi.fn(async () => new Response('sensitive response body', { status: 200 }));
    const diagnosticFetch = createBootstrapDiagnosticFetch('https://project.example', fakeFetch as typeof fetch);
    const request = new Request('https://project.example/rest/v1/rpc/ff_bootstrap?key=PRIVATE_API_KEY', {
      method: 'POST',
      headers: { Authorization: 'Bearer PRIVATE_JWT', Cookie: 'PRIVATE_COOKIE' },
      body: 'private@example.test request body',
    });

    await diagnosticFetch(request);

    const attempt = getBootstrapDiagnostics()[getBootstrapDiagnostics().length - 1]!;
    expect(attempt.fetchInvocations.POST).toBe('fetch-invoked');
    expect(attempt.fetchInvocations.OPTIONS).toBe('not-observable-from-page-fetch');
    expect(attempt.networkReceipt).toBe('not-confirmed-by-page-instrumentation');
    const report = makeSanitizedBootstrapReport();
    for (const secret of ['PRIVATE_API_KEY', 'PRIVATE_JWT', 'PRIVATE_COOKIE', 'private@example.test', 'sensitive response body']) {
      expect(report).not.toContain(secret);
    }
    expect(report).not.toContain('https://project.example');
    expect(fakeFetch).toHaveBeenCalledTimes(1);

    finish('ok');
    await expect(pending).resolves.toBe('ok');
  });

  it('ignores a different RPC path and never treats a fetch invocation as server receipt', async () => {
    let finish!: () => void;
    const pending = withBootstrapDiagnostics(() => new Promise<void>((resolve) => { finish = resolve; }));
    const fakeFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const diagnosticFetch = createBootstrapDiagnosticFetch('https://project.example', fakeFetch as typeof fetch);

    await diagnosticFetch('https://project.example/rest/v1/rpc/ff_market_players', { method: 'POST' });

    const attempt = getBootstrapDiagnostics()[getBootstrapDiagnostics().length - 1]!;
    expect(attempt.fetchInvocations.POST).toBe('not-observed');
    expect(attempt.networkReceipt).toBe('not-confirmed-by-page-instrumentation');
    finish();
    await pending;
  });
});
