import { test, expect, type Page, type Locator } from '@playwright/test';

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


async function imageExists(page: Page, ref: string) { return page.evaluate(ref=>new Promise<boolean>((resolve,reject)=>{const open=indexedDB.open('fantasy-friends-images',1);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result;const tx=db.transaction('images','readonly');const get=tx.objectStore('images').get(ref);get.onsuccess=()=>resolve(!!get.result);get.onerror=()=>reject(get.error);tx.oncomplete=()=>db.close()} }),ref); }
async function imageColor(image: Locator) {
  await expect(image).toBeVisible();
  return image.evaluate(async el => {
    const img=el as HTMLImageElement; await img.decode(); const canvas=document.createElement('canvas'); canvas.width=1;canvas.height=1;
    const ctx=canvas.getContext('2d')!;ctx.drawImage(img,0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];
  });
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
  const saved=await imageColor(preview); await page.getByLabel('Player name').fill('Image Suggestion');
  await page.getByRole('button',{name:'Submit suggestion'}).click(); await expect(page.getByText('Player suggested successfully.')).toBeVisible();
  await page.reload(); const row=page.locator('.suggestion-row').filter({hasText:'Image Suggestion'});
  expect(await imageColor(row.locator('img'))).toEqual(saved);
  await role(page,'leader'); await page.goto('/approvals'); expect(await imageColor(page.locator('.manage-row').filter({hasText:'Image Suggestion'}).locator('img'))).toEqual(saved); await page.locator('.manage-row').filter({hasText:'Image Suggestion'}).getByRole('button',{name:'Details'}).click();
  expect(await imageColor(page.getByRole('img',{name:'Image preview'}))).toEqual(saved);
  await page.getByRole('button',{name:'Approve player'}).click(); await page.goto('/market'); await page.getByLabel('Search players').fill('Image Suggestion');
  expect(await imageColor(page.locator('.player-card img'))).toEqual(saved); await page.reload(); await page.getByLabel('Search players').fill('Image Suggestion');
  expect(await imageColor(page.locator('.player-card img'))).toEqual(saved);
});

test('leader can persist, replace and remove a player image after refresh', async ({page})=>{
  await fresh(page); await role(page,'leader'); await page.goto('/management');
  const row=page.locator('.manage-row').filter({hasText:'Omar Khaled'}); await row.getByRole('button',{name:'Edit'}).click();
  const first=await imageFile(page,'orange','orange.png'); const second=await imageFile(page,'lime','green.png');
  await page.getByLabel('Choose a local image').setInputFiles(first); await expect(page.getByRole('img',{name:'Image preview'})).toBeVisible();
  await page.getByRole('button',{name:'Save changes'}).click(); await page.reload();
  await expect(row.locator('img')).toHaveAttribute('src',/^blob:/); const firstRef=await page.evaluate(()=>JSON.parse(localStorage.getItem('fantasy-friends-demo-v1')!).players.find((p:{id:string})=>p.id==='p1').image); await row.getByRole('button',{name:'Edit'}).click();
  const before=await page.getByRole('img',{name:'Image preview'}).getAttribute('src');
  await page.getByLabel('Choose a local image').setInputFiles(second); await expect.poll(()=>page.getByRole('img',{name:'Image preview'}).getAttribute('src')).not.toBe(before);
  const after=await imageColor(page.getByRole('img',{name:'Image preview'})); await page.getByRole('button',{name:'Save changes'}).click(); await page.reload();
  expect(await imageColor(row.locator('img'))).toEqual(after); const secondRef=await page.evaluate(()=>JSON.parse(localStorage.getItem('fantasy-friends-demo-v1')!).players.find((p:{id:string})=>p.id==='p1').image); await expect.poll(()=>imageExists(page,firstRef)).toBe(false); await row.getByRole('button',{name:'Edit'}).click();
  await page.getByRole('button',{name:'Remove image'}).click(); await page.getByRole('button',{name:'Save changes'}).click(); await page.reload();
  await expect(row.locator('img')).toHaveCount(0); await expect.poll(()=>imageExists(page,secondRef)).toBe(false);
});

