// Explicit one-call project-provider test. No agent, catalog or canvas mutations.
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import assert from "node:assert/strict";
import { createSafeProviderFetch } from "../src/security/safe-provider-fetch.js";
import { loadServerEnv } from "../src/config/env.js";
import { createAdminSupabaseClient } from "../src/supabase/admin.js";
import { OpenAIImageProvider } from "../src/generation/providers/openai-image.js";
import { safeDownload } from "../src/security/safe-download.js";

if (!process.argv.includes("--submit")) throw Error("Requires --submit (one paid call, no retries)");
const env=loadServerEnv();
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(env.supabaseUrl??"")) throw Error("Local DB only");
const db=createAdminSupabaseClient(env);
const {data:row,error}=await db.from("workspace_provider_models").select("provider_config_id,upstream_model_id,enabled").eq("id","748c78b1-29cd-438f-a23c-d6b7367c64f8").single();
if(error||!row?.enabled||row.upstream_model_id!=="gpt-image-2.5-flare") throw Error("Configured flare unavailable");
const {data:config}=await db.from("workspace_provider_configs").select("base_url,api_key_secret_id,enabled").eq("id",row.provider_config_id).single();
if(!config?.enabled)throw Error("Provider unavailable");
const secret=await db.rpc("loomic_provider_secret_read",{p_secret_id:config.api_key_secret_id});
if(secret.error||!secret.data)throw Error("Credentials unavailable");
const request={model:row.upstream_model_id,quality:"standard" as const,outputWidth:1024,outputHeight:1024,background:"transparent" as const,outputFormat:"png" as const,
 prompt:'生成一张 1024×1024 的透明背景 PNG。全部可见画面严格限制在画布正中央的 658×172 像素横向矩形内，即左上角 (183,426)，右下角边界 (841,598)。矩形区域之外全部为真正的 Alpha 透明，不要白底、黑底、棋盘格、外部阴影或额外装饰。矩形内部是一张完整的不透明复古横幅海报，主题为“回家吃饭”。暖黄灯光下的中国老家饭桌、家常饭菜、搪瓷杯、怀旧木窗与旧纸质感，温暖烟火气，复古红色醒目标题，文字仅为“回家吃饭”。所有文字、饭桌、背景与装饰都必须完整排在中央 658×172 区域内，保持横向构图，不要将海报放大填满整个 1024 方形画布。'};
