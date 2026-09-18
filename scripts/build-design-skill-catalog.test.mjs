import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkCatalog, decodeMigrationPayload, generateMigration, MIGRATION_PATH, readCatalog, REPOSITORY_ROOT, validateManifest, validateReferences } from './build-design-skill-catalog.mjs';

const removedNativeSkills = ['brand-consistency', 'canvas-design', 'design-delivery', 'design-refinement', 'infographic-design', 'resource-template-composition', 'typography-layout'];
const copy = value => structuredClone(value);
const manifest = {
  slug: 'sample-design', name: 'Sample', description: 'Design sample.', version: '2.0.0',
  category: 'design', iconName: 'palette', license: null,
  metadata: { bundle: 'loomic-design-skills-v2', loomic: {
    schemaVersion: 1, execution: 'native', intents: ['layout'], outputKinds: ['native-design'],
    requiredTools: ['inspect_design'], optionalTools: ['verify_design_result'],
    models: [{ role: 'planner', required: true, preferredIds: [] }],
    limitations: ['No shell.'], examples: ['Keep the logo; align the title.'], sources: [],
  } },
};
const skill = '---\nname: sample-design\ndescription: Design sample.\nmetadata:\n  version: "2.0.0"\n---\n\nRead [details](references/detail.md) when needed.\n';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'loomic-skill-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'skills', 'sample-design');
  await mkdir(path.join(directory, 'references'), { recursive: true });
  await mkdir(path.join(root, 'supabase', 'migrations'), { recursive: true });
  await writeFile(path.join(root, 'skills', 'catalog.json'), JSON.stringify({ schemaVersion: 1, bundle: manifest.metadata.bundle, skills: [manifest.slug] }));
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(directory, 'SKILL.md'), skill);
  await writeFile(path.join(directory, 'references', 'detail.md'), 'Use real object IDs.\n');
  return { root, directory };
}

test('catalog round-trips every real manifest, SKILL and reference into the generated database payload', async () => {
  const data = await checkCatalog();
  assert.equal(data.rows.length, 15);
  assert.equal(data.rows.reduce((n, row) => n + row.files.length, 0), 36);
  const sql = await readFile(path.join(REPOSITORY_ROOT, MIGRATION_PATH), 'utf8');
  assert.deepEqual(decodeMigrationPayload(sql), data.rows);
  assert.equal(sql, generateMigration(await readCatalog()));
  const raster = new Set(['logo-design', 'campaign-design', 'product-visual', 'social-carousel', 'series-visual-design', 'json-image-prompt']);
  for (const row of data.rows) {
    assert.equal(row.manifest.version, row.manifest.slug === 'gpt-image-2-style-library' ? '1.0.1' : row.manifest.slug === 'nonstandard-image-size' ? '1.4.1' : raster.has(row.manifest.slug) || ['background-removal', 'image-layer-separation', 'game-promo-visuals'].includes(row.manifest.slug) ? '2.2.0' : '2.1.0');
    assert.equal(row.manifest.license, row.manifest.slug === 'gpt-image-2-style-library' ? 'MIT' : null);
    assert.ok(row.manifest.metadata.loomic.composition);
    assert.equal(row.manifest.slug === 'background-removal' || row.manifest.slug === 'nonstandard-image-size' || row.manifest.metadata.loomic.models.some(model => model.role === 'planner'), true);
    assert.equal(row.files.every(file => file.file_path.startsWith('references/')), true);
  }
});

test('historical guidance precision leaves the earlier applied catalog seed unchanged', async () => {
  const previousSql = await readFile(path.join(REPOSITORY_ROOT, 'supabase/migrations/20260909000003_design_skill_catalog.sql'), 'utf8');
  const previous = decodeMigrationPayload(previousSql);
  const current = decodeMigrationPayload(await readFile(path.join(REPOSITORY_ROOT, 'supabase/migrations/20260909000004_design_skill_guidance_precision.sql'), 'utf8'));
  assert.equal(previous.length, current.length);
  const changed = [];
  for (const row of current) {
    const old = previous.find(item => item.manifest.slug === row.manifest.slug);
    assert.ok(old);
    assert.equal(old.manifest.version, '2.0.0');
    if (JSON.stringify(row) !== JSON.stringify(old)) {
      changed.push(row.manifest.slug);
      assert.equal(row.manifest.version, '2.0.1');
      assert.deepEqual({ ...row.manifest, version: old.manifest.version }, old.manifest);
    } else assert.equal(row.manifest.version, '2.0.0');
  }
  assert.deepEqual(changed.sort(), ['background-removal', 'brand-consistency', 'campaign-design', 'canvas-design', 'design-delivery', 'design-refinement', 'infographic-design', 'logo-design', 'product-visual', 'resource-template-composition', 'series-visual-design', 'social-carousel', 'typography-layout'].sort());
});