test('unsupported and oversized images are rejected without losing the current selection', async ({page})=>{
  await fresh(page); await page.goto('/suggest'); const picker=page.getByLabel('Choose a local image');
  await picker.setInputFiles(await imageFile(page,'red','valid.png')); const before=await page.getByRole('img',{name:'Image preview'}).getAttribute('src');
  await picker.setInputFiles({name:'bad.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg/>')});
  await expect(page.getByRole('alert')).toContainText('valid JPG, JPEG, PNG or WebP'); await expect(page.getByRole('img',{name:'Image preview'})).toHaveAttribute('src',before!);
  await picker.setInputFiles({name:'too-large.png',mimeType:'image/png',buffer:Buffer.alloc(5*1024*1024+1)});
  await expect(page.getByRole('alert')).toContainText('larger than 5 MB'); await expect(page.getByRole('img',{name:'Image preview'})).toHaveAttribute('src',before!);
});

test('native picker accepts JPEG, JPG and WebP files and rejects a corrupt PNG', async ({page})=>{
  await fresh(page);await page.goto('/suggest');const picker=page.getByLabel('Choose a local image');
  for(const [name,mime] of [['photo.jpg','image/jpeg'],['photo.jpeg','image/jpeg'],['photo.webp','image/webp']] as const){
    const data=await page.evaluate(type=>{const c=document.createElement('canvas');c.width=4;c.height=4;return c.toDataURL(type).split(',')[1]},mime);
    await picker.setInputFiles({name,mimeType:mime,buffer:Buffer.from(data,'base64')});await expect(page.getByRole('img',{name:'Image preview'})).toBeVisible();
    await page.getByRole('button',{name:'Remove image'}).click();
  }
  await picker.setInputFiles({name:'corrupt.png',mimeType:'image/png',buffer:Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0])});
  await expect(page.getByRole('alert')).toContainText('valid JPG, JPEG, PNG or WebP');await expect(page.getByRole('img',{name:'Image preview'})).toHaveCount(0);
});

test('a large device photo is stored in IndexedDB and survives a refresh', async ({page})=>{
  await fresh(page); await page.goto('/suggest');
  const data=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=700;canvas.height=700;const ctx=canvas.getContext('2d')!;const img=ctx.createImageData(700,700);for(let i=0;i<img.data.length;i+=4){img.data[i]=Math.random()*256;img.data[i+1]=Math.random()*256;img.data[i+2]=Math.random()*256;img.data[i+3]=255;}ctx.putImageData(img,0,0);return canvas.toDataURL('image/png').split(',')[1]});
  const buffer=Buffer.from(data,'base64');expect(buffer.length).toBeGreaterThan(256*1024);expect(buffer.length).toBeLessThan(5*1024*1024);
  await page.getByLabel('Choose a local image').setInputFiles({name:'photo.png',mimeType:'image/png',buffer});
  const preview=page.getByRole('img',{name:'Image preview'});await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute('src',/^blob:/);await page.getByLabel('Player name').fill('Large Photo');
  await page.getByRole('button',{name:'Submit suggestion'}).click();await expect(page.getByText('Player suggested successfully.')).toBeVisible();
  const state=await page.evaluate(()=>localStorage.getItem('fantasy-friends-demo-v1')!);
  expect(state).not.toContain('data:image/');expect(JSON.parse(state).suggestions.find((s:{name:string})=>s.name==='Large Photo').image).toMatch(/^local-image:/);
  await page.reload(); await expect(page.locator('.suggestion-row').filter({hasText:'Large Photo'}).locator('img')).toHaveAttribute('src',/^blob:/);
});

test('leader creates a player with a local photo', async ({page})=>{
  await fresh(page);await role(page,'leader');await page.goto('/management');await page.getByRole('button',{name:'Create player'}).click();
  await page.getByLabel('Player name').fill('Photo Player');await page.getByLabel('Choose a local image').setInputFiles(await imageFile(page,'red','photo.png'));
  const expected=await imageColor(page.getByRole('img',{name:'Image preview'}));await page.getByRole('button',{name:'Publish player'}).click();
  await page.reload();expect(await imageColor(page.locator('.manage-row').filter({hasText:'Photo Player'}).locator('img'))).toEqual(expected);
});

