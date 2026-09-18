import {createClient} from '@supabase/supabase-js';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
if(process.env.SUPABASE_URL!=='http://127.0.0.1:54421')throw new Error('Only the isolated local endpoint is allowed');
const client=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const root='artifacts/local-replica-20260907';
const objects=JSON.parse(await readFile(path.join(root,'storage-inventory.json'),'utf8'));
const ledgerPath=path.join(root,'storage-hydrated.json');
const done=new Set(JSON.parse(await readFile(ledgerPath,'utf8').catch(()=>'[]')));
let cursor=0,failed=0;
await Promise.all(Array.from({length:8},async()=>{
 while(cursor<objects.length){
  const obj=objects[cursor++];const key=obj.bucket_id+'/'+obj.name;if(done.has(key))continue;
  const data=await readFile(path.join(root,'storage',obj.bucket_id,obj.name));
  const {error}=await client.storage.from(obj.bucket_id).upload(obj.name,data,{upsert:true,contentType:obj.metadata?.mimetype||'application/octet-stream'});
  if(error){failed++;if(failed<4)console.log(`Upload error: ${error.message}`);}else done.add(key);
  if(done.size%500===0)console.log(`Local files installed: ${done.size}/${objects.length}`);
 }
}));
await writeFile(ledgerPath,JSON.stringify([...done]));
console.log(JSON.stringify({installed:done.size,total:objects.length,failed}));
if(failed)process.exitCode=1;
