import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createClient} from '@supabase/supabase-js';
assert.equal(process.env.SUPABASE_URL,'http://127.0.0.1:54421');
const sharp=createRequire(new URL('../apps/server/package.json',import.meta.url))('sharp');
const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const dir='artifacts/background-skill-20260915';
const fixture=JSON.parse(await readFile(`${dir}/fixture.json`,'utf8'));
const row=await db.from('background_jobs').select('id,status,payload,result,error_code,error_message').eq('id','6f12a28a-3a17-44af-92c2-2e25cda31d70').eq('session_id',fixture.sessionId).single();assert.ifError(row.error);
const job=row.data;
const report={jobId:job.id,status:job.status,operation:job.payload.operation,background:job.payload.background,outputFormat:job.payload.output_format,sourceCount:job.payload.input_images?.length,model:job.payload.model,error:job.error_message,errorCode:job.error_code};
assert.equal(report.background,'transparent');assert.equal(report.outputFormat,'png');assert.equal(report.sourceCount,1);
if(job.status==='succeeded'){
 const id=job.result.asset_id;const asset=await db.from('asset_objects').select('bucket,object_path').eq('id',id).single();assert.ifError(asset.error);
 const downloaded=await db.storage.from(asset.data.bucket).download(asset.data.object_path);assert.ifError(downloaded.error);
 const bytes=Buffer.from(await downloaded.data.arrayBuffer());const meta=await sharp(bytes).metadata();assert.equal(meta.format,'png');assert(meta.hasAlpha);
 const alpha=await sharp(bytes).extractChannel('alpha').raw().toBuffer();const transparent=alpha.filter(v=>v===0).length;const foreground=alpha.filter(v=>v>0).length;assert(transparent>0&&foreground>0);
 const canvas=await db.from('canvases').select('content').eq('id',fixture.canvasId).single();assert.ifError(canvas.error);
 const placed=canvas.data.content.elements.some(e=>!e.isDeleted&&e.type==='image'&&e.customData?.assetId===id);assert(placed,'Result must be present in canvas');
 Object.assign(report,{assetId:id,width:meta.width,height:meta.height,alphaVerified:true,transparentFraction:transparent/alpha.length,canvasInserted:true,upstreamModel:job.result.upstream_model});
 await writeFile(`${dir}/透明兔子-真实Agent调用.png`,bytes);
}
await writeFile(`${dir}/result.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
if(['dead_letter','failed','canceled'].includes(job.status))process.exitCode=1;
