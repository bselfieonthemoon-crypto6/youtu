import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const path = 'supabase/migrations/20260909000013_skill_library_composition.sql';
const buffer = await readFile(path);
const sql = buffer.toString('utf8');
console.log('bytes:', buffer.byteLength, '| CRLF count:', (sql.match(/\r\n/g) ?? []).length, '| LF count:', (sql.match(/\n/g) ?? []).length);
const header = /^-- Content SHA256: ([0-9a-f]{64})$/m.exec(sql);
console.log('header hash:', header?.[1]);
const match = /entries jsonb := (\$design_catalog_[0-9a-f]{16}\$)([\s\S]*?)\1::jsonb;/.exec(sql);
console.log('payload match:', Boolean(match), '| delimiter:', match?.[1]);
if (match) {
  const hash = createHash('sha256').update(match[2]).digest('hex');
  console.log('payload hash:', hash, '| matches header:', hash === header?.[1]);
  console.log('payload chars:', match[2].length);
  const parsed = JSON.parse(match[2]);
  console.log('entries:', parsed.length);
  for (const row of parsed) {
    const meta = row.manifest.metadata.loomic;
    console.log(' ', row.manifest.slug, '| v=' + row.manifest.version, '| whenToUse=' + (meta.whenToUse !== undefined), '| tier=' + (meta.routing?.tier ?? '-'));
  }
}
