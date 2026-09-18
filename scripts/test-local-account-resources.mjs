import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { writeFile } from 'node:fs/promises';

assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:54421');
const api = 'http://127.0.0.1:3002';
const results = [];
const users = [];
const makeClient = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {auth:{persistSession:false,autoRefreshToken:false}});
async function check(name, action) {
  try { await action(); results.push({name,status:'passed'}); console.log('PASS',name); }
  catch (error) { results.push({name,status:'failed',message:error.message}); console.log('FAIL',name,error.message); }
}
async function request(user, path, method='GET', body, expected=200) {
  const headers = {Authorization:`Bearer ${user.token}`};
  if (body && !(body instanceof FormData)) headers['Content-Type']='application/json';
  const r = await fetch(api+path,{method,headers,body:body instanceof FormData?body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
  if(r.status!==expected){ const payload=await r.json().catch(()=>null);throw new Error(`${method} ${path}: expected ${expected}, received ${r.status}; ${payload?.error?.code??'unknown'} ${payload?.error?.message??''}`); }
  if(r.status===204)return;
  return r.headers.get('content-type')?.includes('application/json')?r.json():Buffer.from(await r.arrayBuffer());
}
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
function form(bytes=image,type='image/png',projectId) { const f=new FormData();if(projectId)f.append('projectId',projectId);f.append('file',new Blob([bytes],{type}),'fixture.png');return f; }
try {
  await check('two independent accounts: signup, password login, session refresh, bootstrap',async()=>{
    for(let i=0;i<2;i++){
      const client=makeClient(),email=`replica-account-${Date.now()}-${i}@example.com`,password=`Test!${crypto.randomUUID()}`;
      const signup=await client.auth.signUp({email,password});assert.ifError(signup.error);assert.ok(signup.data.user);
      await client.auth.signOut();
      const wrong=await client.auth.signInWithPassword({email,password:'Wrong-password!'});assert.ok(wrong.error);
      const login=await client.auth.signInWithPassword({email,password});assert.ifError(login.error);
      const refresh=await client.auth.refreshSession();assert.ifError(refresh.error);
      const user={client,email,id:login.data.user.id,token:refresh.data.session.access_token};users.push(user);
      user.viewer=await request(user,'/api/viewer');
    }
    assert.notEqual(users[0].viewer.workspace.id,users[1].viewer.workspace.id);
  });
  assert.equal(users.length,2);
  const [owner,other]=users;let project,session,kit,asset,duplicate;
  await check('profile display name edit and invalid name rejection',async()=>{
    await request(owner,'/api/viewer/profile','PATCH',{displayName:'Local regression tester'});
    assert.equal((await request(owner,'/api/viewer')).profile.displayName,'Local regression tester');
    await request(owner,'/api/viewer/profile','PATCH',{displayName:''},400);
  });
  await check('workspace settings read/save persist and invalid payload rejected',async()=>{
    const {settings}=await request(owner,'/api/workspace/settings');
    await request(owner,'/api/workspace/settings','PUT',settings);
    assert.deepEqual((await request(owner,'/api/workspace/settings')).settings,settings);
    await request(owner,'/api/workspace/settings','PUT',{defaultModel:''},400);
  });
  await check('project create, rename, detail and list persistence',async()=>{
    ({project}=await request(owner,'/api/projects','POST',{name:'Local API regression'},201));
    await request(owner,`/api/projects/${project.id}`,'PATCH',{name:'Renamed regression'},204);
    assert.equal((await request(owner,`/api/projects/${project.id}`)).project.name,'Renamed regression');
    assert.ok((await request(owner,'/api/projects')).projects.some(p=>p.id===project.id));
  });
  await check('cross-workspace project read/write/delete isolation',async()=>{
    for(const [method,body] of [['GET'],['PATCH',{name:'Forbidden'}],['DELETE']]) await request(other,`/api/projects/${project.id}`,method,body,404);
    assert.equal((await request(owner,`/api/projects/${project.id}`)).project.name,'Renamed regression');
  });
  await check('project thumbnail upload and local downloadable URL',async()=>{
    const result=await request(owner,`/api/projects/${project.id}/thumbnail`,'PUT',form());
    assert.equal(new URL(result.thumbnailUrl).hostname,'127.0.0.1');
    assert.equal((await fetch(result.thumbnailUrl)).status,200);
    assert.ok((await request(owner,'/api/projects')).projects.find(p=>p.id===project.id).thumbnailUrl);
  });
  await check('session create, rename, list, cross-account isolation and delete',async()=>{
    const path=`/api/canvases/${project.primaryCanvas.id}/sessions`;
    ({session}=await request(owner,path,'POST',{title:'Regression session'},201));
    await request(owner,`/api/sessions/${session.id}`,'PATCH',{title:'Renamed session'});
    assert.equal((await request(owner,path)).sessions.find(s=>s.id===session.id).title,'Renamed session');
    await request(owner,`/api/sessions/${session.id}/messages`,'POST',{role:'user',content:'Private regression message'},201);
    assert.equal((await request(owner,`/api/sessions/${session.id}/messages`)).messages.length,1);
    assert.deepEqual((await request(other,`/api/sessions/${session.id}/messages`)).messages,[]);
    await request(other,`/api/sessions/${session.id}`,'PATCH',{title:'Forbidden'},404);
    await request(other,`/api/sessions/${session.id}`,'DELETE',undefined,404);
    await request(owner,`/api/sessions/${session.id}`,'DELETE');
    assert.ok(!(await request(owner,path)).sessions.some(s=>s.id===session.id));
  });
  await check('upload image, signed URL, stable content, preview, delete',async()=>{
    const uploaded=await request(owner,'/api/uploads','POST',form(image,'image/png',project.id),201);asset=uploaded.asset;
    const signed=await request(owner,`/api/uploads/${asset.id}/url`);
    assert.equal(new URL(signed.url).hostname,'127.0.0.1');
    const download=await fetch(signed.url);assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),image);
    assert.deepEqual(await request(owner,`/api/uploads/${asset.id}/content`),image);
    assert.ok((await request(owner,`/api/uploads/${asset.id}/content?preview=1`)).length>0);
    for(const suffix of ['/url','/content']) await request(other,`/api/uploads/${asset.id}${suffix}`,'GET',undefined,404);
    await request(other,`/api/uploads/${asset.id}`,'DELETE',undefined,403);
    await request(owner,`/api/uploads/${asset.id}`,'DELETE');
    await request(owner,`/api/uploads/${asset.id}/url`,'GET',undefined,404);
  });
  await check('reject unsupported upload MIME and unsafe SVG',async()=>{
    await request(owner,'/api/uploads','POST',form('not image','text/plain'),400);
    await request(owner,'/api/uploads','POST',form('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>','image/svg+xml'),400);
  });
  await check('brand kit create, update, asset add/update/delete, duplicate and isolation',async()=>{
    kit=await request(owner,'/api/brand-kits','POST',{name:'Regression kit'},201);
    const updated=await request(owner,`/api/brand-kits/${kit.id}`,'PATCH',{name:'Regression updated',guidance_text:'Use blue'});assert.equal(updated.name,'Regression updated');
    const color=await request(owner,`/api/brand-kits/${kit.id}/assets`,'POST',{asset_type:'color',display_name:'Blue',text_content:'#0000FF'},201);
    const changed=await request(owner,`/api/brand-kits/${kit.id}/assets/${color.id}`,'PATCH',{display_name:'Primary blue'});assert.equal(changed.display_name,'Primary blue');
    duplicate=await request(owner,`/api/brand-kits/${kit.id}/duplicate`,'POST',{},201);assert.equal(duplicate.assets.length,1);
    const logoForm=new FormData();logoForm.append('asset_type','logo');logoForm.append('file',new Blob([image],{type:'image/png'}),'logo.png');
    const logo=await request(owner,`/api/brand-kits/${kit.id}/assets/upload`,'POST',logoForm,201);
    assert.equal((await fetch(logo.file_url)).status,200);
    await request(owner,`/api/brand-kits/${kit.id}/assets/${logo.id}`,'DELETE',undefined,204);
    await request(other,`/api/brand-kits/${kit.id}`,'GET',undefined,404);
    await request(other,`/api/brand-kits/${kit.id}`,'DELETE',undefined,404);
    await request(owner,`/api/brand-kits/${kit.id}/assets/${color.id}`,'DELETE',undefined,204);
    assert.equal((await request(owner,`/api/brand-kits/${kit.id}`)).assets.length,0);
    await request(owner,`/api/brand-kits/${duplicate.id}`,'DELETE',undefined,204);
    await request(owner,`/api/brand-kits/${kit.id}`,'DELETE',undefined,204);
  });
  await check('workspace member add, role update, last-owner protection, remove',async()=>{
    const before=await request(owner,'/api/workspace/members');assert.ok(before.members.some(m=>m.userId===owner.id||m.user_id===owner.id));
    await request(owner,`/api/workspace/members/${owner.id}`,'DELETE',undefined,409);
    await request(owner,`/api/workspace/members/${owner.id}`,'PATCH',{role:'member'},409);
    await request(owner,'/api/workspace/members','POST',{email:other.email,role:'member'},201);
    await request(owner,`/api/workspace/members/${other.id}`,'PATCH',{role:'admin'});
    await request(owner,`/api/workspace/members/${other.id}`,'DELETE',undefined,204);
    assert.equal((await request(owner,'/api/workspace/members')).members.length,before.members.length);
  });
  await check('project archive removes project from list',async()=>{
    await request(owner,`/api/projects/${project.id}`,'DELETE',undefined,204);
    assert.ok(!(await request(owner,'/api/projects')).projects.some(p=>p.id===project.id));
  });
  await check('local recovery-token password reset and logout refresh revocation',async()=>{
    const admin=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
    const recovery=await admin.auth.admin.generateLink({type:'recovery',email:owner.email});assert.ifError(recovery.error);
    const verified=await owner.client.auth.verifyOtp({type:'recovery',token_hash:recovery.data.properties.hashed_token});assert.ifError(verified.error);
    const password=`Reset!${crypto.randomUUID()}`;
    const update=await owner.client.auth.updateUser({password});assert.ifError(update.error);
    await owner.client.auth.signOut();
    const login=await owner.client.auth.signInWithPassword({email:owner.email,password});assert.ifError(login.error);
    const refreshToken=login.data.session.refresh_token;
    await owner.client.auth.signOut();
    const revoked=await owner.client.auth.refreshSession({refresh_token:refreshToken});assert.ok(revoked.error);
  });
} finally {
  for(const u of users)await u.client.auth.signOut();
  await writeFile('artifacts/local-replica-20260907/account-resource-results.json',JSON.stringify({at:new Date().toISOString(),results},null,2));
}
if(results.some(r=>r.status==='failed'))process.exitCode=1;
