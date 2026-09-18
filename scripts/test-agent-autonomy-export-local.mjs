import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const database = 'loomic_replica_light_20260907';
const query = sql => execFileSync('docker', ['exec', '-i', 'supabase_db_thtdhcvjppuvlvahfmga', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', database, '-Atq'],
  { input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
if (query('SELECT current_database();').trim() !== database) throw new Error('Refusing non-local DB');
const migrations = [];
for (const name of ['20260910000001_agent_autonomy', '20260910000002_agent_confirmation_resume', '20260910000003_agent_target_scope', '20260910000004_agent_autonomy_commit_fence', '20260910000009_agent_autonomy_export_fence']) {
  if (query(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='${name.slice(0, 14)}'`).trim() === '0')
    migrations.push(await readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
}
const source = await readFile(new URL('../apps/server/src/features/agent-tasks/agent-task-local-db.qa.sql', import.meta.url), 'utf8');
const fixture = source.slice(0, source.indexOf('SELECT pg_temp.qa_error')).replace(/^BEGIN;\r?$/m, '');
const scope = await readFile(new URL('./test-agent-target-scope-local.mjs', import.meta.url), 'utf8');
const setup = scope.slice(scope.indexOf('DO $$\nDECLARE actor'), scope.indexOf('  PERFORM pg_temp.qa_assert(public.loomic_agent_target_scope_assert'))
  .replace('BEGIN\n', "  grant_value jsonb; task_value jsonb; lease uuid; request jsonb; result_value jsonb; job_id_value uuid; queue_before bigint;\nBEGIN\n");
query(`BEGIN;
${migrations.join('\n')}
${fixture}
CREATE FUNCTION pg_temp.qa_fail_export_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('loomic.qa_export_fail',true)='true' THEN RAISE EXCEPTION 'qa_export_ledger_failure'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER qa_export_ledger_failure BEFORE INSERT ON public.agent_autonomy_exports
  FOR EACH ROW EXECUTE FUNCTION pg_temp.qa_fail_export_ledger();
${setup}
  PERFORM public.loomic_agent_target_scope_activate(actor,session,run1,1,jsonb_build_array(primary_target,selected_target-'objectIds'));
  UPDATE public.agent_runs SET status='completed' WHERE session_id=session;
  task_value:=public.loomic_agent_task_current(actor,session);
  PERFORM public.loomic_agent_autonomy('grant',actor,session,jsonb_build_object('taskId',task_value->>'id','revision',1,'originRunId',run1,'explicit',true));
  grant_value:=public.loomic_agent_autonomy('claim',actor,session,'{}'); lease:=(grant_value->>'claim_token')::uuid;
  request:=jsonb_build_object('idempotency_key',extensions.gen_random_uuid(),'design_id',selected_design,
    'expected_revision',0,'format','png','multiplier',1,'transparent',false);
  SELECT count(*) INTO queue_before FROM pgmq.q_design_export_jobs;
  PERFORM pg_temp.qa_error(format('SELECT public.loomic_autonomy_export_design(%L,%L,%L,%L::jsonb)',actor,session,lease,
    jsonb_set(request,'{design_id}',to_jsonb(unlisted_design))),'autonomy_export_target_mismatch');
  PERFORM pg_temp.qa_error(format('SELECT public.loomic_autonomy_export_design(%L,%L,%L,%L::jsonb)',actor,session,lease,
    jsonb_set(request,'{expected_revision}','1')),'autonomy_export_revision_conflict');
  UPDATE public.agent_task_target_scopes SET target=target||jsonb_build_object('objectIds',jsonb_build_array(selected_object))
    WHERE task_id=(task_value->>'id')::uuid AND target->>'designId'=selected_design::text;
  PERFORM pg_temp.qa_error(format('SELECT public.loomic_autonomy_export_design(%L,%L,%L,%L::jsonb)',actor,session,lease,request),'autonomy_export_target_mismatch');
  UPDATE public.agent_task_target_scopes SET target=target-'objectIds'
    WHERE task_id=(task_value->>'id')::uuid AND target->>'designId'=selected_design::text;
  PERFORM set_config('loomic.qa_export_fail','true',true);
  PERFORM pg_temp.qa_error(format('SELECT public.loomic_autonomy_export_design(%L,%L,%L,%L::jsonb)',actor,session,lease,request),'qa_export_ledger_failure');
  PERFORM set_config('loomic.qa_export_fail','false',true);
  PERFORM pg_temp.qa_assert((SELECT count(*)=queue_before FROM pgmq.q_design_export_jobs),'post-enqueue failure rolls back PGMQ message');
  PERFORM pg_temp.qa_assert(NOT EXISTS(SELECT 1 FROM public.background_jobs WHERE created_by=actor AND job_type='design_export'),'post-enqueue failure rolls back job row');
  result_value:=public.loomic_autonomy_export_design(actor,session,lease,request);
  job_id_value:=(result_value->>'job_id')::uuid;
  PERFORM pg_temp.qa_assert(result_value->>'status'='queued' AND result_value->>'replayed'='false','actual export admitted');
  PERFORM pg_temp.qa_assert((SELECT count(*)=1 FROM public.background_jobs WHERE id=job_id_value AND payload->>'revision'='0'
    AND created_by=actor AND session_id=session AND design_id=selected_design AND target_kind='design'),'exact durable job');
  PERFORM pg_temp.qa_assert((SELECT count(*)=1 FROM pgmq.q_design_export_jobs WHERE message->>'job_id'=job_id_value::text),'one actual PGMQ delivery');
  PERFORM pg_temp.qa_assert(public.loomic_autonomy_export_design(actor,session,lease,request)->>'replayed'='true','exact replay');
  PERFORM pg_temp.qa_assert(jsonb_array_length(public.loomic_autonomy_export_status(actor,session,lease))=1,'ledger status visible');
  PERFORM pg_temp.qa_error(format('SELECT public.loomic_autonomy_export_design(%L,%L,%L,%L::jsonb)',actor,session,lease,
    jsonb_set(request,'{multiplier}','2')),'autonomy_export_idempotency_conflict');
  PERFORM pg_temp.qa_error(format('UPDATE public.background_jobs SET payload=jsonb_set(payload,%L,%L::jsonb) WHERE id=%L',
    '{revision}','2',job_id_value),'autonomy_export_job_immutable');
  PERFORM set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
  PERFORM pg_temp.qa_error(format('UPDATE public.background_jobs SET status=%L,result=%L::jsonb WHERE id=%L',
    'succeeded','{}',job_id_value),'autonomy_export_worker_required');
  PERFORM pg_temp.qa_error(format('DELETE FROM public.background_jobs WHERE id=%L',job_id_value),'autonomy_export_worker_required');
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM pg_temp.qa_assert((SELECT count(*)=queue_before+1 FROM pgmq.q_design_export_jobs),'retries do not duplicate queue delivery');
  PERFORM public.loomic_agent_autonomy('stop',actor,session,'{}');
  request:=jsonb_set(request,'{idempotency_key}',to_jsonb(extensions.gen_random_uuid()));
  PERFORM pg_temp.qa_error(format('SELECT public.loomic_autonomy_export_design(%L,%L,%L,%L::jsonb)',actor,session,lease,request),'autonomy_authorization_expired');
  PERFORM pg_temp.qa_assert((SELECT count(*)=1 FROM public.agent_autonomy_exports WHERE task_id=(task_value->>'id')::uuid),'stop creates no ledger');
  PERFORM pg_temp.qa_assert((SELECT count(*)=queue_before+1 FROM pgmq.q_design_export_jobs),'stop creates no message');
  PERFORM pg_temp.qa_assert(NOT has_function_privilege('authenticated','public.loomic_autonomy_export_design(uuid,uuid,uuid,jsonb)','EXECUTE'),'browser cannot create leased export');
END $$;
ROLLBACK;`);
console.log('PASS: actual atomic export job + PGMQ, target/revision fences, immutable payload, idempotent replay, stop denial. All synthetic rows/messages rolled back.');
