import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
assert(process.argv.includes('--submit'));
assert.equal(process.env.SUPABASE_URL,'http://127.0.0.1:54421');
const options={auth:{persistSession:false,autoRefreshToken:false}};
const admin=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,options);
const auth=createClient(process.env.SUPABASE_URL,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,options);
const account=await admin.auth.admin.getUserById('541006fa-d2a1-4305-be55-b6263c27a1e3');
const link=await admin.auth.admin.generateLink({type:'magiclink',email:account.data.user.email});
const login=await auth.auth.verifyOtp({type:'magiclink',token_hash:link.data.properties.hashed_token});
assert(login.data.session);
async function api(path,body){const response=await fetch(`http://127.0.0.1:3002/api${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${login.data.session.access_token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert(response.ok);return response.json();}
const project=await api('/projects',{name:'Native board browser QA'});
const canvas=project.project.primaryCanvas.id;
const {session}=await api(`/canvases/${canvas}/sessions`,{title:'Native board browser QA'});
console.log(JSON.stringify({canvas,session:session.id}));
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 await page.addInitScript(value=>localStorage.setItem('sb-127-auth-token',JSON.stringify(value)),login.data.session);
 await page.goto(`http://localhost:3020/canvas?id=${canvas}&session=${session.id}`);
 const autonomy=page.getByRole('switch',{name:'自动执行',exact:true});
 await autonomy.waitFor({state:'visible',timeout:60000});
 assert.equal(await autonomy.getAttribute('aria-checked'),'false');
 assert.equal(await page.getByRole('region',{name:'当前需求',exact:true}).count(),0);
 assert.equal(await page.getByText('自动执行与结果检查',{exact:true}).count(),0);
 await autonomy.click();
 await page.waitForFunction(()=>document.querySelector('[role="switch"][aria-label="自动执行"]')?.getAttribute('aria-checked')==='true');
 await autonomy.click();
 await page.waitForFunction(()=>document.querySelector('[role="switch"][aria-label="自动执行"]')?.getAttribute('aria-checked')==='false');
 const input=page.getByRole('textbox',{name:'输入消息'});
 await input.fill('新建一个658×176像素的空白原生设计画板，只创建一张。不要生成图片或视频，不要继续设计。创建保存后核对尺寸并结束。');
 const send=page.getByRole('button',{name:'发送消息',exact:true});
 await send.waitFor({state:'visible',timeout:60000});
 await send.click({timeout:60000});
 await page.getByTestId('design-node-preview').waitFor({state:'visible',timeout:180000});
 assert.equal(await page.getByTestId('design-node-preview').count(),1);
 const saved=await api(`/canvases/${canvas}`);
 const nodes=saved.canvas.content.elements.filter(e=>e.customData?.kind==='loomic-design');
 assert.equal(nodes.length,1);
 const doc=await admin.from('design_documents').select('width,height').eq('id',nodes[0].customData.designId).single();
 assert.deepEqual(doc.data,{width:658,height:176});
 await page.waitForFunction(()=>!document.querySelector('button[aria-label="停止生成"]'),{},{timeout:180000});
 assert.equal(await page.getByText('补充/纠正',{exact:true}).count(),0);
 await page.screenshot({path:'../../artifacts/native-board-creation/browser-live.png'});
 if(process.argv.includes('--followups')){
  await input.fill('把刚才画板的宽度改成800像素，高度不变，不要添加内容。');
  await send.click();
  let changed=false;
  for(let i=0;i<90;i++){
   const current=await admin.from('design_documents').select('width,height').eq('id',nodes[0].customData.designId).single();
   if(current.data?.width===800&&current.data?.height===176){changed=true;break;}
   await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert(changed,'natural correction updated the original board');
  await page.waitForFunction(()=>!document.querySelector('button[aria-label="停止生成"]'),{},{timeout:180000});
  await input.fill('再新建一张320×240像素的空白原生画板，保留刚才那张，不要生成图片。');
  await send.click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-testid="design-node-preview"]').length===2,{},{timeout:180000});
  await page.waitForFunction(()=>!document.querySelector('button[aria-label="停止生成"]'),{},{timeout:180000});
  const current=await admin.from('design_documents').select('width,height').eq('id',nodes[0].customData.designId).single();
  assert.deepEqual(current.data,{width:800,height:176});
  console.log(JSON.stringify({naturalCorrection:true,freshTaskPreservedPrevious:true}));
 }
 await page.reload();await page.getByTestId('design-node-preview').waitFor({state:'visible',timeout:60000});
 assert.equal(await page.getByTestId('design-node-preview').count(),process.argv.includes('--followups')?2:1);
 console.log(JSON.stringify({status:'passed',liveWithoutRefresh:true,refresh:true,canvas,session:session.id}));
} finally {await browser.close();}
