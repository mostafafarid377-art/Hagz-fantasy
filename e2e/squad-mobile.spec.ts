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

const prepare = async (page: Page, empty = false) => {
  await page.goto('/dashboard');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  if (empty) {
    await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('fantasy-friends-demo-v1')!);
      const squad = state.squads.find((item: { managerId: string; leagueId: string }) => item.managerId === 'manager' && item.leagueId === 'league-1');
      squad.playerIds = [];
      squad.captainId = undefined;
      squad.viceCaptainId = undefined;
      squad.confirmed = false;
      localStorage.setItem('fantasy-friends-demo-v1', JSON.stringify(state));
    });
    // Keep the provider's in-memory state in sync with the fixture mutation.
    await page.reload();
  }
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

    const editSquad = actions.getByRole('link', { name: /edit squad/i });
    await expect(editSquad).toHaveAttribute('href', '/squad-builder');
    await expect(editSquad).toBeVisible();
    const editBox = await editSquad.boundingBox();
    expect(editBox!.width).toBeGreaterThan(80);
    await editSquad.click();
    const addPlayers = page.locator('.squad-actions').getByRole('link', { name: /add players/i });
    await expect(addPlayers).toHaveAttribute('href', '/market');
    const addBox = await addPlayers.boundingBox();
    expect(addBox!.width).toBeGreaterThan(80);
    await expect(page.getByLabel('Formation')).toBeVisible();
    await expect(page.locator('.bench-player').first()).toBeVisible();
    await page.locator('.bench-player').first().click();
    const playerSheet = page.getByRole('dialog');
    await expect(playerSheet.getByRole('button', { name: 'Select replacement' })).toBeVisible();
    await playerSheet.getByRole('button', { name: 'Close' }).click();
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

test('Edit Squad, View Squad, formation selection, and saved 11/4 separation work on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page);
  await page.goto('/squad');

  const starters = await page.locator('.pitch .pitch-player strong').allTextContents();
  const bench = await page.locator('.bench-player strong').allTextContents();
  await expect(page.locator('.pitch .pitch-player')).toHaveCount(11);
  await expect(page.locator('.bench-player')).toHaveCount(4);
  await page.getByRole('link', { name: 'Edit squad' }).click();
  await expect(page).toHaveURL(/\/squad-builder$/);
  await expect(page.locator('.pitch .pitch-player')).toHaveCount(11);
  await expect(page.locator('.bench-player')).toHaveCount(4);
  const formation = page.getByLabel('Formation');
  for (const shape of ['4-3-3','4-4-2','3-5-2','3-4-3','4-5-1','5-3-2','5-4-1']) {
    await formation.selectOption(shape);
    await expect(formation).toHaveValue(shape);
    await expect(page.locator('.pitch .pitch-player')).toHaveCount(11);
    await expect(page.locator('.bench-player')).toHaveCount(4);
    expect(await page.locator('.pitch .pitch-player strong').allTextContents()).toEqual(starters);
    expect(await page.locator('.bench-player strong').allTextContents()).toEqual(bench);
  }
  await formation.selectOption('4-3-3');
  await page.reload();
  await expect(page.getByLabel('Formation')).toHaveValue('4-3-3');
  await expect(page.locator('.pitch .pitch-player')).toHaveCount(11);
  await expect(page.locator('.bench-player')).toHaveCount(4);
  await page.getByRole('link', { name: 'View squad' }).click();
  await expect(page).toHaveURL(/\/squad$/);
  await expect(page.locator('.pitch .pitch-player')).toHaveCount(11);
  await expect(page.locator('.bench-player')).toHaveCount(4);
  await expect(page.locator('.squad-actions').getByRole('link', { name: /add players/i })).toHaveCount(0);
  await page.locator('.bench-player').first().click();
  const viewSheet = page.getByRole('dialog');
  await expect(viewSheet.getByRole('link', { name: 'Full profile' })).toBeVisible();
  await expect(viewSheet.getByRole('button', { name: 'Make substitution' })).toHaveCount(0);
  await expect(viewSheet.getByRole('button', { name: 'Select replacement' })).toHaveCount(0);
  await viewSheet.getByRole('button', { name: 'Close' }).click();
  expect(await noHorizontalOverflow(page)).toBe(true);
});

test('squad editor remains operable in English LTR and Arabic RTL', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page);
  await page.goto('/squad-builder');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByLabel('Formation')).toBeVisible();
  await expect(page.locator('.bench-player')).toHaveCount(4);
  await page.getByLabel('Switch language').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByLabel('التشكيل')).toBeVisible();
  await expect(page.locator('.bench-player')).toHaveCount(4);
  await page.locator('.bench-player').first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('button', { name: 'اختر بديلاً' })).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);
});

test('tapping + opens a position-filtered player list', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page, true);
  await page.goto('/squad-builder'); // empty fixture: the builder exposes every position slot

  await page.locator('.pitch-add[aria-label="Add player: GK"]').first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /Add player . GK/ })).toBeVisible();
  // Every offered player is a goalkeeper, not merely the first result.
  const offeredPositions = await dialog.locator('.replacement-row small').allTextContents();
  expect(offeredPositions.length).toBeGreaterThan(0);
  expect(offeredPositions.every(position => position.startsWith('GK ·'))).toBe(true);
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
