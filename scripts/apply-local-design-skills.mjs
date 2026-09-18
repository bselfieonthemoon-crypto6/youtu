import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Intentionally fixed to the existing disposable/local replica, never .env.local.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const database = 'loomic_replica_light_20260907';
const container = 'supabase_db_thtdhcvjppuvlvahfmga';
const workspace = '25eb32ef-ff55-4de7-8c10-9390a51ece06';
const actor = '541006fa-d2a1-4305-be55-b6263c27a1e3';
const migrations = ['20260909000002_skill_package_integrity', '20260909000003_design_skill_catalog', '20260909000004_design_skill_guidance_precision', '20260909000013_skill_library_composition'];
const query = sql => execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', database, '-At'], {
  input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
}).trim();
const identity = query(`SELECT current_database(); SELECT role FROM public.workspace_members WHERE workspace_id='${workspace}' AND user_id='${actor}';`);
if (identity !== `${database}\nowner`) throw new Error('Local replica identity or workspace ownership differs; no changes applied.');
const catalog = JSON.parse(await readFile(path.join(root, 'skills/catalog.json'), 'utf8'));
if (catalog.bundle !== 'loomic-design-skills-v2' || !catalog.skills.every(slug => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))) throw new Error('Invalid catalog');
const body = [];
for (const migration of migrations) {
  const version = migration.split('_')[0];
  if (query(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='${version}';`) !== '0') {
    console.log(`${version}: already recorded; not reapplied`);
    continue;
  }
  body.push(await readFile(path.join(root, 'supabase/migrations', `${migration}.sql`), 'utf8'));
  body.push(`INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ('${version}','${migration.slice(version.length + 1)}');`);
}
// Never re-enable an existing user-disabled entry; enable newly added packages.
body.push(`INSERT INTO public.workspace_skills(workspace_id,skill_id,enabled,installed_by)
  SELECT '${workspace}',id,true,'${actor}' FROM public.skills
  WHERE source='system' AND created_by IS NULL AND metadata->>'bundle'='loomic-design-skills-v2'
    AND slug IN (${catalog.skills.map(slug => `'${slug}'`).join(',')})
  ON CONFLICT (workspace_id,skill_id) DO NOTHING;`);
query(`BEGIN; SELECT pg_advisory_xact_lock(20260909,3);\n${body.join('\n')}\nNOTIFY pgrst, 'reload schema';\nCOMMIT;`);
console.log(query(`SELECT s.slug || ' | v' || s.version || ' | enabled=' || ws.enabled
  FROM public.skills s JOIN public.workspace_skills ws ON ws.skill_id=s.id
  WHERE ws.workspace_id='${workspace}' AND s.metadata->>'bundle'='loomic-design-skills-v2' ORDER BY s.slug;`));
console.log('Local Skills migrations and installation verified; existing enable/disable choices preserved.');
