import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Deliberately restricted to this development replica. No URL/env override and
// no production deployment capability. Default is a read-only preflight.
const database = 'loomic_replica_light_20260907';
const container = 'supabase_db_thtdhcvjppuvlvahfmga';
const migrations = [
  { version: '20260909000017', name: 'agent_task_continuations' },
  { version: '20260909000018', name: 'agent_workflow_cas' },
];
const query = sql => execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
  '-U', 'supabase_admin', '-d', database, '-Atq'], {
  input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
}).trim();
if (query('SELECT current_database();') !== database) throw new Error('Local database identity mismatch');
if (query("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version IN ('20260909000015','20260909000016')") !== '2')
  throw new Error('Required local image pipeline migrations are missing');
const pending = [];
for (const migration of migrations) {
  const sql = await readFile(new URL(`../supabase/migrations/${migration.version}_${migration.name}.sql`, import.meta.url), 'utf8');
  const applied = query(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='${migration.version}'`) !== '0';
  console.log(`${migration.version} sha256=${createHash('sha256').update(sql).digest('hex')} ${applied ? 'already registered' : 'pending'}`);
  if (!applied) pending.push({ ...migration, sql });
}
if (!process.argv.includes('--apply')) console.log('Read-only preflight passed; no migration applied.');
else if (!pending.length) console.log('Migrations already registered; unchanged.');
else {
  if (query("SELECT count(*) FROM public.background_jobs WHERE status::text IN ('pending','queued','running','processing')") !== '0'
    || query("SELECT count(*) FROM public.agent_runs WHERE status::text IN ('accepted','queued','running')") !== '0')
    throw new Error('Active local work exists; refusing to deploy until idle.');
  query(`BEGIN; SET LOCAL lock_timeout='3s'; SELECT pg_advisory_xact_lock(20260909,17);
    ${pending.map(migration => `${migration.sql}\nINSERT INTO supabase_migrations.schema_migrations(version,name) VALUES('${migration.version}','${migration.name}');`).join('\n')}
    NOTIFY pgrst,'reload schema'; COMMIT;`);
  console.log('Agent closed-loop migrations applied only to the fixed local development replica.');
}
