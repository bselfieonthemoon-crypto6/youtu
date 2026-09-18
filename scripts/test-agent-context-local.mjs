// Fixed local replica; pending DDL and all fixtures run in a rolled-back transaction.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const container = 'supabase_db_thtdhcvjppuvlvahfmga';
const database = 'loomic_replica_light_20260907';
const root = new URL('../', import.meta.url);
const query = sql => execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
  '-U', 'supabase_admin', '-d', database, '-Atq'], { input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
if (query('SELECT current_database();').trim() !== database) throw new Error('Local replica identity mismatch');
const installed = query("SELECT to_regclass('public.agent_run_context_snapshots') IS NOT NULL;").trim() === 't';
const pending = installed ? [] : [await readFile(new URL('supabase/migrations/20260909000009_agent_context_snapshots.sql', root), 'utf8')];
if (query("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='chat_sessions' AND column_name='agent_context_history_epoch');").trim() !== 't') {
  pending.push(await readFile(new URL('supabase/migrations/20260909000011_agent_context_history_epoch.sql', root), 'utf8'));
}
const taskSource = await readFile(new URL('apps/server/src/features/agent-tasks/agent-task-local-db.qa.sql', root), 'utf8');
const fixture = taskSource.slice(0, taskSource.indexOf('SELECT pg_temp.qa_assert(public.loomic_agent_task_assert_current'))
  .replace(/^BEGIN;\r?$/m, '');
const assertions = await readFile(new URL('apps/server/src/features/agent-context/agent-context-local-db.qa.sql', root), 'utf8');
const epochAssertions = await readFile(new URL('apps/server/src/features/agent-context/agent-context-history-epoch.qa.sql', root), 'utf8');
const prefix = randomBytes(2).toString('hex');
const sql = `BEGIN;\nSET LOCAL statement_timeout='20s';\nSET LOCAL lock_timeout='3s';\n${pending.join('\n')}\n${fixture}\n${epochAssertions}\n${assertions}\nROLLBACK;\nSELECT 'Agent context database acceptance passed; fixture data and pending DDL rolled back';`
  .replace(/aa0([1-9])0000/g, (_, n) => `${prefix}000${n}`);
const output = query(sql);
console.log(output.split('\n').find(line => line.startsWith('Agent context database acceptance')));
