-- Run against a database where 20260913000001 and 20260913000002 already
-- exist. This applies only 00003 inside the transaction and rolls it back.
\set ON_ERROR_STOP on
BEGIN;
\ir ../../../supabase/migrations/20260913000003_contextual_image_generation_intent.sql

DO $$
DECLARE owner_id uuid; canvas_id uuid; session_id uuid:=gen_random_uuid();
  proposal_run uuid:=gen_random_uuid(); typo_run uuid:=gen_random_uuid(); revise_run uuid:=gen_random_uuid();
  proposal jsonb; revised jsonb; context jsonb; message_id uuid; tool_id uuid:=gen_random_uuid(); bound_id uuid;
BEGIN
  SELECT canvas.created_by,canvas.id INTO owner_id,canvas_id
  FROM public.canvases canvas JOIN public.workspace_members member
    ON member.workspace_id=canvas.workspace_id AND member.user_id=canvas.created_by
  WHERE canvas.created_by IS NOT NULL ORDER BY canvas.created_at,canvas.id LIMIT 1;
  IF owner_id IS NULL THEN RAISE EXCEPTION 'rollback fixture needs one owned workspace canvas'; END IF;
  PERFORM set_config('request.jwt.claim.sub',owner_id::text,true);
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',owner_id,'role','authenticated')::text,true);
  INSERT INTO public.chat_sessions(id,canvas_id,created_by,title)
    VALUES(session_id,canvas_id,owner_id,'semantic image intent rollback test');

  PERFORM public.loomic_create_run_with_request(proposal_run,session_id,owner_id,
    'semantic-proposal',NULL,'fast','准备一张蓝色横幅方案');
  proposal:=public.loomic_propose_image(session_id,canvas_id,proposal_run,
    jsonb_build_object('operation','generate','title','Northstar 横幅','prompt','blue banner',
      'model','rollback-test','aspectRatio','16:9'),'{}'::jsonb);
  INSERT INTO public.tool_executions(id,run_id,tool_call_id,tool_name,status,input,output,requested_by,finished_at)
  VALUES(tool_id,proposal_run,'semantic-proposal-call','generate_image','completed','{}',
    jsonb_build_object('status','awaiting_confirmation','confirmation',jsonb_build_object('confirmationId',proposal->>'id')),owner_id,now());
  INSERT INTO public.chat_messages(session_id,role,content,content_blocks)
  VALUES(session_id,'assistant','方案已经保存，满意的话告诉我就可以开始生成。',jsonb_build_array(jsonb_build_object(
    'type','tool','toolCallId','semantic-proposal-call','toolName','generate_image','status','completed','output',
    jsonb_build_object('status','awaiting_confirmation','confirmation',jsonb_build_object('confirmationId',proposal->>'id')))));

  PERFORM public.loomic_create_run_with_request(typo_run,session_id,owner_id,
    'semantic-typo',NULL,'fast','缺定生成');
  SELECT request_message_id INTO message_id FROM public.agent_runs WHERE id=typo_run;
  -- Relation review and generation-intent review are separate facts. A typo is
  -- preserved here, while the call below represents the positive enum review.
  PERFORM public.loomic_record_image_proposal_turn_relations(owner_id,session_id,canvas_id,typo_run,
    (proposal->>'id')::uuid,jsonb_build_array(jsonb_build_object('message_id',message_id,'relation','preserve')));
  context:=public.loomic_get_semantic_image_confirmation_review(owner_id,session_id,canvas_id,typo_run);
  IF context->'currentMessage'->>'content' IS DISTINCT FROM '缺定生成'
    OR context->'proposal'->>'id' IS DISTINCT FROM proposal->>'id'
    OR context->'proposal' ? 'inputImages' THEN
    RAISE EXCEPTION 'bounded existing-proposal context is invalid';
  END IF;
  bound_id:=public.loomic_bind_reviewed_semantic_image_confirmation(
    owner_id,session_id,canvas_id,typo_run,(proposal->>'id')::uuid);
  IF bound_id IS DISTINCT FROM (proposal->>'id')::uuid THEN RAISE EXCEPTION 'semantic typo did not bind'; END IF;
  IF public.loomic_decide_current_image((proposal->>'id')::uuid,session_id,canvas_id,typo_run,'confirm')->>'status'
    IS DISTINCT FROM 'confirmed' THEN RAISE EXCEPTION 'semantic existing proposal was not confirmed'; END IF;
  IF public.loomic_decide_current_image((proposal->>'id')::uuid,session_id,canvas_id,typo_run,'confirm')->>'status'
    IS DISTINCT FROM 'confirmed' THEN RAISE EXCEPTION 'semantic repeat was not idempotent'; END IF;

  PERFORM public.loomic_create_run_with_request(revise_run,session_id,owner_id,
    'semantic-revise',NULL,'fast','把背景改成绿色，修改后直接生成。');
  revised:=public.loomic_propose_image(session_id,canvas_id,revise_run,
    jsonb_build_object('operation','generate','title','Northstar 绿色横幅','prompt','green banner',
      'model','rollback-test','aspectRatio','16:9'),'{}'::jsonb);
  context:=public.loomic_get_semantic_current_run_image_confirmation_review(
    owner_id,session_id,canvas_id,revise_run,(revised->>'id')::uuid);
  IF context->'proposal'->>'id' IS DISTINCT FROM revised->>'id'
    OR context->'proposal'->>'prompt' IS DISTINCT FROM 'green banner' THEN
    RAISE EXCEPTION 'current-run review did not use the newly frozen proposal';
  END IF;
  IF public.loomic_bind_reviewed_semantic_current_run_image_confirmation(
      owner_id,session_id,canvas_id,revise_run,(proposal->>'id')::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'old proposal was accepted for current-run confirmation';
  END IF;
  bound_id:=public.loomic_bind_reviewed_semantic_current_run_image_confirmation(
    owner_id,session_id,canvas_id,revise_run,(revised->>'id')::uuid);
  IF bound_id IS DISTINCT FROM (revised->>'id')::uuid THEN RAISE EXCEPTION 'current-run proposal did not bind'; END IF;
  IF public.loomic_decide_current_image((revised->>'id')::uuid,session_id,canvas_id,revise_run,'confirm')->>'status'
    IS DISTINCT FROM 'confirmed' THEN RAISE EXCEPTION 'current-run proposal was not confirmed'; END IF;

  BEGIN
    PERFORM public.loomic_bind_reviewed_semantic_image_confirmation(gen_random_uuid(),session_id,canvas_id,
      typo_run,(proposal->>'id')::uuid);
    RAISE EXCEPTION 'cross-owner semantic binding unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='cross-owner semantic binding unexpectedly succeeded' THEN RAISE; END IF;
    IF SQLERRM<>'image_semantic_intent_forbidden' THEN
      RAISE EXCEPTION 'cross-owner check failed for the wrong reason: %',SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'PASS: semantic typo, exact frozen current-run binding, owner scope and repeat idempotence';
END $$;

ROLLBACK;
