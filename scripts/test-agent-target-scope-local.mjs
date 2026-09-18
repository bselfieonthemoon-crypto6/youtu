import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const container = 'supabase_db_thtdhcvjppuvlvahfmga';
const database = 'loomic_replica_light_20260907';
const query = sql => execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', database, '-Atq'],
  { input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
if (query('SELECT current_database();').trim() !== database) throw new Error('Refusing non-local database');

const migrationNames = ['20260910000002_agent_confirmation_resume', '20260910000003_agent_target_scope',
  '20260910000005_agent_correction_scope'];
const migrations = [];
for (const migrationName of migrationNames) {
  if (query(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='${migrationName.slice(0, 14)}';`).trim() === '0')
    migrations.push(await readFile(new URL(`../supabase/migrations/${migrationName}.sql`, import.meta.url), 'utf8'));
}
const migration = migrations.join('\n');
const source = await readFile(new URL('../apps/server/src/features/agent-tasks/agent-task-local-db.qa.sql', import.meta.url), 'utf8');
const fixture = source.slice(0, source.indexOf('SELECT pg_temp.qa_error')).replace(/^BEGIN;\r?$/m, '');
const sql = `BEGIN;
${migration}
${fixture}
CREATE FUNCTION pg_temp.qa_mutate_title(design_id uuid,run_id uuid,actor uuid,object_id uuid,new_text text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE doc public.design_documents; tool_id uuid:=extensions.gen_random_uuid(); scene jsonb; object_value jsonb; commands jsonb; index_value integer;
BEGIN
  SELECT * INTO STRICT doc FROM public.design_documents WHERE id=design_id;
  SELECT ordinality::integer-1,value INTO STRICT index_value,object_value
    FROM jsonb_array_elements(doc.scene->'objects') WITH ORDINALITY WHERE value->>'objectId'=object_id::text;
  scene:=jsonb_set(doc.scene,ARRAY['objects',index_value::text],object_value||jsonb_build_object('text',new_text,'objectVersion',(object_value->>'objectVersion')::integer+1));
  commands:=jsonb_build_array(jsonb_build_object('action','object.update','object_id',object_id,
    'expected_object_version',(object_value->>'objectVersion')::integer,'patch',jsonb_build_object('object_type','text','text',new_text)));
  INSERT INTO public.tool_executions(id,run_id,tool_call_id,tool_name,status,requested_by)
    VALUES(tool_id,run_id,tool_id::text,'manipulate_design','running',actor);
  RETURN public.loomic_agent_design_mutate_v2('manipulate_design',design_id,doc.revision,
    extensions.gen_random_uuid(),commands,scene,actor,run_id,tool_id);
END $$;

DO $$
DECLARE actor uuid:='aa010000-0000-4000-8000-000000000001'; session uuid:='aa060000-0000-4000-8000-000000000001';
  origin_canvas uuid:='aa040000-0000-4000-8000-000000000001'; run1 uuid:='aa070000-0000-4000-8000-000000000001';
  run2 uuid:='aa070000-0000-4000-8000-000000000002'; workspace uuid:='aa020000-0000-4000-8000-000000000001';
  project uuid:='aa030000-0000-4000-8000-000000000001'; second_canvas uuid:='ab040000-0000-4000-8000-000000000002';
  other_project uuid:='ab030000-0000-4000-8000-000000000002'; other_canvas uuid:='ab040000-0000-4000-8000-000000000003';
  selected_design uuid:='ab050000-0000-4000-8000-000000000001'; unlisted_design uuid:='ab050000-0000-4000-8000-000000000002';
  other_project_design uuid:='ab050000-0000-4000-8000-000000000003'; foreign_design uuid:='ab050000-0000-4000-8000-000000000004';
  selected_object uuid:='ab060000-0000-4000-8000-000000000001'; unlisted_object uuid:='ab060000-0000-4000-8000-000000000002';
  primary_target jsonb:='{"kind":"canvas_image","elementId":"source-a","assetId":"aa050000-0000-4000-8000-000000000001"}';
  selected_target jsonb; inherited_targets jsonb; scene jsonb; foreign_workspace uuid:='aa020000-0000-4000-8000-000000000002';
  foreign_project uuid:='aa030000-0000-4000-8000-000000000002'; foreign_canvas uuid:='aa040000-0000-4000-8000-000000000002';
BEGIN
  INSERT INTO public.projects(id,workspace_id,name,slug,created_by)
    VALUES(other_project,workspace,'Target scope other project','target-scope-other-project',actor);
  INSERT INTO public.canvases(id,project_id,workspace_id,name,created_by,content) VALUES
    (second_canvas,project,workspace,'Explicit second board',actor,'{"elements":[],"files":{},"appState":{}}'),
    (other_canvas,other_project,workspace,'Unapproved other project',actor,'{"elements":[],"files":{},"appState":{}}');
  scene:=jsonb_build_object('schemaVersion',1,'engine','fabric','canvas',jsonb_build_object('width',640,'height',360,'background','#ffffff'),
    'objects',jsonb_build_array(
      jsonb_build_object('objectId',selected_object,'objectVersion',1,'type','text','name','Title','x',10,'y',10,'width',300,'height',60,'rotation',0,'opacity',1,'visible',true,'locked',false,'zIndex',0,'text','ORIGINAL','fontFaceId',null,'fontFamily','Arial','fontSize',30,'fontWeight',700,'fontStyle','normal','textAlign','left','lineHeight',1.2,'charSpacing',0,'fill',jsonb_build_object('kind','solid','color','#112233')),
      jsonb_build_object('objectId',unlisted_object,'objectVersion',1,'type','text','name','Footer','x',10,'y',200,'width',300,'height',40,'rotation',0,'opacity',1,'visible',true,'locked',false,'zIndex',1,'text','KEEP','fontFaceId',null,'fontFamily','Arial','fontSize',20,'fontWeight',400,'fontStyle','normal','textAlign','left','lineHeight',1.2,'charSpacing',0,'fill',jsonb_build_object('kind','solid','color','#112233'))));
  INSERT INTO public.design_documents(id,workspace_id,project_id,name,scene,width,height,created_by) VALUES
    (selected_design,workspace,project,'Explicit target',scene,640,360,actor),
    (unlisted_design,workspace,project,'Unlisted same project',scene,640,360,actor),
    (other_project_design,workspace,other_project,'Unapproved project',scene,640,360,actor),
    (foreign_design,foreign_workspace,foreign_project,'Foreign tenant',scene,640,360,'aa010000-0000-4000-8000-000000000002');
  INSERT INTO public.design_nodes(canvas_id,element_id,design_id,workspace_id,created_by) VALUES
    (second_canvas,'selected-design',selected_design,workspace,actor),
    (second_canvas,'unlisted-design',unlisted_design,workspace,actor),
    (other_canvas,'other-project-design',other_project_design,workspace,actor),
    (foreign_canvas,'foreign-design',foreign_design,foreign_workspace,'aa010000-0000-4000-8000-000000000002');
  INSERT INTO public.design_document_versions(design_id,workspace_id,revision,snapshot,actor_kind,actor_user_id,idempotency_key)
    SELECT design.id,design.workspace_id,0,design.scene,'user',design.created_by,extensions.gen_random_uuid()
    FROM public.design_documents design WHERE design.id IN (selected_design,unlisted_design,other_project_design,foreign_design);
  selected_target:=jsonb_build_object('kind','design','designId',selected_design,'objectIds',jsonb_build_array(selected_object));

  PERFORM pg_temp.qa_assert(public.loomic_agent_target_scope_assert(actor,session,run1,1,primary_target),'canonical single target remains authorized');
  PERFORM pg_temp.qa_assert(NOT public.loomic_agent_target_scope_assert(actor,session,run1,1,selected_target),'same-project board is not authorized merely by visibility');
  PERFORM pg_temp.qa_error(format('SELECT public.loomic_agent_target_scope_activate(%L,%L,%L,1,%L::jsonb)',actor,session,run1,
    jsonb_build_array(primary_target,jsonb_build_object('kind','design','designId',other_project_design))),'agent_target_scope_forbidden');
  PERFORM pg_temp.qa_error(format('SELECT public.loomic_agent_target_scope_activate(%L,%L,%L,1,%L::jsonb)',actor,session,run1,
    jsonb_build_array(primary_target,jsonb_build_object('kind','design','designId',foreign_design))),'agent_target_scope_forbidden');
  PERFORM public.loomic_agent_target_scope_activate(actor,session,run1,1,jsonb_build_array(primary_target,selected_target));
  PERFORM pg_temp.qa_assert((SELECT jsonb_array_length(public.loomic_agent_target_scope_list(actor,session,run1,1))=2),'exact scope list persisted');
  PERFORM pg_temp.qa_assert(public.loomic_agent_target_scope_assert(actor,session,run1,1,selected_target),'explicit second board object is authorized');
  PERFORM pg_temp.qa_assert(NOT public.loomic_agent_target_scope_assert(actor,session,run1,1,
    jsonb_build_object('kind','design','designId',selected_design)),'object-scoped authority cannot become whole-board authority');
  PERFORM pg_temp.qa_assert(NOT public.loomic_agent_target_scope_assert(actor,session,run1,1,
    jsonb_build_object('kind','design','designId',unlisted_design)),'unlisted same-project board remains denied');
  PERFORM pg_temp.qa_error(format('SELECT public.loomic_agent_target_scope_activate(%L,%L,%L,1,%L::jsonb)',actor,session,run1,
    jsonb_build_array(primary_target,jsonb_build_object('kind','design','designId',selected_design))),'agent_target_scope_conflict');
  PERFORM pg_temp.qa_mutate_title(selected_design,run1,actor,selected_object,'AUTHORIZED');
  PERFORM pg_temp.qa_assert((SELECT document.scene#>>'{objects,0,text}'='AUTHORIZED' FROM public.design_documents document WHERE document.id=selected_design),'listed cross-board object mutation commits');
  PERFORM pg_temp.qa_error(format('SELECT pg_temp.qa_mutate_title(%L,%L,%L,%L,%L)',selected_design,run1,actor,unlisted_object,'FORBIDDEN'),'agent_task_target_mismatch');

  PERFORM pg_temp.qa_error(format(
    'SELECT public.loomic_agent_target_scope_prepare_correction(%L,%L,%L,%L,%L,2,%L::jsonb)',
    actor,session,origin_canvas,run2,run1,selected_target),'agent_target_scope_correction_conflict');
  UPDATE public.design_nodes SET deleted_at=now() WHERE design_id=selected_design;
  PERFORM pg_temp.qa_error(format(
    'SELECT public.loomic_agent_target_scope_prepare_correction(%L,%L,%L,%L,%L,2,%L::jsonb)',
    actor,session,origin_canvas,run2,run1,primary_target),'agent_target_scope_forbidden');
  UPDATE public.design_nodes SET deleted_at=NULL WHERE design_id=selected_design;
  inherited_targets:=public.loomic_agent_target_scope_prepare_correction(
    actor,session,origin_canvas,run2,run1,2,primary_target);
  PERFORM pg_temp.qa_assert(inherited_targets=jsonb_build_array(primary_target,selected_target),
    'correction preflight returns the exact ordered prior scope');

  PERFORM public.loomic_agent_task_begin(actor,session,origin_canvas,run2,'Keep both selected boards; soften the title',NULL,run1);
  PERFORM public.loomic_agent_target_scope_activate(actor,session,run2,2,inherited_targets);
  PERFORM pg_temp.qa_error(format('SELECT public.loomic_agent_target_scope_assert(%L,%L,%L,1,%L::jsonb)',actor,session,run1,selected_target),'agent_task_superseded');
  PERFORM pg_temp.qa_assert(public.loomic_agent_target_scope_assert(actor,session,run2,2,selected_target),'unchanged correction retains exact cross-board scope');
  PERFORM pg_temp.qa_assert(public.loomic_agent_target_scope_assert(actor,session,run2,2,primary_target),'corrected task retains canonical target');
  PERFORM pg_temp.qa_assert(NOT public.loomic_agent_target_scope_assert(actor,session,run2,2,
    jsonb_build_object('kind','design','designId',unlisted_design)),'correction inheritance does not broaden to an unlisted board');
  PERFORM pg_temp.qa_mutate_title(selected_design,run2,actor,selected_object,'CORRECTED');
  PERFORM pg_temp.qa_assert(NOT has_function_privilege('authenticated','public.loomic_agent_target_scope_assert(uuid,uuid,uuid,bigint,jsonb)','EXECUTE'),'browser cannot assert model-authored targets');
  PERFORM pg_temp.qa_assert(NOT has_table_privilege('authenticated','public.agent_task_target_scopes','SELECT'),'scope rows are server-only');
END $$;
ROLLBACK;
SELECT 'PASS: exact scope, correction inheritance, changed/revoked/foreign denial and SQL write guards; all data rolled back';
`;
console.log(query(sql).trim().split('\n').filter(Boolean).at(-1));
