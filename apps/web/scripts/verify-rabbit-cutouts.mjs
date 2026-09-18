import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
assert.equal(process.env.SUPABASE_URL,'http://127.0.0.1:54421');
const base='../../artifacts/rabbit-cutouts-20260915/';
const imported=JSON.parse(await readFile(base+'import.json','utf8'));
const options={auth:{persistSession:false,autoRefreshToken:false}};
const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,options);
const account=await db.auth.admin.getUserById(imported.ownerId);assert.ifError(account.error);
const link=await db.auth.admin.generateLink({type:'magiclink',email:account.data.user.email});assert.ifError(link.error);
const auth=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY,options);
const login=await auth.auth.verifyOtp({type:'magiclink',token_hash:link.data.properties.hashed_token});assert.ifError(login.error);
const token=login.data.session.access_token;
async function call(path,method='GET',body){const res=await fetch('http://127.0.0.1:3002'+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await res.json();assert(res.ok,`${path}: ${res.status} ${JSON.stringify(data.error)}`);return data;}
let fixture;try{fixture=JSON.parse(await readFile(base+'browser.json','utf8'));}catch(e){if(e.code!=='ENOENT')throw e;fixture={};}
const save=()=>writeFile(base+'browser.json',JSON.stringify(fixture,null,2));
if(!fixture.canvasId){const created=await call('/api/projects','POST',{name:'QA 透明兔子素材验收',description:'本地素材库插入与保存验证'});fixture.canvasId=created.project.primaryCanvas.id;fixture.projectId=created.project.id;await save();}
if(!fixture.designId){const canvas=(await call('/api/canvases/'+fixture.canvasId)).canvas;const created=await call('/api/designs','POST',{request_id:crypto.randomUUID(),canvas_id:fixture.canvasId,expected_canvas_revision:canvas.revision,canvas_element_id:'rabbit-cutouts-'+crypto.randomUUID(),name:'透明兔子素材验证',width:1000,height:700,background:'#dce8f0',node:{x:80,y:140,width:800,height:560}});fixture.designId=created.design_id;await save();}
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.addInitScript(session=>localStorage.setItem('sb-127-auth-token',JSON.stringify(session)),login.data.session);
 await page.goto('http://localhost:3020/canvas?id='+fixture.canvasId);
 await expect(page.getByRole('textbox',{name:'输入消息',exact:true})).toBeEnabled({timeout:45000});
 const node=page.locator(`[data-design-id="${fixture.designId}"]`);await expect(node).toBeVisible({timeout:30000});
 const rect=await node.boundingBox();await page.mouse.click(rect.x+rect.width-10,rect.y+rect.height-10);
 await page.getByRole('button',{name:'打开设计',exact:true}).click();
 await expect(page.getByTestId('design-inline-editor')).toBeVisible();
 const toolbar=page.getByRole('toolbar',{name:'画板工具栏'});
 const search=page.getByPlaceholder('搜索名称、标签或分类');
 if(!await search.isVisible())await toolbar.getByRole('button',{name:'资源',exact:true}).click();
 await search.fill('兔子');
 for(const item of imported.items){const card=page.locator('article').filter({hasText:item.name});await expect(card).toHaveCount(1,{timeout:20000});await expect.poll(()=>card.locator('img').evaluate(img=>img.complete&&img.naturalWidth>0)).toBe(true);}
 fixture.cardsVerified=3;await page.screenshot({path:base+'素材库.png'});await save();
 const existing=(await call('/api/designs/'+fixture.designId)).design.scene.objects;
 if(!existing.some(o=>o.resourceId===imported.items[1].resourceId)){
  const recent=page.waitForResponse(r=>r.url().endsWith(`/api/design-resources/${imported.items[1].resourceId}/recent`)&&r.request().method()==='POST');
  await page.locator('article').filter({hasText:imported.items[1].name}).getByRole('button').first().click();
  assert((await recent).ok());
  await toolbar.getByRole('button',{name:'保存',exact:true}).click();
 }
 await expect.poll(async()=>{const doc=(await call('/api/designs/'+fixture.designId)).design;return doc.scene.objects.some(o=>o.type==='image'&&o.resourceId===imported.items[1].resourceId);},{timeout:20000}).toBe(true);
 fixture.insertionSaved=true;fixture.pageErrors=errors;assert.deepEqual(errors,[]);
 if(process.argv.includes('--outline')) {
  await toolbar.getByRole('button',{name:'图层 / 属性',exact:true}).click();
  await page.getByRole('button',{name:/^选择图层：/}).first().click();
  const count=()=>page.getByTestId('design-inline-editor').locator('canvas.lower-canvas').evaluate(canvas=>{
   const rgba=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let matches=0;
   for(let i=0;i<rgba.length;i+=4)if(Math.abs(rgba[i]-75)<4&&Math.abs(rgba[i+1]-85)<4&&Math.abs(rgba[i+2]-99)<4&&rgba[i+3]>64)matches++;
   return matches;
  });
  await expect.poll(count).toBeGreaterThan(20);fixture.darkGrayOutlinePixels=await count();
  await page.screenshot({path:base+'深灰色图层边框.png'});
 }
 await page.screenshot({path:base+'插入画板.png'});
 await page.reload();await expect(page.locator(`[data-design-id="${fixture.designId}"]`)).toBeVisible({timeout:30000});
 fixture.reloadVerified=true;fixture.outcome='passed';delete fixture.error;await save();console.log(JSON.stringify(fixture));
}catch(e){fixture.outcome='failed';fixture.error=e.message;await save();await page.screenshot({path:base+'failure.png'});throw e;}finally{await browser.close();await auth.auth.signOut({scope:'local'});}
