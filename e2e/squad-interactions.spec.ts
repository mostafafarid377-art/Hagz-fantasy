import { test, expect, type Page } from '@playwright/test';
async function fresh(page: Page, path:string) { await page.goto('/dashboard'); await page.evaluate(()=>localStorage.clear()); await page.goto(path); }
async function state(page:Page) { return page.evaluate(()=>JSON.parse(localStorage.getItem('fantasy-friends-demo-v1')!)); }

test('edit squad opens player details and confirms a same-position replacement',async({page})=>{
  await fresh(page,'/squad-builder');
  await page.locator('.pitch-player').getByText('Amr',{exact:true}).click();
  const sheet=page.getByRole('dialog'); await expect(sheet.getByRole('heading',{name:'Amr Hesham'})).toBeVisible();
  await sheet.getByRole('button',{name:'Select replacement'}).click();
  await expect(sheet.getByRole('button',{name:/Khaled Emad/})).toBeVisible();
  await expect(sheet.getByRole('button',{name:/Mazen Wael/})).toBeVisible();
  await expect(sheet.getByRole('button',{name:/Karim Hassan/})).toHaveCount(0);
  await sheet.getByRole('button',{name:/Mazen Wael/}).click();
  await expect(sheet.getByText('Replacing this player clears their captain or vice captain assignment.')).toBeVisible();
  expect((await state(page)).squads.find((s:{managerId:string;leagueId:string})=>s.managerId==='manager'&&s.leagueId==='league-1').playerIds).toContain('p15');
  await sheet.getByRole('button',{name:'Confirm replacement'}).click();
  await expect(sheet).toHaveCount(0);await expect(page.getByText('Transfer confirmed.')).toBeVisible();
  const squad=(await state(page)).squads.find((s:{managerId:string;leagueId:string})=>s.managerId==='manager'&&s.leagueId==='league-1');expect(squad.playerIds).toHaveLength(15);expect(squad.playerIds).toContain('p17');expect(squad.playerIds).not.toContain('p15');expect(squad.captainId).toBeUndefined();expect(squad.confirmed).toBe(false);
  await page.reload();await expect(page.locator('.pitch-player[aria-label="Player details: Mazen Wael"]')).toBeVisible();
});

test('replacement respects budget and closed market without changing the squad',async({page})=>{
  await fresh(page,'/dashboard');await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('fantasy-friends-demo-v1')!);s.leagues[0].budget=95.5;localStorage.setItem('fantasy-friends-demo-v1',JSON.stringify(s))});await page.goto('/squad-builder');
  await page.locator('.pitch-player').getByText('Ramy',{exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'Select replacement'}).click();await dialog.getByRole('button',{name:/Khaled Emad/}).click();
  await expect(dialog.getByRole('alert')).toHaveText('Not enough budget.');await expect(dialog.getByRole('button',{name:'Confirm replacement'})).toBeDisabled();
  await dialog.getByRole('button',{name:'Close'}).click();
  expect((await state(page)).squads.find((s:{managerId:string;leagueId:string})=>s.managerId==='manager'&&s.leagueId==='league-1').playerIds).toContain('p22');
  await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('fantasy-friends-demo-v1')!);s.leagues[0].marketOpen=false;localStorage.setItem('fantasy-friends-demo-v1',JSON.stringify(s))});await page.reload();
  await page.locator('.pitch-player').getByText('Ramy',{exact:true}).click();await dialog.getByRole('button',{name:'Select replacement'}).click();await dialog.getByRole('button',{name:/Khaled Emad/}).click();await expect(dialog.getByRole('alert')).toHaveText('The market is closed.');await expect(dialog.getByRole('button',{name:'Confirm replacement'})).toBeDisabled();
});

