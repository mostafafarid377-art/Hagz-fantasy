import { test, expect, type Page } from '@playwright/test';
async function prepare(page: Page, empty=false) {
  await page.goto('/dashboard'); await page.evaluate(()=>localStorage.clear()); await page.reload();
  if(empty) {
    await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('fantasy-friends-demo-v1')!);const q=s.squads.find((q:{managerId:string;leagueId:string})=>q.managerId==='manager'&&q.leagueId==='league-1');q.playerIds=[];q.captainId=undefined;q.viceCaptainId=undefined;q.confirmed=false;localStorage.setItem('fantasy-friends-demo-v1',JSON.stringify(s));});
    // Direct localStorage edits do not update DemoProvider's in-memory React state.
    // Reload before interacting so the app and test fixture use the same squad.
    await page.reload();
  }
}
async function team(page: Page){return page.evaluate(()=>JSON.parse(localStorage.getItem('fantasy-friends-demo-v1')!).squads.find((s:{managerId:string;leagueId:string})=>s.managerId==='manager'&&s.leagueId==='league-1'));}

test('empty squad shows fifteen position slots and builds via filtered local market',async({page})=>{
  await prepare(page,true);await page.goto('/squad-builder');
  const pitch=page.locator('.squad-selection-pitch');await expect(pitch.locator('.pitch-add')).toHaveCount(15);
  for(const [pos,count] of [['GK',2],['DEF',5],['MID',5],['FWD',3]] as const)await expect(pitch.getByRole('button',{name:`Add player: ${pos}`})).toHaveCount(count);
  await pitch.getByRole('button',{name:'Add player: GK'}).first().click();const dialog=page.getByRole('dialog');
  await expect(dialog.getByRole('heading',{name:'Add player · GK'})).toBeVisible();await expect(dialog.getByRole('button',{name:/Omar Khaled/})).toBeVisible();await expect(dialog.getByRole('button',{name:/Youssef Adel/})).toHaveCount(0);
  await dialog.getByRole('button',{name:/Omar Khaled/}).click();await expect(dialog).toHaveCount(0);await expect(pitch.locator('.pitch-add')).toHaveCount(14);expect((await team(page)).playerIds).toEqual(['p1']);
  await page.reload();await expect(pitch.locator('.pitch-add')).toHaveCount(14);await expect(pitch.getByRole('button',{name:'Player details: Omar Khaled'})).toBeVisible();
  await pitch.getByRole('button',{name:'Add player: DEF'}).first().click();await dialog.getByRole('button',{name:/Youssef Adel/}).click();expect((await team(page)).playerIds).toEqual(['p1','p3']);
});

test('every one of fifteen empty spots can be filled without losing selections',async({page})=>{
  await prepare(page,true);await page.goto('/squad-builder');const pitch=page.locator('.squad-selection-pitch');
  const groups=[['GK',['Omar Khaled','Sherif Adel']],['DEF',['Youssef Adel','Ahmed Nabil','Ziad Tarek','Mahmoud Samir','Seif Mostafa']],['MID',['Hassan Magdy','Marwan Salah','Fares Ashraf','Tamer Hany','Samy Ibrahim']],['FWD',['Amr Hesham','Yassin Mohamed','Ramy Fathy']]] as const;
  for(const [position,names] of groups){for(const name of names){await pitch.getByRole('button',{name:`Add player: ${position}`}).first().click();await page.getByRole('dialog').getByRole('button',{name:new RegExp(name)}).click();}}
  await expect(pitch.locator('.pitch-add')).toHaveCount(0);const q=await team(page);expect(q.playerIds).toHaveLength(15);expect(new Set(q.playerIds).size).toBe(15);await page.reload();await expect(pitch.locator('.pitch-player')).toHaveCount(11);await expect(page.locator('.bench-player')).toHaveCount(4);const starters=await page.locator('.pitch-player strong').allTextContents();const bench=await page.locator('.bench-player strong').allTextContents();expect(starters).toHaveLength(11);expect(bench).toHaveLength(4);expect(starters.some(name=>bench.includes(name))).toBe(false);await page.getByRole('link',{name:'View squad'}).click();await expect(page.locator('.pitch-player')).toHaveCount(11);await expect(page.locator('.bench-player')).toHaveCount(4);
});

