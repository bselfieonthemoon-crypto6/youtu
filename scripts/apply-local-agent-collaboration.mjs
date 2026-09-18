import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const database = 'loomic_replica_light_20260907';
const container = 'supabase_db_thtdhcvjppuvlvahfmga';
const root = new URL('../', import.meta.url);
const migrations = ['20260909000005_agent_collaboration_settings', '20260909000006_agent_delegations', '20260909000007_expert_model_snapshots', '20260909000008_collaboration_read_and_disable'];
const query = sql => execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', database, '-Atq'], { input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 }).trim();
const identity = query("SELECT current_database(); SELECT role FROM public.workspace_members WHERE workspace_id='25eb32ef-ff55-4de7-8c10-9390a51ece06' AND user_id='541006fa-d2a1-4305-be55-b6263c27a1e3';");
if (identity !== `${database}\nowner`) throw new Error('Local replica identity differs; nothing applied');
const body = [];
for (const name of migrations) {
  const version = name.split('_')[0];
  const sql = await readFile(new URL(`supabase/migrations/${name}.sql`, root), 'utf8');
  console.log(`${name} sha256=${createHash('sha256').update(sql).digest('hex')}`);
  if (query(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='${version}';`) !== '0') {
    console.log(`${version}: already applied; unchanged`); continue;
  }
  body.push(sql, `INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES('${version}','${name.slice(version.length + 1)}');`);
}
if (!process.argv.includes('--apply')) {
  console.log('Read-only preflight. Pass --apply to migrate only the fixed local replica.');
} else {
  query(`BEGIN; SELECT pg_advisory_xact_lock(20260909,5); ${body.join('\n')} NOTIFY pgrst,'reload schema'; COMMIT;`);
  console.log('Local collaboration migrations applied; existing role and default-model selections preserved.');
}
