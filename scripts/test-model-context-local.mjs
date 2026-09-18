// Synthetic safe metadata only: no Vault calls, provider calls, credential reads,
// persisted fixtures, or committed DDL. Fixed local replica, always ROLLBACK.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const container = 'supabase_db_thtdhcvjppuvlvahfmga';
const database = 'loomic_replica_light_20260907';
const root = new URL('../', import.meta.url);
const query = sql => execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
  '-U', 'supabase_admin', '-d', database, '-Atq'], { input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
if (query('SELECT current_database();').trim() !== database) throw new Error('Local replica identity mismatch');
const pending = [];
for (const [name, probe] of [
  ['20260909000009_agent_context_snapshots', "SELECT to_regclass('public.agent_run_context_snapshots') IS NOT NULL;"],
  ['20260909000010_model_context_profiles', "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='workspace_provider_models' AND column_name='context_profile');"],
]) {
  if (query(probe).trim() !== 't') pending.push(await readFile(new URL(`supabase/migrations/${name}.sql`, root), 'utf8'));
}
const taskSource = await readFile(new URL('apps/server/src/features/agent-tasks/agent-task-local-db.qa.sql', root), 'utf8');
const fixture = taskSource.slice(0, taskSource.indexOf('SELECT pg_temp.qa_assert(public.loomic_agent_task_assert_current'))
  .replace(/^BEGIN;\r?$/m, '');
const assertions = await readFile(new URL('./test-model-context-local.sql', import.meta.url), 'utf8');
const prefix = randomBytes(2).toString('hex');
const sql = `BEGIN;\nSET LOCAL statement_timeout='20s';\nSET LOCAL lock_timeout='3s';\n${pending.join('\n')}\n${fixture}\n${assertions}\nROLLBACK;\nSELECT 'Model context SQL acceptance passed; all fixtures and pending DDL rolled back';`
  .replace(/aa0([1-9])0000/g, (_, n) => `${prefix}000${n}`);
const output = query(sql);
console.log(output.split('\n').find(line => line.startsWith('Model context SQL acceptance')));
