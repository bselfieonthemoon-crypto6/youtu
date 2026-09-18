import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../apps/server/package.json',import.meta.url));
const {createClient}=require('@supabase/supabase-js');
assert.equal(process.env.SUPABASE_URL,'http://127.0.0.1:54421');
const admin=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const {data:{user}}=await admin.auth.admin.getUserById('541006fa-d2a1-4305-be55-b6263c27a1e3');
const {data:link}=await admin.auth.admin.generateLink({type:'magiclink',email:user.email});
const client=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY,{auth:{persistSession:false}});
const {data:{session}}=await client.auth.verifyOtp({token_hash:link.properties.hashed_token,type:'magiclink'});
try {
 const response=await fetch('http://127.0.0.1:3002/api/canvases/38d02c58-71e0-4c2c-bb08-f011b6c37ce1',{headers:{Authorization:`Bearer ${session.access_token}`}});
 console.log('canvas API',response.status);
 const {canvas}=await response.json();
 for(const [id,file] of Object.entries(canvas.content.files)){
  let status=null,bytes=null;
  if(file.storageUrl){const download=await fetch(file.storageUrl);status=download.status;bytes=(await download.arrayBuffer()).byteLength;}
  if(file.storageUrl){ const proxy=await fetch('http://127.0.0.1:3002/api/proxy-image?url='+encodeURIComponent(file.storageUrl));console.log('proxy status',proxy.status); }
  console.log(JSON.stringify({id,keys:Object.keys(file),sourcePrefix:file.dataURL?.slice(0,10),status,bytes}));
 }
}finally{await client.auth.signOut({scope:'local'});}
