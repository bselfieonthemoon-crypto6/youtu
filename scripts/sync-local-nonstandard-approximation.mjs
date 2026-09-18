import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { readCatalog, generateMigration } from './build-design-skill-catalog.mjs';

const slug = 'nonstandard-image-size';
const data = await readCatalog();
const rows = data.rows.filter(row => row.manifest.slug === slug);
assert.equal(rows.length, 1);
const sql = generateMigration({ catalog: data.catalog, rows });
const migration = 'supabase/migrations/20260915000004_nonstandard_image_size_approximation.sql';
await writeFile(migration, sql);
if (!process.argv.includes('--apply-local')) {
  console.log('Generated single-skill additive migration; no database changes.');
  process.exit(0);
}
const database = 'loomic_replica_light_20260907';
const query = sql => execFileSync('docker', ['exec','-i','supabase_db_thtdhcvjppuvlvahfmga','psql','-X','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d',database,'-At'], {input:sql,encoding:'utf8',windowsHide:true}).trim();
assert.equal(query('select current_database();'),database);
const invariant = () => query(`select md5(coalesce(jsonb_agg(to_jsonb(s) order by s.id)::text,'')) from public.skills s where slug <> '${slug}'; select md5(coalesce(jsonb_agg(to_jsonb(w) order by w.id)::text,'')) from public.workspace_skills w where skill_id not in (select id from public.skills where slug='${slug}');`);
const before = invariant();
query(`BEGIN; SELECT pg_advisory_xact_lock(20260915,4); ${sql}
INSERT INTO public.workspace_skills(workspace_id,skill_id,enabled,installed_by)
SELECT '25eb32ef-ff55-4de7-8c10-9390a51ece06',id,true,'541006fa-d2a1-4305-be55-b6263c27a1e3' FROM public.skills WHERE slug='${slug}'
ON CONFLICT(workspace_id,skill_id) DO NOTHING;
INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ('20260915000004','nonstandard_image_size_approximation') ON CONFLICT(version) DO NOTHING; COMMIT;`);
assert.equal(invariant(),before,'Other skills and installation states changed');
console.log(query(`select s.slug,s.version,w.enabled from public.skills s join public.workspace_skills w on w.skill_id=s.id where s.slug='${slug}' and w.workspace_id='25eb32ef-ff55-4de7-8c10-9390a51ece06';`));
console.log('Local skill installed; other skills and installation states unchanged.');

