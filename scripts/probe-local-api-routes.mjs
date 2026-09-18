import {readdir,readFile,writeFile} from 'node:fs/promises';
import {createClient} from '@supabase/supabase-js';
if(process.env.SUPABASE_URL!=='http://127.0.0.1:54421')throw new Error('Local replica required');
const dir='apps/server/src/http';const routes=[];
for(const file of await readdir(dir)){
 if(!file.endsWith('.ts')||file.endsWith('.test.ts'))continue;
 const source=await readFile(`${dir}/${file}`,'utf8');
 const re=/app\.(get|post|put|patch|delete)(?:<[\s\S]*?>)?\(\s*["'`]([^"'`]+)["'`]/g;
 for(const m of source.matchAll(re))if(m[2].startsWith('/api/'))routes.push({method:m[1].toUpperCase(),path:m[2],file});
}
const admin=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const {data:{user}}=await admin.auth.admin.getUserById('541006fa-d2a1-4305-be55-b6263c27a1e3');
const {data:link}=await admin.auth.admin.generateLink({type:'magiclink',email:user.email});
const client=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY,{auth:{persistSession:false}});
const {data:auth}=await client.auth.verifyOtp({token_hash:link.properties.hashed_token,type:'magiclink'});
const report=[];
try{
 for(const route of routes){
  const safePath=route.path.replace(/:[A-Za-z_]+/g,'00000000-0000-4000-8000-000000000000');
  const start=performance.now();
  const r=await fetch('http://127.0.0.1:3002'+safePath,{method:route.method,headers:{'Content-Type':'application/json'},...(route.method==='GET'?{}:{body:'{}'}),signal:AbortSignal.timeout(15000)});
  await r.arrayBuffer();
  const row={...route,unauthenticated:r.status,milliseconds:Math.round(performance.now()-start)};
  if(route.method==='GET'){
   const response=await fetch('http://127.0.0.1:3002'+safePath,{headers:{Authorization:`Bearer ${auth.session.access_token}`},signal:AbortSignal.timeout(15000)});
   await response.arrayBuffer();row.authenticatedRead=response.status;
  }
  report.push(row);
 }
 await writeFile('artifacts/local-replica-20260907/api-route-probes.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({routes:report.length,serverErrors:report.filter(r=>r.unauthenticated>=500||r.authenticatedRead>=500),note:'Permission/input probes plus authenticated GETs; not happy-path execution of every mutation'}));
}finally{await client.auth.signOut({scope:'local'});}
