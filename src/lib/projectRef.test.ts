import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVED_PROJECT_REF,
  evaluateProjectRef,
  projectRefOf,
} from './supabase';

const APPROVED_URL = `https://${APPROVED_PROJECT_REF}.supabase.co`;
const OTHER_URL = 'https://zkrfgdiujpagaddsxbcb.supabase.co';

describe('projectRefOf', () => {
  it('extracts the ref from a Supabase project URL', () => {
    expect(projectRefOf(APPROVED_URL)).toBe(APPROVED_PROJECT_REF);
    expect(projectRefOf('https://abcdefghijklmnopqrst.supabase.co')).toBe('abcdefghijklmnopqrst');
    expect(projectRefOf('https://abcdefghijklmnopqrst.supabase.in')).toBe('abcdefghijklmnopqrst');
  });

  it('tolerates whitespace, trailing slashes, paths, ports and case', () => {
    expect(projectRefOf(`  ${APPROVED_URL}/  `)).toBe(APPROVED_PROJECT_REF);
    expect(projectRefOf(`${APPROVED_URL}/auth/v1/callback?x=1`)).toBe(APPROVED_PROJECT_REF);
    expect(projectRefOf(`HTTPS://${APPROVED_PROJECT_REF.toUpperCase()}.SUPABASE.CO`)).toBe(
      APPROVED_PROJECT_REF,
    );
  });

  it('is null for anything that is not a Supabase project host', () => {
    expect(projectRefOf('https://example.com')).toBeNull();
    expect(projectRefOf('https://example.supabase.co')).toBeNull(); // ref must be 20 chars
    expect(projectRefOf('https://abcdefghijklmnopqrst.supabase.co.evil.example')).toBeNull();
    expect(projectRefOf('not a url')).toBeNull();
    expect(projectRefOf('')).toBeNull();
    expect(projectRefOf(undefined)).toBeNull();
    expect(projectRefOf(null)).toBeNull();
  });
});

describe('evaluateProjectRef', () => {
  it('accepts the approved project in a production build', () => {
    expect(evaluateProjectRef({ url: APPROVED_URL, prod: true })).toBeNull();
    expect(evaluateProjectRef({ url: `${APPROVED_URL}/`, prod: true })).toBeNull();
  });

  it('flags any other project, and names what it found', () => {
    expect(evaluateProjectRef({ url: OTHER_URL, prod: true })).toEqual({
      configured: 'zkrfgdiujpagaddsxbcb',
      expected: APPROVED_PROJECT_REF,
    });
  });

  it('flags a production build whose URL is not a Supabase project at all', () => {
    expect(evaluateProjectRef({ url: 'https://example.com', prod: true })).toEqual({
      configured: null,
      expected: APPROVED_PROJECT_REF,
    });
  });

  it('stays quiet in development, where .env.local may point anywhere', () => {
    expect(evaluateProjectRef({ url: OTHER_URL, prod: false })).toBeNull();
  });

  it('stays quiet in Demo mode, where nothing can be written anywhere', () => {
    expect(evaluateProjectRef({ url: OTHER_URL, prod: true, configured: false })).toBeNull();
    expect(evaluateProjectRef({ url: '', prod: true })).toBeNull();
  });
});

/**
 * The wiring, not just the rule: a real production module load with a real URL.
 * `vi.stubEnv('PROD', true)` makes the module behave exactly as it does inside a
 * `vite build`, which is the only place the guard is allowed to bite.
 */
describe('production wiring', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('refuses to create a client when the build points at another project', async () => {
    vi.resetModules();
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_SUPABASE_URL', OTHER_URL);
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_abcdefghijklmnop');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const mod = await import('./supabase');

    expect(mod.isSupabaseConfigured).toBe(true);
    expect(mod.projectRefMismatch).toEqual({
      configured: 'zkrfgdiujpagaddsxbcb',
      expected: APPROVED_PROJECT_REF,
    });
    expect(mod.getSupabase()).toBeNull();
    expect(error).toHaveBeenCalled();
    expect(String(error.mock.calls[0][0])).toContain('Refusing to create a client');
  });

  it('creates a client when the build points at the approved project', async () => {
    vi.resetModules();
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_SUPABASE_URL', APPROVED_URL);
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_abcdefghijklmnop');

    const mod = await import('./supabase');

    expect(mod.projectRefMismatch).toBeNull();
    expect(mod.getSupabase()).not.toBeNull();
  });

  it('leaves development builds alone', async () => {
    vi.resetModules();
    vi.stubEnv('PROD', false);
    vi.stubEnv('VITE_SUPABASE_URL', OTHER_URL);
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_abcdefghijklmnop');

    const mod = await import('./supabase');

    expect(mod.projectRefMismatch).toBeNull();
    expect(mod.getSupabase()).not.toBeNull();
  });
});
