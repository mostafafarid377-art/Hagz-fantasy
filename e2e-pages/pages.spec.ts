import { test, expect } from '@playwright/test';

test('GitHub Pages build loads under a project subdirectory and survives a route refresh', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.status() >= 400 && response.url().startsWith('http://127.0.0.1:4174/')) {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });
  await page.goto('./');
  await expect(page.getByRole('link', { name: 'Explore demo' })).toBeVisible();
  await page.getByRole('link', { name: 'Explore demo' }).click();
  await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe('#/dashboard');
  await page.reload();
  await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
  // The Market tab was removed from navigation, so the market is reached by URL.
  // The dashboard's hero button now goes to the squad tab ("Build your squad").
  // The app uses HashRouter, and a bare '/market' also drops the GitHub Pages base
  // path, so navigate with the hash and a relative base.
  await page.goto('./#/market');
  await expect(page.getByRole('heading', { name: 'Player Market' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('profile back preserves the originating route in a Pages hash build', async ({page})=>{
  await page.goto('./#/squad-builder');
  await page.locator('.pitch-player[aria-label="Player details: Omar Khaled"]').click();
  await page.getByRole('link',{name:'Full profile'}).click();
  await expect.poll(()=>new URL(page.url()).hash).toBe('#/players/p1');
  await page.getByRole('link',{name:'Back',exact:true}).click();
  await expect.poll(()=>new URL(page.url()).hash).toBe('#/squad-builder');
});
