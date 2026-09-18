import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MIGRATION_PATH = 'supabase/migrations/20260909000013_skill_library_composition.sql';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOOL = /^[a-z][a-z0-9_]*$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function keys(value, expected, label) {
  if (!object(value)) fail(`${label}: expected object`);
  for (const key of Object.keys(value)) if (!expected.includes(key)) fail(`${label}: unknown field ${key}`);
  for (const key of expected) if (!(key in value)) fail(`${label}: missing field ${key}`);
}
function strings(value, label, { minimum = 0, pattern } = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 100) fail(`${label}: invalid array`);
  if (value.some(item => typeof item !== 'string' || !item.trim() || item.length > 2000 || (pattern && !pattern.test(item)))) fail(`${label}: invalid string`);
  if (new Set(value).size !== value.length) fail(`${label}: duplicate value`);
}
function text(value, label, maximum = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) fail(`${label}: invalid text`);
}

export function validateManifest(manifest, expectedSlug, bundle) {
  keys(manifest, ['slug', 'name', 'description', 'version', 'category', 'iconName', 'license', 'metadata'], expectedSlug);
  if (manifest.slug !== expectedSlug || !SLUG.test(manifest.slug) || manifest.slug.length > 63) fail(`${expectedSlug}: slug mismatch`);
  for (const key of ['name', 'description', 'iconName']) text(manifest[key], `${expectedSlug}.${key}`);
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) fail(`${expectedSlug}: invalid version`);
  if (!['design', 'generation', 'code', 'data', 'writing', 'custom'].includes(manifest.category)) fail(`${expectedSlug}: invalid category`);
  if (manifest.license !== null) text(manifest.license, `${expectedSlug}.license`);
  keys(manifest.metadata, ['bundle', 'loomic'], `${expectedSlug}.metadata`);
  if (manifest.metadata.bundle !== bundle) fail(`${expectedSlug}: bundle mismatch`);
  const meta = manifest.metadata.loomic;
  keys(meta, ['schemaVersion', 'execution', 'intents', 'outputKinds', 'requiredTools', 'optionalTools', 'models', 'limitations', 'examples', 'sources',
    ...('composition' in meta ? ['composition'] : []), ...('capabilities' in meta ? ['capabilities'] : []),
    ...('attachWorkspaceLibrary' in meta ? ['attachWorkspaceLibrary'] : []), ...('routing' in meta ? ['routing'] : [])], `${expectedSlug}.loomic`);
  if (meta.capabilities !== undefined) strings(meta.capabilities, `${expectedSlug}.capabilities`, { minimum: 1, pattern: /^[a-z][a-z0-9-]*$/ });
  if (meta.attachWorkspaceLibrary !== undefined && typeof meta.attachWorkspaceLibrary !== 'boolean') fail(`${expectedSlug}: attachWorkspaceLibrary must be a boolean`);
  if (meta.routing !== undefined) {
    keys(meta.routing, ['keywords', 'priority'], `${expectedSlug}.routing`);
    strings(meta.routing.keywords, `${expectedSlug}.routing.keywords`, { minimum: 1 });
    if (!Number.isInteger(meta.routing.priority) || meta.routing.priority < 0 || meta.routing.priority > 1000) fail(`${expectedSlug}: invalid routing priority`);
  }
  if (meta.composition) {
    keys(meta.composition, ['role', 'stages'], `${expectedSlug}.composition`);
    if (!['domain', 'workflow', 'reference', 'prompt', 'constraint'].includes(meta.composition.role)) fail(`${expectedSlug}: invalid composition role`);
    strings(meta.composition.stages, `${expectedSlug}.composition.stages`, { minimum: 1 });
    if (meta.composition.stages.some(stage => !['design', 'reference', 'prompt', 'review', 'delivery'].includes(stage))) fail(`${expectedSlug}: invalid composition stage`);
  }
  if (meta.schemaVersion !== 1 || !['native', 'image', 'hybrid', 'guidance'].includes(meta.execution)) fail(`${expectedSlug}: invalid execution schema`);
  for (const key of ['intents', 'outputKinds', 'limitations', 'examples']) strings(meta[key], `${expectedSlug}.${key}`, { minimum: 1 });
  for (const key of ['requiredTools', 'optionalTools']) strings(meta[key], `${expectedSlug}.${key}`, { pattern: TOOL });
  if (meta.requiredTools.some(tool => meta.optionalTools.includes(tool))) fail(`${expectedSlug}: tool cannot be both required and optional`);
  if (!Array.isArray(meta.models) || !meta.models.length) fail(`${expectedSlug}: missing model roles`);
  const roles = new Set();
  for (const model of meta.models) {
    keys(model, ['role', 'required', 'preferredIds', ...('exactIds' in model ? ['exactIds'] : [])], `${expectedSlug}.model`);
    if (!['planner', 'vision', 'image'].includes(model.role) || roles.has(model.role)) fail(`${expectedSlug}: invalid or duplicate model role`);
    roles.add(model.role);
    if (typeof model.required !== 'boolean') fail(`${expectedSlug}: invalid model requirement`);
    strings(model.preferredIds, `${expectedSlug}.preferredIds`);
    if (model.exactIds) strings(model.exactIds, `${expectedSlug}.exactIds`, { minimum: 1 });
  }
  if (!Array.isArray(meta.sources) || meta.sources.length > 30) fail(`${expectedSlug}: invalid sources`);
  for (const source of meta.sources) {
    keys(source, ['title', 'url', 'relation', ...('license' in source ? ['license'] : [])], `${expectedSlug}.source`);
    text(source.title, `${expectedSlug}.source.title`);
    let url;
    try { url = new URL(source.url); } catch { fail(`${expectedSlug}: invalid source URL`); }
    if (url.protocol !== 'https:' || url.username || url.password) fail(`${expectedSlug}: unsafe source URL`);
    if (!['inspired-by', 'adapted-from'].includes(source.relation)) fail(`${expectedSlug}: invalid source relation`);
    if (source.license !== undefined) text(source.license, `${expectedSlug}.source.license`);
    if (source.relation === 'adapted-from' && (!source.license || !manifest.license)) fail(`${expectedSlug}: adapted source needs an explicit package license`);
  }
  return manifest;
}

