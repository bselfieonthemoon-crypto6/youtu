import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
const {WebSocket}=createRequire(new URL('../../server/package.json',import.meta.url))('ws');
assert(process.argv.includes('--submit'),'Explicit --submit required for a paid text-model test');
assert.equal(process.env.SUPABASE_URL,'http://127.0.0.1:54421');
const options={auth:{persistSession:false,autoRefreshToken:false}};
const admin=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,options);
const auth=createClient(process.env.SUPABASE_URL,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,options);
const owner='541006fa-d2a1-4305-be55-b6263c27a1e3';
const account=await admin.auth.admin.getUserById(owner);
const link=await admin.auth.admin.generateLink({type:'magiclink',email:account.data.user.email});
const login=await auth.auth.verifyOtp({type:'magiclink',token_hash:link.data.properties.hashed_token});
assert(login.data.session);
const token=login.data.session.access_token;
async function api(path,body){const response=await fetch(`http://127.0.0.1:3002/api${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert(response.ok,`API status ${response.status}`);return response.json();}
const project=await api('/projects',{name:'Native board Agent E2E QA'});
const canvas=project.project.primaryCanvas.id;
const {session}=await api(`/canvases/${canvas}/sessions`,{title:'Native board Agent E2E QA'});
console.log(JSON.stringify({fixture:{canvas,session:session.id}}));
const prompt='新建一个658×176像素的空白原生设计画板，只创建一张，保留画布其他内容。不要生成图片，不要调用生图或视频模型，不要继续设计。创建保存后核对尺寸并结束。';
await api(`/sessions/${session.id}/messages`,{role:'user',content:prompt,contentBlocks:[{type:'text',text:prompt}]});
const ws=new WebSocket(`ws://127.0.0.1:3002/api/ws?token=${encodeURIComponent(token)}`);
await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
const events=[];
try{
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Agent run timed out; do not blindly resubmit')),180000);
    ws.on('message',raw=>{
      const data=JSON.parse(raw.toString());
      if(data.type==='rpc.request'){ws.send(JSON.stringify({type:'rpc.response',id:data.id,error:'Use persisted canvas state for native blank board QA'}));return;}
      if(data.type==='error'){clearTimeout(timer);reject(new Error(data.code??'websocket_error'));return;}
      if(data.type!=='event')return;
      const event=data.event;events.push(event);
      if(['run.completed','run.failed','run.canceled'].includes(event.type)){clearTimeout(timer);event.type==='run.completed'?resolve():reject(new Error(event.error?.code??event.type));}
    });
    ws.send(JSON.stringify({type:'command',action:'agent.run',accessToken:token,requestId:randomUUID(),payload:{sessionId:session.id,conversationId:canvas,canvasId:canvas,model:'workspace:d4686547-356a-4254-ab9c-5af862e3c40a',prompt}}));
  });
  assert(events.some(event=>event.type==='tool.completed'&&event.toolName==='create_design_boards'),'creation tool completed');
  assert(events.some(event=>event.type==='canvas.sync'),'canvas sync event delivered');
  const saved=await api(`/canvases/${canvas}`);
  const nodes=saved.canvas.content.elements.filter(item=>item.customData?.kind==='loomic-design');
  assert.equal(nodes.length,1);
  const result=await admin.from('design_documents').select('width,height').eq('id',nodes[0].customData.designId).single();
  assert.deepEqual(result.data,{width:658,height:176});
  const jobs=await admin.from('background_jobs').select('id',{count:'exact',head:true}).eq('session_id',session.id);
  assert.equal(jobs.count,0,'no image/video jobs');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    await page.addInitScript(value=>localStorage.setItem('sb-127-auth-token',JSON.stringify(value)),login.data.session);
    await page.goto(`http://localhost:3020/canvas?id=${canvas}&session=${session.id}`);
    await page.getByTestId('design-node-preview').waitFor({state:'visible',timeout:60000});
    await page.reload();await page.getByTestId('design-node-preview').waitFor({state:'visible',timeout:60000});
    assert.equal(await page.getByTestId('design-node-preview').count(),1);
    await mkdir('../../artifacts/native-board-creation',{recursive:true});
    await page.screenshot({path:'../../artifacts/native-board-creation/agent-e2e.png'});
  }finally{await browser.close();}
  console.log(JSON.stringify({status:'passed',canvas,session:session.id,tools:events.filter(e=>e.type==='tool.completed').map(e=>e.toolName),width:658,height:176,imageJobs:0,refresh:true}));
}catch(error){console.log(JSON.stringify({status:'failed',canvas,session:session.id,error:error.message,tools:events.filter(e=>e.type==='tool.completed').map(e=>e.toolName)}));process.exitCode=1;}
finally{ws.close();}