test('player photos appear in profile, lineup, bench and transfers with fallback initials', async ({page})=>{
  await fresh(page);await role(page,'leader');await page.goto('/management');
  for(const name of ['Omar Khaled','Samy Ibrahim']){
    await page.locator('.manage-row').filter({hasText:name}).getByRole('button',{name:'Edit'}).click();
    await page.getByLabel('Choose a local image').setInputFiles(await imageFile(page,'red',name+'.png'));
    await expect(page.getByRole('img',{name:'Image preview'})).toBeVisible();await page.getByRole('button',{name:'Save changes'}).click();
  }
  await role(page,'manager');await page.goto('/market');await page.getByLabel('Search players').fill('Omar Khaled');await expect(page.locator('.player-card img')).toBeVisible();
  await page.goto('/players/p1');await expect(page.locator('.profile-hero .avatar img')).toBeVisible();
  await page.goto('/squad-builder');await expect(page.locator('.pitch-player[aria-label="Player details: Omar Khaled"] img')).toBeVisible();
  // The starting XI is on the pitch; the substitute's image stays in the separate
  // Bench strip rather than being promoted onto the pitch.
  await expect(page.locator('.pitch-player[aria-label="Player details: Omar Khaled"] img')).toBeVisible();
  await expect(page.locator('.bench-player[aria-label="Player details: Samy Ibrahim"] img')).toBeVisible();
  await expect(page.locator('.pitch-player[aria-label="Player details: Youssef Adel"] .avatar span')).toHaveText('YA');
  await page.goto('/transfers');await expect(page.locator('.suggestion-row').filter({hasText:'Omar Khaled'}).locator('img')).toBeVisible();
  await page.getByLabel('Player to transfer out').selectOption('p1');await expect(page.locator('.transfer-person').filter({hasText:'Omar Khaled'}).locator('img')).toBeVisible();
});

test('Arabic picker labels and invalid disguised image feedback', async ({page})=>{
  await fresh(page);await page.goto('/suggest');await expect(page.getByLabel('Choose a local image')).toBeAttached();
  await page.getByRole('button',{name:'Switch language'}).click();
  const picker=page.getByLabel('اختيار صورة من الجهاز');await expect(picker).toBeAttached();
  await picker.setInputFiles({name:'disguised.png',mimeType:'image/png',buffer:Buffer.from('<svg/>')});
  await expect(page.getByRole('alert')).toContainText('اختر صورة صالحة');
  await picker.setInputFiles(await imageFile(page,'blue','valid.png'));await expect(page.getByRole('img',{name:'معاينة الصورة'})).toBeVisible();
  await page.getByRole('button',{name:'إزالة الصورة'}).click();await expect(page.getByRole('img',{name:'معاينة الصورة'})).toHaveCount(0);
});

test('existing base64 player photos migrate into IndexedDB without being lost', async ({page})=>{
  await fresh(page);const png=await imageFile(page,'blue','legacy.png');
  await page.evaluate(base64=>{const state=JSON.parse(localStorage.getItem('fantasy-friends-demo-v1')!);state.players.find((p:{id:string})=>p.id==='p1').image='data:image/png;base64,'+base64;localStorage.setItem('fantasy-friends-demo-v1',JSON.stringify(state))},png.buffer.toString('base64'));
  await page.goto('/players/p1');await expect(page.locator('.profile-hero img')).toBeVisible();
  await expect.poll(async()=>page.evaluate(()=>JSON.parse(localStorage.getItem('fantasy-friends-demo-v1')!).players.find((p:{id:string})=>p.id==='p1').image)).toMatch(/^local-image:/);
  await page.reload();await expect(page.locator('.profile-hero img')).toHaveAttribute('src',/^blob:/);
});

