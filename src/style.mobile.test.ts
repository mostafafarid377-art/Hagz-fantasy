/**
 * @vitest-environment node
 *
 * Mobile overflow guard for the squad summary strip, asserted against the real
 * stylesheet.
 *
 * Why a CSS test: jsdom performs no layout, so a render test cannot prove that a
 * 7-cell grid fits a 360px phone. Playwright would, but browsers cannot be downloaded
 * in every environment (the e2e spec `e2e/squad-mobile.spec.ts` covers the rendered
 * case where a browser is available). These assertions check the properties that
 * actually caused the bug in the screenshot, so the regression is caught either way.
 *
 * The bug: `.squad-summary` was `grid-template-columns: repeat(7,1fr)` at every width,
 * switched to `repeat(4,1fr)` only under 600px. `1fr` has an automatic minimum of
 * min-content, and each cell's value ("5,000,000.0 M" with a non-breaking space) was
 * wider than a 1fr track could be, so the grid grew past the viewport and the 7th cell
 * was clipped.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('./style.css', import.meta.url)), 'utf8');

interface Rule { media: string | null; selector: string; body: string }

/** Flatten the sheet into rules, remembering which @media block each sits in. */
function parse(sheet: string): Rule[] {
  const rules: Rule[] = [];
  let index = 0;
  let media: string | null = null;
  let depth = 0;
  let buffer = '';

  while (index < sheet.length) {
    const char = sheet[index];
    if (char === '{') {
      const prelude = buffer.trim();
      buffer = '';
      depth += 1;
      if (prelude.startsWith('@media')) {
        media = prelude;
        // Contents are parsed by continuing; declarations inside are read below.
        index += 1;
        continue;
      }
      // Read a declaration block.
      let block = '';
      let local = 1;
      index += 1;
      while (index < sheet.length && local > 0) {
        if (sheet[index] === '{') local += 1;
        if (sheet[index] === '}') { local -= 1; if (local === 0) break; }
        block += sheet[index];
        index += 1;
      }
      rules.push({ media, selector: prelude, body: block });
      index += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) media = null;
      buffer = '';
      index += 1;
      continue;
    }
    buffer += char;
    index += 1;
  }
  return rules;
}

const rules = parse(css);
const mobile = rules.filter((rule) => rule.media?.includes('max-width:600px'));
const summaryMobile = mobile.filter((rule) => rule.selector.includes('.squad-summary'));

describe('the squad summary cannot overflow a phone', () => {
  it('uses shrinkable tracks (minmax(0,1fr)) on mobile, not bare 1fr', () => {
    const grid = summaryMobile.find((rule) => rule.body.includes('grid-template-columns'));
    expect(grid, 'a mobile .squad-summary grid rule exists').toBeTruthy();
    expect(grid!.body).toContain('minmax(0,1fr)');
  });

  it('never lays out seven columns on a phone', () => {
    for (const rule of summaryMobile) {
      if (!rule.body.includes('grid-template-columns')) continue;
      expect(rule.body).not.toMatch(/repeat\(\s*7/);
    }
  });

  it('gives every cell min-width:0 so a wide value cannot force the grid wider', () => {
    const cells = summaryMobile.filter((rule) => rule.selector.includes('>div'));
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.some((rule) => rule.body.includes('min-width:0'))).toBe(true);
  });

  it('lets the value wrap instead of being unbreakable', () => {
    const strong = summaryMobile.find((rule) => rule.selector.includes('strong'));
    expect(strong).toBeTruthy();
    expect(strong!.body).toMatch(/white-space:normal/);
  });

  it('drops the trailing in-line-end border on every 4th cell', () => {
    expect(summaryMobile.some((rule) => rule.selector.includes('nth-child(4n)')
      && rule.body.includes('border-inline-end:0'))).toBe(true);
  });

  it('uses minmax tracks on desktop too, so the strip is never wider than its parent', () => {
    const desktop = rules.filter((rule) => rule.media === null
      && rule.selector === '.squad-summary'
      && rule.body.includes('grid-template-columns'));
    expect(desktop.length).toBeGreaterThan(0);
    expect(desktop[desktop.length - 1].body).toContain('minmax(0');
  });
});

describe('the squad action buttons stack instead of overflowing', () => {
  it('has a single-column mobile row', () => {
    const row = mobile.find((rule) => rule.selector === '.squad-actions');
    expect(row, 'a mobile .squad-actions rule exists').toBeTruthy();
    expect(row!.body).toMatch(/grid-template-columns:1fr/);
  });

  it('clears the desktop min-width that two 150px buttons relied on', () => {
    const button = mobile.find((rule) => rule.selector === '.squad-actions .button');
    expect(button).toBeTruthy();
    expect(button!.body).toContain('min-width:0');
    expect(button!.body).toContain('width:100%');
  });
});

describe('the invite card and last-game list fit a phone', () => {
  it('stacks the invite code above its actions on mobile', () => {
    const declarations = mobile.filter((rule) => rule.selector === '.invite-card .invite-code');
    expect(declarations.length).toBeGreaterThan(0);
    expect(declarations.some((rule) => /flex-direction:column/.test(rule.body))).toBe(true);
  });

  it('makes the copy/share buttons full width on mobile', () => {
    const declarations = mobile.filter((rule) => rule.selector === '.invite-card .invite-code-actions');
    expect(declarations.length).toBeGreaterThan(0);
    expect(declarations.some((rule) => /grid-template-columns:1fr/.test(rule.body))).toBe(true);
  });

  it('hides the position column in the last-game list rather than squeezing it', () => {
    const row = mobile.find((rule) => rule.selector === '.last-game-row');
    expect(row).toBeTruthy();
    expect(row!.body).toContain('grid-template-columns');
  });
});

describe('the pitch keeps its proportions', () => {
  it('shrinks the pitch height at each breakpoint instead of scrolling', () => {
    const heights = [...css.matchAll(/\.pitch\{height:(\d+)px\}/g)].map((match) => Number(match[1]));
    expect(heights.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...heights)).toBeLessThanOrEqual(500);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(240);
  });

  it('keeps a horizontal gap on the pitch bands so they can shrink together', () => {
    // .pitch-row is a flex row with justify-content:space-evenly plus a gap; the gap is
    // what lets a five-across band fit a 320px phone without spilling.
    const row = rules.filter((rule) => rule.selector.endsWith('.pitch-row'));
    expect(row.length).toBeGreaterThan(0);
    expect(row.some((rule) => /(^|;)gap:\s*\d/.test(rule.body))).toBe(true);
  });
});
