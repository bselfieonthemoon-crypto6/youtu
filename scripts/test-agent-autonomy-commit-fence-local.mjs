import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const database = 'loomic_replica_light_20260907';
const query = sql => execFileSync('docker', ['exec', '-i', 'supabase_db_thtdhcvjppuvlvahfmga', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', database, '-Atq'],
  { input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
if (query('SELECT current_database();').trim() !== database) throw new Error('Refusing non-local DB');
const migrations = [];
for (const name of ['20260910000001_agent_autonomy', '20260910000002_agent_confirmation_resume', '20260910000003_agent_target_scope', '20260910000004_agent_autonomy_commit_fence']) {
  if (query(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='${name.slice(0, 14)}'`).trim() === '0')
    migrations.push(await readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
}
const source = await readFile(new URL('../apps/server/src/features/agent-tasks/agent-task-local-db.qa.sql', import.meta.url), 'utf8');
const fixture = source.slice(0, source.indexOf('SELECT pg_temp.qa_error')).replace(/^BEGIN;\r?$/m, '');
// Reuse the native design fixture and actual audited mutation RPC from scope QA.
const scope = await readFile(new URL('./test-agent-target-scope-local.mjs', import.meta.url), 'utf8');
const helper = scope.slice(scope.indexOf('CREATE FUNCTION pg_temp.qa_mutate_title'), scope.indexOf('DO $$\nDECLARE actor'))
  .replace('new_text text)', 'new_text text,p_tool uuid)')
  .replace('tool_id uuid:=extensions.gen_random_uuid()', 'tool_id uuid:=p_tool')
  .replace(/  INSERT INTO public\.tool_executions[\s\S]+?actor\);\n/, '');
const setup = scope.slice(scope.indexOf('DO $$\nDECLARE actor'), scope.indexOf('  PERFORM pg_temp.qa_assert(public.loomic_agent_target_scope_assert'))
  .replace('BEGIN\n', "  grant_value jsonb; task_value jsonb; lease uuid; first_tool uuid:=extensions.gen_random_uuid(); late_tool uuid:=extensions.gen_random_uuid(); proposal uuid:='ad080000-0000-4000-8000-000000000001'; confirmation uuid:=extensions.gen_random_uuid(); mutation uuid:=extensions.gen_random_uuid(); frozen jsonb; current_doc public.design_documents;\nBEGIN\n");
query(`BEGIN;
${migrations.join('\n')}
${fixture}
${helper}
${setup}
  PERFORM public.loomic_agent_target_scope_activate(actor,session,run1,1,jsonb_build_array(primary_target,selected_target-'objectIds'));
  UPDATE public.agent_runs SET status='completed' WHERE session_id=session;
  task_value:=public.loomic_agent_task_current(actor,session);
  PERFORM public.loomic_agent_autonomy('grant',actor,session,jsonb_build_object('taskId',task_value->>'id','revision',1,'originRunId',run1,'explicit',true));
  grant_value:=public.loomic_agent_autonomy('claim',actor,session,'{}'); lease:=(grant_value->>'claim_token')::uuid;
  PERFORM pg_temp.qa_assert(lease IS NOT NULL,'claim exists');
  PERFORM public.loomic_autonomy_start_tool(actor,session,lease,first_tool,'manipulate_design',NULL);
  PERFORM pg_temp.qa_mutate_title(selected_design,run1,actor,selected_object,'AUTOMATIC',first_tool);
  PERFORM pg_temp.qa_assert((SELECT document.scene#>>'{objects,0,text}'='AUTOMATIC' FROM public.design_documents document WHERE document.id=selected_design),'live lease native mutation succeeds');
  PERFORM public.loomic_autonomy_start_tool(actor,session,lease,late_tool,'manipulate_design',NULL);
  SELECT * INTO current_doc FROM public.design_documents WHERE id=selected_design;
  frozen:=jsonb_build_object('design_id',selected_design,'expected_revision',current_doc.revision,'idempotency_key',mutation,
    'commands',jsonb_build_array(jsonb_build_object('action','object.remove','object_id',unlisted_object,'expected_object_version',1)));
  PERFORM public.loomic_create_agent_action_confirmation(confirmation,'design_mutation',actor,workspace,session,origin_canvas,
    (task_value->>'id')::uuid,1,run1,late_tool,NULL,'{}',frozen,now()+interval '10 minutes');
  INSERT INTO public.image_generation_proposals(id,session_id,canvas_id,created_by,origin_run_id,input,details,status,approved_cost)
    VALUES(proposal,session,origin_canvas,actor,run1,'{"prompt":"fixture","model":"fixture"}','{}','confirmed',0);
  PERFORM public.loomic_autonomy_reserve_image(actor,session,lease,proposal);
  INSERT INTO public.background_jobs(id,workspace_id,project_id,canvas_id,target_kind,session_id,queue_name,job_type,status,payload,created_by)
    VALUES(proposal,workspace,project,origin_canvas,'canvas',session,'image_generation_jobs','image_generation','queued',
      jsonb_build_object('prompt','fixture','model','fixture','aspect_ratio','1:1','origin_run_id',run1,'source_element_id','source-a','source_asset_id','aa050000-0000-4000-8000-000000000001','target',jsonb_build_object('kind','canvas','canvas_id',origin_canvas,'element_id','fixture-placeholder')),actor);
  UPDATE public.canvases SET content=jsonb_set(content,'{elements}',content->'elements'||jsonb_build_array(
    jsonb_build_object('id','fixture-placeholder','type','image','customData',jsonb_build_object('type','image-generator','jobId',proposal)))) WHERE id=origin_canvas;
  PERFORM public.loomic_agent_autonomy('stop',actor,session,'{}');
  PERFORM pg_temp.qa_error(format('SELECT pg_temp.qa_mutate_title(%L,%L,%L,%L,%L,%L)',selected_design,run1,actor,selected_object,'LATE',late_tool),'autonomy_authorization_expired');
  PERFORM pg_temp.qa_assert((SELECT document.scene#>>'{objects,0,text}'='AUTOMATIC' FROM public.design_documents document WHERE document.id=selected_design),'late native scene rolled back');
  PERFORM pg_temp.qa_assert(NOT EXISTS(SELECT 1 FROM public.design_agent_tool_requests WHERE tool_execution_id=late_tool),'late native audit request rolled back');
  PERFORM pg_temp.qa_error(format('UPDATE public.background_jobs SET credits_cost=10 WHERE id=%L',proposal),'autonomy_authorization_expired');
  PERFORM pg_temp.qa_error(format('UPDATE public.background_jobs SET image_enqueued_at=now() WHERE id=%L',proposal),'autonomy_authorization_expired');
  PERFORM pg_temp.qa_error(format('SELECT public.loomic_commit_image_job(%L)',proposal),'autonomy_authorization_expired');
  PERFORM pg_temp.qa_assert((SELECT credits_cost IS NULL AND image_enqueued_at IS NULL FROM public.background_jobs WHERE id=proposal),'stop prevents billing and enqueue');
  PERFORM pg_temp.qa_error(format('SELECT public.loomic_autonomy_start_tool(%L,%L,%L,%L,%L,NULL)',actor,session,lease,extensions.gen_random_uuid(),'manipulate_design'),'autonomy_authorization_expired');
  PERFORM pg_temp.qa_assert(NOT has_function_privilege('authenticated','public.loomic_autonomy_start_tool(uuid,uuid,uuid,uuid,text,jsonb)','EXECUTE'),'untrusted caller cannot mint lease ledger');
  PERFORM pg_temp.qa_assert(NOT has_table_privilege('authenticated','public.agent_autonomy_image_leases','SELECT'),'lease tokens are not browser-readable');
  PERFORM pg_temp.qa_assert(public.loomic_claim_agent_action_confirmation(confirmation,actor,origin_canvas)->>'state'='claimed','explicit user confirmation survives automatic stop');
  scene:=jsonb_set(current_doc.scene,'{objects}',jsonb_build_array(current_doc.scene#>'{objects,0}'));
  PERFORM public.loomic_agent_design_mutate_v2('manipulate_design',selected_design,current_doc.revision,mutation,
    frozen->'commands',scene,actor,run1,late_tool,NULL,NULL,confirmation,true);
  PERFORM pg_temp.qa_assert((SELECT jsonb_array_length(document.scene->'objects')=1 FROM public.design_documents document WHERE document.id=selected_design),'exact explicitly confirmed deletion commits after auto stop');
END $$;
ROLLBACK;`);
console.log('PASS: actual native mutation/rollback, atomic ledger, stopped image billing/enqueue, restricted RPC and lease visibility. All local fixtures rolled back.');
