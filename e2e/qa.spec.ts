import { test, expect, type Page } from '@playwright/test';

async function fresh(page: Page) {
  await page.goto('/dashboard');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}
async function role(page: Page, value: 'manager' | 'leader') {
  await page.goto('/settings'); await page.getByLabel('Demo role').selectOption(value);
}
async function imageFile(page: Page, color: string, name: string) {
  const base64 = await page.evaluate((fill) => {
    const canvas = document.createElement('canvas'); canvas.width=32; canvas.height=32;
    const context=canvas.getContext('2d')!; context.fillStyle=fill; context.fillRect(0,0,32,32);
    return canvas.toDataURL('image/png').split(',')[1];
  }, color);
  return { name, mimeType:'image/png', buffer: Buffer.from(base64,'base64') };
}

test('manager image selection, replacement, removal and suggestion persistence', async ({page})=>{
  await fresh(page); await page.goto('/suggest');
  const picker=page.getByLabel('Choose a local image');
  const first=await imageFile(page,'red','first.png'); const second=await imageFile(page,'blue','second.png');
  await picker.setInputFiles(first); const preview=page.getByRole('img',{name:'Image preview'});
  await expect(preview).toBeVisible(); const original=await preview.getAttribute('src');
  await picker.setInputFiles(second); await expect.poll(()=>preview.getAttribute('src')).not.toBe(original);
  await page.getByRole('button',{name:'Remove image'}).click(); await expect(preview).toHaveCount(0);
  await picker.setInputFiles(second); await expect(preview).toBeVisible();
  const saved=await preview.getAttribute('src'); await page.getByLabel('Player name').fill('Image Suggestion');
  await page.getByRole('button',{name:'Submit suggestion'}).click(); await expect(page.getByText('Player suggested successfully.')).toBeVisible();
  await page.reload(); const row=page.locator('.suggestion-row').filter({hasText:'Image Suggestion'});
  await expect(row.locator('img')).toHaveAttribute('src',saved!);
  await role(page,'leader'); await page.goto('/approvals'); await page.locator('.manage-row').filter({hasText:'Image Suggestion'}).getByRole('button',{name:'Details'}).click();
  await expect(page.getByRole('img',{name:'Image preview'})).toHaveAttribute('src',saved!);
  await page.getByRole('button',{name:'Approve player'}).click(); await page.goto('/market'); await page.getByLabel('Search players').fill('Image Suggestion');
  await expect(page.locator('.player-card img')).toHaveAttribute('src',saved!); await page.reload(); await page.getByLabel('Search players').fill('Image Suggestion');
  await expect(page.locator('.player-card img')).toHaveAttribute('src',saved!);
});

test('leader can persist, replace and remove a player image after refresh', async ({page})=>{
  await fresh(page); await role(page,'leader'); await page.goto('/management');
  const row=page.locator('.manage-row').filter({hasText:'Omar Khaled'}); await row.getByRole('button',{name:'Edit'}).click();
  const first=await imageFile(page,'orange','orange.png'); const second=await imageFile(page,'lime','green.png');
  await page.getByLabel('Choose a local image').setInputFiles(first); await expect(page.getByRole('img',{name:'Image preview'})).toBeVisible();
  await page.getByRole('button',{name:'Save changes'}).click(); await page.reload();
  await expect(row.locator('img')).toHaveAttribute('src',/^data:image\/png;base64,/); await row.getByRole('button',{name:'Edit'}).click();
  const before=await page.getByRole('img',{name:'Image preview'}).getAttribute('src');
  await page.getByLabel('Choose a local image').setInputFiles(second); await expect.poll(()=>page.getByRole('img',{name:'Image preview'}).getAttribute('src')).not.toBe(before);
  const after=await page.getByRole('img',{name:'Image preview'}).getAttribute('src'); await page.getByRole('button',{name:'Save changes'}).click(); await page.reload();
  await expect(row.locator('img')).toHaveAttribute('src',after!); await row.getByRole('button',{name:'Edit'}).click();
  await page.getByRole('button',{name:'Remove image'}).click(); await page.getByRole('button',{name:'Save changes'}).click(); await page.reload();
  await expect(row.locator('img')).toHaveCount(0);
});

