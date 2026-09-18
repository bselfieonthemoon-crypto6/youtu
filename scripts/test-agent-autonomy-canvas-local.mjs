import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const database = 'loomic_replica_light_20260907';
const query = sql => execFileSync('docker', ['exec', '-i', 'supabase_db_thtdhcvjppuvlvahfmga', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', database, '-Atq'],
  { input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
if (query('SELECT current_database();').trim() !== database) throw new Error('Refusing non-local DB');
const migrations = [];
for (const name of ['20260910000001_agent_autonomy', '20260910000002_agent_confirmation_resume', '20260910000003_agent_target_scope', '20260910000004_agent_autonomy_commit_fence', '20260910000006_agent_autonomy_canvas_writes']) {
  if (query(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='${name.slice(0, 14)}'`).trim() === '0')
    migrations.push(await readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
}
const source = await readFile(new URL('../apps/server/src/features/agent-tasks/agent-task-local-db.qa.sql', import.meta.url), 'utf8');
const fixture = source.slice(0, source.indexOf('SELECT pg_temp.qa_error')).replace(/^BEGIN;\r?$/m, '');
const scope = await readFile(new URL('./test-agent-target-scope-local.mjs', import.meta.url), 'utf8');
const setup = scope.slice(scope.indexOf('DO $$\nDECLARE actor'), scope.indexOf('  PERFORM pg_temp.qa_assert(public.loomic_agent_target_scope_assert'))
  .replace('BEGIN\n', "  grant_value jsonb; task_value jsonb; lease uuid; request jsonb; result_value jsonb; original_canvas jsonb;\nBEGIN\n");
query(`BEGIN;
${migrations.join('\n')}
${fixture}
${setup}
  UPDATE public.design_nodes SET canvas_id=origin_canvas WHERE design_id IN (selected_design,unlisted_design);
  UPDATE public.canvases SET content=jsonb_set(content,'{elements}',content->'elements'||jsonb_build_array(
    jsonb_build_object('id','selected-design','type','embeddable','version',1,'x',0,'y',0,'width',640,'height',360,
      'customData',jsonb_build_object('kind','loomic-design','designId',selected_design)),
    jsonb_build_object('id','unlisted-design','type','embeddable','version',1,'x',700,'y',0,'width',640,'height',360,
      'customData',jsonb_build_object('kind','loomic-design','designId',unlisted_design))
  )) WHERE id=origin_canvas;
  PERFORM public.loomic_agent_target_scope_activate(actor,session,run1,1,jsonb_build_array(primary_target,
    jsonb_build_object('kind','design','designId',selected_design,'elementId','selected-design')));
  UPDATE public.agent_runs SET status='completed' WHERE session_id=session;
  task_value:=public.loomic_agent_task_current(actor,session);
  PERFORM public.loomic_agent_autonomy('grant',actor,session,jsonb_build_object('taskId',task_value->>'id','revision',1,'originRunId',run1,'explicit',true));
  grant_value:=public.loomic_agent_autonomy('claim',actor,session,'{}'); lease:=(grant_value->>'claim_token')::uuid;
  request:=jsonb_build_object('idempotency_key',extensions.gen_random_uuid(),'positions',jsonb_build_array(
    jsonb_build_object('design_id',selected_design,'element_id','selected-design','expected_version',1,'expected_x',0,'expected_y',0,'x',100,'y',200)));
  SELECT content INTO original_canvas FROM public.canvases WHERE id=origin_canvas;
  UPDATE public.agent_task_target_scopes SET target=target||jsonb_build_object('objectIds',jsonb_build_array(selected_object))
    WHERE task_id=(task_value->>'id')::uuid AND target->>'designId'=selected_design::text;
  PERFORM pg_temp.qa_error(format('SELECT public.loomic_autonomy_arrange_design_boards(%L,%L,%L,%L::jsonb)',actor,session,lease,request),'autonomy_canvas_target_mismatch');
  UPDATE public.agent_task_target_scopes SET target=target-'objectIds'
    WHERE task_id=(task_value->>'id')::uuid AND target->>'designId'=selected_design::text;
  PERFORM pg_temp.qa_error(format('SELECT public.loomic_autonomy_arrange_design_boards(%L,%L,%L,%L::jsonb)',actor,session,lease,
    jsonb_set(request,'{positions,0,element_id}','"unlisted-design"')),'autonomy_canvas_target_mismatch');
  PERFORM pg_temp.qa_error(format('SELECT public.loomic_autonomy_arrange_design_boards(%L,%L,%L,%L::jsonb)',actor,session,lease,
    jsonb_set(request,'{positions}',(request->'positions')||(request->'positions'))),'autonomy_canvas_duplicate_target');
  -- A later invalid target rolls back the entire batch, including earlier nodes.
  PERFORM pg_temp.qa_error(format('SELECT public.loomic_autonomy_arrange_design_boards(%L,%L,%L,%L::jsonb)',actor,session,lease,
    jsonb_set(request,'{positions}',(request->'positions')||jsonb_build_array(jsonb_build_object(
      'design_id',unlisted_design,'element_id','unlisted-design','expected_version',1,'expected_x',700,'expected_y',0,'x',900,'y',200)))),'autonomy_canvas_target_mismatch');
  UPDATE public.canvases SET content=jsonb_set(content,'{elements,1,locked}','true') WHERE id=origin_canvas;
  PERFORM pg_temp.qa_error(format('SELECT public.loomic_autonomy_arrange_design_boards(%L,%L,%L,%L::jsonb)',actor,session,lease,request),'autonomy_canvas_unsupported_node');
  UPDATE public.canvases SET content=original_canvas WHERE id=origin_canvas;
  PERFORM pg_temp.qa_error(format('SELECT public.loomic_autonomy_arrange_design_boards(%L,%L,%L,%L::jsonb)',actor,session,lease,
    jsonb_set(request,'{positions,0,design_id}',to_jsonb(unlisted_design))),'autonomy_canvas_target_mismatch');
  PERFORM pg_temp.qa_error(format('SELECT public.loomic_autonomy_arrange_design_boards(%L,%L,%L,%L::jsonb)',actor,session,lease,
    jsonb_set(request,'{positions,0,expected_x}','1')),'autonomy_canvas_revision_conflict');
  PERFORM pg_temp.qa_assert((SELECT content=original_canvas FROM public.canvases WHERE id=origin_canvas),'failed writes preserve whole canvas');
  result_value:=public.loomic_autonomy_arrange_design_boards(actor,session,lease,request);
  PERFORM pg_temp.qa_assert(result_value->>'status'='applied','actual translation commits');
  PERFORM pg_temp.qa_assert((SELECT element->>'x'='100' AND element->>'y'='200' AND element->>'version'='2'
    FROM public.canvases c,jsonb_array_elements(c.content->'elements') element WHERE c.id=origin_canvas AND element->>'id'='selected-design'),'coordinates and version updated');
  PERFORM pg_temp.qa_assert((SELECT element=(SELECT value FROM jsonb_array_elements(original_canvas->'elements') value WHERE value->>'id'='unlisted-design')
    FROM public.canvases c,jsonb_array_elements(c.content->'elements') element WHERE c.id=origin_canvas AND element->>'id'='unlisted-design'),'unrelated node unchanged');
  PERFORM pg_temp.qa_assert(public.loomic_autonomy_arrange_design_boards(actor,session,lease,request)->>'replayed'='true','replay returns exact durable result despite old CAS');
  PERFORM pg_temp.qa_error(format('SELECT public.loomic_autonomy_arrange_design_boards(%L,%L,%L,%L::jsonb)',actor,session,lease,
    jsonb_set(request,'{positions,0,x}','101')),'autonomy_canvas_idempotency_conflict');
  request:=jsonb_set(request,'{idempotency_key}',to_jsonb(extensions.gen_random_uuid()));
  PERFORM pg_temp.qa_error(format('SELECT public.loomic_autonomy_arrange_design_boards(%L,%L,%L,%L::jsonb)',actor,session,lease,request),'autonomy_canvas_revision_conflict');
  SELECT content INTO original_canvas FROM public.canvases WHERE id=origin_canvas;
  PERFORM public.loomic_agent_autonomy('stop',actor,session,'{}');
  PERFORM pg_temp.qa_error(format('SELECT public.loomic_autonomy_arrange_design_boards(%L,%L,%L,%L::jsonb)',actor,session,lease,request),'autonomy_authorization_expired');
  PERFORM pg_temp.qa_assert((SELECT content=original_canvas FROM public.canvases WHERE id=origin_canvas),'stop refuses late write');
  PERFORM pg_temp.qa_assert((SELECT count(*)=1 FROM public.agent_autonomy_canvas_arrangements WHERE task_id=(task_value->>'id')::uuid),'only one durable operation');
  PERFORM pg_temp.qa_assert(NOT has_function_privilege('authenticated','public.loomic_autonomy_arrange_design_boards(uuid,uuid,uuid,jsonb)','EXECUTE'),'browser cannot submit server leases');
END $$;
ROLLBACK;`);
console.log('PASS: actual scoped board translation, CAS, idempotent replay/conflict, unrelated content preservation, stop fence. Synthetic fixtures rolled back.');
