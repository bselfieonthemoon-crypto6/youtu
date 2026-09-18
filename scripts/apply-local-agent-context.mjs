// Read-only by default. The explicit --apply mode is reserved for deployment.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const database = 'loomic_replica_light_20260907';
const container = 'supabase_db_thtdhcvjppuvlvahfmga';
const migrations = ['20260909000009_agent_context_snapshots', '20260909000010_model_context_profiles', '20260909000011_agent_context_history_epoch'];
const query = sql => execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
  '-U', 'supabase_admin', '-d', database, '-Atq'], { input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 }).trim();
if (query('SELECT current_database();') !== database) throw new Error('Local replica identity mismatch');
const pending = [];
for (const name of migrations) {
  const version = name.split('_')[0];
  const migration = await readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
  console.log(`${name} sha256=${createHash('sha256').update(migration).digest('hex')}`);
  if (query(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='${version}';`) !== '0') {
    console.log(`${name}: already registered; unchanged.`);
  } else {
    pending.push(migration, `INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES('${version}','${name.slice(version.length + 1)}');`);
  }
}
if (!process.argv.includes('--apply')) {
  console.log('Read-only preflight passed. No migration applied.');
} else if (pending.length) {
  query(`BEGIN; SELECT pg_advisory_xact_lock(20260909,9); ${pending.join('\n')} NOTIFY pgrst,'reload schema'; COMMIT;`);
  console.log('Context, model-profile and history-epoch migrations applied in order only to the fixed local replica.');
} else {
  console.log('All context migrations already applied; unchanged.');
}