test('composition migration preserves unchanged packages while raster packages match direct image dependencies', async () => {
  assert.equal(MIGRATION_PATH, 'supabase/migrations/20260909000013_skill_library_composition.sql');
  const previous = decodeMigrationPayload(await readFile(path.join(REPOSITORY_ROOT, 'supabase/migrations/20260909000004_design_skill_guidance_precision.sql'), 'utf8'));
  const current = (await checkCatalog()).rows;
  const raster = new Set(['logo-design', 'campaign-design', 'product-visual', 'social-carousel', 'series-visual-design']);
  for (const old of previous) {
    const row = current.find(item => item.manifest.slug === old.manifest.slug);
    if (!row) {
      // Native-board skills that require the retired manipulate_design tool
      // were removed from the catalog.
      assert.equal(removedNativeSkills.includes(old.manifest.slug), true);
      continue;
    }
    if (row.manifest.slug === 'json-image-prompt') {
      assert.equal(row.manifest.metadata.loomic.execution, 'guidance');
      assert.deepEqual(row.manifest.metadata.loomic.requiredTools, []);
      assert.deepEqual(row.manifest.metadata.loomic.models.map(model => model.role), ['planner']);
      assert.deepEqual(row.manifest.metadata.loomic.optionalTools, ['generate_image', 'edit_image', 'inspect_canvas']);
      continue;
    }
    if (raster.has(row.manifest.slug)) {
      assert.equal(row.manifest.version, '2.2.0');
      assert.equal(row.manifest.metadata.loomic.execution, 'image');
      assert.deepEqual(row.manifest.metadata.loomic.requiredTools, ['generate_image', 'edit_image']);
      assert.equal(row.manifest.metadata.loomic.models.find(model => model.role === 'image').required, true);
      continue;
    }
    if (row.manifest.slug === 'gpt-image-2-style-library') {
      assert.equal(row.manifest.version, '1.0.1');
      assert.deepEqual(row.manifest.metadata.loomic.requiredTools, ['search_prompt_library', 'get_prompt_library_entry']);
      continue;
    }
    if (row.manifest.slug === 'image-layer-separation') {
      assert.equal(row.manifest.version, '2.2.0');
      assert.equal(row.manifest.metadata.loomic.execution, 'guidance');
      assert.ok(row.content.includes('Low + 1K'));
      assert.ok(row.content.includes('2–4'));
      continue;
    }
    if (row.manifest.slug === 'background-removal') {
      assert.equal(row.manifest.version, '2.2.0');
      assert.deepEqual(row.manifest.metadata.loomic.requiredTools, ['edit_image']);
      assert.equal(row.content.includes('sourceUsage=edit'), true);
      continue;
    }
    assert.equal(row.content.replace('version: "2.1.0"', `version: "${old.manifest.version}"`), old.content);
    assert.deepEqual(row.files, old.files);
    const manifest = structuredClone(row.manifest);
    manifest.version = old.manifest.version;
    delete manifest.metadata.loomic.composition;
    assert.deepEqual(manifest, old.manifest);
  }
  const adapted = current.find(row => row.manifest.slug === 'gpt-image-2-style-library');
  assert.deepEqual(adapted.manifest.metadata.loomic.requiredTools, ['search_prompt_library', 'get_prompt_library_entry']);
  assert.equal(adapted.files.some(file => file.content.includes('Copyright (c) 2026 freestylefly')), true);
  assert.equal(adapted.manifest.metadata.loomic.sources[0].relation, 'adapted-from');
});

test('preserves literal SQL-looking skill content as data and rejects outer dollar injection', async t => {
  const { root, directory } = await fixture(t);
  const original = 'User says: O\'Reilly; DROP TABLE public.skills; -- this is content, not SQL.\n';
  await writeFile(path.join(directory, 'references', 'detail.md'), original);
  const data = await readCatalog(root);
  assert.equal(decodeMigrationPayload(generateMigration(data))[0].files[0].content, original);
  data.rows[0].content += '\n$design_catalog_migration$';
  assert.throws(() => generateMigration(data), /delimiter collision/);
});

