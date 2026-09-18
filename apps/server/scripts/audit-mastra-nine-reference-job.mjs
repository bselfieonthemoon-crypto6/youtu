// Read-only verification of the already-submitted real nine-reference QA job.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:54421');
const root = resolve('../..');
const evidence = JSON.parse(await readFile(resolve(root, 'artifacts/paid-dialogue-live/browser-turns/2026-09-13T08-24-38-153Z.json'), 'utf8'));
const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const result = await client.from('background_jobs').select('id,status,payload,result,error_code')
  .eq('id', '563b4819-393d-4900-8d24-9792e13d86b2').eq('session_id', evidence.sessionId).single();
assert.ifError(result.error);
const job = result.data;
const tools = await client.from('tool_executions').select('tool_name,output').eq('run_id', evidence.runId);
assert.ifError(tools.error);
const source = tools.data.find(t => t.output?.jobId === job.id)?.output?.sourceAssetIds;
assert.deepEqual(source, evidence.request.attachments.map(a => a.assetId), 'Actual tool source IDs must equal nine UI uploads in order');
const files = (await readdir(resolve(root, 'artifacts/qa-multi-reference-20260913/cards'))).filter(f => f.endsWith('.png')).sort();
assert.equal(job.payload.input_images.length, 9);
const comparisons = [];
for (let index = 0; index < 9; index++) {
  const data = job.payload.input_images[index];
  assert.match(data, /^data:image\/[^;]+;base64,/);
  const bytes = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
  const local = await readFile(resolve(root, 'artifacts/qa-multi-reference-20260913/cards', files[index]));
  const sample = async buffer => [...await sharp(buffer).removeAlpha().extract({ left: 10, top: 10, width: 1, height: 1 }).raw().toBuffer()];
  const actual = await sample(bytes), expected = await sample(local);
  assert(actual.every((v, c) => Math.abs(v - expected[c]) <= 8), `Reference ${index + 1} color/order changed`);
  comparisons.push({ index: index + 1, name: files[index], sha256: createHash('sha256').update(bytes).digest('hex'), actual, expected });
}
const report = { runId: evidence.runId, jobId: job.id, status: job.status, errorCode: job.error_code,
  orderedAssetsMatch: true, count: 9, comparisons, model: job.payload.model,
  width: job.result?.width, height: job.result?.height,
  note: 'Real UI run continued after harness assertion failure; this audit never resubmits it.' };
const output = resolve(root, 'artifacts/qa-multi-reference-20260913/real-job-audit.json');
await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
