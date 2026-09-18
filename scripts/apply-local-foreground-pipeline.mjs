import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const database = 'loomic_replica_light_20260907';
const container = 'supabase_db_thtdhcvjppuvlvahfmga';
const migrations = [
  { version: '20260909000015', name: 'image_foreground_stage' },
  { version: '20260909000016', name: 'recoverable_canvas_image_jobs' },
];
const query = sql => execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', database, '-Atq'], { input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 }).trim();
if (query('SELECT current_database();') !== database) throw new Error('Local database identity mismatch');
const pending = [];
for (const item of migrations) {
  const sql = await readFile(new URL(`../supabase/migrations/${item.version}_${item.name}.sql`, import.meta.url), 'utf8');
  const applied = query(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='${item.version}';`) !== '0';
  console.log(`${item.version} sha256=${createHash('sha256').update(sql).digest('hex')} ${applied ? 'already registered' : 'pending'}`);
  if (!applied) pending.push({ ...item, sql });
}
if (!process.argv.includes('--apply')) console.log('Read-only preflight passed; no migration applied.');
else if (!pending.length) console.log('Migrations already registered; unchanged.');
else {
  if (query("SELECT count(*) FROM public.background_jobs WHERE status::text IN ('queued','running','processing')") !== '0'
    || query("SELECT count(*) FROM public.agent_runs WHERE status::text IN ('queued','running')") !== '0')
    throw new Error('Active local work exists; refusing migration until it is idle.');
  query(`BEGIN; SET LOCAL lock_timeout='3s'; SELECT pg_advisory_xact_lock(20260909,15);
    ${pending.map(item => `${item.sql}\nINSERT INTO supabase_migrations.schema_migrations(version,name) VALUES('${item.version}','${item.name}');`).join('\n')}
    NOTIFY pgrst,'reload schema'; COMMIT;`);
  console.log('Image pipeline migrations applied only to fixed local replica.');
}
