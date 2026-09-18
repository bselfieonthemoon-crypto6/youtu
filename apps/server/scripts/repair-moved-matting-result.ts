// Repair only the reported completed job. Never calls the generation provider.
import { Client } from 'pg';
if (process.env.SUPABASE_URL !== 'http://127.0.0.1:54421') throw Error('Local only');
const db = new Client({ connectionString: process.env.SUPABASE_DB_URL });
await db.connect();
try {
  await db.query('begin');
  const canvasId = '38d02c58-71e0-4c2c-bb08-f011b6c37ce1';
  const jobId = '8c399717-4b06-4161-834a-f7b89d569d9a';
  const job = (await db.query('select status,result,payload from background_jobs where id=$1 and canvas_id=$2', [jobId, canvasId])).rows[0];
  if (job?.status !== 'succeeded') throw Error('Job is not completed');
  const row = (await db.query('select content from canvases where id=$1 for update', [canvasId])).rows[0];
  const content = row.content;
  const placeholder = content.elements.find((e: any) => e.id === job.payload.target.element_id);
  const image = content.elements.find((e: any) => e.id === job.result.canvas_element_id);
  if (!placeholder || placeholder.customData?.jobId !== jobId || !image || image.customData?.sourceJobId !== jobId || image.isDeleted) throw Error('Target identity changed');
  if (placeholder.isDeleted) { console.log('Already repaired; no changes.'); await db.query('rollback'); }
  else {
    // Do not overwrite a result the user has since moved/edited independently.
    const independentlyMoved = image.x !== job.payload.target.placement.x || image.y !== job.payload.target.placement.y;
    if (!independentlyMoved) {
      for (const key of ['x', 'y', 'width', 'height', 'angle', 'frameId', 'groupIds']) if (placeholder[key] !== undefined) image[key] = placeholder[key];
      image.version = Number(image.version ?? 1) + 1;
      image.versionNonce = Math.floor(Math.random() * 2000000000);
      image.updated = Date.now();
    }
    placeholder.isDeleted = true;
    placeholder.version = Number(placeholder.version ?? 1) + 1;
    placeholder.versionNonce = Math.floor(Math.random() * 2000000000);
    placeholder.updated = Date.now();
    await db.query('update canvases set content=$1::jsonb,revision=revision+1,updated_at=now() where id=$2', [JSON.stringify(content), canvasId]);
    await db.query('commit');
    console.log(JSON.stringify({ jobId, imageId: image.id, x: image.x, y: image.y, preservedUserPlacement: independentlyMoved, removedPlaceholder: placeholder.id, providerCalls: 0 }));
  }
} catch (error) { await db.query('rollback'); throw error; }
finally { await db.end(); }
