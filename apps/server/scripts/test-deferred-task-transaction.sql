-- Run after migration 00012 in a transaction; always roll back these fixtures.
DO $$
DECLARE
  actor uuid := '541006fa-d2a1-4305-be55-b6263c27a1e3';
  board uuid := 'aac8cd05-bb35-4be8-b97c-6c969ba5334b';
  design uuid := 'b4a6f9e7-02bf-45b5-a63a-78692bcea5a2';
  session uuid := gen_random_uuid(); first_run uuid := gen_random_uuid();
  second_run uuid := gen_random_uuid(); third_run uuid := gen_random_uuid();
  proposal uuid := gen_random_uuid(); target jsonb; prepared jsonb; stale jsonb; active jsonb; before_task jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  target := jsonb_build_object('kind','design','designId',design);
  INSERT INTO public.chat_sessions(id,canvas_id,created_by,title) VALUES(session,board,actor,'rollback intent activation test');
  INSERT INTO public.agent_runs(id,session_id,thread_id,status,created_by) VALUES
    (first_run,session,'rollback-test','running',actor),(second_run,session,'rollback-test','running',actor),(third_run,session,'rollback-test','running',actor);
  prepared := public.loomic_agent_task_prepare(actor,session,board,first_run,'把标题改为新店开业',target,NULL);
  IF EXISTS(SELECT 1 FROM public.agent_design_tasks WHERE session_id=session) OR
     EXISTS(SELECT 1 FROM public.agent_design_task_runs WHERE run_id=first_run)
    THEN RAISE EXCEPTION 'prepare created a durable task'; END IF;
  active := public.loomic_agent_task_activate(actor,session,board,first_run,'把标题改为新店开业',target,NULL,prepared);
  IF (active->>'revision')::int<>1 OR active->>'runId'<>first_run::text THEN RAISE EXCEPTION 'activation wrong'; END IF;
  IF public.loomic_agent_task_activate(actor,session,board,first_run,'把标题改为新店开业',target,NULL,prepared)<>active
    THEN RAISE EXCEPTION 'activation retry changed task'; END IF;
  INSERT INTO public.image_generation_proposals(id,session_id,canvas_id,created_by,origin_run_id,input,details)
    VALUES(proposal,session,board,actor,first_run,'{}','{}');
  SELECT to_jsonb(t) INTO before_task FROM public.agent_design_tasks t WHERE t.session_id=session;
  prepared := public.loomic_agent_task_prepare(actor,session,board,second_run,'先讲讲设计思路，不要修改',NULL,first_run);
  IF (SELECT to_jsonb(t) FROM public.agent_design_tasks t WHERE t.session_id=session)<>before_task OR
    (SELECT status FROM public.image_generation_proposals WHERE id=proposal)<>'pending' OR
    (SELECT status FROM public.agent_runs WHERE id=first_run)<>'running'
    THEN RAISE EXCEPTION 'consultation preparation mutated task/proposal/run'; END IF;
  stale := public.loomic_agent_task_prepare(actor,session,board,third_run,'只修改字体颜色',NULL,first_run);
  active := public.loomic_agent_task_activate(actor,session,board,third_run,'只修改字体颜色',NULL,first_run,stale);
  IF (active->>'revision')::int<>2 OR (SELECT status FROM public.image_generation_proposals WHERE id=proposal)<>'superseded'
    THEN RAISE EXCEPTION 'activation did not advance/invalidate atomically'; END IF;
  BEGIN
    PERFORM public.loomic_agent_task_activate(actor,session,board,second_run,'先讲讲设计思路，不要修改',NULL,first_run,prepared);
    RAISE EXCEPTION 'stale activation passed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%agent_task_activation_conflict%' THEN RAISE; END IF;
  END;
  IF has_function_privilege('authenticated','public.loomic_agent_task_prepare(uuid,uuid,uuid,uuid,text,jsonb,uuid)','EXECUTE') OR
    has_function_privilege('anon','public.loomic_agent_task_activate(uuid,uuid,uuid,uuid,text,jsonb,uuid,jsonb)','EXECUTE')
    THEN RAISE EXCEPTION 'RPC exposed to unprivileged roles'; END IF;
  RAISE NOTICE 'PASS: prepare zero writes; consultation preserves task/proposal/run; activation exactly once; stale CAS denied; RPC roles isolated';
END $$;
