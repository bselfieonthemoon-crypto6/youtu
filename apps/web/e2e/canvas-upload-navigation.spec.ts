import {test,expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
const sharp=createRequire(new URL('../../server/package.json',import.meta.url))('sharp');
test.use({trace:'off',video:'off',actionTimeout:15000});
test('uploaded image survives immediate home navigation; failed save blocks navigation',async({page,request})=>{
 test.skip(process.env.SUPABASE_URL!=='http://127.0.0.1:54421','Local replica only');
 test.setTimeout(120000);
 const url=process.env.SUPABASE_URL!;
 const admin=createClient(url,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
 const {data:{user}}=await admin.auth.admin.getUserById('541006fa-d2a1-4305-be55-b6263c27a1e3');
 const {data:link}=await admin.auth.admin.generateLink({type:'magiclink',email:user!.email!});
 const client=createClient(url,process.env.SUPABASE_ANON_KEY!,{auth:{persistSession:false}});
 const {data:auth}=await client.auth.verifyOtp({token_hash:link!.properties.hashed_token,type:'magiclink'});
 const headers={Authorization:`Bearer ${auth.session!.access_token}`};
 const server='http://127.0.0.1:3002';
 const created=await request.post(`${server}/api/projects`,{headers,data:{name:`Upload navigation regression ${Date.now()}`}});
 expect(created.ok()).toBe(true);
 const {project}=await created.json();const id=project.primaryCanvas.id;
 await page.addInitScript(({key,session})=>localStorage.setItem(key,JSON.stringify(session)),{key:`sb-${new URL(url).hostname.split('.')[0]}-auth-token`,session:auth.session});
 try{
  await page.goto(`/canvas?id=${id}`);
  await expect(page.getByRole('button',{name:'菜单',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'菜单',exact:true}).click();
  await expect(page.getByRole('menuitem',{name:/导入图片/})).toBeEnabled();
  await page.keyboard.press('Escape');
  const png=await sharp(randomBytes(256*256*3),{raw:{width:256,height:256,channels:3}}).png().toBuffer();
  expect(png.length).toBeGreaterThan(65536);
  await page.locator('input[type=file][accept="image/*"]').first().setInputFiles({name:'navigation-test.png',mimeType:'image/png',buffer:png});
  // Wait for a real edit to reach the debounce, then block every save so the
  // homepage transition must wait for (and report) a failed flush.
  await page.route('**/api/canvases/'+id,async route=>{
   if(route.request().method()==='PUT')await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'test_save_failure',message:'Test save unavailable'}})});
   else await route.continue();
  });
  await page.getByRole('button',{name:'菜单',exact:true}).click();
  await page.getByRole('menuitem',{name:'主页',exact:true}).click();
  await expect(page.getByText(/Test save unavailable|保存失败|save canvas|503/i).first()).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/canvas\\?id=${id}`));
  await page.unroute('**/api/canvases/'+id);
  await page.getByRole('button',{name:'菜单',exact:true}).click();
  await page.getByRole('menuitem',{name:'主页',exact:true}).click();
  await expect(page).toHaveURL(/\/home/);
  const read=await request.get(`${server}/api/canvases/${id}`,{headers});
  const {canvas}=await read.json();
  const images=canvas.content.elements.filter((e:any)=>e.type==='image'&&!e.isDeleted);
  expect(images).toHaveLength(1);
  expect(canvas.content.files[images[0].fileId]).toBeTruthy();
  await page.goto(`/canvas?id=${id}`);
  await expect(page.getByRole('button',{name:'菜单',exact:true})).toBeVisible();
  await page.reload();
  await expect.poll(async () => page.locator('canvas').evaluateAll(canvases => {
   let colored=0;
   for(const canvas of canvases){
    const ctx=canvas.getContext('2d'); if(!ctx)continue;
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
    for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]>0 && Math.max(pixels[i],pixels[i+1],pixels[i+2])-Math.min(pixels[i],pixels[i+1],pixels[i+2])>35)colored++;
   }
   return colored;
  }),{timeout:30000}).toBeGreaterThan(1000);
  const reread=await request.get(`${server}/api/canvases/${id}`,{headers});
  expect((await reread.json()).canvas.content.elements.filter((e:any)=>e.type==='image'&&!e.isDeleted)).toHaveLength(1);
  await page.getByRole('button',{name:'菜单',exact:true}).click();
  await expect(page.getByRole('menuitem',{name:/导入图片/})).toBeEnabled();
  await page.keyboard.press('Escape');
  // Chromium's File System Access picker is not a Playwright filechooser.
  // Supply its selected file while exercising the real Excalidraw insertion.
  await page.evaluate(bytes=>Object.defineProperty(window,'showOpenFilePicker',{configurable:true,value:async()=>[{getFile:async()=>new File([new Uint8Array(bytes)],'native-upload.png',{type:'image/png'})}]}),Array.from(png));
  await page.getByRole('button',{name:'图片 (9)',exact:true}).click();
  await page.getByRole('button',{name:'菜单',exact:true}).click();
  await page.getByRole('menuitem',{name:'主页',exact:true}).click();
  await expect(page.getByText('请先点击画布放置图片，再离开。')).toBeVisible();
  await page.mouse.click(400,400);
  await page.getByRole('button',{name:'菜单',exact:true}).click();
  await page.getByRole('menuitem',{name:'主页',exact:true}).click();
  await expect(page).toHaveURL(/\/home/);
  const nativeRead=await request.get(`${server}/api/canvases/${id}`,{headers});
  expect((await nativeRead.json()).canvas.content.elements.filter((e:any)=>e.type==='image'&&!e.isDeleted)).toHaveLength(2);
 }finally{await client.auth.signOut({scope:'local'});}
});
