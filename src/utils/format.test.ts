// @vitest-environment jsdom
/**
 * The demo stores prices in MILLIONS (5.5) and the live database stores raw
 * currency units (5_500_000). Both must render as "5.5M" - feeding a raw unit value
 * to the millions formatter produced "5,000,000.0 M", which is what the Squad
 * screenshot showed.
 */
import { describe, it, expect } from 'vitest';
import { formatMoney, formatCompactMoney } from './format';

describe('formatMoney (demo scale: millions)', () => {
  it('renders 5.5 as 5.5M', () => {
    expect(formatMoney(5.5).replace(/\s/g, '')).toBe('5.5M');
  });

  it('renders 100 as 100M, not 100.0M', () => {
    expect(formatMoney(100).replace(/\s/g, '')).toBe('100M');
  });

  it('drops a trailing .0 but keeps a real decimal', () => {
    expect(formatMoney(4.5).replace(/\s/g, '')).toBe('4.5M');
    expect(formatMoney(0).replace(/\s/g, '')).toBe('0M');
  });

  it('separates the suffix with an ordinary space so the value can wrap', () => {
    // A non-breaking space made "5,000,000.0 M" unbreakable inside a fixed grid
    // cell, which pushed the summary strip wider than the phone viewport.
    expect(formatMoney(5.5)).not.toContain('\u00a0');
  });
});

describe('formatCompactMoney (live scale: raw units)', () => {
  it('renders 5_000_000 as 5M, not 5,000,000.0 M', () => {
    expect(formatCompactMoney(5_000_000).replace(/\s/g, '')).toBe('5M');
  });

  it('renders 95_000_000 as 95M', () => {
    expect(formatCompactMoney(95_000_000).replace(/\s/g, '')).toBe('95M');
  });

  it('renders 100_000_000 as 100M', () => {
    expect(formatCompactMoney(100_000_000).replace(/\s/g, '')).toBe('100M');
  });

  it('keeps one decimal when the value has a fractional million', () => {
    expect(formatCompactMoney(5_500_000).replace(/\s/g, '')).toBe('5.5M');
    expect(formatCompactMoney(9_750_000).replace(/\s/g, '')).toBe('9.8M');
  });

  it('never prints a thousands separator for millions', () => {
    // The bug: 5,000,000.0 M. Any digit-grouping comma is the symptom.
    for (const value of [1_000_000, 12_500_000, 95_000_000, 100_000_000]) {
      expect(formatCompactMoney(value)).not.toMatch(/\d,\d{3}/);
    }
  });

  it('handles zero and small values without crashing', () => {
    expect(formatCompactMoney(0).replace(/\s/g, '')).toBe('0M');
    expect(formatCompactMoney(500_000).replace(/\s/g, '')).toBe('0.5M');
  });
});