test('an unavailable URL falls back to player initials', async ({page})=>{
  await fresh(page);await page.route('https://example.com/broken.png',route=>route.abort());
  await page.evaluate(()=>{const state=JSON.parse(localStorage.getItem('fantasy-friends-demo-v1')!);state.players.find((p:{id:string})=>p.id==='p1').image='https://example.com/broken.png';localStorage.setItem('fantasy-friends-demo-v1',JSON.stringify(state))});
  await page.goto('/players/p1');await expect(page.locator('.profile-hero .avatar span')).toHaveText('OK');await expect(page.locator('.profile-hero .avatar img')).toHaveCount(0);
});

test('discarding a selected draft deletes the uncommitted blob', async ({page})=>{
  await fresh(page);await page.goto('/suggest');await page.getByLabel('Choose a local image').setInputFiles(await imageFile(page,'red','draft.png'));
  await expect(page.getByRole('img',{name:'Image preview'})).toBeVisible();
  const ref=await page.locator('input[type="hidden"]').inputValue();expect(await imageExists(page,ref)).toBe(true);
  await page.getByRole('button',{name:'Remove image'}).click();await expect.poll(()=>imageExists(page,ref)).toBe(false);
});

test('IndexedDB storage errors are explained and leave the previous image intact', async ({page})=>{
  await fresh(page);await page.goto('/suggest');const picker=page.getByLabel('Choose a local image');
  await picker.setInputFiles(await imageFile(page,'red','first.png'));await expect(page.getByRole('img',{name:'Image preview'})).toBeVisible();const previous=await imageColor(page.getByRole('img',{name:'Image preview'}));
  await page.evaluate(()=>{indexedDB.open=()=>{throw new DOMException('Quota exceeded','QuotaExceededError')}});
  await picker.setInputFiles(await imageFile(page,'blue','second.png'));await expect(page.getByRole('alert')).toContainText('Could not store the image');
  expect(await imageColor(page.getByRole('img',{name:'Image preview'}))).toEqual(previous);
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
  // Formation previews retain the exact Starting XI and the separate Bench. They
  // never promote a substitute or drop a roster member while the shape changes.
  const originals=await page.locator('.pitch-player strong').allTextContents();
  const benchOriginals=await page.locator('.bench-player strong').allTextContents();
  const playerIdsBefore=await page.evaluate(()=>JSON.parse(localStorage.getItem('fantasy-friends-demo-v1')!).squads.find((s:{leagueId:string;managerId:string})=>s.leagueId==='league-1'&&s.managerId==='manager').playerIds);
  await expect(page.locator('.pitch-player')).toHaveCount(11); await expect(page.locator('.bench-player')).toHaveCount(4);
  for(const f of ['4-3-3','4-4-2','3-5-2','3-4-3','4-5-1','5-3-2','5-4-1']){
    await page.getByLabel('Formation').selectOption(f); await expect(page.getByLabel('Formation')).toHaveValue(f);
    expect(await page.locator('.pitch-player strong').allTextContents()).toEqual(originals);
    expect(await page.locator('.bench-player strong').allTextContents()).toEqual(benchOriginals);
    expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('fantasy-friends-demo-v1')!).squads.find((s:{leagueId:string;managerId:string})=>s.leagueId==='league-1'&&s.managerId==='manager').playerIds)).toEqual(playerIdsBefore);
  }
  await page.getByLabel('Formation').selectOption('4-3-3');
  await page.goto('/squad-builder');
  await page.locator('.pitch-player[aria-label="Player details: Hassan Magdy"]').click();
  const captainSheet=page.getByRole('dialog');
  await captainSheet.getByRole('button',{name:'Captain',exact:true}).click();
  await captainSheet.getByRole('button',{name:'Close'}).click();
  await expect(page.getByText('Select a vice captain from your squad.')).toBeVisible();
  await page.locator('.pitch-player[aria-label="Player details: Amr Hesham"]').click();
  const viceCaptainSheet=page.getByRole('dialog');
  await viceCaptainSheet.getByRole('button',{name:'Vice captain',exact:true}).click();
  await viceCaptainSheet.getByRole('button',{name:'Close'}).click();
  await expect(page.getByText('Squad is valid')).toBeVisible();
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
