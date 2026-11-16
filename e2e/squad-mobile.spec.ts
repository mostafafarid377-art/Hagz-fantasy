import { test, expect, type Page } from '@playwright/test';

/**
 * Mobile layout guard for the demo squad screen (the live squad screen shares the
 * same Pitch component, summary strip and CSS).
 *
 * The bug this covers: at 360px the `.squad-summary` strip overflowed horizontally and
 * clipped its 7th cell, because the grid had four fixed columns and each value was an
 * unbreakable "5,000,000.0 M". These assertions are about the DOCUMENT never being
 * wider than the viewport, which is the symptom the user photographed.
 */

const prepare = async (page: Page) => {
  await page.goto('/dashboard');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
};

/** True when nothing on the page scrolls horizontally. */
const noHorizontalOverflow = async (page: Page) => {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
  });
  return overflow.scrollWidth <= overflow.clientWidth + 1;
};

for (const width of [320, 360, 390]) {
  test(`squad summary and pitch fit a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await prepare(page);
    await page.goto('/squad');

    // The 7-cell strip is present and none of it is clipped.
    const summary = page.locator('.squad-summary');
    await expect(summary).toBeVisible();
    await expect(summary.locator('> div')).toHaveCount(7);

    const box = await summary.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);

    // Every cell sits inside the strip's own box (the 7th used to be cut off).
    const cellsInside = await page.evaluate(() => {
      const strip = document.querySelector('.squad-summary')!.getBoundingClientRect();
      return [...document.querySelectorAll('.squad-summary > div')].every((cell) => {
        const rect = cell.getBoundingClientRect();
        return rect.left >= strip.left - 1 && rect.right <= strip.right + 1;
      });
    });
    expect(cellsInside).toBe(true);

    expect(await noHorizontalOverflow(page)).toBe(true);
  });

  test(`squad actions stay reachable on a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await prepare(page);
    await page.goto('/squad');

    const actions = page.locator('.squad-actions');
    await expect(actions).toBeVisible();
    // Below the pitch, not above it.
    const pitch = await page.locator('.pitch').boundingBox();
    const row = await actions.boundingBox();
    expect(pitch).not.toBeNull();
    expect(row).not.toBeNull();
    expect(row!.y).toBeGreaterThan(pitch!.y);

    // Both controls are clickable targets, not 0-width slivers.
    for (const button of [actions.getByRole('link', { name: /transfer/i }), actions.getByRole('link', { name: /add players/i })]) {
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box!.width).toBeGreaterThan(80);
    }
    expect(await noHorizontalOverflow(page)).toBe(true);
  });
}

test('money is compact and never shows raw units', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await prepare(page);
  await page.goto('/squad');
  const text = (await page.locator('.squad-summary').innerText()).replace(/\s/g, '');
  expect(text).not.toMatch(/\d,\d{3}/);
  expect(text).not.toMatch(/\d\.0M/);
});

test('the formation selector changes the pitch on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page);
  // The builder shows capacity slots; use My Squad, which draws the starting XI.
  await page.goto('/squad');

  const shapeOf = async () => page.evaluate(() => {
    const counts: Record<string, number> = {};
    for (const row of document.querySelectorAll('.pitch .pitch-row')) {
      const placed = row.querySelectorAll('.pitch-player').length;
      const empty = row.querySelectorAll('.pitch-add, .pitch-empty').length;
      const label = row.querySelector('.pitch-add small, .pitch-player small')?.textContent?.trim() ?? '?';
      counts[label] = placed + empty;
    }
    return counts;
  });

  const before = await shapeOf();
  await page.getByLabel('Formation').selectOption('4-4-2');
  const after = await shapeOf();
  expect(after).not.toEqual(before);
  expect(await noHorizontalOverflow(page)).toBe(true);
});

test('the league overview shows the invite code and fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await prepare(page);
  await page.goto('/league');

  const code = page.locator('.invite-code strong');
  await expect(code).toBeVisible();
  // The demo code, from the demo store - never a hardcoded literal in the component.
  await expect(code).toHaveText('CIRCLE26');
  await expect(page.getByRole('button', { name: /copy code/i })).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);
});
