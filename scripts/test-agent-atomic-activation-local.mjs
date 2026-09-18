import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const database = 'loomic_replica_light_20260907';
const query = sql => execFileSync('docker', ['exec','-i','supabase_db_thtdhcvjppuvlvahfmga','psql','-X','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d',database,'-Atq'],
  { input: sql, encoding:'utf8', windowsHide:true, maxBuffer:1024*1024 });
if (query('SELECT current_database();').trim() !== database) throw new Error('Non-local DB refused');
const migration = await readFile(new URL('../supabase/migrations/20260910000007_agent_atomic_activation.sql', import.meta.url),'utf8');
const applied = query("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='20260910000007'").trim() !== '0';
const source = await readFile(new URL('../apps/server/src/features/agent-tasks/agent-task-local-db.qa.sql', import.meta.url),'utf8');
const fixture = source.slice(0,source.indexOf('SELECT pg_temp.qa_error')).replace(/^BEGIN;\r?$/m,'');
const args = `'aa010000-0000-4000-8000-000000000001','aa060000-0000-4000-8000-000000000001','aa040000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000002','Preserve footer',NULL,'aa070000-0000-4000-8000-000000000001'`;
query(`BEGIN; ${applied ? '' : migration} ${fixture}
CREATE TEMP TABLE qa_activation AS SELECT public.loomic_agent_task_prepare(${args}) AS prepared;
SELECT pg_temp.qa_assert(private.loomic_context_state('aa010000-0000-4000-8000-000000000001',
 'aa020000-0000-4000-8000-000000000001','aa060000-0000-4000-8000-000000000001',
 'aa070000-0000-4000-8000-000000000002',NULL)->>'taskRevision' IS NULL,'prepared run has unbound context');
CREATE FUNCTION pg_temp.fail_grant() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'qa_injected_grant_failure'; END$$;
CREATE TRIGGER qa_fail_grant BEFORE INSERT ON public.agent_task_autonomy FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_grant();
SELECT pg_temp.qa_error($q$SELECT public.loomic_agent_task_activate_autonomous(${args},(SELECT prepared FROM qa_activation),true)$q$,'qa_injected_grant_failure');
SELECT pg_temp.qa_assert((SELECT revision=1 FROM public.agent_design_tasks WHERE session_id='aa060000-0000-4000-8000-000000000001'),'grant failure rolls back task revision');
SELECT pg_temp.qa_assert(NOT EXISTS(SELECT 1 FROM public.agent_design_task_runs WHERE run_id='aa070000-0000-4000-8000-000000000002'),'grant failure rolls back run mapping');
DROP TRIGGER qa_fail_grant ON public.agent_task_autonomy;
SELECT public.loomic_agent_task_activate_autonomous(${args},(SELECT prepared FROM qa_activation),true);
SELECT pg_temp.qa_assert((SELECT enabled AND task_revision=2 FROM public.agent_task_autonomy WHERE session_id='aa060000-0000-4000-8000-000000000001'),'activation and grant commit together');
SELECT pg_temp.qa_error($q$SELECT private.loomic_context_state('aa010000-0000-4000-8000-000000000001',
 'aa020000-0000-4000-8000-000000000001','aa060000-0000-4000-8000-000000000001',
 'aa070000-0000-4000-8000-000000000002',NULL)$q$,'agent_context_task_forbidden');
SELECT pg_temp.qa_assert(private.loomic_context_state('aa010000-0000-4000-8000-000000000001',
 'aa020000-0000-4000-8000-000000000001','aa060000-0000-4000-8000-000000000001',
 'aa070000-0000-4000-8000-000000000002',
 (SELECT id FROM public.agent_design_tasks WHERE session_id='aa060000-0000-4000-8000-000000000001'))->>'taskRevision'='2',
 'activated run requires the real task binding; stale unbound context remains forbidden');
SELECT public.loomic_agent_task_activate_autonomous(${args},(SELECT prepared FROM qa_activation),true);
SELECT pg_temp.qa_assert((SELECT revision=2 FROM public.agent_design_tasks WHERE session_id='aa060000-0000-4000-8000-000000000001'),'replay does not advance revision');
SELECT public.loomic_agent_autonomy('stop','aa010000-0000-4000-8000-000000000001','aa060000-0000-4000-8000-000000000001');
SELECT public.loomic_agent_task_activate_autonomous(${args},(SELECT prepared FROM qa_activation),true);
SELECT pg_temp.qa_assert((SELECT NOT enabled FROM public.agent_task_autonomy WHERE session_id='aa060000-0000-4000-8000-000000000001'),'replay does not override stop');
SELECT pg_temp.qa_assert(NOT has_function_privilege('authenticated','public.loomic_agent_task_activate_autonomous(uuid,uuid,uuid,uuid,text,jsonb,uuid,jsonb,boolean)','EXECUTE'),'clients cannot grant themselves autonomy');
ROLLBACK;`);
console.log('PASS atomic activation: injected grant failure rolls back, context rebind required, retry idempotent, stop preserved. All fixtures and DDL rolled back.');
