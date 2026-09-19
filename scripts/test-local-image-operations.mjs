import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {createClient} from '@supabase/supabase-js';
const require=createRequire(new URL('../apps/server/package.json',import.meta.url));
const sharp=require('sharp');
assert.equal(process.env.SUPABASE_URL,'http://127.0.0.1:54421');
const admin=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const {data:{user}}=await admin.auth.admin.getUserById('541006fa-d2a1-4305-be55-b6263c27a1e3');
const {data:link}=await admin.auth.admin.generateLink({type:'magiclink',email:user.email});
const client=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY,{auth:{persistSession:false}});
const {data:auth}=await client.auth.verifyOtp({token_hash:link.properties.hashed_token,type:'magiclink'});
const headers={Authorization:`Bearer ${auth.session.access_token}`,'Content-Type':'application/json'};
const api=async(path,body)=>{
 const response=await fetch('http://127.0.0.1:3002'+path,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
 assert.ok(response.ok,`${path}: ${response.status}`);return response.json();
};
const report=process.env.LOOMIC_TEST_IMAGE_MODES?JSON.parse(await readFile('artifacts/local-replica-20260907/image-operations-report.json','utf8').catch(()=>'[]')):[];
try{
 const {project}=await api('/api/projects',{name:`图片编辑独立验收 ${Date.now()}`});
 const source=await sharp(Buffer.from('<svg width="128" height="128"><rect width="128" height="128" fill="white"/><circle cx="64" cy="64" r="26" fill="red"/></svg>')).png().toBuffer();
 const mask=await sharp(Buffer.from('<svg width="128" height="128"><rect width="128" height="128" fill="black"/><rect x="32" y="32" width="64" height="64" fill="white"/></svg>')).png().toBuffer();
 const modes=(process.env.LOOMIC_TEST_IMAGE_MODES??'erase_transparent,smart_erase,remove_background,region_matting').split(',');
 for(const mode of modes){
  const started=Date.now();
  const {job}=await api('/api/jobs/image-generation',{project_id:project.id,canvas_id:project.primaryCanvas.id,prompt:'Local isolated image operation test',operation:mode,input_images:[`data:image/png;base64,${source.toString('base64')}`],...(['erase_transparent','smart_erase'].includes(mode)?{mask_image:`data:image/png;base64,${mask.toString('base64')}`} :{}),...(mode==='region_matting'?{selection_region:{x:.2,y:.2,width:.6,height:.6}}:{})});
  let current;
  for(let n=0;n<240;n++){
   ({job:current}=await api(`/api/jobs/${job.id}`));
   if(['succeeded','failed','dead_letter','canceled'].includes(current.status))break;
   await new Promise(r=>setTimeout(r,2000));
  }
  const row={mode,jobId:job.id,status:current.status,errorCode:current.error_code,ms:Date.now()-started};
  if(current.status==='succeeded'){
   const response=await fetch(current.result.signed_url,{signal:AbortSignal.timeout(30000)});assert.ok(response.ok);
   const output=Buffer.from(await response.arrayBuffer());const metadata=await sharp(output).metadata();
   row.width=metadata.width;row.height=metadata.height;row.layers=current.result.layers?.length;
   if(['erase_transparent','smart_erase','remove_background'].includes(mode)){
    assert.equal(metadata.width,128);assert.equal(metadata.height,128);
   }else{
    assert.ok(metadata.width>0&&metadata.width<=128);assert.ok(metadata.height>0&&metadata.height<=128);
   }
   if(['erase_transparent','smart_erase'].includes(mode)){
    const before=await sharp(source).ensureAlpha().raw().toBuffer();const after=await sharp(output).ensureAlpha().raw().toBuffer();
    for(let y=0;y<128;y++)for(let x=0;x<128;x++)if(x<32||x>=96||y<32||y>=96){const offset=(y*128+x)*4;assert.deepEqual(after.subarray(offset,offset+4),before.subarray(offset,offset+4));}
    if(mode==='erase_transparent')assert.equal(after[(64*128+64)*4+3],0);
    row.unmaskedPixelsUnchanged=true;
   }
  }
  report.push(row);console.log(JSON.stringify(row));
  await writeFile('artifacts/local-replica-20260907/image-operations-report.json',JSON.stringify(report,null,2));
 }
}finally{await client.auth.signOut({scope:'local'});}