async function safeText(root, relative) {
  if (relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(relative)) fail(`Unsafe package path: ${relative}`);
  const absolute = path.resolve(root, relative);
  const relation = path.relative(root, absolute);
  if (relation.startsWith('..') || path.isAbsolute(relation)) fail(`Package path escapes root: ${relative}`);
  // Reject links on every component, not just the final file.
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) fail(`Symlink not allowed in package: ${relative}`);
  }
  if (!(await lstat(absolute)).isFile()) fail(`Expected regular file: ${relative}`);
  const content = (await readFile(absolute, 'utf8')).replace(/\r\n/g, '\n');
  if (Buffer.byteLength(content) > 128_000 || content.includes('\0')) fail(`Invalid or oversized text: ${relative}`);
  return content;
}

// Image references are stored as base64 text (the skill package model is text
// only). They ship for preview/reference; the agent snapshot skips them.
const IMAGE_MIME_BY_EXTENSION = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'],
]);
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const imageMime = name => IMAGE_MIME_BY_EXTENSION.get(name.slice(name.lastIndexOf('.')).toLowerCase());
const isImageFile = name => imageMime(name) !== undefined;

async function referencePaths(directory, relative = 'references') {
  let entries;
  try { entries = await readdir(path.join(directory, relative), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT' && relative === 'references') return []; throw error; }
  if ((await lstat(path.join(directory, relative))).isSymbolicLink()) fail(`Symlink references: ${directory}`);
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const file = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) fail(`Symlink reference: ${file}`);
    if (entry.isDirectory()) files.push(...await referencePaths(directory, file));
    else if (entry.isFile() && /\.(md|txt|json)$/.test(entry.name)) files.push(file);
    else if (entry.isFile() && isImageFile(entry.name)) files.push(file);
    else fail(`Only reference text or image files are registered: ${file}`);
  }
  return files;
}

async function safeImage(root, relative) {
  if (relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(relative)) fail(`Unsafe package path: ${relative}`);
  const absolute = path.resolve(root, relative);
  const relation = path.relative(root, absolute);
  if (relation.startsWith('..') || path.isAbsolute(relation)) fail(`Package path escapes root: ${relative}`);
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) fail(`Symlink not allowed in package: ${relative}`);
  }
  if (!(await lstat(absolute)).isFile()) fail(`Expected regular file: ${relative}`);
  const data = await readFile(absolute);
  if (data.byteLength > MAX_IMAGE_BYTES) fail(`Oversized image reference: ${relative}`);
  return data.toString('base64');
}

