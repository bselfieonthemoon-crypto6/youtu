import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
assert.equal(process.env.SUPABASE_URL,'http://127.0.0.1:54421');
const dir='../../artifacts/overflow-resize-20260915/';await mkdir(dir,{recursive:true});
const imported=JSON.parse(await readFile('../../artifacts/rabbit-cutouts-20260915/import.json','utf8'));
const opts={auth:{persistSession:false,autoRefreshToken:false}};
const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,opts);
const account=await db.auth.admin.getUserById(imported.ownerId);assert.ifError(account.error);
const link=await db.auth.admin.generateLink({type:'magiclink',email:account.data.user.email});assert.ifError(link.error);
const auth=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY,opts);
const login=await auth.auth.verifyOtp({type:'magiclink',token_hash:link.data.properties.hashed_token});assert.ifError(login.error);
async function call(path,method='GET',body){const res=await fetch('http://127.0.0.1:3002'+path,{method,headers:{Authorization:`Bearer ${login.data.session.access_token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await res.json();assert(res.ok,JSON.stringify(data.error));return data;}
let f;try{f=JSON.parse(await readFile(dir+'fixture.json','utf8'));}catch(e){if(e.code!=='ENOENT')throw e;f={};}
if(!f.canvasId){const p=(await call('/api/projects','POST',{name:'QA 遮罩外缩放',description:'遮罩事件独立验收'})).project;f.canvasId=p.primaryCanvas.id;await writeFile(dir+'fixture.json',JSON.stringify(f));}
if(!f.designId){const c=(await call('/api/canvases/'+f.canvasId)).canvas;f.designId=(await call('/api/designs','POST',{request_id:crypto.randomUUID(),canvas_id:f.canvasId,expected_canvas_revision:c.revision,canvas_element_id:'pan-'+crypto.randomUUID(),name:'遮罩平移验证',width:600,height:800,background:'#ffffff',node:{x:430,y:300,width:240,height:320}})).design_id;await writeFile(dir+'fixture.json',JSON.stringify(f));}
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1600,height:1000}});
const baseline=process.argv.includes('--baseline');const report={baseline,checks:[]};
try{
 await page.addInitScript(session=>localStorage.setItem('sb-127-auth-token',JSON.stringify(session)),login.data.session);
 await page.goto('http://localhost:3020/canvas?id='+f.canvasId);
 await expect(page.getByRole('textbox',{name:'输入消息',exact:true})).toBeEnabled({timeout:45000});
 const node=page.locator(`[data-design-id="${f.designId}"]`);await expect(node).toBeVisible({timeout:30000});let box=await node.boundingBox();
 await page.mouse.click(box.x+box.width-8,box.y+box.height-8);await page.getByRole('button',{name:'打开设计',exact:true}).click();
 const shade=page.getByTestId('design-overflow-shade');await expect(shade).toBeVisible();
 if(process.argv.includes('--candidate'))await page.locator('[data-inline-overflow="true"] .canvas-container').evaluate(el=>{el.parentElement.style.pointerEvents='none';});
 await page.getByRole('button',{name:'拖拽画布 (H)',exact:true}).click();
 for(const side of ['left','right','top','bottom']){
  const b=await shade.boundingBox();const p=side==='left'?{x:b.x-40,y:b.y+b.height/2}:side==='right'?{x:b.x+b.width+40,y:b.y+b.height/2}:side==='top'?{x:b.x+b.width/2,y:b.y-40}:{x:b.x+b.width/2,y:b.y+b.height+40};
  const target=await page.evaluate(p=>{const el=document.elementFromPoint(p.x,p.y);return {tag:el?.tagName,class:el?.className};},p);
  console.log('hit',side,JSON.stringify(target));
  await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+35,p.y+20,{steps:8});await page.mouse.up();
  if(!baseline)await expect.poll(async()=>{const a=await shade.boundingBox();return Math.abs(a.x-b.x)+Math.abs(a.y-b.y);}).toBeGreaterThan(25);
  const a=await shade.boundingBox();report.checks.push({side,target,delta:{x:a.x-b.x,y:a.y-b.y}});
 }
 if(!baseline){
  await page.getByRole('button',{name:'选择 (V)',exact:true}).click();
  const toolbar=page.getByRole('toolbar',{name:'画板工具栏'});await toolbar.getByRole('button',{name:'添加文字',exact:true}).click();
  await toolbar.getByRole('button',{name:'保存',exact:true}).click();
  await expect.poll(async()=>((await call('/api/designs/'+f.designId)).design.scene.objects.length)).toBeGreaterThan(0);
  const doc=(await call('/api/designs/'+f.designId)).design;const obj=doc.scene.objects.at(-1);const b=await shade.boundingBox();
  // Use the selected text's center in the board coordinate system.
  const p={x:b.x+(obj.x+obj.width/2)*b.width/600,y:b.y+(obj.y+obj.height/2)*b.height/800};
  await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+20,p.y+15,{steps:8});await page.mouse.up();await toolbar.getByRole('button',{name:'保存',exact:true}).click();
  await expect.poll(async()=>{const o=(await call('/api/designs/'+f.designId)).design.scene.objects.find(o=>o.objectId===obj.objectId);return Math.abs(o.x-obj.x)+Math.abs(o.y-obj.y);},{timeout:10000}).toBeGreaterThan(5);
  report.boardObjectDrag=true;
  const moved=(await call('/api/designs/'+f.designId)).design.scene.objects.find(o=>o.objectId===obj.objectId);
  const current=await shade.boundingBox();
  const start={x:current.x+(moved.x+moved.width/2)*current.width/600,y:current.y+(moved.y+moved.height/2)*current.height/800};
  await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(current.x+current.width+30,start.y,{steps:12});await page.mouse.up();await toolbar.getByRole('button',{name:'保存',exact:true}).click();
  await expect.poll(async()=>{const o=(await call('/api/designs/'+f.designId)).design.scene.objects.find(o=>o.objectId===obj.objectId);return o.x-moved.x;},{timeout:10000}).toBeGreaterThan(50);
  report.dragBeyondBoard=true;
  const handle = await page.getByTestId('design-fabric-viewport').evaluate(el => {
    let fiber=el[Object.keys(el).find(k=>k.startsWith('__reactFiber$'))];
    let canvas;
    for(;fiber&&!canvas;fiber=fiber.return) {
      for(let hook=fiber.memoizedState;hook;hook=hook.next) {
        const ref=hook.memoizedState?.current;
        if(ref&&typeof ref.getActiveObject==='function') {canvas=ref;break;}
      }
    }
    if(!canvas)throw Error('Fabric canvas not found');
    const object=canvas.getActiveObject();object.setCoords();
    const point=object.oCoords.br;
    const rect=canvas.upperCanvasEl.getBoundingClientRect();
    return {x:rect.left+point.x*rect.width/canvas.getWidth(),y:rect.top+point.y*rect.height/canvas.getHeight()};
  });
  const frame=await shade.boundingBox();
  assert(handle.x>frame.x+frame.width,'Resize handle must be outside the artboard');
  const beforeResize=(await call('/api/designs/'+f.designId)).design.scene.objects.find(o=>o.objectId===obj.objectId);
  const hit=await page.evaluate(p=>document.elementFromPoint(p.x,p.y)?.className,handle);
  assert(String(hit).includes('upper-canvas'),'Outside control must hit Fabric');
  await page.mouse.move(handle.x,handle.y);await page.mouse.down();await page.mouse.move(handle.x+25,handle.y+20,{steps:10});await page.mouse.up();
  await toolbar.getByRole('button',{name:'保存',exact:true}).click();
  await expect.poll(async()=>{const o=(await call('/api/designs/'+f.designId)).design.scene.objects.find(o=>o.objectId===obj.objectId);return Math.abs((o.scaleX??1)-(beforeResize.scaleX??1))+Math.abs(o.width-beforeResize.width);}).toBeGreaterThan(0.01);
  report.outsideHandleResize=true;
  const board=await shade.boundingBox();const outside={x:board.x-35,y:board.y+board.height/2};
  await page.mouse.move(outside.x,outside.y);await page.mouse.down({button:'middle'});await page.mouse.move(outside.x+30,outside.y+20,{steps:8});await page.mouse.up({button:'middle'});
  await expect.poll(async()=>{const a=await shade.boundingBox();return Math.abs(a.x-board.x)+Math.abs(a.y-board.y);}).toBeGreaterThan(25);
  report.middleButtonPan=true;
 }
 await page.screenshot({path:dir+(baseline?'baseline':'verified')+'.png'});report.outcome='passed';
}catch(e){report.outcome='failed';report.error=e.message;await page.screenshot({path:dir+'failure.png'});throw e;}finally{await writeFile(dir+(baseline?'baseline':'verified')+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));await browser.close();await auth.auth.signOut({scope:'local'});}


