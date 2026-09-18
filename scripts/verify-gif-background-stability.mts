import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {exportAnimatedDesignGifInBrowser} from '../apps/web/src/lib/design-animated-gif-export.ts';
const webRequire=createRequire(`${process.cwd()}/apps/web/package.json`);
const serverRequire=createRequire(`${process.cwd()}/apps/server/package.json`);
const sharp=serverRequire('sharp');
const {GIFEncoder,quantize,applyPalette}=webRequire('gifenc');
const dir='artifacts/gif-stability-20260915';await mkdir(dir,{recursive:true});
const source='artifacts/semantic-layers-20260915';
const background=await sharp(`${source}/layer-0-background.png`).resize(656,288).png().toBuffer();
const foreground=await sharp(`${source}/layer-1-element.png`).resize(180,260).png().toBuffer();
const scene:any={canvas:{width:656,height:288,background:'#ffffff'},objects:[{objectId:'test-sprite',type:'image',visible:true,opacity:1,x:40,y:12,width:180,height:260,animation:{type:'float',durationMs:1000,amount:8}}]};
const frames=new Map<number,Uint8ClampedArray>();
const renderFrame=async (_scene:any,size:any)=>{
  let data=frames.get(size.timeMs);
  if(!data){const top=12+Math.round(8*Math.sin(size.timeMs/1000*Math.PI*2));
    const bytes=await sharp(background).composite([{input:foreground,left:40,top}]).ensureAlpha().raw().toBuffer();
    data=new Uint8ClampedArray(bytes);frames.set(size.timeMs,data);
  }
  return {width:656,height:288,data} as ImageData;
};
let fixed:Uint8Array|undefined;
await exportAnimatedDesignGifInBrowser({name:'fixed-background',scene},{waitForFonts:async()=>{},waitForImages:async()=>({missingAssetObjectIds:[]}),renderFrame},
 {createObjectURL:()=> 'test:gif',revokeObjectURL:()=>{},clickDownload:()=>{},scheduleRevoke:fn=>fn(),yieldToBrowser:async()=>{},createGifBlob:bytes=>{fixed=Uint8Array.from(bytes);return new Blob();}});
assert(fixed);await writeFile(`${dir}/fixed.gif`,fixed);
const old=GIFEncoder();
for(const data of frames.values()){
 const palette=quantize(data,256,{format:'rgba4444',oneBitAlpha:true});
 old.writeFrame(applyPalette(data,palette,'rgba4444'),656,288,{palette,delay:80,repeat:0,dispose:2});
}
old.finish();await writeFile(`${dir}/before.gif`,old.bytes());
console.log(JSON.stringify({frames:frames.size,fixedBytes:fixed.length,source:'Existing real split assets; no model calls or design changes'}));
