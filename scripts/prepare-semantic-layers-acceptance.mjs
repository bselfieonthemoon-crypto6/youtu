import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createClient} from '@supabase/supabase-js';
assert.equal(process.env.SUPABASE_URL,'http://127.0.0.1:54421');
const dir='artifacts/semantic-layers-20260915';await mkdir(dir,{recursive:true});
const opts={auth:{persistSession:false,autoRefreshToken:false}};
const admin=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,opts);
const owner='541006fa-d2a1-4305-be55-b6263c27a1e3';
const account=await admin.auth.admin.getUserById(owner);assert.ifError(account.error);
const link=await admin.auth.admin.generateLink({type:'magiclink',email:account.data.user.email});assert.ifError(link.error);
const client=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY,opts);
const auth=await client.auth.verifyOtp({type:'magiclink',token_hash:link.data.properties.hashed_token});assert.ifError(auth.error);
const call=async(path,method='GET',body)=>{const r=await fetch('http://127.0.0.1:3002'+path,{method,headers:{Authorization:`Bearer ${auth.data.session.access_token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();assert(r.ok,JSON.stringify(d.error));return d;};
try {
  let fixture;try{fixture=JSON.parse(await readFile(`${dir}/fixture.json`,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!fixture){
    const source=(await call('/api/canvases/df3b513c-6c2d-40e3-a784-123c35643806')).canvas;
    const element=source.content.elements.find(e=>!e.isDeleted&&e.customData?.assetId==='d4e6f727-0837-4a60-82df-f948e6d9c111');assert(element,'Source image must exist');
    const project=(await call('/api/projects','POST',{name:'QA 大模型图层拆分',description:'透明元素与修补背景真实验收'})).project;
    const target=(await call(`/api/canvases/${project.primaryCanvas.id}`)).canvas;
    const copy={...element,id:crypto.randomUUID(),x:100,y:150,width:656,height:288,version:1,versionNonce:Math.floor(Math.random()*1000000)};
    await call(`/api/canvases/${target.id}`,'PUT',{content:{...target.content,elements:[copy],files:{[copy.fileId]:source.content.files[copy.fileId]}}});
    const sessions=await admin.from('chat_sessions').select('id').eq('canvas_id',target.id).order('created_at').limit(1);assert.ifError(sessions.error);
    fixture={canvasId:target.id,projectId:project.id,sessionId:sessions.data[0]?.id,sourceElementId:copy.id,sourceAssetId:copy.customData.assetId};
    await writeFile(`${dir}/fixture.json`,JSON.stringify(fixture,null,2));
  }
  console.log(JSON.stringify(fixture));
}finally{await client.auth.signOut({scope:'local'});}
