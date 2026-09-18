import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const database = 'loomic_replica_light_20260907';
const query = sql => execFileSync('docker', ['exec','-i','supabase_db_thtdhcvjppuvlvahfmga','psql','-X','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d',database,'-Atq'], {input:sql,encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024});
assert.equal(query('SELECT current_database()').trim(), database);
assert.equal(query("SELECT count(*) FROM public.agent_runs WHERE status IN ('accepted','running')").trim(),'0','Active runs must finish before migration');
const quote = value => `'${value.replaceAll("'", "''")}'`;
let sql='BEGIN; SET LOCAL lock_timeout=\'5s\';\n';
const applied=[];
for (const [version,name] of [['20260910000011','image_requirement_confirmation'],['20260910000012','agent_run_request_message']]) {
  const body=readFileSync(new URL(`../supabase/migrations/${version}_${name}.sql`,import.meta.url),'utf8');
  const exists=query(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version=${quote(version)}`).trim()==='1';
  if (exists) {
    assert.equal(query(`SELECT statements[1]=${quote(body)} FROM supabase_migrations.schema_migrations WHERE version=${quote(version)}`).trim(),'t',`Migration ${version} differs from deployed version`);
    continue;
  }
  sql+=`${body}\nINSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES(${quote(version)},${quote(name)},ARRAY[${quote(body)}]);\n`;
  applied.push(version);
}
query(sql+'COMMIT;');
console.log(JSON.stringify({database,applied}));
