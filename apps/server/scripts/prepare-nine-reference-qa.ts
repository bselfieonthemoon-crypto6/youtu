/** Deterministic test cards, not model-generated images. Fresh QA assets only. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createClient } from '@supabase/supabase-js';
assert(process.argv.includes('--submit'));
assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:54421');
const fixtureArg = process.argv.find(x => x.startsWith('--fixture='))?.slice(10);
assert(fixtureArg);
const fixture = JSON.parse(await readFile(resolve(fixtureArg), 'utf8'));
assert(fixture.fixture?.canvasId && fixture.ownerId && fixture.workspaceId);
const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const canvas = await admin.from('canvases').select('name,created_by,workspace_id').eq('id', fixture.fixture.canvasId).single();
assert.ifError(canvas.error);
const project = await admin.from('projects').select('name').eq('id', fixture.fixture.projectId).single();
assert.ifError(project.error);
assert(project.data?.name.startsWith('QA paid dialogue ') && canvas.data?.created_by === fixture.ownerId && canvas.data.workspace_id === fixture.workspaceId);
const words = ['ALPHA','BRAVO','CHARLIE','DELTA','ECHO','FOXTROT','GOLF','HOTEL','INDIA'];
const colors = ['#d52424','#2249cc','#247b35','#dbc51d','#8332aa','#ee861d','#1aa6bb','#e46ba6','#808080'];
const attachments = [];
for (let i = 0; i < 9; i++) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="${colors[i]}"/><rect x="30" y="155" width="452" height="202" fill="white"/><text x="256" y="228" font-family="Arial" font-size="50" text-anchor="middle" fill="black">${i + 1}</text><text x="256" y="310" font-family="Arial" font-size="54" font-weight="bold" text-anchor="middle" fill="black">${words[i]}</text></svg>`;
  const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
  const path = `${fixture.workspaceId}/qa-nine/${randomUUID()}.png`;
  const uploaded = await admin.storage.from('workspace-assets').upload(path, bytes, { contentType: 'image/png' }); assert.ifError(uploaded.error);
  const asset = await admin.from('asset_objects').insert({ workspace_id: fixture.workspaceId, project_id: fixture.fixture.projectId,
    created_by: fixture.ownerId, bucket: 'workspace-assets', object_path: path, mime_type: 'image/png', byte_size: bytes.length,
  }).select('id').single(); assert.ifError(asset.error);
  const signed = await admin.storage.from('workspace-assets').createSignedUrl(path, 3600); assert.ifError(signed.error);
  attachments.push({ assetId: asset.data!.id, url: signed.data!.signedUrl, mimeType: 'image/png', name: `reference-${i + 1}.png` });
}
const path = resolve(fixtureArg + '.references.json');
await writeFile(path, JSON.stringify(attachments, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ path, count: attachments.length, assetIds: attachments.map(x => x.assetId), expectedWords: words }));
