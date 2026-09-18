import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
assert.equal(process.env.SUPABASE_URL,'http://127.0.0.1:54421');
const opts={auth:{persistSession:false,autoRefreshToken:false}};
const admin=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,opts);
const auth=createClient(process.env.SUPABASE_URL,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,opts);
const owner='541006fa-d2a1-4305-be55-b6263c27a1e3';
const project=randomUUID(),canvas=randomUUID(),session=randomUUID(),run=randomUUID();
const checked=async query=>{const result=await query;if(result.error)throw new Error(result.error.code??'database_error');return result.data;};
await checked(admin.from('projects').insert({id:project,workspace_id:'25eb32ef-ff55-4de7-8c10-9390a51ece06',name:'Native board creation QA',slug:`board-qa-${project}`,created_by:owner}));
await checked(admin.from('canvases').insert({id:canvas,project_id:project,name:'Native board creation QA',created_by:owner,is_primary:true,content:{elements:[],files:{},appState:{scrollX:0,scrollY:0,zoom:{value:1}}}}));
await checked(admin.from('chat_sessions').insert({id:session,canvas_id:canvas,title:'Native board creation QA',created_by:owner,thread_id:`board-qa-${session}`}));
await checked(admin.from('agent_runs').insert({id:run,session_id:session,thread_id:`board-qa-${session}`,status:'running',execution_mode:'fast',created_by:owner}));
const original=await checked(admin.from('canvases').select('revision').eq('id',canvas).single());
const input={p_user:owner,p_session:session,p_run:run,p_prompt:'新建一个658×176空白画板',p_expected_canvas_revision:original.revision,p_boards:[{name:'658×176 QA',width:658,height:176,x:100,y:150}],p_source_assets:[],p_default_enabled:false};
try {
  const result=await checked(admin.rpc('loomic_agent_create_design_boards',input));
  const replay=await checked(admin.rpc('loomic_agent_create_design_boards',input));
  assert.equal(replay.replayed,true);
  assert.equal(result.boards.length,1);
  const design=result.boards[0].design_id;
  let deletionId;
  if(process.argv.includes('--delete')){
    const source=await checked(admin.from('design_documents').select('scene').eq('id','3d99fa8e-39f7-4321-9f44-ca2bb8600b43').single());
    const scene=structuredClone(source.scene);
    scene.canvas={width:658,height:176,background:'#ffffff'};
    scene.objects.forEach((object,index)=>{object.objectId=randomUUID();object.name=`Delete QA ${index}`;object.rotation=index===0?1:0;});
    deletionId=scene.objects[1].objectId;
    assert(scene.objects[1].objectVersion>1);
    await checked(admin.from('design_documents').update({scene}).eq('id',design));
  }
  const doc=await checked(admin.from('design_documents').select('width,height').eq('id',design).single());
  assert.deepEqual(doc,{width:658,height:176});
  const account=await admin.auth.admin.getUserById(owner);
  const link=await admin.auth.admin.generateLink({type:'magiclink',email:account.data.user.email});
  const login=await auth.auth.verifyOtp({type:'magiclink',token_hash:link.data.properties.hashed_token});
  assert(login.data.session);
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    await page.addInitScript(value=>localStorage.setItem('sb-127-auth-token',JSON.stringify(value)),login.data.session);
    await page.goto(`http://localhost:3020/canvas?id=${canvas}&session=${session}`);
    const node=page.locator(`[data-testid="design-node-preview"][data-design-id="${design}"]`);
    const openBoard=async()=>{const box=await node.boundingBox();assert(box);await page.mouse.dblclick(box.x+box.width/2,box.y+box.height/2);};
    await node.waitFor({state:'visible',timeout:60000});
    assert.equal(await node.count(),1);
    if(deletionId){
      await openBoard();
      await page.getByRole('button',{name:'图层 / 属性',exact:true}).click();
      const dock=page.getByTestId('design-properties-dock');
      const checkDock=async()=>{
        await page.waitForFunction(()=>{
          const panel=document.querySelector('[data-testid="design-properties-dock"]')?.getBoundingClientRect();
          const canvas=document.querySelector('[data-testid="canvas-editor"]')?.getBoundingClientRect();
          return panel&&canvas&&Math.abs(panel.right-canvas.right)<2;
        });
      };
      await checkDock();
      const separator=page.getByRole('separator',{name:'Resize chat panel'});
      await separator.focus();
      const initialWidth=await separator.getAttribute('aria-valuenow');
      await separator.press('ArrowLeft');await separator.press('ArrowLeft');
      assert.notEqual(await separator.getAttribute('aria-valuenow'),initialWidth);
      await checkDock();
      await separator.press('ArrowRight');await separator.press('ArrowRight');await separator.press('ArrowRight');
      await checkDock();
      console.log(JSON.stringify({dockResize:'passed'}));
      await page.getByText('Delete QA 1',{exact:true}).click();
      await page.getByRole('button',{name:'删除所选对象',exact:true}).click();
      assert.equal(await page.locator(`[data-layer-id="${deletionId}"]`).count(),0);
      const save=async()=>{
        await page.getByRole('button',{name:'保存',exact:true}).click();
        await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).some(e=>e.getAttribute('aria-label')==='保存'&&e.disabled));
      };
      await save();
      const hasLayer=async()=>{const saved=await checked(admin.from('design_documents').select('scene').eq('id',design).single());return saved.scene.objects.some(o=>o.objectId===deletionId);};
      assert.equal(await hasLayer(),false);
      await page.getByRole('button',{name:'撤销',exact:true}).click();await save();
      assert.equal(await hasLayer(),true);
      await page.getByRole('button',{name:'重做',exact:true}).click();await save();
      assert.equal(await hasLayer(),false);
      await page.getByRole('button',{name:'完成',exact:true}).click();
      await page.reload();await node.waitFor({state:'visible',timeout:60000});
      await openBoard();await page.getByRole('button',{name:'图层 / 属性',exact:true}).click();
      assert.equal(await page.locator(`[data-layer-id="${deletionId}"]`).count(),0);
      assert.equal(await hasLayer(),false);
      await page.screenshot({path:'../../artifacts/native-board-creation/deletion-reopen.png'});
      const rotatedSaved=await checked(admin.from('design_documents').select('scene').eq('id',design).single());
      assert.equal(rotatedSaved.scene.objects.find(o=>o.name==='Delete QA 0').rotation,1);
      await page.getByRole('button',{name:'画板详情',exact:true}).click();
      await page.getByText('图片工具',{exact:true}).waitFor();
      assert.equal(await page.getByTestId('design-inline-editor').count(),0);
      console.log(JSON.stringify({rotatedInlineAndManualSwitch:'passed'}));
      console.log(JSON.stringify({deletion:'passed',save:true,undo:true,redo:true,reopen:true,design}));
    }
    await page.reload();
    await node.waitFor({state:'visible',timeout:60000});
    assert.equal(await node.count(),1);
    await mkdir('../../artifacts/native-board-creation',{recursive:true});
    const menuBox=await node.boundingBox();assert(menuBox);
    await page.mouse.click(menuBox.x+menuBox.width/2,menuBox.y+menuBox.height/2,{button:'right'});
    await page.locator('.context-menu').waitFor({state:'visible'});
    await page.waitForFunction(()=>{
      const menu=document.querySelector('.popover:has(> .context-menu)');
      if(!menu?.matches(':popover-open'))return false;
      return Array.from(menu.querySelectorAll('.context-menu-item')).every(item=>{
        const r=item.getBoundingClientRect();
        return !r.width||!r.height||r.top>=innerHeight||r.bottom<=0||item.contains(document.elementFromPoint(r.x+r.width/2,Math.min(innerHeight-1,r.y+r.height/2)));
      });
    });
    await page.screenshot({path:'../../artifacts/native-board-creation/context-menu.png'});
    await page.keyboard.press('Escape');
    await page.locator('.context-menu').waitFor({state:'hidden'});
    console.log(JSON.stringify({contextMenuTopLayer:'passed'}));
    await page.screenshot({path:'../../artifacts/native-board-creation/refresh.png'});
    console.log(JSON.stringify({status:'passed',canvasId:canvas,sessionId:session,designId:design,width:658,height:176,replay:true,visibleAfterRefresh:true,providerCalls:0}));
  } finally {await browser.close();}
} finally {
  await checked(admin.from('agent_runs').update({status:'completed',completed_at:new Date().toISOString()}).eq('id',run));
}
