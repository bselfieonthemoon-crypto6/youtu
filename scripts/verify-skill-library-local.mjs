import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { checkCatalog } from './build-design-skill-catalog.mjs';

// Fixed local replica only. No credentials, model calls or database writes.
const database = 'loomic_replica_light_20260907';
const container = 'supabase_db_thtdhcvjppuvlvahfmga';
const workspace = '25eb32ef-ff55-4de7-8c10-9390a51ece06';
const query = sql => execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', database, '-Atq'], {
  input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024,
}).trim();
assert.equal(query('select current_database();'), database);
const { rows } = await checkCatalog();
const actual = JSON.parse(query(`select coalesce(json_agg(json_build_object(
  'slug',s.slug,'version',s.version,'content',s.skill_content,'metadata',s.metadata,'enabled',ws.enabled,
  'files',(select coalesce(json_agg(json_build_object('file_path',f.file_path,'content',f.content)), '[]'::json) from public.skill_files f where f.skill_id=s.id)
)), '[]'::json) from public.skills s join public.workspace_skills ws on ws.skill_id=s.id
where ws.workspace_id='${workspace}' and s.source='system' and s.created_by is null and s.metadata->>'bundle'='loomic-design-skills-v2';`));
let fileCount = 0;
for (const row of rows) {
  const found = actual.find(value => value.slug === row.manifest.slug);
  assert.ok(found, `Workspace installation missing: ${row.manifest.slug}`);
  assert.equal(found.version, row.manifest.version, `${found.slug}: version drift`);
  assert.equal(found.content.replace(/\r\n/g, '\n'), row.content, `${found.slug}: body drift`);
  assert.deepEqual(found.metadata.loomic, row.manifest.metadata.loomic, `${found.slug}: metadata drift`);
  for (const file of row.files) {
    const stored = found.files.find(value => value.file_path === file.file_path);
    assert.ok(stored, `${found.slug}: missing ${file.file_path}`);
    assert.equal(stored.content.replace(/\r\n/g, '\n'), file.content, `${found.slug}: reference drift`);
    fileCount++;
  }
}
assert.equal(actual.find(row => row.slug === 'gpt-image-2-style-library').enabled, true);
assert.equal(query("select count(*) from supabase_migrations.schema_migrations where version='20260909000013';"), '1');
console.log(JSON.stringify({ status: 'passed', scope: 'local database catalog + current workspace installation',
  skills: rows.length, referenceFiles: fileCount, migration: '20260909000013', newSkillEnabled: true,
  note: 'Exact body/reference/metadata comparison; existing toggles not changed. This is not a live-model or image-quality evaluation.' }));
