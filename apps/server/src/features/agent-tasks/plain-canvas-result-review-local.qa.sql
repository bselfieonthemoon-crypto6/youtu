\set ON_ERROR_STOP on
-- Local replica only. Synthetic lifecycle checks, no queue/provider calls.
-- Reuses the already-paid asset as a fixture; all changes roll back.
BEGIN;
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='3s';
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
DO $$
#variable_conflict use_variable
DECLARE sample public.background_jobs; canvas_id uuid; session_id uuid; prepare_id uuid; run_id uuid; job_id uuid;
  request_id uuid; scenario text; target_asset text; task public.agent_design_tasks; registered boolean;
  claim jsonb; saved_brief jsonb; rejected boolean;
  confirmation_run uuid; next_proposal uuid;
BEGIN
  IF current_database()<>'loomic_replica_light_20260907' THEN RAISE EXCEPTION 'local QA only'; END IF;
  SELECT * INTO STRICT sample FROM public.background_jobs WHERE id='dedfe2c8-1267-4201-815b-ad25936c701c';
  target_asset:=sample.result->>'asset_id';
  FOREACH scenario IN ARRAY ARRAY['success','retry_before_enqueue','worker_before_registration','delivery_before_registration',
    'preference_off','stopped','new_message','canceled','wrong_asset','foreign_owner','deleted_element'] LOOP
    canvas_id:=extensions.gen_random_uuid(); session_id:=extensions.gen_random_uuid();
    prepare_id:=extensions.gen_random_uuid(); run_id:=extensions.gen_random_uuid(); job_id:=extensions.gen_random_uuid();
    INSERT INTO public.canvases(id,project_id,name,is_primary,created_by,content)
      VALUES(canvas_id,sample.project_id,'Canvas review rollback QA',false,sample.created_by,'{"elements":[],"files":{},"appState":{}}');
    INSERT INTO public.chat_sessions(id,canvas_id,title,created_by,thread_id)
      VALUES(session_id,canvas_id,'Canvas review rollback QA',sample.created_by,session_id::text);
    INSERT INTO public.agent_autonomy_preferences(session_id,created_by,enabled)
      VALUES(session_id,sample.created_by,scenario<>'preference_off');
    PERFORM public.loomic_create_run_with_request(prepare_id,session_id,sample.created_by,session_id::text,'fixture-model','thinking',
      'Only one image. Review the text, subject and ratio after delivery. Do not generate again.');
    SELECT request_message_id INTO request_id FROM public.agent_runs WHERE id=prepare_id;
    UPDATE public.agent_runs SET status='completed' WHERE id=prepare_id;
    INSERT INTO public.image_generation_proposals(id,session_id,canvas_id,created_by,origin_run_id,requirement_message_id,input,details,status,approved_cost)
      VALUES(job_id,session_id,canvas_id,sample.created_by,prepare_id,request_id,'{}','{}','confirmed',0);
    PERFORM public.loomic_create_run_with_request(run_id,session_id,sample.created_by,session_id::text,'fixture-model','thinking','确认生成');
    INSERT INTO public.background_jobs(id,workspace_id,project_id,canvas_id,target_kind,session_id,queue_name,job_type,status,payload,created_by)
      VALUES(job_id,sample.workspace_id,sample.project_id,canvas_id,'canvas',session_id,'image_generation_jobs','image_generation','queued',
        jsonb_build_object('aspect_ratio','1:1','target',jsonb_build_object('kind','canvas','canvas_id',canvas_id,'element_id',job_id)),sample.created_by);
    IF scenario='worker_before_registration' THEN UPDATE public.background_jobs SET status='running' WHERE id=job_id; END IF;
    registered:=CASE WHEN scenario='delivery_before_registration' THEN true ELSE public.loomic_register_canvas_result_review(
      CASE WHEN scenario='foreign_owner' THEN extensions.gen_random_uuid() ELSE sample.created_by END,session_id,run_id,job_id) END;
    IF registered IS DISTINCT FROM (scenario NOT IN ('preference_off','foreign_owner')) THEN
      RAISE EXCEPTION 'unexpected registration: %',scenario; END IF;
    IF EXISTS(SELECT 1 FROM public.agent_design_tasks t WHERE t.session_id=session_id)
      THEN RAISE EXCEPTION 'task activated before delivery'; END IF;
    IF scenario='retry_before_enqueue' THEN
      UPDATE public.agent_runs SET status='completed' WHERE id=run_id;
      run_id:=extensions.gen_random_uuid();
      PERFORM public.loomic_create_run_with_request(run_id,session_id,sample.created_by,session_id::text,'fixture-model','thinking','确认生成');
      IF NOT public.loomic_register_canvas_result_review(sample.created_by,session_id,run_id,job_id)
        THEN RAISE EXCEPTION 'uncommitted confirmation recovery registration failed'; END IF;
    END IF;
    IF scenario='stopped' THEN PERFORM public.loomic_agent_autonomy('stop',sample.created_by,session_id); END IF;
    IF scenario='new_message' THEN INSERT INTO public.chat_messages(session_id,role,content) VALUES(session_id,'user','Cancel that task; start a different one.'); END IF;
    UPDATE public.agent_runs SET status=CASE WHEN scenario='canceled' THEN 'canceled'
      WHEN scenario='delivery_before_registration' THEN 'running' ELSE 'completed' END WHERE id=run_id;
    UPDATE public.canvases SET content=jsonb_build_object('elements',jsonb_build_array(jsonb_build_object(
      'id',job_id,'type','image','isDeleted',scenario='deleted_element','customData',jsonb_build_object('assetId',target_asset))),
      'files','{}'::jsonb,'appState','{}'::jsonb) WHERE id=canvas_id;
    UPDATE public.background_jobs SET status='succeeded',result=jsonb_build_object(
      'asset_id',CASE WHEN scenario='wrong_asset' THEN extensions.gen_random_uuid()::text ELSE target_asset END,
      'canvas_element_id',job_id,'canvas_finalized_at',now()::text) WHERE id=job_id;
    IF scenario='delivery_before_registration' THEN
      IF NOT public.loomic_register_canvas_result_review(sample.created_by,session_id,run_id,job_id)
        THEN RAISE EXCEPTION 'already-delivered registration recovery failed'; END IF;
      UPDATE public.agent_runs SET status='completed' WHERE id=run_id;
    END IF;
    SELECT t.* INTO task FROM public.agent_design_tasks t WHERE t.session_id=session_id;
    IF (task.id IS NOT NULL) IS DISTINCT FROM (scenario IN ('success','retry_before_enqueue','worker_before_registration','delivery_before_registration'))
      THEN RAISE EXCEPTION 'unexpected binding: %',scenario; END IF;
    IF scenario IN ('success','retry_before_enqueue','worker_before_registration','delivery_before_registration') THEN
      IF task.current_run_id<>run_id OR task.target->>'assetId'<>target_asset OR task.brief#>>'{canvasResultReview,mode}'<>'read_only'
        OR position('Do not generate again' IN task.goal)=0 THEN RAISE EXCEPTION 'task intent changed'; END IF;
      IF NOT EXISTS(SELECT 1 FROM public.agent_design_task_jobs b WHERE b.job_id=job_id AND b.run_id=run_id)
        OR NOT EXISTS(SELECT 1 FROM public.agent_task_continuations c WHERE c.job_id=job_id AND c.status='pending')
        OR NOT EXISTS(SELECT 1 FROM public.agent_task_autonomy a WHERE a.task_id=task.id AND a.enabled AND a.state='waiting')
        THEN RAISE EXCEPTION 'continuation enrollment missing'; END IF;
      UPDATE public.background_jobs SET result=result WHERE id=job_id;
      IF (SELECT count(*) FROM public.agent_design_task_jobs b WHERE b.job_id=job_id)<>1
        THEN RAISE EXCEPTION 'duplicate result binding'; END IF;
      IF scenario='success' AND to_regprocedure('private.loomic_is_current_task_confirmation(public.agent_runs)') IS NOT NULL THEN
        confirmation_run:=extensions.gen_random_uuid(); next_proposal:=extensions.gen_random_uuid();
        INSERT INTO public.image_generation_proposals(id,session_id,canvas_id,created_by,origin_run_id,requirement_message_id,input,details,status,approved_cost)
          SELECT next_proposal,session_id,canvas_id,sample.created_by,run_id,r.request_message_id,'{}','{}','pending',0
          FROM public.agent_runs r WHERE r.id=run_id;
        PERFORM public.loomic_create_run_with_request(confirmation_run,session_id,sample.created_by,session_id::text,'fixture-model','thinking','确认生成');
        IF NOT EXISTS(SELECT 1 FROM public.agent_task_autonomy a WHERE a.task_id=task.id AND a.state='waiting')
          OR NOT EXISTS(SELECT 1 FROM public.agent_task_continuations c WHERE c.job_id=job_id AND c.status='pending')
          THEN RAISE EXCEPTION 'pure confirmation stopped current task'; END IF;
        IF NOT (SELECT private.loomic_is_current_task_confirmation(r) FROM public.agent_runs r WHERE r.id=confirmation_run)
          THEN RAISE EXCEPTION 'current confirmation not identified'; END IF;
        UPDATE public.agent_runs SET status='completed' WHERE id=confirmation_run;
        RAISE NOTICE 'PASS exact confirmation preserves existing grant and review';
      END IF;
      IF scenario='success' AND to_regprocedure('public.loomic_agent_continuation_update_brief(uuid,uuid,uuid,jsonb)') IS NOT NULL THEN
        claim:=public.loomic_claim_agent_continuation(sample.created_by,session_id);
        IF claim->>'claim_token' IS NULL THEN RAISE EXCEPTION 'missing review claim'; END IF;
        PERFORM public.loomic_agent_continuation_update_brief(sample.created_by,job_id,(claim->>'claim_token')::uuid,
          task.brief||'{"qaFence":true}'::jsonb);
        SELECT t.brief INTO saved_brief FROM public.agent_design_tasks t WHERE t.id=task.id;
        IF saved_brief->>'qaFence'<>'true' THEN RAISE EXCEPTION 'active brief not committed'; END IF;
        PERFORM public.loomic_stop_agent_continuations(sample.created_by,session_id);
        rejected:=false;
        BEGIN
          PERFORM public.loomic_agent_continuation_update_brief(sample.created_by,job_id,(claim->>'claim_token')::uuid,'{"late":true}');
        EXCEPTION WHEN OTHERS THEN
          IF SQLERRM<>'continuation_stopped_or_changed' THEN RAISE; END IF;
          rejected:=true;
        END;
        IF NOT rejected THEN RAISE EXCEPTION 'stopped brief write accepted'; END IF;
        rejected:=false;
        BEGIN
          PERFORM public.loomic_agent_continuation_update_workflow(sample.created_by,job_id,(claim->>'claim_token')::uuid,task.revision::integer,NULL,'{}');
        EXCEPTION WHEN OTHERS THEN
          IF SQLERRM<>'continuation_stopped_or_changed' THEN RAISE; END IF;
          rejected:=true;
        END;
        IF NOT rejected OR (SELECT t.brief FROM public.agent_design_tasks t WHERE t.id=task.id) IS DISTINCT FROM saved_brief
          THEN RAISE EXCEPTION 'stopped metadata changed'; END IF;
        RAISE NOTICE 'PASS active brief commit and stopped brief/workflow rejection';
        IF to_regprocedure('private.loomic_is_current_task_confirmation(public.agent_runs)') IS NOT NULL THEN
          PERFORM public.loomic_agent_autonomy('stop',sample.created_by,session_id);
          confirmation_run:=extensions.gen_random_uuid();
          PERFORM public.loomic_create_run_with_request(confirmation_run,session_id,sample.created_by,session_id::text,'fixture-model','thinking','确认生成');
          IF NOT EXISTS(SELECT 1 FROM public.agent_task_autonomy a WHERE a.task_id=task.id AND a.state='stopped')
            THEN RAISE EXCEPTION 'confirmation revived stopped grant'; END IF;
          UPDATE public.agent_runs SET status='completed' WHERE id=confirmation_run;
          INSERT INTO public.chat_messages(session_id,role,content) VALUES(session_id,'user','改成红色，先不要生成');
          confirmation_run:=extensions.gen_random_uuid();
          PERFORM public.loomic_create_run_with_request(confirmation_run,session_id,sample.created_by,session_id::text,'fixture-model','thinking','确认生成');
          IF (SELECT private.loomic_is_current_task_confirmation(r) FROM public.agent_runs r WHERE r.id=confirmation_run)
            THEN RAISE EXCEPTION 'confirmation inherited stale proposal after correction'; END IF;
          RAISE NOTICE 'PASS confirmation cannot revive stop or inherit stale requirements';
        END IF;
      END IF;
    END IF;
    RAISE NOTICE 'PASS plain canvas review %',scenario;
  END LOOP;
END $$;
ROLLBACK;
