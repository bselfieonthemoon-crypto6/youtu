-- Run on a database with 20260913000003. Apply only 00004 and roll back all
-- schema/data changes. No provider request or billable job is submitted.
\set ON_ERROR_STOP on
BEGIN;
\ir ../../../supabase/migrations/20260913000004_semantic_image_repeat_continuity.sql

DO $$
DECLARE owner_id uuid; canvas_id uuid; workspace_id uuid; project_id uuid; session_id uuid:=gen_random_uuid();
  initial_run uuid:=gen_random_uuid(); typo_run uuid:=gen_random_uuid(); later_run uuid:=gen_random_uuid();
  proposal jsonb; context jsonb; typo_message uuid; tool_id uuid:=gen_random_uuid(); bound_id uuid;
BEGIN
  SELECT canvas.created_by,canvas.id,canvas.workspace_id,canvas.project_id
    INTO owner_id,canvas_id,workspace_id,project_id
  FROM public.canvases canvas JOIN public.workspace_members member
    ON member.workspace_id=canvas.workspace_id AND member.user_id=canvas.created_by
  WHERE canvas.created_by IS NOT NULL ORDER BY canvas.created_at,canvas.id LIMIT 1;
  IF owner_id IS NULL THEN RAISE EXCEPTION 'rollback fixture needs one owned workspace canvas'; END IF;
  PERFORM set_config('request.jwt.claim.sub',owner_id::text,true);
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',owner_id,'role','authenticated')::text,true);
  INSERT INTO public.chat_sessions(id,canvas_id,created_by,title)
    VALUES(session_id,canvas_id,owner_id,'semantic repeat continuity rollback test');

  PERFORM public.loomic_create_run_with_request(initial_run,session_id,owner_id,
    'semantic-repeat-initial',NULL,'fast','把背景改成绿色，修改后直接生成。');
  proposal:=public.loomic_propose_image(session_id,canvas_id,initial_run,
    jsonb_build_object('operation','generate','title','绿色横幅','prompt','green banner',
      'model','rollback-test','aspectRatio','16:9'),'{}'::jsonb);
  bound_id:=public.loomic_bind_reviewed_semantic_current_run_image_confirmation(
    owner_id,session_id,canvas_id,initial_run,(proposal->>'id')::uuid);
  IF bound_id IS DISTINCT FROM (proposal->>'id')::uuid THEN RAISE EXCEPTION 'initial current-run bind failed'; END IF;
  IF public.loomic_decide_current_image((proposal->>'id')::uuid,session_id,canvas_id,initial_run,'confirm')->>'status'
    IS DISTINCT FROM 'confirmed' THEN RAISE EXCEPTION 'initial current-run decision failed'; END IF;
  PERFORM public.loomic_prepare_image_submission((proposal->>'id')::uuid,owner_id,session_id,20);

  INSERT INTO public.background_jobs(
    id,workspace_id,project_id,canvas_id,session_id,queue_name,job_type,status,payload,created_by
  ) VALUES((proposal->>'id')::uuid,workspace_id,project_id,canvas_id,session_id,
    'image_generation_jobs','image_generation','succeeded',jsonb_build_object(
      'operation','generate','prompt','green banner','model','rollback-test',
      'aspect_ratio','16:9','quality','hd','auto_finalize_canvas',true,
      'target',jsonb_build_object('kind','canvas','canvas_id',canvas_id)),owner_id);
  INSERT INTO public.tool_executions(id,run_id,tool_call_id,tool_name,status,input,output,requested_by,finished_at)
  VALUES(tool_id,initial_run,'semantic-direct-call','generate_image','completed','{}',
    jsonb_build_object('status','processing','jobId',proposal->>'id'),owner_id,now());
  INSERT INTO public.chat_messages(session_id,role,content,content_blocks)
  VALUES(session_id,'assistant','图片任务已提交。',jsonb_build_array(jsonb_build_object(
    'type','tool','toolCallId','semantic-direct-call','toolName','generate_image','status','completed','output',
    jsonb_build_object('status','processing','jobId',proposal->>'id'))));

  PERFORM public.loomic_create_run_with_request(typo_run,session_id,owner_id,
    'semantic-repeat-typo',NULL,'fast','却定');
  SELECT request_message_id INTO typo_message FROM public.agent_runs WHERE id=typo_run;
  context:=public.loomic_get_image_proposal_relation_context(owner_id,session_id,canvas_id,typo_run);
  IF context->>'proposalId' IS DISTINCT FROM proposal->>'id'
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(context->'turns') turn
      WHERE turn->>'id'=typo_message::text) THEN
    RAISE EXCEPTION 'confirmed proposal typo was not exposed for bounded relation review';
  END IF;
  PERFORM public.loomic_record_image_proposal_turn_relations(owner_id,session_id,canvas_id,typo_run,
    (proposal->>'id')::uuid,jsonb_build_array(jsonb_build_object('message_id',typo_message,'relation','preserve')));
  context:=public.loomic_get_semantic_image_confirmation_review(owner_id,session_id,canvas_id,typo_run);
  IF context->'proposal'->>'id' IS DISTINCT FROM proposal->>'id'
    OR context->'proposal'->>'jobStatus' IS DISTINCT FROM 'succeeded' THEN
    RAISE EXCEPTION 'processing ledger did not establish trusted repeat context';
  END IF;
  bound_id:=public.loomic_bind_reviewed_semantic_image_confirmation(
    owner_id,session_id,canvas_id,typo_run,(proposal->>'id')::uuid);
  IF bound_id IS DISTINCT FROM (proposal->>'id')::uuid THEN RAISE EXCEPTION 'repeat typo did not bind'; END IF;
  IF public.loomic_decide_current_image((proposal->>'id')::uuid,session_id,canvas_id,typo_run,'confirm')->>'status'
    IS DISTINCT FROM 'confirmed' THEN RAISE EXCEPTION 'repeat typo was not idempotent'; END IF;

  -- The preserved typo remains a fact for the next turn, rather than hiding
  -- the confirmed proposal forever after one failed semantic attempt.
  PERFORM public.loomic_create_run_with_request(later_run,session_id,owner_id,
    'semantic-repeat-later',NULL,'fast','确定生成');
  context:=public.loomic_get_semantic_image_confirmation_review(owner_id,session_id,canvas_id,later_run);
  IF context->'proposal'->>'id' IS DISTINCT FROM proposal->>'id' THEN
    RAISE EXCEPTION 'preserved typo did not retain later confirmed continuity';
  END IF;

  -- A forged tool output without a real scoped job must not establish trust.
  DELETE FROM public.background_jobs WHERE id=(proposal->>'id')::uuid;
  IF public.loomic_get_semantic_image_confirmation_review(owner_id,session_id,canvas_id,later_run) IS NOT NULL THEN
    RAISE EXCEPTION 'tool ledger without real job remained trusted';
  END IF;
  RAISE NOTICE 'PASS: confirmed relation repair, semantic current-run processing ledger, real job and repeat idempotence';
END $$;

ROLLBACK;
