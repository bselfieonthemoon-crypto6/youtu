import { createClient } from '@supabase/supabase-js';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderDesignPreviewBuffer, renderDesignExportBuffer } from '../src/features/designs/design-preview-renderer.js';
import { loadDesignFontBinaries } from '../src/features/designs/design-font-renderer.js';
import { create } from 'fontkit';
const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const out = resolve('../../artifacts/design-preview-audit-20260908');
await mkdir(out, { recursive: true });
const { data: document, error } = await admin.from('design_documents').select('*').eq('id', '4e9585ba-2f23-41d6-86aa-4fe01436511d').single();
if (error) throw new Error('read_design_failed');
await writeFile(resolve(out, 'document.json'), JSON.stringify(document, null, 2));
const ids = new Set<string>([document.preview_asset_object_id, ...document.scene.objects.map((o: any) => o.assetObjectId).filter(Boolean)]);
const assets = new Map();
for (const id of ids) {
  const { data: asset } = await admin.from('asset_objects').select('id,bucket,object_path,mime_type').eq('id', id).single();
  const { data, error } = await admin.storage.from(asset!.bucket).download(asset!.object_path);
  if (error || !data) throw new Error('asset_read_failed');
  const buffer = Buffer.from(await data.arrayBuffer());
  assets.set(id, { buffer, mimeType: asset!.mime_type });
  if (id === document.preview_asset_object_id) await writeFile(resolve(out, 'persisted-preview.webp'), buffer);
}
await loadDesignFontBinaries(admin, document.scene, document.workspace_id, assets);
for (const id of new Set<string>(document.scene.objects.map((o: any) => o.fontFaceId).filter(Boolean))) {
  const font = create(assets.get(id).buffer);
  console.log(JSON.stringify({ faceId: id, family: 'familyName' in font ? font.familyName : 'collection' }));
  if ('layout' in font) for (const object of document.scene.objects.filter((o: any) => o.fontFaceId === id)) {
    const missing = [...new Set<string>([...object.text] as string[])].filter(character => !font.hasGlyphForCodePoint(character.codePointAt(0)!));
    console.log(JSON.stringify({ objectId: object.objectId, missing: missing.map(character => ({ character: JSON.stringify(character), codePoint: `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}` })) }));
  }
}
await writeFile(resolve(out, 'bound-font-preview.webp'), await renderDesignPreviewBuffer(document.scene, assets));
await writeFile(resolve(out, 'bound-font-export.png'), await renderDesignExportBuffer(document.scene, assets, { format: 'png', multiplier: 1, transparent: false }));
console.log(JSON.stringify({ revision: document.revision, previewRevision: document.preview_revision, objects: document.scene.objects.map((o: any) => ({ id: o.objectId, type: o.type, zIndex: o.zIndex, x: o.x, y: o.y, width: o.width, height: o.height, visible: o.visible, asset: o.assetObjectId })) }));
