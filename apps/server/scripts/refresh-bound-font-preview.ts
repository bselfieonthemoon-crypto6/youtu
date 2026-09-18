import { randomUUID, createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createSupabaseDesignPreviewRenderer } from '../src/features/designs/design-preview-renderer.js';
import { createSupabaseDesignPreviewRepository } from '../src/features/designs/design-preview-service.js';
import type { AdminSupabaseClient } from '../src/supabase/admin.js';
import { loadServerEnv } from '../src/config/env.js';

// Maintenance of a derived preview only. Never edit the design scene or reuse a cached asset URL.
if (process.env.SUPABASE_URL !== 'http://127.0.0.1:54421' || !process.argv.includes('--apply')) {
  throw new Error('Explicit --apply and the local replica are required.');
}
const id = process.argv.find(arg => arg.startsWith('--design='))?.slice(9);
if (!id || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Explicit design ID required.');
const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } }) as AdminSupabaseClient;
const before = await admin.from('design_documents').select('*').eq('id', id).single();
if (before.error || !before.data) throw new Error('Unable to read design.');
const document = before.data;
const actorUserId = document.updated_by ?? document.created_by;
if (!actorUserId) throw new Error('Design has no attributable actor.');
const hash = (scene: unknown) => createHash('sha256').update(JSON.stringify(scene)).digest('hex');
const out = resolve('../../artifacts/design-font-repair-20260908', `${id}-${document.revision}`);
await mkdir(out, { recursive: true });
await writeFile(resolve(out, 'before.json'), JSON.stringify(document, null, 2));
const jobId = randomUUID();
const rendered = await createSupabaseDesignPreviewRenderer().render({
  job: { id: jobId } as never, designId: id, revision: document.revision,
  requestedBy: actorUserId,
}, { env: loadServerEnv(), getAdminClient: () => admin, renewVt: async () => {} });
const result = await createSupabaseDesignPreviewRepository(() => admin).commit({
  designId: id, expectedRevision: document.revision, previewRevision: document.revision,
  previewAssetObjectId: rendered.preview_asset_object_id, idempotencyKey: jobId,
  actorUserId,
});
const after = await admin.from('design_documents').select('scene,revision,preview_revision,preview_asset_object_id').eq('id', id).single();
if (after.error || !after.data) throw new Error('Unable to verify derived preview.');
const report = { ...result, originalAsset: document.preview_asset_object_id, newAsset: rendered.preview_asset_object_id, sceneUnchanged: hash(document.scene) === hash(after.data.scene), revisionUnchanged: document.revision === after.data.revision };
await writeFile(resolve(out, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!result.committed) throw new Error('Design changed during rendering; stale preview was not applied.');
