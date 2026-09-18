import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

// Explicitly isolated local fixtures. No video, subscriptions or paid provider calls.
assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:54421');
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false}});
const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {auth:{persistSession:false}});
const report = {suite:'local-agent-jobs', cases:[], fixtureUser:null};
const email = `agent-jobs-${randomUUID()}@example.test`;
const password = randomUUID()+'aA1!';
const created = await admin.auth.admin.createUser({email,password,email_confirm:true});
assert.equal(created.error,null);
report.fixtureUser=created.data.user.id;
const signed = await client.auth.signInWithPassword({email,password});
assert.equal(signed.error,null);
const headers={Authorization:`Bearer ${signed.data.session.access_token}`,'Content-Type':'application/json'};
async function request(method,path,body,status){
 const response=await fetch('http://127.0.0.1:3002'+path,{method,headers:body===undefined?{Authorization:headers.Authorization}:headers,...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
 const data=await response.json().catch(()=>null);
 assert.equal(response.status,status,`${method} ${path}: ${response.status} ${data?.error?.code??''}`);
 return data;
}
async function check(name,fn){try{await fn();report.cases.push({name,passed:true});}catch(e){report.cases.push({name,passed:false,error:String(e.message).slice(0,400)});}console.log(JSON.stringify(report.cases.at(-1)));}
try{
 const viewer=await request('GET','/api/viewer',undefined,200);
 const workspaceId=viewer.workspace.id;
 let skillId,configId;
 await check('skills create with supporting file and read',async()=>{
  const data=await request('POST','/api/skills',{name:`Replica audit ${randomUUID()}`,description:'Isolated integration test',category:'custom',skillContent:'# Local audit\nSummarize the design brief without generating media.',files:[{filePath:'references/brief.md',content:'Ask for audience and dimensions.'}]},201);
  skillId=data.skill.id;assert.equal(data.skill.files.length,1);
  assert.equal((await request('GET',`/api/skills/${skillId}`,undefined,200)).skill.id,skillId);
  await request('GET',`/api/skills/${skillId}/files`,undefined,200);
 });
 await check('skills install replay disable enable update uninstall delete',async()=>{
  assert.ok(skillId);
  await request('POST','/api/workspaces/skills',{skillId},204);
  await request('POST','/api/workspaces/skills',{skillId},204);
  await request('PATCH',`/api/workspaces/skills/${skillId}`,{enabled:false},204);
  let installed=(await request('GET','/api/workspaces/skills',undefined,200)).skills.filter(s=>s.id===skillId);
  assert.equal(installed.length,1);assert.equal(installed[0].enabled,false);
  await request('PATCH',`/api/workspaces/skills/${skillId}`,{enabled:true},204);
  await request('PUT',`/api/skills/${skillId}`,{description:'Updated audit fixture'},200);
  await request('DELETE',`/api/workspaces/skills/${skillId}`,undefined,204);
  await request('DELETE',`/api/skills/${skillId}`,undefined,204);
  await request('GET',`/api/skills/${skillId}`,undefined,404);
 });
 await check('provider rejects insecure URL',async()=>{await request('POST','/api/workspace/provider-configs',{displayName:'Audit',baseUrl:'http://127.0.0.1:9',apiKey:'fake-audit-key'},422);});
 await check('provider isolated CRUD and secret redaction',async()=>{
  const data=await request('POST','/api/workspace/provider-configs',{displayName:'Replica audit disabled provider',baseUrl:'https://api.apiyi.com/v1',apiKey:'fake-audit-key',enabled:false,models:[{upstreamModelId:'audit-only',displayName:'Audit',modality:'text',enabled:false}]},201);
  configId=data.config.id;assert.equal(JSON.stringify(data).includes('fake-audit-key'),false);
  await request('PUT',`/api/workspace/provider-configs/${configId}`,{displayName:'Updated disabled audit'},200);
  const list=await request('GET','/api/workspace/provider-configs',undefined,200);assert.ok(list.configs.some(c=>c.id===configId));
  await request('DELETE',`/api/workspace/provider-configs/${configId}`,undefined,204);
 });
 await check('job filters reject invalid status and type',async()=>{
  await request('GET','/api/jobs?status=not-a-status',undefined,400);
  await request('GET','/api/jobs?job_type=not-a-type',undefined,400);
 });
 await check('jobs list normal filter',async()=>{await request('GET','/api/jobs?status=succeeded&job_type=image_generation',undefined,200);});
 await check('jobs invalid identifier returns client error',async()=>{await request('GET','/api/jobs/not-a-uuid',undefined,400);});
 await check('controlled queued job cancellation refunds once',async()=>{
  const jobId=randomUUID();
  const insert=await admin.from('background_jobs').insert({id:jobId,workspace_id:workspaceId,created_by:created.data.user.id,job_type:'image_generation',queue_name:'image_generation_jobs',status:'queued',payload:{prompt:'Controlled non-enqueued cancellation test'},credits_cost:0});
  assert.equal(insert.error,null);
  // This record is deliberately never enqueued: no external image request.
  const deduction=await admin.rpc('loomic_deduct_credits_idempotent',{p_workspace_id:workspaceId,p_user_id:created.data.user.id,p_amount:1,p_job_id:jobId,p_description:'Local controlled cancellation fixture'});
  assert.equal(deduction.error,null);
  const duplicate=await admin.rpc('loomic_deduct_credits_idempotent',{p_workspace_id:workspaceId,p_user_id:created.data.user.id,p_amount:1,p_job_id:jobId,p_description:'Local duplicate fixture'});
  assert.equal(duplicate.error,null);assert.equal(duplicate.data.charged_new,false);
  assert.equal(duplicate.data.transaction_id,deduction.data.transaction_id);
  assert.equal((await admin.from('background_jobs').update({credits_cost:1,credits_transaction_id:deduction.data.transaction_id}).eq('id',jobId)).error,null);
  assert.equal((await request('POST',`/api/jobs/${jobId}/cancel`,{},200)).job.status,'canceled');
  // Current API returns 404 on terminal cancel; retry must never create a second refund.
  await request('POST',`/api/jobs/${jobId}/cancel`,{},404);
  const ledger=await admin.from('credit_transactions').select('transaction_type,amount').eq('job_id',jobId);
  assert.equal(ledger.error,null);assert.equal(ledger.data.filter(t=>t.transaction_type==='generation_refund').length,1);
  await request('POST',`/api/jobs/${jobId}/restore-to-canvas`,{},409);
 });
 await check('completed fixture read refreshes URL and restore is idempotent',async()=>{
  const {project}=await request('POST','/api/projects',{name:'Isolated job restore audit'},201);
  const canvasId=project.primaryCanvas.id;
  const jobId=randomUUID(),assetId=randomUUID();
  const objectPath=`${workspaceId}/generated/${jobId}.png`;
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a20sAAAAASUVORK5CYII=','base64');
  assert.equal((await admin.storage.from('project-assets').upload(objectPath,png,{contentType:'image/png'})).error,null);
  assert.equal((await admin.from('asset_objects').insert({id:assetId,workspace_id:workspaceId,project_id:project.id,bucket:'project-assets',object_path:objectPath,mime_type:'image/png',byte_size:png.length,created_by:created.data.user.id})).error,null);
  assert.equal((await admin.from('background_jobs').insert({id:jobId,workspace_id:workspaceId,project_id:project.id,canvas_id:canvasId,created_by:created.data.user.id,job_type:'image_generation',queue_name:'image_generation_jobs',status:'succeeded',completed_at:new Date().toISOString(),payload:{prompt:'Synthetic completed image result; no provider call'},result:{asset_id:assetId,object_path:objectPath,width:1,height:1,mime_type:'image/png',signed_url:'http://127.0.0.1:54421/expired-fixture'}})).error,null);
  const {job}=await request('GET',`/api/jobs/${jobId}`,undefined,200);
  const image=await fetch(job.result.signed_url,{signal:AbortSignal.timeout(10000)});assert.equal(image.status,200);
  const restored=await request('POST',`/api/jobs/${jobId}/restore-to-canvas`,{},200);
  assert.equal(restored.inserted,true);
  const replay=await request('POST',`/api/jobs/${jobId}/restore-to-canvas`,{},200);
  assert.equal(replay.inserted,false);assert.equal(replay.elementId,restored.elementId);
  await request('POST',`/api/jobs/${jobId}/cancel`,{},404);
  assert.equal((await admin.from('asset_objects').update({deletion_pending_at:new Date().toISOString()}).eq('id',assetId)).error,null);
  await request('POST',`/api/jobs/${jobId}/restore-to-canvas`,{},410);
 });
 await check('foreign job read cancel restore are denied',async()=>{
  const foreign=await admin.from('background_jobs').select('id').neq('created_by',created.data.user.id).eq('job_type','image_generation').limit(1).single();
  assert.equal(foreign.error,null);
  await request('GET',`/api/jobs/${foreign.data.id}`,undefined,404);
  await request('POST',`/api/jobs/${foreign.data.id}/cancel`,{},404);
  await request('POST',`/api/jobs/${foreign.data.id}/restore-to-canvas`,{},404);
 });
 await check('Agent rejects a model outside workspace catalog before creating a run',async()=>{
  const {project}=await request('POST','/api/projects',{name:'Isolated Agent validation audit'},201);
  const {session}=await request('POST',`/api/canvases/${project.primaryCanvas.id}/sessions`,{title:'No provider execution'},201);
  const response=await fetch('http://127.0.0.1:3002/api/agent/runs',{method:'POST',headers,body:JSON.stringify({sessionId:session.id,conversationId:randomUUID(),canvasId:project.primaryCanvas.id,prompt:'No execution audit',model:'audit:nonexistent-model'}),signal:AbortSignal.timeout(30000)});
  const data=await response.json();
  // HTTP acceptance does not start streaming; cancel unexpected acceptance immediately.
  if(data.runId)await request('POST',`/api/agent/runs/${data.runId}/cancel`,{},202);
  assert.equal(response.status,422);
 });
 await check('Agent empty catalog retains configured environment default',async()=>{
  const {project}=await request('POST','/api/projects',{name:'Isolated Agent implicit default audit'},201);
  const {session}=await request('POST',`/api/canvases/${project.primaryCanvas.id}/sessions`,{title:'Implicit default without provider execution'},201);
  const run=await request('POST','/api/agent/runs',{sessionId:session.id,conversationId:randomUUID(),canvasId:project.primaryCanvas.id,prompt:'Acceptance-only default model audit'},202);
  await request('POST',`/api/agent/runs/${run.runId}/cancel`,{},202);
 });
}finally{
 await client.auth.signOut({scope:'local'});
 await writeFile('artifacts/local-replica-20260907/agent-jobs-audit.json',JSON.stringify(report,null,2));
}
console.log(JSON.stringify({passed:report.cases.filter(c=>c.passed).length,total:report.cases.length,fixtureUser:report.fixtureUser}));
if(report.cases.some(c=>!c.passed))process.exitCode=1;