export function validateReferences(content, fromPath, available) {
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim();
    if (/^https:\/\//.test(raw) || raw.startsWith('#')) continue;
    let target;
    try { target = decodeURIComponent(raw.split('#')[0]); } catch { fail(`Invalid reference encoding in ${fromPath}`); }
    if (!target || target.includes('\\') || target.startsWith('/') || /^[a-z]+:/i.test(target) || target.split('/').includes('..')) fail(`Unsafe reference in ${fromPath}: ${raw}`);
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), target));
    if (!available.has(resolved)) fail(`Missing bundled reference from ${fromPath}: ${resolved}`);
  }
}

export async function readCatalog(repositoryRoot = REPOSITORY_ROOT) {
  const skillRoot = path.join(await realpath(repositoryRoot), 'skills');
  if ((await lstat(skillRoot)).isSymbolicLink()) fail('Skill root must not be a symlink');
  const catalog = JSON.parse(await safeText(skillRoot, 'catalog.json'));
  keys(catalog, ['schemaVersion', 'bundle', 'skills'], 'catalog');
  if (catalog.schemaVersion !== 1) fail('Unsupported catalog schema');
  text(catalog.bundle, 'catalog.bundle', 100);
  if (!SLUG.test(catalog.bundle)) fail('Invalid catalog bundle');
  strings(catalog.skills, 'catalog.skills', { minimum: 1, pattern: SLUG });
  const rows = [];
  for (const slug of [...catalog.skills].sort()) {
    if (slug.length > 63) fail(`Invalid slug: ${slug}`);
    const manifest = validateManifest(JSON.parse(await safeText(skillRoot, `${slug}/manifest.json`)), slug, catalog.bundle);
    const content = await safeText(skillRoot, `${slug}/SKILL.md`);
    const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content)?.[1];
    if (!frontmatter) fail(`${slug}: missing frontmatter`);
    const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
    const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
    if (name !== slug || description !== manifest.description) fail(`${slug}: frontmatter/manifest mismatch`);
    if (!content.includes(`version: "${manifest.version}"`)) fail(`${slug}: content version mismatch`);
    const files = [];
    for (const file_path of await referencePaths(path.join(skillRoot, slug))) {
      const mime = imageMime(file_path);
      files.push(mime
        ? { file_path, content: await safeImage(skillRoot, `${slug}/${file_path}`), mime_type: mime }
        : { file_path, content: await safeText(skillRoot, `${slug}/${file_path}`), mime_type: file_path.endsWith('.json') ? 'application/json' : 'text/markdown' });
    }
    const available = new Set(['SKILL.md', ...files.map(file => file.file_path)]);
    validateReferences(content, 'SKILL.md', available);
    for (const file of files) validateReferences(file.content, file.file_path, available);
    rows.push({ manifest, content, files });
  }
  return { catalog, rows };
}

