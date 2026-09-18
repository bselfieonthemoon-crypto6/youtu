-- Included inside the parent QA transaction. Uses only its fabricated actor,
-- workspace and project, and never reads or edits an existing user document.
CREATE FUNCTION pg_temp.qa_mutate_title(design_id uuid, run_id uuid, actor uuid, object_id uuid, new_text text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE doc public.design_documents; tool_id uuid := extensions.gen_random_uuid();
  scene jsonb; object_value jsonb; commands jsonb; index_value integer;
BEGIN
  SELECT * INTO STRICT doc FROM public.design_documents d WHERE d.id=design_id;
  SELECT ordinality::integer-1,value INTO STRICT index_value,object_value
    FROM jsonb_array_elements(doc.scene->'objects') WITH ORDINALITY WHERE value->>'objectId'=object_id::text;
  scene := jsonb_set(doc.scene,ARRAY['objects',index_value::text],object_value||jsonb_build_object(
    'text',new_text,'objectVersion',(object_value->>'objectVersion')::integer+1));
  commands := jsonb_build_array(jsonb_build_object('action','object.update','object_id',object_id,
    'expected_object_version',(object_value->>'objectVersion')::integer,'patch',jsonb_build_object('object_type','text','text',new_text)));
  INSERT INTO public.tool_executions(id,run_id,tool_call_id,tool_name,status,requested_by)
    VALUES(tool_id,run_id,tool_id::text,'manipulate_design','running',actor);
  RETURN public.loomic_agent_design_mutate_v2('manipulate_design',design_id,doc.revision,
    extensions.gen_random_uuid(),commands,scene,actor,run_id,tool_id);
END $$;

DO $$
DECLARE
  actor uuid := 'aa010000-0000-4000-8000-000000000001';
  workspace uuid := 'aa020000-0000-4000-8000-000000000001';
  project uuid := 'aa030000-0000-4000-8000-000000000001';
  canvas uuid := 'aa040000-0000-4000-8000-000000000001';
  foreign_canvas uuid := extensions.gen_random_uuid(); session uuid := extensions.gen_random_uuid();
  run1 uuid := extensions.gen_random_uuid(); run2 uuid := extensions.gen_random_uuid();
  design uuid := extensions.gen_random_uuid(); other_design uuid := extensions.gen_random_uuid();
  foreign_design uuid := extensions.gen_random_uuid(); title_id uuid := extensions.gen_random_uuid();
  subtitle_id uuid := extensions.gen_random_uuid(); scene jsonb; title jsonb; snapshot jsonb;
  current_snapshot jsonb; saved_scene jsonb; before_revision bigint;
  saved_versions jsonb; saved_receipts jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','service_role')::text,true);
  INSERT INTO public.canvases(id,project_id,workspace_id,name,created_by,content)
    VALUES(foreign_canvas,project,workspace,'QA distinct design canvas',actor,'{"elements":[],"files":{}}');
  INSERT INTO public.chat_sessions(id,canvas_id,created_by,thread_id) VALUES(session,canvas,actor,session::text);
  INSERT INTO public.agent_runs(id,session_id,thread_id,status,created_by)
    VALUES(run1,session,session::text,'running',actor),(run2,session,session::text,'running',actor);
  title := jsonb_build_object('objectId',title_id,'objectVersion',1,'type','text','name','QA title',
    'x',30,'y',30,'width',400,'height',60,'rotation',0,'opacity',1,'visible',true,'locked',false,'zIndex',0,
    'text','ORIGINAL','fontFaceId',null,'fontFamily','Arial','fontSize',30,'fontWeight',700,
    'fontStyle','normal','textAlign','left','lineHeight',1.2,'charSpacing',0,'fill',jsonb_build_object('kind','solid','color','#112233'));
  scene := jsonb_build_object('schemaVersion',1,'engine','fabric','canvas',jsonb_build_object('width',640,'height',360,'background','#ffffff'),
    'objects',jsonb_build_array(title,title||jsonb_build_object('objectId',subtitle_id,'name','QA subtitle','text','KEEP','y',180,'zIndex',1)));
  INSERT INTO public.design_documents(id,workspace_id,project_id,name,scene,width,height,created_by)
    VALUES(design,workspace,project,'QA selected design',scene,640,360,actor),
      (other_design,workspace,project,'QA other design',scene,640,360,actor),
      (foreign_design,workspace,project,'QA foreign canvas design',scene,640,360,actor);
  INSERT INTO public.design_nodes(canvas_id,element_id,design_id,workspace_id,created_by)
    VALUES(canvas,design::text,design,workspace,actor),(canvas,other_design::text,other_design,workspace,actor),
      (foreign_canvas,foreign_design::text,foreign_design,workspace,actor);
  INSERT INTO public.design_document_versions(design_id,workspace_id,revision,snapshot,actor_kind,actor_user_id,idempotency_key)
    SELECT d.id,workspace,0,d.scene,'user',actor,extensions.gen_random_uuid()
      FROM public.design_documents d WHERE d.id IN (design,other_design,foreign_design);
  PERFORM pg_temp.qa_error(format(
    'SELECT public.loomic_agent_task_begin(%L,%L,%L,%L,%L,%L::jsonb)',actor,session,canvas,run1,'goal',jsonb_build_object('kind','design','designId',foreign_design)),
    'agent_task_target_forbidden');
  snapshot := public.loomic_agent_task_begin(actor,session,canvas,run1,'Rename title',
    jsonb_build_object('kind','design','designId',design,'objectIds',jsonb_build_array(title_id)));
  PERFORM pg_temp.qa_assert(public.loomic_agent_task_begin(actor,session,canvas,run1,'Rename title',
    jsonb_build_object('kind','design','designId',design,'objectIds',jsonb_build_array(title_id))) = snapshot,'begin retry is idempotent');
  PERFORM pg_temp.qa_mutate_title(design,run1,actor,title_id,'FIRST');
  SELECT d.scene,d.revision INTO saved_scene,before_revision FROM public.design_documents d WHERE d.id=design;
  PERFORM pg_temp.qa_assert(saved_scene#>>'{objects,0,text}'='FIRST' AND saved_scene->'objects'->1 = scene->'objects'->1,
    'current run changes only selected object');
  PERFORM pg_temp.qa_error(format('SELECT pg_temp.qa_mutate_title(%L,%L,%L,%L,%L)',design,run1,actor,subtitle_id,'FORBIDDEN'),'agent_task_target_mismatch');
  PERFORM pg_temp.qa_error(format('SELECT pg_temp.qa_mutate_title(%L,%L,%L,%L,%L)',other_design,run1,actor,title_id,'FORBIDDEN'),'agent_task_target_mismatch');
  PERFORM pg_temp.qa_assert((SELECT d.scene FROM public.design_documents d WHERE d.id=design)=saved_scene,'rejected target mutation rolls back entirely');
  PERFORM pg_temp.qa_assert((SELECT d.scene FROM public.design_documents d WHERE d.id=other_design)=scene,'other artboard never changes');
  current_snapshot := public.loomic_agent_task_begin(actor,session,canvas,run2,'Use FINAL instead',NULL,run1);
  PERFORM pg_temp.qa_assert((current_snapshot->>'revision')::integer=2 AND current_snapshot->>'goal'='Rename title'
    AND current_snapshot->'corrections'='["Use FINAL instead"]'::jsonb AND current_snapshot->'target'=snapshot->'target','correction retains goal and target');
  PERFORM pg_temp.qa_error(format('SELECT pg_temp.qa_mutate_title(%L,%L,%L,%L,%L)',design,run1,actor,title_id,'LATE'),'agent_task_superseded');
  PERFORM pg_temp.qa_assert((SELECT d.revision FROM public.design_documents d WHERE d.id=design)=before_revision,'late old run cannot advance document revision');
  PERFORM pg_temp.qa_mutate_title(design,run2,actor,title_id,'FINAL');
  PERFORM pg_temp.qa_assert((SELECT d.scene#>>'{objects,0,text}' FROM public.design_documents d WHERE d.id=design)='FINAL','latest correction run can commit');
  PERFORM pg_temp.qa_assert(NOT has_table_privilege('authenticated','public.agent_design_tasks','INSERT,UPDATE,DELETE'),'authenticated clients cannot write task rows');
  PERFORM pg_temp.qa_error(format('UPDATE public.design_document_versions SET agent_run_id=NULL WHERE design_id=%L AND actor_kind=''agent''',design),
    'agent_design_audit_required');
  PERFORM pg_temp.qa_error(format('UPDATE public.design_agent_tool_requests SET live_agent_run_id=NULL WHERE design_id=%L',design),
    'agent_design_audit_identity_immutable');
  SELECT d.scene,d.revision INTO saved_scene,before_revision FROM public.design_documents d WHERE d.id=design;
  SELECT jsonb_agg(to_jsonb(v)-'agent_run_id'-'tool_execution_id' ORDER BY v.revision) INTO saved_versions
    FROM public.design_document_versions v WHERE v.design_id=design;
  SELECT jsonb_agg(to_jsonb(r)-'live_agent_run_id'-'live_tool_execution_id' ORDER BY r.tool_execution_id) INTO saved_receipts
    FROM public.design_agent_tool_requests r WHERE r.design_id=design;
  DELETE FROM public.chat_sessions WHERE id=session;
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM pg_temp.qa_assert(NOT EXISTS(SELECT 1 FROM public.agent_design_tasks WHERE session_id=session),
    'ordinary session deletion removes task and run snapshots without a circular foreign key failure');
  PERFORM pg_temp.qa_assert(NOT EXISTS(SELECT 1 FROM public.agent_runs WHERE session_id=session)
    AND NOT EXISTS(SELECT 1 FROM public.tool_executions WHERE run_id IN (run1,run2)),
    'session deletion still removes its run and execution ledger');
  PERFORM pg_temp.qa_assert((SELECT d.scene=saved_scene AND d.revision=before_revision FROM public.design_documents d WHERE d.id=design),
    'session deletion preserves the design scene and current revision');
  PERFORM pg_temp.qa_assert((SELECT jsonb_agg(to_jsonb(v)-'agent_run_id'-'tool_execution_id' ORDER BY v.revision)
    FROM public.design_document_versions v WHERE v.design_id=design)=saved_versions,
    'all version commands, snapshots and authors survive session deletion unchanged');
  PERFORM pg_temp.qa_assert((SELECT jsonb_agg(to_jsonb(r)-'live_agent_run_id'-'live_tool_execution_id' ORDER BY r.tool_execution_id)
    FROM public.design_agent_tool_requests r WHERE r.design_id=design)=saved_receipts,
    'audit receipts retain original run and tool identifiers and idempotency results');
  PERFORM pg_temp.qa_assert(NOT EXISTS(SELECT 1 FROM public.design_document_versions v WHERE v.design_id=design
      AND (v.agent_run_id IS NOT NULL OR v.tool_execution_id IS NOT NULL))
    AND NOT EXISTS(SELECT 1 FROM public.design_agent_tool_requests r WHERE r.design_id=design
      AND (r.live_agent_run_id IS NOT NULL OR r.live_tool_execution_id IS NOT NULL)),
    'only live audit links detach after their parent ledger is removed');
  RAISE NOTICE 'PASS: real design RPC rejects stale run, wrong artboard and unselected layer; current edit commits';
END $$;