test('unsupported and oversized images are rejected without losing the current selection', async ({page})=>{
  await fresh(page); await page.goto('/suggest'); const picker=page.getByLabel('Choose a local image');
  await picker.setInputFiles(await imageFile(page,'red','valid.png')); const before=await page.getByRole('img',{name:'Image preview'}).getAttribute('src');
  await picker.setInputFiles({name:'bad.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg/>')});
  await expect(page.getByRole('alert')).toContainText('PNG, JPEG or WebP'); await expect(page.getByRole('img',{name:'Image preview'})).toHaveAttribute('src',before!);
  await picker.setInputFiles({name:'too-large.png',mimeType:'image/png',buffer:Buffer.alloc(5*1024*1024+1)});
  await expect(page.getByRole('alert')).toContainText('up to 5 MB'); await expect(page.getByRole('img',{name:'Image preview'})).toHaveAttribute('src',before!);
});

test('a large device photo is resized and survives a refresh', async ({page})=>{
  await fresh(page); await page.goto('/suggest');
  const data=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=700;canvas.height=700;const ctx=canvas.getContext('2d')!;const img=ctx.createImageData(700,700);for(let i=0;i<img.data.length;i+=4){img.data[i]=Math.random()*256;img.data[i+1]=Math.random()*256;img.data[i+2]=Math.random()*256;img.data[i+3]=255;}ctx.putImageData(img,0,0);return canvas.toDataURL('image/png').split(',')[1]});
  const buffer=Buffer.from(data,'base64');expect(buffer.length).toBeGreaterThan(256*1024);expect(buffer.length).toBeLessThan(5*1024*1024);
  await page.getByLabel('Choose a local image').setInputFiles({name:'photo.png',mimeType:'image/png',buffer});
  const preview=page.getByRole('img',{name:'Image preview'});await expect(preview).toBeVisible();
  const stored=await preview.getAttribute('src');expect(stored?.startsWith('data:image/webp;')||stored?.startsWith('data:image/jpeg;')).toBe(true);
  expect(stored!.length).toBeLessThan(256*1024*1.4);await page.getByLabel('Player name').fill('Large Photo');
  await page.getByRole('button',{name:'Submit suggestion'}).click();await expect(page.getByText('Player suggested successfully.')).toBeVisible();await page.reload();
  await expect(page.locator('.suggestion-row').filter({hasText:'Large Photo'}).locator('img')).toHaveAttribute('src',stored!);
});

test('browser storage failure is surfaced instead of reporting a saved suggestion', async ({page})=>{
  await fresh(page); await page.goto('/suggest'); await page.getByLabel('Player name').fill('No Storage');
  await page.evaluate(()=>{ Storage.prototype.setItem = () => { throw new DOMException('quota exceeded','QuotaExceededError'); }; });
  await page.getByRole('button',{name:'Submit suggestion'}).click();
  await expect(page.getByRole('status')).toContainText('could not be saved');
  await expect(page.getByText('Player suggested successfully.')).toHaveCount(0);
});

test('all formations preserve the squad, and captain and vice-captain remain distinct', async ({page})=>{
  await fresh(page); await page.goto('/squad-builder');
  const originals=await page.locator('.roster-row strong').allTextContents();
  for(const f of ['4-3-3','4-4-2','3-5-2','3-4-3','4-5-1','5-3-2','5-4-1']){
    await page.getByLabel('Formation').selectOption(f); await expect(page.getByLabel('Formation')).toHaveValue(f);
    expect(await page.locator('.roster-row strong').allTextContents()).toEqual(originals);
  }
  await page.getByLabel('Formation').selectOption('4-3-3');
  await page.getByLabel('Set captain: Hassan Magdy').click(); await expect(page.getByText('Select a vice captain from your squad.')).toBeVisible();
  await page.getByLabel('Set vice captain: Amr Hesham').click(); await expect(page.getByText('Squad is valid')).toBeVisible();
  await page.getByRole('button',{name:'Confirm lineup'}).click(); await page.reload();
  await expect(page.getByText('Squad confirmed')).toBeVisible();
  const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('fantasy-friends-demo-v1')!));
  const squad=stored.squads.find((s:{leagueId:string;managerId:string})=>s.leagueId==='league-1'&&s.managerId==='manager');
  expect(squad.captainId).toBe('p9'); expect(squad.viceCaptainId).toBe('p15');
});

