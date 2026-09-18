import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const database = 'loomic_replica_light_20260907';
const query = sql => execFileSync('docker', ['exec', '-i', 'supabase_db_thtdhcvjppuvlvahfmga', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', database, '-Atq'],
  { input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
if (query('SELECT current_database();').trim() !== database) throw new Error('Refusing non-local DB');
const migration = await readFile(new URL('../supabase/migrations/20260910000001_agent_autonomy.sql', import.meta.url), 'utf8');
const applied = query("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='20260910000001'").trim() !== '0';
const source = await readFile(new URL('../apps/server/src/features/agent-tasks/agent-task-local-db.qa.sql', import.meta.url), 'utf8');
const fixture = source.slice(0, source.indexOf('SELECT pg_temp.qa_error')).replace(/^BEGIN;\r?$/m, '');
const user = "'aa010000-0000-4000-8000-000000000001'";
const session = "'aa060000-0000-4000-8000-000000000001'";
const invoke = (action, args = "'{}'") => `public.loomic_agent_autonomy('${action}',${user},${session},${args})`;
const sql = `BEGIN;
${applied ? '' : migration}
${fixture}
CREATE TEMP TABLE qa_autonomy_task AS SELECT public.loomic_agent_task_current(${user},${session}) AS task;
SELECT ${invoke('preference', "'{\"enabled\":true}'")};
CREATE TEMP TABLE qa_autonomy_grant AS SELECT ${invoke('grant', "(SELECT jsonb_build_object('taskId',task->>'id','revision',task->>'revision','originRunId',task->>'runId') FROM qa_autonomy_task)")} AS g;
SELECT pg_temp.qa_assert(${invoke('claim')} IS NULL,'active foreground run blocks background claim');
UPDATE public.agent_runs SET status='completed' WHERE session_id=${session};
UPDATE qa_autonomy_grant SET g=${invoke('claim')};
SELECT pg_temp.qa_assert((SELECT g->>'state'='running' FROM qa_autonomy_grant),'durable grant claims after foreground completes');
SELECT pg_temp.qa_assert(${invoke('claim')} IS NULL,'concurrent scheduler cannot claim twice');
SELECT pg_temp.qa_assert(${invoke('active', "'{\"token\":\"00000000-0000-4000-8000-000000000000\"}'")} IS NULL,'wrong lease cannot execute');
SELECT pg_temp.qa_assert(public.loomic_agent_autonomy('status','aa010000-0000-4000-8000-000000000002',${session},'{}') IS NULL,'foreign user cannot read grant');
INSERT INTO public.image_generation_proposals(id,session_id,canvas_id,created_by,origin_run_id,input,details,status)
 SELECT ('ab080000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,${session},'aa040000-0000-4000-8000-000000000001',${user},
 'aa070000-0000-4000-8000-000000000001','{}','{}','confirmed' FROM generate_series(1,9) i;
DO $$BEGIN FOR i IN 1..8 LOOP PERFORM ${invoke('image', "(SELECT jsonb_build_object('token',g->>'claim_token','proposalId','ab080000-0000-4000-8000-'||lpad(i::text,12,'0')) FROM qa_autonomy_grant)")}; END LOOP; END$$;
SELECT ${invoke('image', "(SELECT jsonb_build_object('token',g->>'claim_token','proposalId','ab080000-0000-4000-8000-000000000001') FROM qa_autonomy_grant)")};
SELECT pg_temp.qa_assert((SELECT cardinality(image_proposals)=8 FROM public.agent_task_autonomy WHERE session_id=${session}),'replayed proposal reservation is idempotent');
SELECT pg_temp.qa_error($q$SELECT ${invoke('image', "(SELECT jsonb_build_object('token',g->>'claim_token','proposalId','ab080000-0000-4000-8000-000000000009') FROM qa_autonomy_grant)")}$q$,'autonomy_image_budget_exhausted');
DO $$BEGIN FOR i IN 1..24 LOOP PERFORM ${invoke('round', "(SELECT jsonb_build_object('token',g->>'claim_token') FROM qa_autonomy_grant)")}; END LOOP; END$$;
SELECT pg_temp.qa_error($q$SELECT ${invoke('round', "(SELECT jsonb_build_object('token',g->>'claim_token') FROM qa_autonomy_grant)")}$q$,'autonomy_round_budget_exhausted');
SELECT ${invoke('bind', "(SELECT jsonb_build_object('token',g->>'claim_token','runId','ab090000-0000-4000-8000-000000000001') FROM qa_autonomy_grant)")};
INSERT INTO public.agent_runs(id,session_id,thread_id,status,execution_mode,created_by) VALUES
('ab090000-0000-4000-8000-000000000001',${session},'autonomy-test','accepted','thinking',${user});
SELECT pg_temp.qa_assert(${invoke('active', "(SELECT jsonb_build_object('token',g->>'claim_token') FROM qa_autonomy_grant)")} IS NOT NULL,'bound autonomous run does not revoke its own grant');
SELECT ${invoke('stop')};
SELECT pg_temp.qa_assert(${invoke('active', "(SELECT jsonb_build_object('token',g->>'claim_token') FROM qa_autonomy_grant)")} IS NULL,'stop fences late tool writes');
SELECT ${invoke('grant', "(SELECT jsonb_build_object('taskId',task->>'id','revision',task->>'revision','originRunId',task->>'runId') FROM qa_autonomy_task)")};
SELECT pg_temp.qa_assert((SELECT NOT enabled AND rounds=24 FROM public.agent_task_autonomy WHERE session_id=${session}),'automatic enrollment preserves explicit stop and consumed budget');
SELECT pg_temp.qa_assert(NOT has_function_privilege('authenticated','public.loomic_agent_autonomy(text,uuid,uuid,jsonb)','EXECUTE'),'untrusted clients cannot mint autonomy grants');
ROLLBACK;`;
query(sql);
console.log('Agent autonomy local transactional QA passed; all fixtures rolled back.');
