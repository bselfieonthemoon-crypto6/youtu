import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const container = 'supabase_db_thtdhcvjppuvlvahfmga';
const database = 'loomic_replica_light_20260907';
const query = sql => execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', database, '-Atq'],
  { input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
if (query('SELECT current_database();').trim() !== database) throw new Error('Refusing non-local database');
const migrations = [];
for (const name of ['20260909000017_agent_task_continuations', '20260909000018_agent_workflow_cas']) {
  if (query(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='${name.slice(0, 14)}';`).trim() === '0')
    migrations.push(await readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
}
const source = await readFile(new URL('../apps/server/src/features/agent-tasks/agent-task-local-db.qa.sql', import.meta.url), 'utf8');
const fixture = source.slice(0, source.indexOf('SELECT pg_temp.qa_error')).replace(/^BEGIN;\r?$/m, '');
const job = n => `INSERT INTO public.background_jobs(id,workspace_id,project_id,canvas_id,target_kind,session_id,queue_name,job_type,status,payload,result,created_by) VALUES
('aa080000-0000-4000-8000-00000000000${n}','aa020000-0000-4000-8000-000000000001','aa030000-0000-4000-8000-000000000001',
 'aa040000-0000-4000-8000-000000000001','canvas','aa060000-0000-4000-8000-000000000001','image_generation_jobs','image_generation','succeeded',
 '{"origin_run_id":"aa070000-0000-4000-8000-000000000001","source_element_id":"source-a","source_asset_id":"aa050000-0000-4000-8000-000000000001","target":{"kind":"canvas","canvas_id":"aa040000-0000-4000-8000-000000000001","element_id":"output-${n}"}}',
 '{"asset_id":"aa050000-0000-4000-8000-000000000003"}','aa010000-0000-4000-8000-000000000001');
 UPDATE public.background_jobs SET result=result||'{"canvas_finalized_at":"2026-09-09T10:00:00Z"}' WHERE id='aa080000-0000-4000-8000-00000000000${n}';`;
const deadLetterJob = n => `INSERT INTO public.background_jobs(id,workspace_id,project_id,canvas_id,target_kind,session_id,queue_name,job_type,status,payload,result,created_by) VALUES
('aa080000-0000-4000-8000-00000000000${n}','aa020000-0000-4000-8000-000000000001','aa030000-0000-4000-8000-000000000001',
 'aa040000-0000-4000-8000-000000000001','canvas','aa060000-0000-4000-8000-000000000001','image_generation_jobs','image_generation','dead_letter',
 '{"origin_run_id":"aa070000-0000-4000-8000-000000000001","source_element_id":"source-a","source_asset_id":"aa050000-0000-4000-8000-000000000001","target":{"kind":"canvas","canvas_id":"aa040000-0000-4000-8000-000000000001","element_id":"output-${n}"}}',
 '{}','aa010000-0000-4000-8000-000000000001');
 UPDATE public.background_jobs SET result='{"terminal_test":true}' WHERE id='aa080000-0000-4000-8000-00000000000${n}';`;
const user = "'aa010000-0000-4000-8000-000000000001'";
const session = "'aa060000-0000-4000-8000-000000000001'";
const sql = `BEGIN;
${migrations.join('\n')}
${fixture}
CREATE TEMP TABLE qa_workflow AS
SELECT public.loomic_agent_task_current(${user},${session}) AS task;
SELECT public.loomic_agent_task_update_workflow(
  'aa070000-0000-4000-8000-000000000001',1,NULL,
  jsonb_build_object(
    'version',1,
    'workflowId','ab000000-0000-4000-8000-000000000001',
    'workflowRevision',1,
    'taskId',(SELECT task->>'id' FROM qa_workflow),
    'taskRevision',1,
    'runId','aa070000-0000-4000-8000-000000000001',
    'title','QA workflow',
    'status','ready',
    'authority','planning_snapshot_not_execution_authority',
    'steps',jsonb_build_array(jsonb_build_object(
      'stepId','deliver','title','Deliver','intent','Apply and verify',
      'dependsOn','[]'::jsonb,'status','ready','requiresTargetConfirmation',false,
      'proposalIds','[]'::jsonb,'proposalJobs','{}'::jsonb,'jobs','[]'::jsonb,'results','[]'::jsonb
    )),
    'createdAt','2026-09-09T00:00:00.000Z',
    'updatedAt','2026-09-09T00:00:00.000Z'
  )
);
UPDATE qa_workflow SET task=public.loomic_agent_task_assert_current(
  'aa070000-0000-4000-8000-000000000001'
);
SELECT pg_temp.qa_error($q$
  SELECT public.loomic_agent_task_update_workflow(
    'aa070000-0000-4000-8000-000000000001',1,NULL,
    (SELECT task->'brief'->'agentWorkflow' FROM qa_workflow)
  )
$q$,'agent_workflow_revision_conflict');
SELECT public.loomic_agent_task_update_brief(
  'aa070000-0000-4000-8000-000000000001',
  '{"goal":"Ordinary brief update","preserve":[],"changes":[],"acceptance":[],"questions":[],"agentWorkflow":{"workflowRevision":999}}'
);
SELECT pg_temp.qa_assert(
  (public.loomic_agent_task_assert_current('aa070000-0000-4000-8000-000000000001')#>>'{brief,agentWorkflow,workflowRevision}')='1',
  'ordinary brief update preserves the database workflow instead of accepting replacement metadata'
);
${job(1)}
SELECT pg_temp.qa_assert((SELECT count(*)=1 FROM public.agent_task_continuations WHERE session_id=${session}),'terminal marker creates exactly one durable event');
SELECT pg_temp.qa_assert(public.loomic_claim_agent_continuation(${user},${session}) IS NULL,'active agent prevents concurrent continuation');
UPDATE public.agent_runs SET status='completed' WHERE session_id=${session};
SELECT pg_temp.qa_assert(public.loomic_claim_agent_continuation('aa010000-0000-4000-8000-000000000002',${session}) IS NULL,'foreign user cannot claim');
CREATE TEMP TABLE qa_claim AS SELECT public.loomic_claim_agent_continuation(${user},${session}) AS event;
SELECT pg_temp.qa_assert((SELECT event->>'job_id'='aa080000-0000-4000-8000-000000000001' FROM qa_claim),'claim has correct job');
SELECT pg_temp.qa_assert(public.loomic_claim_agent_continuation(${user},${session}) IS NULL,'duplicate tab cannot claim running event');
SELECT pg_temp.qa_assert(public.loomic_agent_continuation_active(${user},'aa080000-0000-4000-8000-000000000001',(SELECT (event->>'claim_token')::uuid FROM qa_claim)),'claim is active');
SELECT pg_temp.qa_assert(NOT public.loomic_finish_agent_continuation(${user},'aa080000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000000','completed','{}'),'wrong lease cannot finish');
SELECT pg_temp.qa_assert(NOT public.loomic_bind_agent_continuation_run(${user},'aa080000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000000','aa090000-0000-4000-8000-000000000001'),'wrong lease cannot bind continuation run');
SELECT pg_temp.qa_assert(public.loomic_bind_agent_continuation_run(${user},'aa080000-0000-4000-8000-000000000001',(SELECT (event->>'claim_token')::uuid FROM qa_claim),'aa090000-0000-4000-8000-000000000001'),'active lease binds exact continuation run');
INSERT INTO public.agent_runs(id,session_id,thread_id,status,execution_mode,created_by) VALUES
('aa090000-0000-4000-8000-000000000001',${session},'task-qa-a:result:1','accepted','thinking',${user});
SELECT pg_temp.qa_assert((SELECT status='running' FROM public.agent_task_continuations WHERE job_id='aa080000-0000-4000-8000-000000000001'),'bound continuation run does not supersede itself');
SELECT pg_temp.qa_assert(public.loomic_finish_agent_continuation(${user},'aa080000-0000-4000-8000-000000000001',(SELECT (event->>'claim_token')::uuid FROM qa_claim),'completed',
 '{"runId":"aa090000-0000-4000-8000-000000000001","content":"Read-only result verified"}'),'finish succeeds');
SELECT pg_temp.qa_assert((SELECT count(*)=1 FROM public.chat_messages WHERE id='aa090000-0000-4000-8000-000000000001'),'chat and event persisted together');
UPDATE public.agent_runs SET status='completed',completed_at=now() WHERE id='aa090000-0000-4000-8000-000000000001';
UPDATE public.background_jobs SET result=result||'{"chat_finalized_at":"2026-09-09T10:01:00Z"}' WHERE id='aa080000-0000-4000-8000-000000000001';
SELECT pg_temp.qa_assert((SELECT count(*)=1 FROM public.agent_task_continuations WHERE session_id=${session}),'recovery marker cannot duplicate event');
${job(2)}
${job(3)}
TRUNCATE qa_claim; INSERT INTO qa_claim SELECT public.loomic_claim_agent_continuation(${user},${session});
SELECT public.loomic_stop_agent_continuations(${user},${session});
SELECT pg_temp.qa_assert(NOT public.loomic_agent_continuation_active(${user},'aa080000-0000-4000-8000-000000000002',(SELECT (event->>'claim_token')::uuid FROM qa_claim)),'stop fences subsequent calls');
SELECT pg_temp.qa_assert(NOT public.loomic_finish_agent_continuation(${user},'aa080000-0000-4000-8000-000000000002',(SELECT (event->>'claim_token')::uuid FROM qa_claim),'completed','{}'),'late stopped completion rejected');
SELECT pg_temp.qa_assert((SELECT count(*)=2 FROM public.agent_task_continuations WHERE job_id IN ('aa080000-0000-4000-8000-000000000002','aa080000-0000-4000-8000-000000000003') AND status='needs_attention' AND outcome->>'reason'='review_stopped'),'stop terminates both running and pending reviews');
${job(4)}
TRUNCATE qa_claim; INSERT INTO qa_claim SELECT public.loomic_claim_agent_continuation(${user},${session});
UPDATE public.agent_task_continuations SET claimed_at=now()-interval '4 minutes' WHERE job_id='aa080000-0000-4000-8000-000000000004';
SELECT public.loomic_claim_agent_continuation(${user},${session});
SELECT pg_temp.qa_assert((SELECT status='needs_attention' FROM public.agent_task_continuations WHERE job_id='aa080000-0000-4000-8000-000000000004'),'unknown provider outcome is not retried');
${job(5)}
TRUNCATE qa_claim; INSERT INTO qa_claim SELECT public.loomic_claim_agent_continuation(${user},${session});
SELECT pg_temp.qa_assert(public.loomic_bind_agent_continuation_run(${user},'aa080000-0000-4000-8000-000000000005',(SELECT (event->>'claim_token')::uuid FROM qa_claim),'aa090000-0000-4000-8000-000000000002'),'race fixture binds proposed continuation run');
INSERT INTO public.agent_runs(id,session_id,thread_id,status,execution_mode,created_by) VALUES
('aa070000-0000-4000-8000-000000000005',${session},'task-qa-a:new-user-run','accepted','fast',${user});
SELECT pg_temp.qa_assert((SELECT status='superseded' AND outcome->>'reason'='new_user_run' FROM public.agent_task_continuations WHERE job_id='aa080000-0000-4000-8000-000000000005'),'new user run atomically supersedes an older continuation lease');
SELECT pg_temp.qa_assert(NOT public.loomic_agent_continuation_active(${user},'aa080000-0000-4000-8000-000000000005',(SELECT (event->>'claim_token')::uuid FROM qa_claim)),'superseded continuation cannot make a model call');
UPDATE public.agent_runs SET status='completed',completed_at=now() WHERE id='aa070000-0000-4000-8000-000000000005';
${deadLetterJob(6)}
SELECT pg_temp.qa_assert((SELECT status='pending' FROM public.agent_task_continuations WHERE job_id='aa080000-0000-4000-8000-000000000006'),'dead-letter image result creates a terminal continuation event');
TRUNCATE qa_claim; INSERT INTO qa_claim SELECT public.loomic_claim_agent_continuation(${user},${session});
SELECT pg_temp.qa_assert(public.loomic_finish_agent_continuation(${user},'aa080000-0000-4000-8000-000000000006',(SELECT (event->>'claim_token')::uuid FROM qa_claim),'needs_attention','{"reason":"generation_failed_or_canceled"}'),'dead-letter event can reach needs-attention instead of waiting forever');
${job(7)}
UPDATE public.agent_runs SET status='running' WHERE id='aa070000-0000-4000-8000-000000000002';
SELECT public.loomic_agent_task_begin(${user},${session},'aa040000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000002','Stop generation, move only',NULL,'aa070000-0000-4000-8000-000000000001');
SELECT pg_temp.qa_error($q$
  SELECT public.loomic_agent_task_update_workflow(
    'aa070000-0000-4000-8000-000000000001',1,1,
    jsonb_build_object(
      'version',1,'workflowId','ab000000-0000-4000-8000-000000000001','workflowRevision',2,
      'taskId',(SELECT task->>'id' FROM qa_workflow),'taskRevision',1,
      'runId','aa070000-0000-4000-8000-000000000001'
    )
  )
$q$,'agent_task_superseded');
SELECT pg_temp.qa_assert(public.loomic_claim_agent_continuation(${user},${session}) IS NULL,'old task revision cannot resume');
SELECT pg_temp.qa_assert((SELECT status='superseded' FROM public.agent_task_continuations WHERE job_id='aa080000-0000-4000-8000-000000000007'),'stale event marked superseded');
SELECT pg_temp.qa_assert(NOT has_function_privilege('authenticated','public.loomic_claim_agent_continuation(uuid,uuid)','EXECUTE'),'browser cannot bypass server claim boundary');
SELECT pg_temp.qa_assert(NOT has_function_privilege('authenticated','public.loomic_bind_agent_continuation_run(uuid,uuid,uuid,uuid)','EXECUTE'),'browser cannot bind a continuation run');
SELECT pg_temp.qa_assert(NOT has_table_privilege('authenticated','public.agent_task_continuations','SELECT'),'events not exposed to arbitrary users');
ROLLBACK;
SELECT 'PASS: durable result events, workflow CAS and metadata preservation, all terminal states, auth, duplicate claims, atomic run lease/chat, stop, new-run race, crash and correction fencing; all test data rolled back';
`;
console.log(query(sql).trim().split('\n').filter(Boolean).at(-1));
