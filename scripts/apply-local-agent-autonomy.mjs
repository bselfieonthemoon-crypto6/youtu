import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Only this isolated local replica may be changed. No env/URL override.
const database = 'loomic_replica_light_20260907';
const container = 'supabase_db_thtdhcvjppuvlvahfmga';
const migrations = [
  ['20260910000001', 'agent_autonomy'],
  ['20260910000002', 'agent_confirmation_resume'],
  ['20260910000003', 'agent_target_scope'],
  ['20260910000004', 'agent_autonomy_commit_fence'],
  ['20260910000005', 'agent_correction_scope'],
  ['20260910000006', 'agent_autonomy_canvas_writes'],
  ['20260910000007', 'agent_atomic_activation'],
  ['20260910000008', 'agent_design_creation'],
];
const query = sql => execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
  '-U', 'supabase_admin', '-d', database, '-Atq'], {
  input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
}).trim();
if (query('SELECT current_database();') !== database) throw new Error('Local database identity mismatch');
if (query("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version IN ('20260909000017','20260909000018')") !== '2')
  throw new Error('Required closed-loop migrations are missing');
const pending = [];
for (const [version, name] of migrations) {
  const sql = await readFile(new URL(`../supabase/migrations/${version}_${name}.sql`, import.meta.url), 'utf8');
  const applied = query(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='${version}'`) !== '0';
  console.log(`${version} sha256=${createHash('sha256').update(sql).digest('hex')} ${applied ? 'registered' : 'pending'}`);
  if (!applied) pending.push({ version, name, sql });
}
if (!process.argv.includes('--apply')) console.log('Read-only preflight passed.');
else if (!pending.length) console.log('Already registered; unchanged.');
else {
  if (query("SELECT count(*) FROM public.background_jobs WHERE status::text IN ('pending','queued','running','processing','retrying')") !== '0'
    || query("SELECT count(*) FROM public.agent_runs WHERE status::text IN ('accepted','queued','running')") !== '0')
    throw new Error('Active local work exists; refusing deployment until idle.');
  query(`BEGIN; SET LOCAL lock_timeout='3s'; SELECT pg_advisory_xact_lock(20260910,1);
    ${pending.map(m => `${m.sql}\nINSERT INTO supabase_migrations.schema_migrations(version,name) VALUES('${m.version}','${m.name}');`).join('\n')}
    NOTIFY pgrst,'reload schema'; COMMIT;`);
  console.log('Autonomy migrations applied only to the fixed local development replica.');
}
