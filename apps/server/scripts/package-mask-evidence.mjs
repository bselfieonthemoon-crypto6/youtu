import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const base='../../artifacts/';
const target=base+'apiyi-mask-support-20260914';
const cases=[['flare-low','repaint-probe-gpt-image-2.5-flare-1789385395652','low'],['sunburst-low','repaint-probe-gpt-image-2.5-sunburst-1789385438917','low'],['sunburst-high','repaint-probe-gpt-image-2.5-sunburst-1789386100335','high']];
const sums={};
for(const [name,dir,quality] of cases){
 await mkdir(`${target}/${name}`,{recursive:true});
 for(const f of ['source.png','mask.png','provider-original.png']){
  await copyFile(`${base}${dir}/${f}`,`${target}/${name}/${f}`);
  sums[`${name}/${f}`]=createHash('sha256').update(await readFile(`${target}/${name}/${f}`)).digest('hex');
 }
 const req=JSON.parse(await readFile(`${base}${dir}/request.json`,'utf8'));
 const params={model:req.model,prompt:req.prompt,size:'1280x544',quality,n:1,background:'opaque',output_format:'png'};
 await writeFile(`${target}/${name}/parameters.json`,JSON.stringify(params,null,2));
 await writeFile(`${target}/${name}/prompt.txt`,req.prompt);
 if(name==='sunburst-high')await copyFile(`${base}${dir}/transport.json`,`${target}/${name}/transport.json`);
}
await writeFile(`${target}/SHA256SUMS.json`,JSON.stringify(sums,null,2));
console.log(JSON.stringify({cases:cases.length,images:Object.keys(sums).length,target}));
