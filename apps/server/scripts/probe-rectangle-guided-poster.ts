// Isolated project-provider experiment; never composites or modifies model output.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {loadServerEnv} from '../src/config/env.js';
import {createAdminSupabaseClient} from '../src/supabase/admin.js';
import {OpenAIImageProvider} from '../src/generation/providers/openai-image.js';
import {createSafeProviderFetch} from '../src/security/safe-provider-fetch.js';
import {safeDownload} from '../src/security/safe-download.js';

const dir=process.argv.find(a=>a.startsWith('--dir='))?.slice(6);
if(!dir) throw Error('Requires explicit --dir');
const size=process.argv.find(a=>a.startsWith('--target='))?.slice(9)??'320x70';
assert(/^\d+x\d+$/.test(size));
const [targetWidth,targetHeight]=size.split('x').map(Number) as [number,number];
assert(targetWidth>0&&targetHeight>0);
const scale=Math.max(1,Math.ceil(1024/Math.max(targetWidth,targetHeight)));
const ratioCompensation=process.argv.includes('--ratio-compensation');
if(ratioCompensation)assert(size==='320x70'&&process.argv.includes('--four-margins'));
const desiredContent={width:targetWidth*scale,height:targetHeight*scale};
const contentWidth=desiredContent.width,contentHeight=ratioCompensation?245:desiredContent.height,align=(n:number)=>Math.ceil(n/16)*16;
const margin=process.argv.includes('--four-margins')?64:0;
let width=align(contentWidth+margin*2),height=align(contentHeight+margin*2);
if(contentWidth>=contentHeight)height=align(Math.max(contentHeight+margin*2,width/3,655360/width));
else width=align(Math.max(contentWidth+margin*2,height/3,655360/height));
assert(Math.max(width,height)<=3840&&width*height<=8294400);
const left=Math.floor((width-contentWidth)/2),top=Math.floor((height-contentHeight)/2),right=left+contentWidth,bottom=top+contentHeight;
const insideRect=(x:number,y:number)=>x>=left&&x<right&&y>=top&&y<bottom;
if(process.argv.includes('--prepare')) {
  await mkdir(dir,{recursive:false});
  const source=Buffer.alloc(width*height*4),mask=Buffer.alloc(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4,inside=insideRect(x,y);
    source[i]=source[i+1]=source[i+2]=inside?160:0;
    source[i+3]=inside?255:0;
    mask[i+3]=inside?0:255;
  }
  await writeFile(`${dir}/source.png`,await sharp(source,{raw:{width,height,channels:4}}).png().toBuffer());
  await writeFile(`${dir}/mask.png`,await sharp(mask,{raw:{width,height,channels:4}}).png().toBuffer());
  await writeFile(`${dir}/plan.json`,JSON.stringify({targetWidth,targetHeight,scale,width,height,left,top,contentWidth,contentHeight,desiredContent,ratioCompensation},null,2));
  console.log(JSON.stringify({event:'prepared',dir,width,height,content:`${contentWidth}x${contentHeight}`,left,top,mask:'alpha0 edit, alpha255 preserve'}));
} else if(process.argv.includes('--submit')) {
  const source=await readFile(`${dir}/source.png`),mask=await readFile(`${dir}/mask.png`);
  for(const [bytes,isMask] of [[source,false],[mask,true]] as const){
    const {data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.equal(info.width,width);assert.equal(info.height,height);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)assert.equal(data[(y*width+x)*4+3],(insideRect(x,y)!==isMask)?255:0);
  }
  const env=loadServerEnv();
  assert(/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(env.supabaseUrl??''));
  const db=createAdminSupabaseClient(env);
  const {data:row,error}=await db.from('workspace_provider_models').select('provider_config_id,upstream_model_id,enabled').eq('id','748c78b1-29cd-438f-a23c-d6b7367c64f8').single();
  if(error||!row?.enabled||row.upstream_model_id!=='gpt-image-2.5-flare')throw Error('Configured flare unavailable');
  const {data:config}=await db.from('workspace_provider_configs').select('base_url,api_key_secret_id,enabled').eq('id',row.provider_config_id).single();
  if(!config?.enabled)throw Error('Provider unavailable');
  const secret=await db.rpc('loomic_provider_secret_read',{p_secret_id:config.api_key_secret_id});
  if(secret.error||!secret.data)throw Error('Credentials unavailable');
  const request={model:row.upstream_model_id,quality:'standard' as const,outputWidth:width,outputHeight:height,background:'transparent' as const,outputFormat:'png' as const,
    inputImages:[`data:image/png;base64,${source.toString('base64')}`],maskImage:`data:image/png;base64,${mask.toString('base64')}`,
    prompt:`将参考图中央的灰色矩形替换成一张完整的不透明“回家吃饭”复古宣传海报。保持矩形原有的位置、${contentWidth}×${contentHeight} 像素尺寸和宽高比例，所有画面安排在这个矩形内，保留矩形外透明区域和 ${width}×${height} 画布尺寸。暖黄灯光、中国老家饭桌、家常饭菜、搪瓷杯、怀旧木窗与旧纸质感，复古红色醒目标题“回家吃饭”。`};
  await writeFile(`${dir}/request.json`,JSON.stringify({...request,inputImages:['source.png'],maskImage:'mask.png'},null,2));
  const provider=new OpenAIImageProvider(String(secret.data),config.base_url);
  const client=(provider as any).client,realFetch=client.fetch;
  let calls=0;
  client.fetch=createSafeProviderFetch(config.base_url,{fetch:async(input,init)=>{
    assert.equal(++calls,1,'No retry');
    const encoded=new Request(input,init);
    assert(new URL(encoded.url).pathname.endsWith('/images/edits'));
    const form=await encoded.clone().formData();
    const sentImage=form.get('image[]')??form.get('image[0]')??form.get('image'),sentMask=form.get('mask');
    assert(sentImage instanceof File && sentMask instanceof File);
    assert(Buffer.from(await sentImage.arrayBuffer()).equals(source));
    assert(Buffer.from(await sentMask.arrayBuffer()).equals(mask));
    assert.equal(form.get('background'),'transparent');assert.equal(form.get('size'),`${width}x${height}`);
    const transport={endpoint:'images/edits',model:form.get('model'),size:form.get('size'),background:form.get('background'),quality:form.get('quality'),sourceUnchanged:true,maskUnchanged:true,calls};
    await writeFile(`${dir}/transport.json`,JSON.stringify(transport,null,2));console.log(JSON.stringify(transport));
    return realFetch(encoded);
  }});
  console.log(JSON.stringify({event:'submitting',dir,maxCalls:1}));
  const result=await provider.generate(request);
  const download=await safeDownload(result.url,{kind:'image',maxBytes:30*1024*1024,timeoutMs:60000,maxRedirects:2,allowDataUri:true,allowedMimeTypes:['image/png','image/webp','image/jpeg']});
  await writeFile(`${dir}/result.png`,download.buffer);
  const {data,info}=await sharp(download.buffer).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let minX=info.width,minY=info.height,maxX=-1,maxY=-1,transparent=0,outsideVisible=0,insideVisible=0;
  for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++){
    const a=data[(y*info.width+x)*4+3]!;if(a===0)transparent++;
    if(a>8){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);if(!insideRect(x,y))outsideVisible++;else insideVisible++;}
  }
  const report={targetWidth,targetHeight,scale,width:info.width,height:info.height,visibleBounds:maxX>=0?{x:minX,y:minY,width:maxX-minX+1,height:maxY-minY+1}:null,transparentPixels:transparent,outsideVisiblePixels:outsideVisible,insideVisiblePixels:insideVisible,expectedContent:{x:left,y:top,width:contentWidth,height:contentHeight},postprocessing:'none'};
  await writeFile(`${dir}/report.json`,JSON.stringify({...report,desiredContent,ratioCompensation},null,2));console.log(JSON.stringify({event:'complete',dir,...report,desiredContent,ratioCompensation}));
} else throw Error('Requires --prepare or --submit');
