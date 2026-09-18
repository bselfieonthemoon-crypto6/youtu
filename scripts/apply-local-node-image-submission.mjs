// Fixed local-replica deployment only; read-only unless --apply is supplied.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const database = 'loomic_replica_light_20260907';
const container = 'supabase_db_thtdhcvjppuvlvahfmga';
const name = '20260909000014_durable_node_image_submission';
const version = name.split('_')[0];
const query = sql => execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
  '-U', 'supabase_admin', '-d', database, '-Atq'], { input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 }).trim();
if (query('SELECT current_database();') !== database) throw new Error('Local replica identity mismatch');
const migration = await readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
console.log(`${name} sha256=${createHash('sha256').update(migration).digest('hex')}`);
if (!process.argv.includes('--apply')) {
  console.log('Read-only preflight passed. No migration applied.');
} else if (query(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='${version}';`) !== '0') {
  console.log('Migration already registered; unchanged.');
} else {
  query(`BEGIN; SELECT pg_advisory_xact_lock(20260909,14); ${migration}\nINSERT INTO supabase_migrations.schema_migrations(version,name) VALUES('${version}','${name.slice(version.length + 1)}'); NOTIFY pgrst,'reload schema'; COMMIT;`);
  console.log('Durable node image migration applied only to the fixed local replica.');
}
