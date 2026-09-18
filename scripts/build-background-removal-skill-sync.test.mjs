import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { BACKGROUND_REMOVAL_SLUG, MIGRATION_PATH, REPOSITORY_ROOT, checkBackgroundRemovalSync, decodeMigrationPayload, generateMigration, readBackgroundRemovalPackage } from './build-background-removal-skill-sync.mjs';

test('additive sync contains exactly the validated background-removal package', async () => {
  const data = await checkBackgroundRemovalSync();
  assert.equal(data.row.manifest.slug, BACKGROUND_REMOVAL_SLUG);
  const sql = await readFile(path.join(REPOSITORY_ROOT, MIGRATION_PATH), 'utf8');
  const payload = decodeMigrationPayload(sql);
  assert.equal(payload.bundle, data.catalog.bundle);
  assert.deepEqual(payload.package, data.row);
  assert.equal(sql, generateMigration(data));
});

test('sync preserves the existing skill UUID and never changes workspace installations', () => {
  const sql = generateMigration({ catalog: { bundle: 'loomic-design-skills-v2' }, row: {
    manifest: { slug: BACKGROUND_REMOVAL_SLUG, metadata: { bundle: 'loomic-design-skills-v2' } }, content: 'guide', files: [],
  } });
  assert.match(sql, /SELECT s\.id INTO target_id[\s\S]*WHERE s\.slug = 'background-removal' FOR UPDATE/);
  assert.match(sql, /IF target_id IS NULL THEN[\s\S]*catalog seed before this sync/);
  assert.doesNotMatch(sql, /INSERT INTO public\.skills/);
  assert.doesNotMatch(sql, /workspace_skills/);
  assert.doesNotMatch(sql, /DELETE FROM public\.skills/);
  assert.match(sql, /DELETE FROM public\.skill_files/);
});
