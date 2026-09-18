import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { readCatalog, generateMigration } from './build-design-skill-catalog.mjs';

const slugs = ['logo-design','campaign-design','product-visual','social-carousel','series-visual-design','json-image-prompt','gpt-image-2-style-library'];
const data = await readCatalog();
const rows = data.rows.filter(row => slugs.includes(row.manifest.slug));
assert.equal(rows.length, slugs.length);
const sql = generateMigration({catalog:data.catalog,rows});
if (!process.argv.includes('--apply-local')) {
  console.log(JSON.stringify({slugs,mode:'dry-run',note:'No database changes'}));
} else {
  const database='loomic_replica_light_20260907';
  const query=sql=>execFileSync('docker',['exec','-i','supabase_db_thtdhcvjppuvlvahfmga','psql','-X','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d',database,'-Atq'],{input:sql,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024}).trim();
  assert.equal(query('select current_database();'),database);
  const list=slugs.map(slug=>`'${slug}'`).join(',');
  const protectedSql=`select md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id)::text,'')) from public.skills t where slug not in (${list}); select md5(coalesce(jsonb_agg(to_jsonb(t) order by t.workspace_id,t.skill_id)::text,'')) from public.workspace_skills t;`;
  const before=query(protectedSql);
  const backup=`artifacts/raster-skills-backup-${Date.now()}.json`;
  await writeFile(backup,query(`select jsonb_build_object('skills',(select jsonb_agg(to_jsonb(s)) from skills s where slug in (${list})),'files',(select jsonb_agg(to_jsonb(f)) from skill_files f join skills s on s.id=f.skill_id where s.slug in (${list})));`),{flag:'wx'});
  query(`BEGIN; SELECT pg_advisory_xact_lock(20260915,6); ${sql} COMMIT;`);
  assert.equal(query(protectedSql),before,'Unrelated skills or installation toggles changed');
  const actual=JSON.parse(query(`select jsonb_agg(jsonb_build_object('slug',slug,'version',version,'metadata',metadata,'content',skill_content)) from skills where slug in (${list});`));
  for(const row of rows){const stored=actual.find(s=>s.slug===row.manifest.slug);assert.equal(stored.version,row.manifest.version);assert.deepEqual(stored.metadata.loomic,row.manifest.metadata.loomic);assert.equal(stored.content.replace(/\r\n/g,'\n'),row.content);}
  console.log(JSON.stringify({synced:slugs,backup,verified:true,installationTogglesUnchanged:true}));
}
