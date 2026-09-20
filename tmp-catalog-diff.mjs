import { readFile } from 'node:fs/promises';
import { decodeMigrationPayload, generateMigration, MIGRATION_PATH, readCatalog } from './scripts/build-design-skill-catalog.mjs';

const oldRows = decodeMigrationPayload(await readFile(MIGRATION_PATH, 'utf8'));
const data = await readCatalog();
const newRows = JSON.parse(JSON.stringify(data.rows));

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function diffPaths(a, b, prefix = '') {
  if (same(a, b)) return [];
  const both = a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b);
  if (!both) return [{ path: prefix || '(root)', old: a, next: b }];
  if (Array.isArray(a)) {
    const out = [];
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      if (index >= a.length) out.push({ path: `${prefix}[${index}]`, old: undefined, next: b[index] });
      else if (index >= b.length) out.push({ path: `${prefix}[${index}]`, old: a[index], next: undefined });
      else out.push(...diffPaths(a[index], b[index], `${prefix}[${index}]`));
    }
    return out;
  }
  const out = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in a)) out.push({ path, old: undefined, next: b[key] });
    else if (!(key in b)) out.push({ path, old: a[key], next: undefined });
    else out.push(...diffPaths(a[key], b[key], path));
  }
  return out;
}

const oldBySlug = new Map(oldRows.map(row => [row.manifest.slug, row]));
const newBySlug = new Map(newRows.map(row => [row.manifest.slug, row]));
console.log('old slugs:', [...oldBySlug.keys()].length, '| new slugs:', [...newBySlug.keys()].length);
console.log('dropped slugs:', [...oldBySlug.keys()].filter(slug => !newBySlug.has(slug)));
console.log('added slugs:', [...newBySlug.keys()].filter(slug => !oldBySlug.has(slug)));

const shrink = (value) => {
  if (typeof value !== 'string') return JSON.stringify(value);
  return value.length > 90 ? `${JSON.stringify(value.slice(0, 90))}…(${value.length} chars)` : JSON.stringify(value);
};

for (const [slug, next] of newBySlug) {
  const old = oldBySlug.get(slug);
  if (!old) { console.log(`\n== ${slug}: NEW ROW`); continue; }
  const manifestDiff = diffPaths(old.manifest, next.manifest);
  const contentChanged = old.content !== next.content;
  const filesDiff = diffPaths(old.files, next.files);
  if (!manifestDiff.length && !contentChanged && !filesDiff.length) { console.log(`\n== ${slug}: identical`); continue; }
  console.log(`\n== ${slug}: manifest paths=${manifestDiff.length} contentChanged=${contentChanged} filePaths=${filesDiff.length}`);
  for (const item of manifestDiff) console.log(`   manifest ${item.path}: ${shrink(item.old)} -> ${shrink(item.next)}`);
  if (contentChanged) console.log(`   content: ${old.content.length} chars -> ${next.content.length} chars`);
  for (const item of filesDiff) {
    const isContent = /\.content$/.test(item.path);
    console.log(`   files ${item.path}: ${isContent ? 'text-changed' : shrink(item.old)} -> ${isContent ? 'text-changed' : shrink(item.next)}`);
  }
}

const expected = generateMigration(data);
const oldSql = await readFile(MIGRATION_PATH, 'utf8');
console.log('\nold migration bytes:', Buffer.byteLength(oldSql), '| new migration bytes:', Buffer.byteLength(expected));
console.log('old payload bytes:', Buffer.byteLength(JSON.stringify(oldRows)), '| new payload bytes:', Buffer.byteLength(JSON.stringify(newRows)));