test('swap starter and bench players in either direction and persist lineup',async({page})=>{
  await fresh(page,'/squad');await page.locator('.pitch-player[aria-label="Player details: Youssef Adel"]').click();
  const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'Make substitution'}).click();
  await expect(page.getByText('Choose a player to swap')).toBeVisible();await expect(page.locator('.bench-player.swap-target')).toHaveCount(1);
  await page.locator('.bench-player[aria-label="Select swap player: Seif Mostafa"]').click();
  let team=(await state(page)).squads.find((s:{managerId:string;leagueId:string})=>s.managerId==='manager'&&s.leagueId==='league-1');expect(team.playerIds.indexOf('p8')).toBeLessThan(11);expect(team.playerIds.indexOf('p3')).toBeGreaterThanOrEqual(11);expect(team.playerIds).toHaveLength(15);expect(team.confirmed).toBe(false);
  await page.locator('.bench-player[aria-label="Player details: Youssef Adel"]').click();await dialog.getByRole('button',{name:'Make substitution'}).click();
  await expect(page.locator('.pitch-player.swap-target')).toHaveCount(4);await page.locator('.pitch-player[aria-label="Select swap player: Seif Mostafa"]').click();
  team=(await state(page)).squads.find((s:{managerId:string;leagueId:string})=>s.managerId==='manager'&&s.leagueId==='league-1');expect(team.playerIds.indexOf('p3')).toBeLessThan(11);expect(team.playerIds.indexOf('p8')).toBeGreaterThanOrEqual(11);
  await page.reload();await expect(page.locator('.pitch-player[aria-label="Player details: Youssef Adel"]')).toBeVisible();
});

test('corrective swaps fix formation mismatches and can be cancelled',async({page})=>{
  await fresh(page,'/squad');
  const team=async()=> (await state(page)).squads.find((s:{managerId:string;leagueId:string})=>s.managerId==='manager'&&s.leagueId==='league-1');

  // A swap can be started and cancelled without changing the squad.
  await page.locator('.pitch-player[aria-label="Player details: Youssef Adel"]').click();
  await page.getByRole('dialog').getByRole('button',{name:'Make substitution'}).click();
  await page.getByRole('button',{name:'Cancel swap'}).first().click();
  expect((await team()).playerIds[10]).toBe('p22');

  // Swapping a starter for a substitute that breaks the shape surfaces the mismatch.
  // The formation select was removed from this tab on request, so a swap is now the
  // only way a user can invalidate the lineup from here - which is what this covers.
  const swap=async()=>{
    await page.locator('.pitch-player[aria-label="Player details: Ramy Fathy"]').click();
    await page.getByRole('dialog').getByRole('button',{name:'Make substitution'}).click();
    await page.locator('.bench-player[aria-label="Select swap player: Tamer Hany"]').click();
  };
  await swap();
  await expect(page.getByText(/Starting positions do not match the selected formation/i)).toBeVisible();

  // Swapping back restores a valid squad.
  await swap();
  await expect(page.getByText('Squad is valid')).toBeVisible();
  await expect(page.getByRole('button',{name:'Confirm lineup'})).toBeEnabled();
});

test('player sheet captain controls, escape and Arabic mobile layout work',async({page})=>{
  await page.setViewportSize({width:390,height:844});await fresh(page,'/squad');await page.locator('.pitch-player[aria-label="Player details: Youssef Adel"]').click();
  const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'Captain',exact:true}).click();await expect(dialog.getByRole('button',{name:'Captain',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);expect((await state(page)).squads.find((s:{managerId:string;leagueId:string})=>s.managerId==='manager'&&s.leagueId==='league-1').captainId).toBe('p3');
  await page.getByLabel('Switch language').click();await page.locator('.pitch-player[aria-label="تفاصيل اللاعب: Youssef Adel"]').click();await expect(page.getByRole('button',{name:'إجراء تبديل'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('standings and dashboard show fantasy totals rather than league points',async({page})=>{
  await fresh(page,'/standings');await expect(page.getByText('Ranked by fantasy points')).toBeVisible();await expect(page.getByRole('columnheader',{name:'League pts'})).toHaveCount(0);
  const rows=page.locator('tbody tr');await expect(rows.nth(0)).toContainText('624');await expect(rows.nth(1)).toContainText('598');await expect(rows.nth(2)).toContainText('572');
  await page.goto('/dashboard');const mini=page.locator('.mini-table .mini-row');await expect(mini.nth(0)).toContainText('624');await expect(mini.nth(2)).toContainText('572');
});
