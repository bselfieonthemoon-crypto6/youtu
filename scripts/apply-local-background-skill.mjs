import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {checkBackgroundRemovalSync,MIGRATION_PATH} from './build-background-removal-skill-sync.mjs';
await checkBackgroundRemovalSync();
const database='loomic_replica_light_20260907';
const query=sql=>execFileSync('docker',['exec','-i','supabase_db_thtdhcvjppuvlvahfmga','psql','-X','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d',database,'-At'],{input:sql,encoding:'utf8',windowsHide:true}).trim();
assert.equal(query('select current_database();'),database);
const invariant=()=>query(`select md5(coalesce(jsonb_agg(to_jsonb(s) order by s.id)::text,'')) from public.skills s where slug <> 'background-removal'; select md5(coalesce(jsonb_agg(to_jsonb(w) order by w.workspace_id,w.skill_id)::text,'')) from public.workspace_skills w;`);
const before=invariant();
await mkdir('artifacts/background-skill-20260915',{recursive:true});
const backup=query(`select jsonb_build_object('skill',to_jsonb(s),'files',(select jsonb_agg(to_jsonb(f)) from public.skill_files f where f.skill_id=s.id)) from public.skills s where slug='background-removal';`);
await writeFile('artifacts/background-skill-20260915/package-before-sync.json',backup);
const sql=await readFile(MIGRATION_PATH,'utf8');
query(`BEGIN; SELECT pg_advisory_xact_lock(20260915,1); ${sql}
INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ('20260915000001','sync_background_removal_skill') ON CONFLICT(version) DO NOTHING; COMMIT;`);
assert.equal(invariant(),before,'Other skills and installation state must remain unchanged');
console.log(query(`select slug || ' v' || version || ' id=' || id from public.skills where slug='background-removal';`));
console.log('Local package synced; other skills and workspace enabled states unchanged.');