test('suggestions and leader queues remain isolated when switching leagues', async ({page})=>{
  await fresh(page); await page.goto('/suggest'); await page.getByLabel('Player name').fill('League One Only'); await page.getByRole('button',{name:'Submit suggestion'}).click();
  await expect(page.getByText('Player suggested successfully.')).toBeVisible(); await page.getByLabel('Switch league').selectOption('league-2');
  await expect(page.getByText('League One Only')).toHaveCount(0); await role(page,'leader'); await page.goto('/approvals');
  await expect(page.getByText('League One Only')).toHaveCount(0); await page.getByLabel('Switch league').selectOption('league-1');
  await expect(page.getByText('League One Only')).toBeVisible();
});

test('responsive English and Arabic pages have no page overflow or critical browser errors', async ({page})=>{
  test.setTimeout(180000); await fresh(page);
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(`pageerror: ${error.message}`));
  page.on('console',message=>{if(message.type()==='error')errors.push(`console: ${message.text()}`)});
  page.on('requestfailed',request=>errors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));
  page.on('response',response=>{if(response.status()>=400)errors.push(`HTTP ${response.status()}: ${response.url()}`)});
  const sizes=[{width:390,height:844},{width:768,height:1024},{width:1440,height:900}];
  const routes=['/','/login','/signup','/dashboard','/league','/create-league','/join-league','/market','/players/p1','/squad','/squad-builder','/transfers','/suggest','/fixtures','/match-center','/match-center/gw09','/head-to-head','/standings','/statistics','/points','/profile','/settings','/notifications'];
  for(const language of ['en','ar']){
    await page.goto('/settings',{waitUntil:'networkidle'});
    if(language==='ar') await page.getByLabel('Language',{exact:true}).selectOption('ar');
    await expect(page.locator('html')).toHaveAttribute('dir',language==='ar'?'rtl':'ltr');
    for(const size of sizes){
      await page.setViewportSize(size);
      for(const route of routes){
        await page.goto(route,{waitUntil:'networkidle'});
        const dimensions=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,inner:window.innerWidth}));
        expect(dimensions.scroll,`${language} ${size.width}x${size.height} ${route}`).toBeLessThanOrEqual(dimensions.inner);
        await expect(page.locator('#root')).not.toBeEmpty();
      }
      await page.goto('/settings',{waitUntil:'networkidle'});
      await page.getByLabel(language==='ar'?'الدور التجريبي':'Demo role',{exact:true}).selectOption('leader');
      await page.goto('/management',{waitUntil:'networkidle'});
      await page.getByRole('button',{name:language==='ar'?'إنشاء لاعب':'Create player'}).click();
      await expect(page.locator('.form-panel')).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth),`leader form ${language} ${size.width}`).toBeLessThanOrEqual(size.width);
      await page.goto('/approvals',{waitUntil:'networkidle'});
      await page.locator('.manage-row').filter({hasText:'Hady Wael'}).getByRole('button',{name:language==='ar'?'رفض':'Reject'}).click();
      await expect(page.locator('textarea')).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth),`review form ${language} ${size.width}`).toBeLessThanOrEqual(size.width);
      await page.goto('/settings',{waitUntil:'networkidle'});
      await page.getByLabel(language==='ar'?'الدور التجريبي':'Demo role',{exact:true}).selectOption('manager');
    }
  }
  expect(errors).toEqual([]);
});
