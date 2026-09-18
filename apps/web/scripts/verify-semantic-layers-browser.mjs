import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
assert(process.argv.includes('--submit'),'Explicit --submit required');
assert.equal(process.env.SUPABASE_URL,'http://127.0.0.1:54421');
const dir='../../artifacts/semantic-layers-20260915';
const f=JSON.parse(await readFile(`${dir}/fixture.json`,'utf8'));
const options={auth:{persistSession:false,autoRefreshToken:false}};
const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,options);
const existing=await db.from('background_jobs').select('id,status,error_code,credits_cost').eq('canvas_id',f.canvasId);assert.ifError(existing.error);
if(existing.data.length){
 assert(process.argv.includes('--replace-unstarted'),'Never submit a duplicate QA split');
 assert.equal(existing.data.length,1);const prior=existing.data[0];
 assert.equal(prior.status,'dead_letter');assert.equal(prior.error_code,'model_not_found');
 assert.equal(prior.credits_cost??0,0,'Unstarted QA must not carry unrefunded credits');
 const transactions=await db.from('credit_transactions').select('id').eq('job_id',prior.id);assert.ifError(transactions.error);assert.equal(transactions.data.length,0);
 const artifacts=await db.from('asset_objects').select('id').like('object_path',`%${prior.id}%`);assert.ifError(artifacts.error);assert.equal(artifacts.data.length,0);
}
const account=await db.auth.admin.getUserById('541006fa-d2a1-4305-be55-b6263c27a1e3');assert.ifError(account.error);
const link=await db.auth.admin.generateLink({type:'magiclink',email:account.data.user.email});assert.ifError(link.error);
const auth=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY,options);
const login=await auth.auth.verifyOtp({type:'magiclink',token_hash:link.data.properties.hashed_token});assert.ifError(login.error);
const browser=await chromium.launch({channel:'chrome',headless:true});
const report={};
try{
 const page=await browser.newPage({viewport:{width:1600,height:1000}});
 await page.addInitScript(session=>localStorage.setItem('sb-127-auth-token',JSON.stringify(session)),login.data.session);
 await page.goto(`http://localhost:3020/canvas?id=${f.canvasId}`);
 await expect(page.locator('.excalidraw__canvas.interactive')).toBeVisible({timeout:45000});
 await page.mouse.click(600,800);await page.keyboard.press('v');await page.keyboard.press('Control+a');
 await page.getByRole('button',{name:'图层拆分',exact:true}).click();
 await page.getByRole('textbox',{name:'要拆分的元素名称'}).fill('左侧完整蛇形角色，包含头部、身体和羽毛装饰\n右侧完整人物，包含头饰、衣服和手脚');
 const submit=page.getByRole('button',{name:'开始拆分',exact:true});await expect(submit).toBeEnabled({timeout:15000});
 await page.screenshot({path:`${dir}/before-submit.png`});
 const responsePromise=page.waitForResponse(r=>r.url().includes('/api/jobs/image-generation')&&r.request().method()==='POST',{timeout:30000});
 await submit.click();const response=await responsePromise;const body=await response.json();assert(response.ok(),JSON.stringify(body.error));
 report.submitted=true;report.httpStatus=response.status();
 const request=response.request().postDataJSON();report.request={operation:request.operation,backend:request.layer_backend,layerNames:request.layer_names,quality:request.quality,resolution:request.resolution,model:request.model};
 await writeFile(`${dir}/browser.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 await page.screenshot({path:`${dir}/submitted.png`});
}catch(error){report.error=error.message;await writeFile(`${dir}/browser.json`,JSON.stringify(report,null,2));throw error;}
finally{await browser.close();await auth.auth.signOut({scope:'local'});}