test('generated mutation has catalog ownership checks and only deletes dropped bundle system skills', async t => {
  const { root } = await fixture(t);
  const sql = generateMigration(await readCatalog(root));
  const withoutPayload = sql.replace(/entries jsonb := (\$design_catalog_[0-9a-f]{16}\$)[\s\S]*?\1::jsonb;/, 'entries jsonb := NULL;');
  assert.match(withoutPayload, /ORDER BY s\.slug FOR UPDATE/);
  assert.match(withoutPayload, /s\.source IS DISTINCT FROM 'system' OR s\.created_by IS NOT NULL/);
  assert.match(withoutPayload, /WHERE owned\.source = 'system' AND owned\.created_by IS NULL/);
  assert.match(withoutPayload, /IF target_id IS NULL THEN\s+RAISE EXCEPTION/);
  assert.doesNotMatch(withoutPayload, /(?:INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\s+(?:public\.)?workspace_skills/i);
  // The only DELETE is the bundle-scoped removal of dropped system skills.
  assert.match(withoutPayload, /DELETE FROM public\.skills AS removed/);
  assert.match(withoutPayload, /removed\.source = 'system' AND removed\.created_by IS NULL/);
  assert.match(withoutPayload, /removed\.metadata->>'bundle' = 'loomic-design-skills-v2'/);
  assert.match(withoutPayload, /removed\.slug NOT IN \(SELECT item->'manifest'->>'slug' FROM jsonb_array_elements\(entries\)/);
  assert.doesNotMatch(withoutPayload, /\b(?:TRUNCATE|DROP TABLE|ALTER TABLE)\b/i);
});

test('source/migration drift and checksum corruption fail instead of silently accepting stale DB seed content', async t => {
  const { root, directory } = await fixture(t);
  const sql = generateMigration(await readCatalog(root));
  await writeFile(path.join(root, MIGRATION_PATH), sql);
  await checkCatalog(root);
  await writeFile(path.join(directory, 'references', 'detail.md'), 'Changed design guidance.\n');
  await assert.rejects(checkCatalog(root), /stale/);
  assert.throws(() => decodeMigrationPayload(sql.replace('Use real object IDs.', 'Use fake object IDs.')), /checksum mismatch/);
});

test('missing references, path traversal, unsupported schemes and invalid encoding are rejected', async t => {
  const { root, directory } = await fixture(t);
  await rm(path.join(directory, 'references', 'detail.md'));
  await assert.rejects(readCatalog(root), /Missing bundled reference/);
  const available = new Set(['references/detail.md']);
  for (const target of ['../secret.md', '%2e%2e/secret.md', '/absolute.md', 'file:///secret.md', 'http://example.com', 'references\\detail.md', '%XX']) {
    assert.throws(() => validateReferences(`[link](${target})`, 'SKILL.md', available));
  }
  assert.doesNotThrow(() => validateReferences('[link](references/detail.md#section)', 'SKILL.md', available));
});

test('package directory symlinks cannot make the generator read outside its skill root', async t => {
  const { root, directory } = await fixture(t);
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'loomic-skill-external-'));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  await writeFile(path.join(elsewhere, 'secret.md'), 'should not be read');
  await rm(path.join(directory, 'references'), { recursive: true });
  await symlink(elsewhere, path.join(directory, 'references'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readCatalog(root), /Symlink/);
});

test('legacy font assets are kept on disk and are not registered as executable package files', async t => {
  const { root, directory } = await fixture(t);
  await mkdir(path.join(directory, 'canvas-fonts'));
  const font = path.join(directory, 'canvas-fonts', 'legacy.ttf');
  await writeFile(font, Buffer.from([0, 1, 2, 255]));
  assert.equal((await readCatalog(root)).rows[0].files.length, 1);
  assert.deepEqual(await readFile(font), Buffer.from([0, 1, 2, 255]));
});

test('unsafe slugs, duplicate entries and injected bundle comments cannot reach SQL generation', async t => {
  const { root } = await fixture(t);
  for (const skills of [['../sample-design'], ['sample-design', 'sample-design']]) {
    await writeFile(path.join(root, 'skills', 'catalog.json'), JSON.stringify({ schemaVersion: 1, bundle: manifest.metadata.bundle, skills }));
    await assert.rejects(readCatalog(root));
  }
  await writeFile(path.join(root, 'skills', 'catalog.json'), JSON.stringify({ schemaVersion: 1, bundle: 'bad\nSELECT 1;', skills: ['sample-design'] }));
  await assert.rejects(readCatalog(root), /Invalid catalog bundle/);
});

test('manifest validates tool/model dependencies, exact IDs and explicit adapted-source licensing', () => {
  assert.doesNotThrow(() => validateManifest(copy(manifest), manifest.slug, manifest.metadata.bundle));
  const invalid = [];
  let row = copy(manifest); row.metadata.loomic.requiredTools = ['execute;']; invalid.push(row);
  row = copy(manifest); row.metadata.loomic.optionalTools = ['inspect_design']; invalid.push(row);
  row = copy(manifest); row.metadata.loomic.models.push(copy(row.metadata.loomic.models[0])); invalid.push(row);
  row = copy(manifest); row.metadata.loomic.models[0].exactIds = []; invalid.push(row);
  row = copy(manifest); row.metadata.loomic.sources = [{ title: 'Copied', url: 'https://example.com/skill', license: 'MIT', relation: 'adapted-from' }]; invalid.push(row);
  row = copy(manifest); row.metadata.loomic.sources = [{ title: 'Private token', url: 'https://user:secret@example.com/skill', relation: 'inspired-by' }]; invalid.push(row);
  for (const value of invalid) assert.throws(() => validateManifest(value, manifest.slug, manifest.metadata.bundle));
});

test('frontmatter identity and description must agree with the package manifest', async t => {
  const { root, directory } = await fixture(t);
  await writeFile(path.join(directory, 'SKILL.md'), skill.replace('name: sample-design', 'name: another-design'));
  await assert.rejects(readCatalog(root), /frontmatter\/manifest mismatch/);
});
