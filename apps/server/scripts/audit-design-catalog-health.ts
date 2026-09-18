// Read-only catalog audit. Does not publish, mutate or delete resources.
import { createClient } from '@supabase/supabase-js';
import { Client } from 'pg';
import { create, type Font } from 'fontkit';
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import { loomicSceneV1Schema, designTextPresetContentSchema } from '@loomic/shared';
import { renderBoundText, splitDesignTextLines } from '../src/features/designs/design-font-renderer.js';
import { renderDesignPreviewBuffer } from '../src/features/designs/design-preview-renderer.js';

if (process.env.SUPABASE_URL !== 'http://127.0.0.1:54421') throw Error('Local replica only');
const db = new Client({ connectionString: process.env.SUPABASE_DB_URL });
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const report: any = { counts: {}, issues: [], samples: [], checkedAt: new Date().toISOString() };
await db.connect();
await db.query('begin read only');
try {
  const workspace = (await db.query("select workspace_id from design_documents where id=$1", ['4e9585ba-2f23-41d6-86aa-4fe01436511d'])).rows[0].workspace_id;
  const read = async (table: string) => (await db.query(`select * from ${table} where deleted_at is null and ((scope='platform' and status='published') or (scope='workspace' and workspace_id=$1)) order by id`, [workspace])).rows;
  const templates = await read('design_templates'), presets = await read('text_presets'), resources = await read('design_resources'), faces = await read('font_faces');
  report.counts = { templates: templates.length, textPresets: presets.length, resources: resources.length, fonts: faces.length };
  const references = new Map<string, string[]>();
  const ref = (id: string | undefined, source: string) => { if (id) references.set(id, [...(references.get(id) ?? []), source]); };
  for (const resource of resources) { ref(resource.asset_object_id, `resource:${resource.id}`); ref(resource.preview_asset_object_id, `resource-preview:${resource.id}`); }
  for (const face of faces) ref(face.asset_object_id, `font:${face.id}`);
  for (const template of templates) ref(template.preview_asset_object_id, `template-preview:${template.id}`);
  for (const preset of presets) ref(preset.preview_asset_object_id, `text-preview:${preset.id}`);
  for (const row of [...templates, ...presets]) for (const object of (row.scene ?? row.style)?.objects ?? []) ref(object.assetObjectId, `scene:${row.id}:${object.objectId}`);
  const assets = (await db.query(`select a.id,a.bucket,a.object_path,a.mime_type,a.byte_size,a.deletion_pending_at,s.id as stored from asset_objects a left join storage.objects s on s.bucket_id=a.bucket and s.name=a.object_path where a.id=any($1::uuid[])`, [[...references.keys()]])).rows;
  const assetMap = new Map(assets.map(a => [a.id, a]));
  for (const [id, sources] of references) {
    const asset = assetMap.get(id);
    if (!asset || !asset.stored || asset.deletion_pending_at) report.issues.push({ kind: 'missing_storage_reference', id, sources });
  }
  report.counts.referencedAssets = references.size;
  const download = async (id: string) => {
    const asset = assetMap.get(id);
    if (!asset) throw Error('missing_asset_metadata');
    const result = await admin.storage.from(asset.bucket).download(asset.object_path);
    if (result.error || !result.data) throw Error('storage_download_failed');
    return Buffer.from(await result.data.arrayBuffer());
  };
  const fonts = new Map<string, Font>();
  const fontBytes = new Map<string, { buffer: Buffer; mimeType: string }>();
  for (const face of faces) {
    try {
      const bytes = await download(face.asset_object_id);
      const font = create(bytes);
      if (!('layout' in font)) throw Error('font_collection');
      fonts.set(face.id, font);
      fontBytes.set(face.id, { buffer: bytes, mimeType: 'application/font' });
      if (!face.allow_web_embed) report.issues.push({ kind: 'font_not_embeddable', id: face.id });
    } catch (error) { report.issues.push({ kind: 'font_decode', id: face.id, error: String(error) }); }
  }
  let textObjects = 0;
  for (const [kind, rows, schema, field] of [['template', templates, loomicSceneV1Schema, 'scene'], ['text', presets, designTextPresetContentSchema, 'style']] as const) {
    for (const row of rows) {
      const result = schema.safeParse(row[field]);
      if (!result.success) { report.issues.push({ kind: 'schema', collection: kind, id: row.id, issues: result.error.issues }); continue; }
      for (const object of result.data.objects) {
        if (object.type !== 'text' && object.type !== 'textbox') continue;
        textObjects++;
        if (!object.fontFaceId) { report.issues.push({ kind: 'unbound_font', collection: kind, id: row.id, objectId: object.objectId, family: object.fontFamily }); continue; }
        const font = fonts.get(object.fontFaceId);
        if (!font) { report.issues.push({ kind: 'unavailable_font', collection: kind, id: row.id, faceId: object.fontFaceId }); continue; }
        try { renderBoundText(object, font, 'fill="black"'); }
        catch (error) {
          const missing = [...new Set(splitDesignTextLines(object.text).flatMap(line => font.layout(line).glyphs.filter(glyph => glyph.id === 0).flatMap(glyph => glyph.codePoints)))];
          report.issues.push({ kind: 'text_render', collection: kind, id: row.id, name: row.name, objectId: object.objectId, missing: missing.map(code => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`), error: String(error) });
        }
      }
    }
  }
  report.counts.textObjects = textObjects;
  if (process.argv.includes('--full-preview')) {
    report.fullPreviews = { passed: 0, failed: 0 };
    for (const template of templates) {
      try {
        const binaries = new Map(fontBytes);
        for (const id of new Set<string>(template.scene.objects.map((object: any) => object.assetObjectId).filter(Boolean))) {
          binaries.set(id, { buffer: await download(id), mimeType: assetMap.get(id)?.mime_type ?? 'application/octet-stream' });
        }
        await renderDesignPreviewBuffer(template.scene, binaries);
        report.fullPreviews.passed++;
      } catch (error) {
        report.fullPreviews.failed++;
        report.issues.push({ kind: 'full_preview', id: template.id, name: template.name, error: String(error) });
      }
    }
    console.log('FULL_PREVIEWS', JSON.stringify(report.fullPreviews));
  }
  // Evenly distributed binary samples for every resource kind; no full image-library download.
  for (const kind of new Set(resources.map(r => r.kind))) {
    const group = resources.filter(r => r.kind === kind);
    const samples = group.filter((_, i) => i % Math.max(1, Math.floor(group.length / 24)) === 0).slice(0, 24);
    for (const resource of samples) {
      try {
        const bytes = await download(resource.asset_object_id);
        const metadata = await sharp(bytes).metadata();
        if (!metadata.width || !metadata.height) throw Error('missing_dimensions');
        report.samples.push({ id: resource.id, kind, width: metadata.width, height: metadata.height });
      } catch (error) { report.issues.push({ kind: 'resource_decode', id: resource.id, name: resource.name, error: String(error) }); }
    }
  }
  // Verify the real user's API sees the same catalog and every cursor terminates.
  const auth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const account = await admin.auth.admin.getUserById('541006fa-d2a1-4305-be55-b6263c27a1e3');
  const link = await admin.auth.admin.generateLink({ type: 'magiclink', email: account.data.user!.email! });
  if (link.error) throw link.error;
  const login = await auth.auth.verifyOtp({ type: 'magiclink', token_hash: link.data.properties.hashed_token });
  if (login.error) throw login.error;
  try {
    const headers = { Authorization: `Bearer ${login.data.session!.access_token}` };
    report.apiCounts = {};
    for (const collection of ['resources', 'templates', 'text-presets', 'fonts']) {
      let cursor: string | undefined;
      const seen = new Set<string>(), cursors = new Set<string>();
      do {
        const response = await fetch(`http://127.0.0.1:3002/api/design-${collection}?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers, signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw Error(`catalog_api_${collection}_${response.status}`);
        const body: any = await response.json();
        for (const item of body.items) {
          const id = item.id ?? item.family?.id;
          if (seen.has(id)) report.issues.push({ kind: 'pagination_duplicate', collection, id });
          seen.add(id);
        }
        cursor = body.next_cursor ?? undefined;
        if (cursor && cursors.has(cursor)) throw Error('repeated_cursor');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      report.apiCounts[collection] = seen.size;
    }
    for (const face of faces) {
      const response = await fetch(`http://127.0.0.1:3002/api/design-fonts/faces/${face.id}/content`, { headers, signal: AbortSignal.timeout(15000) });
      if (!response.ok) report.issues.push({ kind: 'font_user_access', id: face.id, status: response.status });
      await response.arrayBuffer();
    }
  } finally { await auth.auth.signOut({ scope: 'local' }); }
} finally {
  await db.query('rollback');
  await db.end();
  await writeFile('../../artifacts/design-catalog-health-20260908.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ counts: report.counts, apiCounts: report.apiCounts, sampledBinaries: report.samples.length, issueCounts: report.issues.reduce((counts: any, item: any) => ({ ...counts, [item.kind]: (counts[item.kind] ?? 0) + 1 }), {}) }));
}