test('add player respects budget, market status, and position limits',async({page})=>{
  await prepare(page,true);await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('fantasy-friends-demo-v1')!);s.leagues[0].budget=1;localStorage.setItem('fantasy-friends-demo-v1',JSON.stringify(s));});await page.goto('/squad-builder');
  await page.locator('.pitch-add[aria-label="Add player: GK"]').first().click();let dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:/Omar Khaled/}).click();await expect(dialog.getByRole('alert')).toHaveText('Not enough budget.');expect((await team(page)).playerIds).toHaveLength(0);await dialog.getByRole('button',{name:'Close'}).click();
  await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('fantasy-friends-demo-v1')!);s.leagues[0].budget=100;s.leagues[0].marketOpen=false;localStorage.setItem('fantasy-friends-demo-v1',JSON.stringify(s));});await page.reload();
  await page.locator('.pitch-add[aria-label="Add player: DEF"]').first().click();dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:/Youssef Adel/}).click();await expect(dialog.getByRole('alert')).toHaveText('The market is closed.');expect((await team(page)).playerIds).toHaveLength(0);
});

test('my squad supports empty positions, and adding a bench player does not change starters',async({page})=>{
  await prepare(page,true);await page.goto('/squad-builder');await expect(page.locator('.squad-selection-pitch .pitch-add')).toHaveCount(15);await page.getByRole('button',{name:'Add player: MID'}).first().click();await page.getByRole('dialog').getByRole('button',{name:/Hassan Magdy/}).click();expect((await team(page)).playerIds).toEqual(['p9']);
  await prepare(page);await page.goto('/squad-builder');await page.getByRole('button',{name:'Remove: Seif Mostafa'}).click();await page.goto('/squad-builder');const before=await team(page);await expect(page.locator('.bench-add[aria-label="Add player: DEF"]')).toHaveCount(1);
  await page.locator('.bench-add[aria-label="Add player: DEF"]').click();await page.getByRole('dialog').getByRole('button',{name:/Ali Hamdy/}).click();const after=await team(page);expect(after.playerIds.slice(0,11)).toEqual(before.playerIds.slice(0,11));expect(after.playerIds).toContain('p7');
});

test('empty slots support Arabic mobile layout and closing the picker',async({page})=>{
  await page.setViewportSize({width:390,height:844});await prepare(page,true);await page.goto('/squad-builder');await page.getByLabel('Switch language').click();
  await expect(page.locator('.squad-selection-pitch .pitch-add')).toHaveCount(15);await page.locator('.pitch-add[aria-label="إضافة لاعب: GK"]').first().click();await expect(page.getByRole('dialog').getByRole('heading',{name:'إضافة لاعب · GK'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);expect((await team(page)).playerIds).toHaveLength(0);
});

test('profile back returns to the originating page and direct links fall back to market',async({page})=>{
  await prepare(page);await page.goto('/squad-builder');await page.locator('.pitch-player[aria-label="Player details: Omar Khaled"]').click();await page.getByRole('link',{name:'Full profile'}).click();await expect(page).toHaveURL(/\/players\/p1$/);await page.getByRole('link',{name:'Back',exact:true}).click();await expect(page).toHaveURL(/\/squad-builder$/);
  await page.goto('/squad');await page.locator('.pitch-player[aria-label="Player details: Omar Khaled"]').click();await page.getByRole('link',{name:'Full profile'}).click();await page.getByRole('link',{name:'Back',exact:true}).click();await expect(page).toHaveURL(/\/squad$/);
  await page.goto('/statistics');await page.getByRole('link',{name:'Omar Khaled'}).click();await page.getByRole('link',{name:'Back',exact:true}).click();await expect(page).toHaveURL(/\/statistics$/);
  await page.goto('/players/p1');await page.getByRole('link',{name:'Back',exact:true}).click();await expect(page).toHaveURL(/\/market$/);
});

test('match details return to their originating fixtures page and standings omit W D L',async({page})=>{
  await prepare(page);await page.goto('/head-to-head');await page.locator('.fixture-row').first().click();await page.getByRole('link',{name:'Back',exact:true}).click();await expect(page).toHaveURL(/\/head-to-head$/);
  await page.goto('/standings');for(const name of ['W','D','L'])await expect(page.getByRole('columnheader',{name,exact:true})).toHaveCount(0);await expect(page.getByRole('columnheader',{name:'Fantasy pts'})).toBeVisible();
});

test('dashboard empty slots open the same position picker',async({page})=>{
  await prepare(page,true);await page.goto('/dashboard');const pitch=page.locator('.squad-selection-pitch');await expect(pitch.locator('.pitch-add')).toHaveCount(15);
  await pitch.getByRole('button',{name:'Add player: DEF'}).first().click();await page.getByRole('dialog').getByRole('button',{name:/Youssef Adel/}).click();expect((await team(page)).playerIds).toEqual(['p3']);
});
