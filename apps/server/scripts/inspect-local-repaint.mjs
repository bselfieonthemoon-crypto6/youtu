import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false}});
const id = process.argv[2] ?? 'aaa072ef-b7cd-45f7-95f6-5e9e054b73a8';
const {data:job,error} = await db.from('background_jobs').select('payload,result').eq('id',id).single();
if(error) throw error;
const {data:assets,error:ae} = await db.from('asset_objects').select('id,bucket,object_path').like('object_path',`%${id}%`);
if(ae)throw ae;
const raw = async data => {
 if(typeof data !== 'string') throw Error('Unexpected source type');
 if(data.startsWith('data:'))return Buffer.from(data.split(',')[1],'base64');
 const r=await fetch(data);if(!r.ok)throw Error(`Image fetch ${r.status}`);return Buffer.from(await r.arrayBuffer());
};
const mask = await sharp(await raw(job.payload.mask_image)).removeAlpha().greyscale().raw().toBuffer({resolveWithObject:true});
const stats = async (buffer,label) => {
 const meta=await sharp(buffer).metadata();
 const {data,info}=await sharp(buffer).resize(mask.info.width,mask.info.height,{fit:'fill'}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 let selected=0,black=0,transparent=0;const sum=[0,0,0,0];
 for(let i=0;i<mask.data.length;i++){if(mask.data[i]<200)continue;selected++;const o=i*4;for(let c=0;c<4;c++)sum[c]+=data[o+c];if(data[o]<20&&data[o+1]<20&&data[o+2]<20&&data[o+3]>240)black++;if(data[o+3]<10)transparent++;}
 const overall = await sharp(buffer).stats();
 console.log(JSON.stringify({label,width:meta.width,height:meta.height,channels:meta.channels,overall:overall.channels.map(c=>({min:c.min,max:c.max,mean:Math.round(c.mean)})),selected,black,transparent,mean:sum.map(s=>Math.round(s/selected))}));
};
await stats(await raw(job.payload.input_images[0]),'input');
for(const asset of assets){const {data,error}=await db.storage.from(asset.bucket).download(asset.object_path);if(error)throw error;const buffer=Buffer.from(await data.arrayBuffer());await stats(buffer,asset.object_path.split('/').at(-1));if(process.argv.includes('--save-original')&&asset.object_path.includes('source-before'))await writeFile(`../../artifacts/paid-dialogue-live/${id}-provider-original.png`,buffer);}