if (process.argv.includes("--banner")) request.prompt = request.prompt.replaceAll("横幅海报", "横额").replaceAll("海报", "横额");
if (process.argv.includes("--simple")) request.prompt = '生成一张 1024×1024 的透明背景 PNG。全部可见画面严格限制在画布正中央的 658×172 像素横向矩形内，居中于画布。内容是一张“回家吃饭”的复古横额，暖黄灯光、中国老家饭桌、家常饭菜、搪瓷杯、怀旧木窗与旧纸质感，复古红色醒目标题“回家吃饭”。';
const white = process.argv.includes("--white");
const double = process.argv.includes("--double");
const direct = process.argv.includes("--direct");
const inset = process.argv.includes("--inset");
if (double) {
  request.outputWidth = 2048; request.outputHeight = 2048;
  request.prompt = '生成一张 2048×2048 的透明背景 PNG。全部可见画面严格限制在画布正中央的 1316×344 像素横向矩形内，居中于画布，其余地方透明。内容是一张“回家吃饭”的复古横额，暖黄灯光、中国老家饭桌、家常饭菜、搪瓷杯、怀旧木窗与旧纸质感，复古红色醒目标题“回家吃饭”。';
}
if (direct) {
  request.outputWidth=1408; request.outputHeight=480;
  request.prompt='生成一张“回家吃饭”的复古横额，画面铺满整张横向图片。暖黄灯光、中国老家饭桌、家常饭菜、搪瓷杯、怀旧木窗与旧纸质感，复古红色醒目标题“回家吃饭”。';
}
const target = direct ? {left:0,top:0,right:1408,bottom:480} : double ? {left:366,top:852,right:1682,bottom:1196} : {left:183,top:426,right:841,bottom:598};
if (inset) {
  if (!direct || !white) throw Error("--inset requires --direct --white");
  request.prompt='生成一张 1408×480 的白色背景 PNG。全部画面限制在画布正中央的 1316×344 像素横向矩形内，居中于画布，空出来的地方留纯白色。内容是一张“回家吃饭”的复古横额，暖黄灯光、中国老家饭桌、家常饭菜、搪瓷杯、怀旧木窗与旧纸质感，复古红色醒目标题“回家吃饭”。';
  Object.assign(target,{left:46,top:68,right:1362,bottom:412});
}
const finalRequest = {...request, ...(white ? {background:"opaque" as const, prompt:request.prompt.replace("透明背景 PNG", "纯白色背景 PNG").replace("矩形区域之外全部为真正的 Alpha 透明，不要白底、黑底、棋盘格、外部阴影或额外装饰。", "矩形区域之外全部为纯白色 #FFFFFF，不要透明、黑底、棋盘格、渐变、外部阴影或额外装饰。")} : {})};
if (process.argv.includes("--320x70")) {
  if (!direct || !white || !inset) throw Error("--320x70 requires --direct --white --inset");
  finalRequest.prompt='生成一张 1408×480 的白色背景 PNG。全部画面限制在画布正中央的 1280×280 像素横向矩形内，居中于画布，空出来的地方留纯白色。内容是一张“回家吃饭”的复古宣传横额，暖黄灯光、中国老家饭桌、家常饭菜、搪瓷杯、怀旧木窗与旧纸质感，复古红色醒目标题“回家吃饭”。';
  Object.assign(target,{left:64,top:100,right:1344,bottom:380});
}
if (process.argv.includes("--320x70-nearest")) {
  if (!process.argv.includes("--320x70")) throw Error("--320x70-nearest requires --320x70");
  finalRequest.outputWidth=1280; finalRequest.outputHeight=512;
  finalRequest.prompt='生成一张 1280×512 的白色背景 PNG。全部画面限制在画布正中央的 1280×280 像素横向矩形内，居中于画布，左右铺满，空出来的上下区域留纯白色。内容是一张“回家吃饭”的复古宣传横额，暖黄灯光、中国老家饭桌、家常饭菜、搪瓷杯、怀旧木窗与旧纸质感，复古红色醒目标题“回家吃饭”。';
  Object.assign(target,{left:0,top:116,right:1280,bottom:396});
}
if (direct) Object.assign(finalRequest,{background:"opaque"});
const sizeArg = process.argv.find(arg=>arg.startsWith("--target="))?.slice(9);
let sizePlan: {width:number;height:number;scale:number;contentWidth:number;contentHeight:number}|undefined;
if (sizeArg) {
  if (white || direct || double || inset) throw Error("--target is an independent transparent test");
  if (!/^\d+x\d+$/.test(sizeArg)) throw Error("Invalid target");
  const [width,height]=sizeArg.split("x").map(Number) as [number,number];
  if (width<=0 || height<=0) throw Error("Positive target required");
  const scale=Math.max(1,Math.ceil(1024/Math.max(width,height)));
  const contentWidth=width*scale,contentHeight=height*scale;
  const align=(n:number)=>Math.ceil(n/16)*16;
  finalRequest.outputWidth=align(contentWidth);
  finalRequest.outputHeight=align(Math.max(contentHeight,finalRequest.outputWidth/3,655360/finalRequest.outputWidth));
  if (height>width) {
    finalRequest.outputHeight=align(contentHeight);
    finalRequest.outputWidth=align(Math.max(contentWidth,finalRequest.outputHeight/3,655360/finalRequest.outputHeight));
  }
  if (Math.max(finalRequest.outputWidth,finalRequest.outputHeight)>3840 || finalRequest.outputWidth*finalRequest.outputHeight>8294400) throw Error("Size exceeds test limits");
  sizePlan={width,height,scale,contentWidth,contentHeight};
  const left=(finalRequest.outputWidth-contentWidth)/2,top=(finalRequest.outputHeight-contentHeight)/2;
  Object.assign(target,{left,top,right:left+contentWidth,bottom:top+contentHeight});
  finalRequest.prompt=`生成一张 ${finalRequest.outputWidth}×${finalRequest.outputHeight} 的透明背景 PNG。全部可见画面限制在画布正中央的 ${contentWidth}×${contentHeight} 像素横向矩形内，居中于画布。${contentWidth===finalRequest.outputWidth?'左右铺满。':''}矩形外全部为真正的透明区域，不要白底、棋盘格或外部阴影。矩形内是一张完整的不透明“回家吃饭”复古宣传海报，暖黄灯光、中国老家饭桌、家常饭菜、搪瓷杯、怀旧木窗与旧纸质感，复古红色醒目标题“回家吃饭”。`;
  if(process.argv.includes("--shape-fill")) {
    const ratio=width/height;
    let shape=ratio>=3?'超宽横幅，横向展开':ratio>=1.4?'横版海报':ratio>=0.8?'接近方形的海报':ratio>1/3?'竖版海报，纵向布局':'细长竖幅，纵向展开';
    if(process.argv.includes("--slight-orientation") && ratio>=0.8 && ratio<1.4) shape=ratio>1?'略宽的横版海报':ratio<1?'略高的竖版海报':'正方形海报';
    if(process.argv.includes("--numeric-only")) shape='海报';
    const edges=contentWidth===finalRequest.outputWidth?'左右贴齐画布边缘，仅上下透明。':contentHeight===finalRequest.outputHeight?'上下贴齐画布边缘，仅左右透明。':'';
    finalRequest.prompt=`生成一张 ${finalRequest.outputWidth}×${finalRequest.outputHeight} 的透明背景 PNG。中央是一张 ${contentWidth}×${contentHeight} 像素的完整${shape}，居中于画布，画面填满这个矩形区域，不要在矩形内部额外留边。${edges}矩形外全部为真正的透明区域，不要白底、棋盘格或外部阴影。矩形内是一张完整的不透明“回家吃饭”复古宣传海报，暖黄灯光、中国老家饭桌、家常饭菜、搪瓷杯、怀旧木窗与旧纸质感，复古红色醒目标题“回家吃饭”。`;
  }
}
if(process.argv.includes("--user-simple")) {
  if(sizeArg!=="320x70" || white || direct) throw Error("--user-simple requires transparent --target=320x70");
  finalRequest.prompt='生成一张 1280×512 的透明背景 PNG。中央是一张 1280×280 像素的完整海报，居中于画布。矩形内是一张完整的不透明“回家吃饭”复古宣传海报，暖黄灯光、中国老家饭桌、家常饭菜、搪瓷杯、怀旧木窗与旧纸质感，复古红色醒目标题“回家吃饭”。';
}
const simpleFourMargins=process.argv.includes('--simple-four-margins');
if(simpleFourMargins){
  assert(sizePlan && !white && !direct);
  const {contentWidth,contentHeight}=sizePlan;
  const align=(n:number)=>Math.ceil(n/16)*16;
  finalRequest.outputWidth=align(contentWidth+128);
  finalRequest.outputHeight=align(Math.max(contentHeight+128,finalRequest.outputWidth/3,655360/finalRequest.outputWidth));
  const left=Math.floor((finalRequest.outputWidth-contentWidth)/2),top=Math.floor((finalRequest.outputHeight-contentHeight)/2);
  Object.assign(target,{left,top,right:left+contentWidth,bottom:top+contentHeight});
  finalRequest.prompt=`生成一张透明背景 PNG。画布中央是一张 ${contentWidth}×${contentHeight} 像素的完整不透明横向复古宣传海报，四周透明。海报主题“回家吃饭”，暖黄灯光、中国老家饭桌、家常饭菜、搪瓷杯、怀旧木窗与旧纸质感，醒目的复古红色标题“回家吃饭”。`;
}
const noText=process.argv.includes('--no-text');
if(noText){
  assert(simpleFourMargins);
  finalRequest.prompt=finalRequest.prompt.replace('醒目的复古红色标题“回家吃饭”。','只有图案，不要任何文字、标题、字母或数字。');
}
const experiment=process.argv.find(a=>a.startsWith('--experiment='))?.slice(13);
if(experiment){
  assert(simpleFourMargins&&noText&&sizeArg==='320x70');
  assert(experiment==='flowers'||experiment==='ratio');
  if(experiment==='flowers')finalRequest.prompt='生成一张透明背景 PNG。画布中央是一张 1280×280 像素的完整不透明横向装饰图，四周透明。图内只有几朵横向排列的花卉图案，复古插画与旧纸质感。只有图案，不要任何文字、标题、字母或数字。';
  else finalRequest.prompt=finalRequest.prompt.replace('1280×280 像素的','宽高比为 32:7 的');
}
const nativeWide=process.argv.includes('--native-wide-probe');
if(nativeWide){
  assert(simpleFourMargins&&noText&&sizeArg==='320x70'&&!experiment);
  Object.assign(finalRequest,{outputWidth:2048,outputHeight:448,background:'opaque'});
  finalRequest.prompt='生成一张完整的横向复古插画，画面铺满整张图片，不留边。暖黄灯光、中国老家饭桌、家常饭菜、搪瓷杯、怀旧木窗与旧纸质感。只有图案，不要任何文字、标题、字母或数字。';
  Object.assign(target,{left:0,top:0,right:2048,bottom:448});
  sizePlan={width:320,height:70,scale:6.4,contentWidth:2048,contentHeight:448};
}
const routeCheck=process.argv.find(a=>a.startsWith('--route-check='))?.slice(14);
if(routeCheck){
  assert(simpleFourMargins&&!nativeWide&&!experiment);
  assert(routeCheck==='poster'||routeCheck==='asset'||routeCheck==='rabbit');
  const poster=routeCheck==='poster';
  Object.assign(finalRequest,{outputWidth:poster?1280:1024,outputHeight:poster?1088:1024,background:poster?'opaque':'transparent'});
  finalRequest.prompt=poster?'生成一张完整的“回家吃饭”复古宣传海报，画面铺满整张图片。暖黄灯光、中国老家饭桌、家常饭菜、搪瓷杯、怀旧木窗与旧纸质感，醒目的复古红色标题“回家吃饭”。':'生成透明背景 PNG 素材：一组摆放紧凑的中国家常饭菜，一碗米饭、一盘红烧肉和一小碟青菜，怀旧复古手绘插画风格，暖黄色光照。碗碟完整可见，主体尽量占满画布但不要触边，只有饭菜与碗碟，不要桌子、房间、背景、文字或外部投影。';
  Object.assign(target,{left:0,top:0,right:finalRequest.outputWidth,bottom:finalRequest.outputHeight});
  if(routeCheck==='rabbit')finalRequest.prompt='生成一张真正透明背景 PNG 素材：一只可爱的白色兔子，全身完整，包括竖起的耳朵、尾巴和脚，坐姿，身体略朝左，温柔地看向左侧。清新柔和的绘本插画，浅暖色日光从左上照亮，精致但轮廓简洁，小尺寸下也清晰。仅一只兔子，不要背景、地面、文字、装饰或外部投影，四周留少量透明空隙，不要裁掉身体。';
}
const variant=routeCheck?`route-check-${routeCheck}`:nativeWide?'native-wide-probe':experiment?`experiment-${experiment}`:noText?'simple-four-margins-no-text':simpleFourMargins?'simple-four-margins':process.argv.includes("--user-simple")?'user-simple':process.argv.includes("--numeric-only")?'numeric-only':process.argv.includes("--slight-orientation")?'slight-orientation':process.argv.includes("--shape-fill")?'shape-fill':'baseline';
const dir=`../../artifacts/small-${direct ? "direct" : white ? "white" : "transparent"}-${process.argv.includes("--banner") ? "banner" : "poster"}-${Date.now()}-${variant}`;
await mkdir(dir,{recursive:true});
await writeFile(`${dir}/request.json`,JSON.stringify(finalRequest,null,2));
if(sizePlan) await writeFile(`${dir}/plan.json`,JSON.stringify({variant,sizePlan,target},null,2));
console.log(JSON.stringify({event:"submitting",dir,model:finalRequest.model,size:`${finalRequest.outputWidth}x${finalRequest.outputHeight}`,quality:"low",maxCalls:1}));
const provider=new OpenAIImageProvider(String(secret.data),config.base_url);
if(simpleFourMargins){
  const client=(provider as any).client,realFetch=client.fetch;
  let calls=0;
  client.fetch=createSafeProviderFetch(config.base_url,{fetch:async(input,init)=>{
    assert.equal(++calls,1,'No retries');
    const encoded=new Request(input,init);
    assert(new URL(encoded.url).pathname.endsWith('/images/generations'));
    const body=await encoded.clone().json() as Record<string,unknown>;
    assert(!('image' in body)&&!('mask' in body)&&!('inputImages' in body));
    assert.equal(body.background,finalRequest.background);
    assert.equal(body.size,`${finalRequest.outputWidth}x${finalRequest.outputHeight}`);
    await writeFile(`${dir}/transport.json`,JSON.stringify({endpoint:'images/generations',calls,body},null,2));
    return realFetch(encoded);
  }});
}
let result:{url:string};
if(nativeWide){
  try{
    const response=await (provider as any).client.images.generate({model:finalRequest.model,prompt:finalRequest.prompt,size:'2048x448',quality:'low',background:'opaque',output_format:'png',n:1},{maxRetries:0});
    const item=response.data?.[0];
    assert(item?.b64_json||item?.url,'No image returned');
    result={url:item.b64_json?`data:image/png;base64,${item.b64_json}`:item.url};
  }catch(error){
    const e=error as {status?:number;code?:string;message?:string};
    const failure={event:'upstream-rejected',status:e.status,code:e.code,message:e.message,dir};
    await writeFile(`${dir}/failure.json`,JSON.stringify(failure,null,2));
    console.log(JSON.stringify(failure));process.exit(1);
  }
}else result=await provider.generate(finalRequest);
const downloaded=await safeDownload(result.url,{kind:"image",maxBytes:30*1024*1024,timeoutMs:60000,maxRedirects:2,allowDataUri:true,allowedMimeTypes:["image/png","image/webp","image/jpeg"]});
await writeFile(`${dir}/result.png`,downloaded.buffer);
const {data,info}=await sharp(downloaded.buffer).ensureAlpha().raw().toBuffer({resolveWithObject:true});
let minX=info.width,minY=info.height,maxX=-1,maxY=-1,outside=0,visible=0,transparentPixels=0;
for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++){
 const i=(y*info.width+x)*4;
 if(data[i+3]===0) transparentPixels++;
 if(data[i+3]!>8 && (!white || Math.min(data[i]!,data[i+1]!,data[i+2]!)<245)){visible++;minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);if(x<target.left||x>=target.right||y<target.top||y>=target.bottom)outside++;}
}
const report={model:request.model,sizePlan,width:info.width,height:info.height,transparentPixels,measurement:white?"nonwhite RGB below 245, alpha above 8":"alpha above 8",visibleBounds:visible?{x:minX,y:minY,width:maxX-minX+1,height:maxY-minY+1}:null,visiblePixelsOutsideTarget:outside,visiblePixels:visible};
await writeFile(`${dir}/report.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({event:"complete",dir,...report}));
