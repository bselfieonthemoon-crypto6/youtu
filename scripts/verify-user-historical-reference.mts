import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {createClient} from '@supabase/supabase-js';
import {loadMastraHistoricalUploads,verifyMastraHistoricalUpload} from '../apps/server/src/agent/mastra-history-attachments.ts';
import {resolveAgentImageAttachment} from '../apps/server/src/agent/attachment-resolver.ts';
assert.equal(process.env.SUPABASE_URL,'http://127.0.0.1:54421');
const options={auth:{persistSession:false,autoRefreshToken:false}};
const admin=createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,options);
const owner=await admin.auth.admin.getUserById('541006fa-d2a1-4305-be55-b6263c27a1e3');assert.ifError(owner.error);
const link=await admin.auth.admin.generateLink({type:'magiclink',email:owner.data.user!.email!});assert.ifError(link.error);
const client=createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_ANON_KEY!,options);
const auth=await client.auth.verifyOtp({type:'magiclink',token_hash:link.data.properties.hashed_token});assert.ifError(auth.error);
try {
  const sessionId='473c80de-4b2b-46c5-b40d-78c72d3392f7';
  const assetId='5d15c558-ad08-4328-9ff9-d2526248d671';
  const uploads=await loadMastraHistoricalUploads({client,sessionId});
  const original=uploads.find(u=>u.assetId===assetId);assert(original,'Original pre-confirmation reference remains discoverable');
  await verifyMastraHistoricalUpload({client,sessionId,messageId:original.messageId,assetId});
  const image=await resolveAgentImageAttachment({client,attachment:{assetId,url:'https://expired.invalid/expired-reference',name:original.name??'reference',mimeType:'image/webp',source:'upload'}});
  assert(image.buffer.length>0);
  const report={sessionId,assetId,messageId:original.messageId,historicalUploadCount:uploads.length,recoveredFromAssetId:true,expiredUrlUnused:true,bytes:image.buffer.length,mimeType:image.mimeType};
  await mkdir('artifacts/historical-reference-20260915',{recursive:true});
  await writeFile('artifacts/historical-reference-20260915/original-user-reference.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} finally {await client.auth.signOut({scope:'local'});}
