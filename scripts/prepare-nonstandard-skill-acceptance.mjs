import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createClient} from '@supabase/supabase-js';
assert.equal(process.env.SUPABASE_URL,'http://127.0.0.1:54421');
const dir='artifacts/nonstandard-image-size-20260915';await mkdir(dir,{recursive:true});
const options={auth:{persistSession:false,autoRefreshToken:false}};
const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,options);
const ownerId='541006fa-d2a1-4305-be55-b6263c27a1e3';
const account=await db.auth.admin.getUserById(ownerId);assert.ifError(account.error);
const link=await db.auth.admin.generateLink({type:'magiclink',email:account.data.user.email});assert.ifError(link.error);
const auth=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY,options);
const login=await auth.auth.verifyOtp({type:'magiclink',token_hash:link.data.properties.hashed_token});assert.ifError(login.error);
async function call(path,method='GET',body){const r=await fetch('http://127.0.0.1:3002'+path,{method,headers:{Authorization:`Bearer ${login.data.session.access_token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();assert(r.ok,JSON.stringify(data.error));return data;}
const skills=await call('/api/workspaces/skills');const skill=skills.skills.find(s=>s.slug==='nonstandard-image-size');assert(skill);console.log(JSON.stringify({slug:skill.slug,enabled:skill.enabled,version:skill.version,readiness:skill.readiness}));
await writeFile(`${dir}/readiness-${process.argv[2]??'before'}.json`,JSON.stringify(skill,null,2));
let fixture;try{fixture=JSON.parse(await readFile(`${dir}/fixture.json`,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
if(!fixture){const project=(await call('/api/projects','POST',{name:'QA 非标准尺寸技能',description:'验证近似尺寸技能读取与实际输出比例'})).project;
 const sessions=await db.from('chat_sessions').select('id').eq('canvas_id',project.primaryCanvas.id).order('created_at').limit(1);assert.ifError(sessions.error);
 let sessionId=sessions.data[0]?.id;
 if(!sessionId){const created=await db.from('chat_sessions').insert({canvas_id:project.primaryCanvas.id,created_by:ownerId,title:'近似尺寸技能验证',thread_id:'thread_'+crypto.randomUUID()}).select('id').single();assert.ifError(created.error);sessionId=created.data.id;}
 fixture={canvasId:project.primaryCanvas.id,sessionId,projectId:project.id};await writeFile(`${dir}/fixture.json`,JSON.stringify(fixture,null,2));
}
console.log(JSON.stringify(fixture));await auth.auth.signOut({scope:'local'});

