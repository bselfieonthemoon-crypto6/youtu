import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createClient} from '@supabase/supabase-js';
assert.equal(process.env.SUPABASE_URL,'http://127.0.0.1:54421');
const sharp=createRequire(new URL('../apps/server/package.json',import.meta.url))('sharp');
const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const dir='artifacts/semantic-layers-20260915';
const f=JSON.parse(await readFile(`${dir}/fixture.json`,'utf8'));
const jobs=await db.from('background_jobs').select('id,status,payload,result,error_message,error_code').eq('canvas_id',f.canvasId).order('created_at',{ascending:false});assert.ifError(jobs.error);
const job=jobs.data.find(j=>j.payload.layer_backend==='semantic');assert(job,'A real semantic split job is required');
const report={jobId:job.id,status:job.status,error:job.error_message,errorCode:job.error_code,quality:job.payload.quality,resolution:job.payload.resolution,model:job.payload.model,layers:[]};
if(job.status!=='succeeded'){console.log(JSON.stringify(report));process.exit(1);}
assert.equal(job.payload.quality,'standard');assert.equal(job.payload.resolution,'1k');
assert.equal(job.result.layers.length,job.payload.layer_names.length+1);
const canvas=await db.from('canvases').select('content').eq('id',f.canvasId).single();assert.ifError(canvas.error);
assert(canvas.data.content.elements.some(e=>!e.isDeleted&&e.id===f.sourceElementId),'Source image must be preserved');
for(const [index,layer] of job.result.layers.entries()){
 const asset=await db.from('asset_objects').select('bucket,object_path').eq('id',layer.asset_id).single();assert.ifError(asset.error);
 const file=await db.storage.from(asset.data.bucket).download(asset.data.object_path);assert.ifError(file.error);
 const bytes=Buffer.from(await file.data.arrayBuffer());const meta=await sharp(bytes).metadata();assert.equal(meta.format,'png');
 let transparentFraction=0;
 if(layer.kind!=='background'){
   assert(meta.hasAlpha);const alpha=await sharp(bytes).extractChannel('alpha').raw().toBuffer();
   assert(alpha.some(v=>v===0)&&alpha.some(v=>v>0),'Foreground must have visible pixels and actual transparency');
   transparentFraction=alpha.filter(v=>v===0).length/alpha.length;
 }
 assert(canvas.data.content.elements.some(e=>!e.isDeleted&&e.customData?.assetId===layer.asset_id),'Every layer must be on the canvas');
 const output=`${dir}/layer-${index}-${layer.kind}.png`;await writeFile(output,bytes);
 report.layers.push({name:layer.name,kind:layer.kind,width:meta.width,height:meta.height,x:layer.x,y:layer.y,transparentFraction,assetId:layer.asset_id,output});
}
report.originalPreserved=true;report.allLayersInserted=true;
await writeFile(`${dir}/result.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
