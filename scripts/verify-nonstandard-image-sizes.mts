import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolveNativeImageSize } from '../packages/shared/src/native-image-size.ts';

// Historical user targets. Exercise the real resolver, never a copied formula.
const targets = [[480,112],[512,512],[656,288],[350,300],[720,96],[512,268],[719,1280],[115,115],[340,320],[1080,1920],[1440,2560],[600,800],[656,176]];
const rows = [];
for (const [width,height] of targets) {
  const ratio = width / height;
  if (ratio > 3 || ratio < 1/3) {
    assert.throws(() => resolveNativeImageSize(`${width}:${height}`), /3:1/);
    rows.push({target:`${width}×${height}`,status:'unsupported',reason:'Exceeds current 3:1 limit; no silent clamping'});
    continue;
  }
  for (const resolution of ['1k','2k','4k'] as const) {
    const result = resolveNativeImageSize(`${width}:${height}`,resolution);
    const error = Math.abs(result.width/result.height/ratio-1);
    assert.ok(error <= .01);
    assert.equal(result.width % 16,0); assert.equal(result.height % 16,0);
    assert.ok(result.width*result.height >= 655360 && result.width*result.height <= 8294400);
    rows.push({target:`${width}×${height}`,resolution,requested:result.size,ratioErrorPercent:Number((error*100).toFixed(4)),status:'ratio-compatible'});
  }
}
assert.equal(rows.filter(r=>r.status==='unsupported').length,3);
assert.equal(rows.filter(r=>r.status==='ratio-compatible').length,30);
// Standard workflow snapshots must remain unchanged.
assert.equal(resolveNativeImageSize('1:1').size,'1024x1024');
assert.equal(resolveNativeImageSize('16:9').size,'1280x720');
assert.equal(resolveNativeImageSize('16:9','4k').size,'3840x2160');
await mkdir('artifacts/nonstandard-image-size-20260915',{recursive:true});
await writeFile('artifacts/nonstandard-image-size-20260915/size-matrix.json',JSON.stringify({scope:'Local resolver only; no provider output or pixel-size guarantee',rows},null,2));
console.table(rows.filter(r=>!('resolution' in r)||r.resolution==='1k'));
console.log('PASS: 30 supported mappings, 3 explicit exclusions, 3 standard workflow snapshots.');
