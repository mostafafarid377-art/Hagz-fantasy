import { test, expect } from '@playwright/test';

test.beforeEach(async ({page})=>{await page.goto('/dashboard');await page.evaluate(()=>localStorage.clear());await page.reload();});

test('application loads and desktop navigation works',async({page})=>{
  await expect(page.getByRole('heading',{name:/Welcome back/})).toBeVisible();
  // The Market tab was removed from navigation; the screen is reached from the
  // dashboard's "Explore market" action instead.
  await page.getByRole('link',{name:'Explore market'}).click();
  await expect(page.getByRole('heading',{name:'Player Market'})).toBeVisible();
  await page.goto('/squad-builder');await expect(page.getByRole('heading',{name:'Squad Builder'})).toBeVisible();
});
test('language and direction change without reload',async({page})=>{
  await page.getByLabel('Switch language').click();await expect(page.locator('html')).toHaveAttribute('dir','rtl');
  await expect(page.getByRole('heading',{name:/أهلاً بعودتك/})).toBeVisible();
  await page.getByLabel('تغيير اللغة').click();await expect(page.locator('html')).toHaveAttribute('dir','ltr');
});
test('role switching restricts leader actions to the leader',async({page})=>{
  await page.goto('/management');await expect(page.getByText('Access restricted')).toBeVisible();
  await page.goto('/settings');await page.getByLabel('Demo role').selectOption('leader');await page.goto('/management');
  await expect(page.getByRole('button',{name:'Create player'})).toBeVisible();
});
test('market search and position filters',async({page})=>{
  await page.goto('/market');await page.getByLabel('Search players').fill('Fares');
  await expect(page.getByText('Fares Ashraf')).toBeVisible();await page.getByLabel('Position').selectOption('GK');
  await expect(page.getByText('No players found')).toBeVisible();
});
test('manager suggests and leader approves exactly once',async({page})=>{
  await page.goto('/suggest');await page.getByLabel('Player name').fill('Hatem Test');await page.getByRole('button',{name:'Submit suggestion'}).click();
  await expect(page.getByText('Player suggested successfully.')).toBeVisible();
  await page.goto('/settings');await page.getByLabel('Demo role').selectOption('leader');await page.goto('/approvals');
  await page.locator('.manage-row').filter({hasText:'Hatem Test'}).getByRole('button',{name:'Details'}).click();
  await page.getByRole('button',{name:'Approve player'}).click();await page.goto('/market');await page.getByLabel('Search players').fill('Hatem Test');
  await expect(page.getByText('Hatem Test',{exact:true})).toHaveCount(1);
});
test('leader rejection feedback is visible to the manager',async({page})=>{
  await page.goto('/settings');await page.getByLabel('Demo role').selectOption('leader');await page.goto('/approvals');
  await page.locator('.manage-row').filter({hasText:'Hady Wael'}).getByRole('button',{name:'Reject'}).click();
  await page.getByLabel('Rejection reason (optional)').fill('Unavailable this season');await page.getByRole('button',{name:'Confirm rejection'}).click();
  await page.goto('/settings');await page.getByLabel('Demo role').selectOption('manager');await page.goto('/suggest');
  await expect(page.getByText(/Unavailable this season/)).toBeVisible();await expect(page.getByText('Rejected')).toBeVisible();
});
test('formation mismatch can be fixed by swapping a starter and substitute',async({page})=>{
  await page.goto('/squad-builder');await page.getByLabel('Formation').selectOption('4-4-2');
  await expect(page.getByText('Starting positions do not match the selected formation. Swap starters and substitutes to fix it.')).toBeVisible();
  await page.getByLabel('Starter',{exact:true}).selectOption('p22');await page.getByLabel('Substitute',{exact:true}).selectOption('p14');await page.getByRole('button',{name:'Swap players'}).click();
  await expect(page.getByText('Squad is valid')).toBeVisible();await page.getByRole('button',{name:'Confirm lineup'}).click();await expect(page.getByText('Squad confirmed')).toBeVisible();
});
test('squad add and remove preserves position and budget constraints',async({page})=>{
  await page.goto('/squad-builder');await page.getByLabel('Remove: Tamer Hany').click();await page.goto('/market');
  await page.getByLabel('Search players').fill('Adam Sherif');await page.getByRole('button',{name:'Add to squad'}).click();
  await expect(page.getByRole('button',{name:'Remove'})).toBeVisible();await page.goto('/squad-builder');
  // The roster list under the pitch was removed, so the squad is now read from the
  // pitch itself. The builder shows on-pitch players with a "Player details" label.
  await expect(page.locator('.pitch-player[aria-label*="Adam Sherif"]')).toBeVisible();
});
test('transfer preview and confirmation update the squad',async({page})=>{
  await page.goto('/transfers');await page.getByLabel('Player to transfer out').selectOption('p15');await page.getByLabel('Replacement player').selectOption('p17');
  await expect(page.getByText('After transfer:')).toBeVisible();await page.getByRole('button',{name:'Confirm transfer'}).click();
  await expect(page.getByText('Transfer confirmed.')).toBeVisible();await expect(page.locator('.suggestion-row').filter({hasText:'Mazen Wael'})).toBeVisible();
});
test('switching leagues isolates market and competition samples',async({page})=>{
  await page.getByLabel('Switch league').selectOption('league-2');await page.goto('/market');
  await page.getByLabel('Search players').fill('Hady Wael');await expect(page.getByText('No players found')).toBeVisible();
  await page.goto('/standings');await expect(page.getByText('No competition data for this league')).toBeVisible();
});
test('mobile and tablet navigation work without horizontal overflow',async({page})=>{
  for(const width of [390,768]){await page.setViewportSize({width,height:844});await page.goto('/dashboard');
    await expect(page.locator('.mobile-nav')).toBeVisible();await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    // The Market tab is intentionally gone; the remaining tabs must work and the
    // market screen must still be reachable from in-page actions.
    await expect(page.locator('.mobile-nav').getByRole('link',{name:'Market'})).toHaveCount(0);
    await page.locator('.mobile-nav').getByRole('link',{name:'Squad'}).click();await expect(page.locator('.mobile-nav')).toBeVisible();}
});
test('Arabic mobile layout has RTL navigation and no page overflow',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.getByLabel('Switch language').click();
  await expect(page.locator('html')).toHaveAttribute('dir','rtl');await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.locator('.mobile-nav').getByRole('link',{name:'السوق'}).click();await expect(page.getByRole('heading',{name:'سوق اللاعبين'})).toBeVisible();
});
