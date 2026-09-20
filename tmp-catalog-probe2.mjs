import { readFile } from 'node:fs/promises';
import { decodeMigrationPayload, MIGRATION_PATH } from './scripts/build-design-skill-catalog.mjs';

const sql = await readFile(MIGRATION_PATH, 'utf8');
const rows = decodeMigrationPayload(sql);
console.log('rows in checked-in migration:', rows.length);
for (const row of rows) {
  const meta = row.manifest.metadata.loomic;
  console.log(row.manifest.slug, '| version=' + row.manifest.version, '| whenToUse=' + (meta.whenToUse !== undefined), '| routingTier=' + (meta.routing?.tier ?? '-'), '| keys=' + Object.keys(meta).join(','));
}
