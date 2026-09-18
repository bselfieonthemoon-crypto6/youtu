import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createClient} from '@supabase/supabase-js';
const sharp=createRequire(new URL('../apps/server/package.json',import.meta.url))('sharp');
assert.equal(process.env.SUPABASE_URL,'http://127.0.0.1:54421');
const admin=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const {data:{user}}=await admin.auth.admin.getUserById('541006fa-d2a1-4305-be55-b6263c27a1e3');
const {data:link}=await admin.auth.admin.generateLink({type:'magiclink',email:user.email});
const client=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY,{auth:{persistSession:false}});
const {data:auth}=await client.auth.verifyOtp({token_hash:link.properties.hashed_token,type:'magiclink'});
const headers={Authorization:`Bearer ${auth.session.access_token}`,'Content-Type':'application/json'};
const api=(path,method='GET',body)=>fetch('http://127.0.0.1:3002'+path,{method,headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(90000)});
try{
 const response=await api('/api/projects','POST',{name:`OCR isolated test ${Date.now()}`});assert.ok(response.ok);
 const {project}=await response.json();const canvasId=project.primaryCanvas.id;
 const bytes=await sharp(Buffer.from('<svg width="400" height="120"><rect width="400" height="120" fill="white"/><text x="20" y="80" font-family="Arial" font-size="56" fill="black">HELLO 42</text></svg>')).png().toBuffer();
 const image={assetId:'ocr-test-image',url:`data:image/png;base64,${bytes.toString('base64')}`,mimeType:'image/png'};
 const saved=await api(`/api/canvases/${canvasId}`,'PUT',{content:{elements:[{id:image.assetId,type:'image',fileId:'ocr-file',isDeleted:false,x:0,y:0,width:400,height:120,version:1,versionNonce:1}],appState:{},files:{'ocr-file':{id:'ocr-file',dataURL:image.url,mimeType:image.mimeType,created:Date.now()}}}});assert.ok(saved.ok,`save ${saved.status}`);
 const denied=await api('/api/images/recognize-text','POST',{canvasId:crypto.randomUUID(),image});assert.equal(denied.status,404);
 const result=await api('/api/images/recognize-text','POST',{canvasId,image});
 const data=await result.json();
 assert.ok(result.ok,`OCR ${result.status}: ${data.error?.code}`);
 assert.match(data.texts.join(' '),/HELLO\s*42/i);
 console.log(JSON.stringify({test:'real OCR with authorized canvas + missing canvas 404',status:'passed',texts:data.texts}));
}finally{await client.auth.signOut({scope:'local'});}
