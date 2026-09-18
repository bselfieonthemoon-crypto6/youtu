// Read-only export of explicitly scoped local jobs. Never submits inference,
// updates canvas content, or contacts a cloud image provider.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const sharp = require('sharp');
if (process.env.SUPABASE_URL !== 'http://127.0.0.1:54421') throw new Error('Local replica only');
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const ids = [
  'b968698e-81b0-4894-a862-fbfac142af04',
  '51d7f3bb-0cb3-4d81-83f8-28609c6db0ef',
];
const output = resolve('artifacts/matting-quality-20260908');
await mkdir(output, { recursive: true });
const manifest = [];
const panels = [];
for (const [index, id] of ids.entries()) {
  const { data: job, error } = await admin.from('background_jobs').select('id,canvas_id,payload,result,status').eq('id', id).single();
  if (error || job?.canvas_id !== '38d02c58-71e0-4c2c-bb08-f011b6c37ce1' || job.status !== 'succeeded') throw new Error(`Sample ${index + 1} unavailable`);
  const input = job.payload.input_images?.[0];
  if (!input?.startsWith('data:image/')) throw new Error('Expected stored inline source, not an external URL');
  const original = Buffer.from(input.slice(input.indexOf(',') + 1), 'base64');
  const sourceMeta = await sharp(original).metadata();
  const foregrounds = job.result.layers?.filter(layer => layer.kind !== 'background') ?? [{ asset_id: job.result.asset_id, x: 0, y: 0 }];
  if (!foregrounds.length) throw new Error('No foreground layers');
  const composites = [];
  for (const layer of foregrounds) {
    const { data: asset, error: ae } = await admin.from('asset_objects').select('bucket,object_path').eq('id', layer.asset_id).single();
    if (ae || !asset) throw new Error('Result asset unavailable');
    const { data: blob, error: se } = await admin.storage.from(asset.bucket).download(asset.object_path);
    if (se || !blob) throw new Error('Result bytes unavailable');
    composites.push({ input: Buffer.from(await blob.arrayBuffer()), left: layer.x ?? 0, top: layer.y ?? 0 });
  }
  const result = await sharp({ create: { width: sourceMeta.width, height: sourceMeta.height, channels: 4, background: '#00000000' } }).composite(composites).png().toBuffer();
  const stem = `sample-${index + 1}`;
  await writeFile(resolve(output, `${stem}-source.png`), await sharp(original).png().toBuffer());
  await writeFile(resolve(output, `${stem}-current.png`), result);
  const { data: rgba, info } = await sharp(result).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let transparent = 0, opaque = 0, soft = 0;
  for (let p = 3; p < rgba.length; p += 4) { if (rgba[p] <= 5) transparent++; else if (rgba[p] >= 250) opaque++; else soft++; }
  const pixels = info.width * info.height;
  const stats = { sample: stem, jobId: id, operation: job.payload.operation, sourceWidth: sourceMeta.width, sourceHeight: sourceMeta.height, outputWidth: info.width, outputHeight: info.height, sourceSha256: createHash('sha256').update(original).digest('hex'), transparentFraction: transparent / pixels, opaqueFraction: opaque / pixels, softFraction: soft / pixels };
  manifest.push(stats);
  const variants = [original, ...await Promise.all(['#ffffff', '#111111'].map(background => sharp(result).flatten({ background }).png().toBuffer()))];
  for (const [col, bytes] of variants.entries()) {
    panels.push({ input: await sharp(bytes).resize(360, 360, { fit: 'contain', background: '#e5e7eb' }).png().toBuffer(), left: col * 380 + 10, top: index * 410 + 40 });
  }
  console.log(JSON.stringify(stats));
}
await writeFile(resolve(output, 'manifest.json'), JSON.stringify({ note: 'Alpha coverage is descriptive, not an accuracy score. No hand-labelled ground truth.', samples: manifest }, null, 2));
const height = manifest.length * 410;
const labels = `<svg width="1140" height="${height}">${manifest.map((_, i) => ['Source', 'Current foreground / white', 'Current foreground / black'].map((s, j) => `<text x="${j * 380 + 12}" y="${i * 410 + 25}" font-size="16" font-family="Arial">Sample ${i + 1}: ${s}</text>`).join('')).join('')}</svg>`;
await sharp({ create: { width: 1140, height, channels: 3, background: '#e5e7eb' } }).composite([...panels, { input: Buffer.from(labels), left: 0, top: 0 }]).png().toFile(resolve(output, 'current-contact-sheet.png'));
console.log(`Read-only samples exported to ${output}`);