export function generateMigration({ catalog, rows }) {
  const payload = JSON.stringify(rows);
  const hash = sha256(payload);
  const delimiter = `$design_catalog_${hash.slice(0, 16)}$`;
  if (payload.includes(delimiter) || payload.includes('$design_catalog_migration$')) fail('SQL dollar delimiter collision');
  return `-- Generated by scripts/build-design-skill-catalog.mjs; do not hand-edit.\n-- Bundle: ${catalog.bundle}\n-- Content SHA256: ${hash}\n-- Catalog-listed system skills with no creator are upserted.\n-- System skills of this bundle that left the catalog are deleted (installs cascade).\n-- Other system skills, user skills, toggles and unrelated files are untouched.\nDO $design_catalog_migration$\nDECLARE\n  entries jsonb := ${delimiter}${payload}${delimiter}::jsonb;\n  entry jsonb;\n  file_entry jsonb;\n  target_id uuid;\nBEGIN\n  -- Lock existing rows before ownership checks. A competing slug INSERT is\n  -- checked again by the guarded UPSERT below, so it cannot grant ownership.\n  PERFORM 1 FROM public.skills AS s\n    WHERE s.slug IN (SELECT item->'manifest'->>'slug' FROM jsonb_array_elements(entries) AS item)\n    ORDER BY s.slug FOR UPDATE;\n  IF EXISTS (\n    SELECT 1 FROM public.skills AS s\n    WHERE s.slug IN (SELECT item->'manifest'->>'slug' FROM jsonb_array_elements(entries) AS item)\n      AND (s.source IS DISTINCT FROM 'system' OR s.created_by IS NOT NULL)\n  ) THEN\n    RAISE EXCEPTION 'Design skill catalog conflicts with a non-owned skill; nothing was changed';\n  END IF;\n\n  FOR entry IN SELECT value FROM jsonb_array_elements(entries) LOOP\n    target_id := NULL;\n    INSERT INTO public.skills AS owned (slug, name, description, author, version, license, category, icon_name, source, skill_content, metadata, is_featured)\n    VALUES (entry->'manifest'->>'slug', entry->'manifest'->>'name', entry->'manifest'->>'description', 'Loomic',\n      entry->'manifest'->>'version', entry->'manifest'->>'license', entry->'manifest'->>'category',\n      entry->'manifest'->>'iconName', 'system', entry->>'content', entry->'manifest'->'metadata', true)\n    ON CONFLICT (slug) DO UPDATE SET\n      name = EXCLUDED.name, description = EXCLUDED.description, author = EXCLUDED.author,\n      version = EXCLUDED.version, license = EXCLUDED.license, category = EXCLUDED.category,\n      icon_name = EXCLUDED.icon_name, skill_content = EXCLUDED.skill_content,\n      metadata = COALESCE(owned.metadata, '{}'::jsonb) || EXCLUDED.metadata, updated_at = now()\n    WHERE owned.source = 'system' AND owned.created_by IS NULL\n    RETURNING id INTO target_id;\n    IF target_id IS NULL THEN\n      RAISE EXCEPTION 'Design skill ownership changed concurrently; nothing was changed';\n    END IF;\n    FOR file_entry IN SELECT value FROM jsonb_array_elements(entry->'files') LOOP\n      INSERT INTO public.skill_files (skill_id, file_path, content, mime_type)\n      VALUES (target_id, file_entry->>'file_path', file_entry->>'content', file_entry->>'mime_type')\n      ON CONFLICT (skill_id, file_path) DO UPDATE SET\n        content = EXCLUDED.content, mime_type = EXCLUDED.mime_type, updated_at = now();\n    END LOOP;\n  END LOOP;\n  DELETE FROM public.skills AS removed\n    WHERE removed.source = 'system' AND removed.created_by IS NULL\n      AND removed.metadata->>'bundle' = '${catalog.bundle}'\n      AND removed.slug NOT IN (SELECT item->'manifest'->>'slug' FROM jsonb_array_elements(entries) AS item);\nEND;\n$design_catalog_migration$;\n`;
}

export function decodeMigrationPayload(migration) {
  const match = /entries jsonb := (\$design_catalog_[0-9a-f]{16}\$)([\s\S]*?)\1::jsonb;/.exec(migration);
  if (!match) fail('Missing generated migration payload');
  const payload = JSON.parse(match[2]);
  const hash = sha256(match[2]);
  if (!migration.includes(`-- Content SHA256: ${hash}\n`)) fail('Migration payload checksum mismatch');
  return payload;
}

export async function checkCatalog(repositoryRoot = REPOSITORY_ROOT) {
  const data = await readCatalog(repositoryRoot);
  const expected = generateMigration(data);
  const actual = await readFile(path.join(repositoryRoot, MIGRATION_PATH), 'utf8');
  decodeMigrationPayload(actual);
  if (actual.replace(/\r\n/g, '\n') !== expected) fail('Generated migration is stale; run node scripts/build-design-skill-catalog.mjs --write');
  return data;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !['--check', '--write'].includes(args[0]))) fail('Usage: node scripts/build-design-skill-catalog.mjs [--check|--write]');
  const data = args[0] === '--write' ? await readCatalog() : await checkCatalog();
  if (args[0] === '--write') await writeFile(path.join(REPOSITORY_ROOT, MIGRATION_PATH), generateMigration(data), 'utf8');
  console.log(`${args[0] === '--write' ? 'Generated' : 'Verified'} ${data.rows.length} skills and ${data.rows.reduce((n, row) => n + row.files.length, 0)} reference files; no database connection used.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
