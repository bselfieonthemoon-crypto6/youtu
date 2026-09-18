-- Run after both 20260913000001 and 20260913000002.
-- Uses one existing owned canvas, creates isolated rows, and rolls everything back.
BEGIN;
DO $$
DECLARE
  owner_id uuid; canvas_id uuid; session_id uuid:=gen_random_uuid();
  requirement_run uuid:=gen_random_uuid(); discussion_run uuid:=gen_random_uuid();
  failed_bare_run uuid:=gen_random_uuid(); agree_run uuid:=gen_random_uuid(); confirm_run uuid:=gen_random_uuid(); newer_run uuid:=gen_random_uuid();
  change_run uuid:=gen_random_uuid(); after_change_run uuid:=gen_random_uuid(); change_message uuid;
  tool_id uuid:=gen_random_uuid(); proposal jsonb; decided jsonb; bound_id uuid; review_context jsonb;
  failed_bare_message uuid; discussion_message uuid; agree_message uuid; cta_message uuid;
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
    VALUES(session_id,canvas_id,owner_id,'proposal relation rollback test');

  PERFORM public.loomic_create_run_with_request(requirement_run,session_id,owner_id,
    'proposal-relation-requirement',NULL,'fast','保存 Northstar 横幅方案');
  proposal:=public.loomic_propose_image(session_id,canvas_id,requirement_run,
    jsonb_build_object('operation','generate','title','Northstar 横幅','prompt','blue brand banner','model','rollback-test','aspectRatio','16:9'),
    '{}'::jsonb);
  INSERT INTO public.tool_executions(id,run_id,tool_call_id,tool_name,status,input,output,requested_by,finished_at)
  VALUES(tool_id,requirement_run,'proposal-save-call','generate_image','completed','{}',
    jsonb_build_object('status','awaiting_confirmation','confirmation',jsonb_build_object('confirmationId',proposal->>'id')),owner_id,now());
  INSERT INTO public.chat_messages(session_id,role,content,content_blocks)
  VALUES(session_id,'assistant','方案已保存，可以先讨论。',jsonb_build_array(jsonb_build_object(
    'type','tool','toolCallId','proposal-save-call','toolName','generate_image','status','completed','output',
    jsonb_build_object('status','awaiting_confirmation','confirmation',jsonb_build_object('confirmationId',proposal->>'id')))));

  -- Without an immediately preceding generation CTA a bare confirmation is
  -- not authorized, but remains eligible for later continuity classification.
  PERFORM public.loomic_create_run_with_request(failed_bare_run,session_id,owner_id,
    'proposal-relation-failed-bare',NULL,'fast','确认');
  SELECT request_message_id INTO failed_bare_message FROM public.agent_runs WHERE id=failed_bare_run;
  review_context:=public.loomic_get_contextual_image_confirmation_review(owner_id,session_id,canvas_id,failed_bare_run);
  IF review_context IS NULL THEN RAISE EXCEPTION 'bounded dialogue review context was not available'; END IF;

  PERFORM public.loomic_create_run_with_request(discussion_run,session_id,owner_id,
    'proposal-relation-discussion',NULL,'fast','这个色彩符合品牌吗？');
  SELECT request_message_id INTO discussion_message FROM public.agent_runs WHERE id=discussion_run;
  INSERT INTO public.chat_messages(session_id,role,content) VALUES(session_id,'assistant','符合，蓝色与品牌规范一致。');
  PERFORM public.loomic_create_run_with_request(agree_run,session_id,owner_id,
    'proposal-relation-agree',NULL,'fast','符合，保留当前方案。');
  SELECT request_message_id INTO agree_message FROM public.agent_runs WHERE id=agree_run;
  INSERT INTO public.chat_messages(session_id,role,content)
    VALUES(session_id,'assistant','留白这块我们就此定下。想生成时告诉我一声即可，我再提交任务。')
    RETURNING id INTO cta_message;
  PERFORM public.loomic_create_run_with_request(confirm_run,session_id,owner_id,
    'proposal-relation-confirm',NULL,'fast','确认');

  PERFORM public.loomic_record_image_proposal_turn_relations(owner_id,session_id,canvas_id,confirm_run,
    (proposal->>'id')::uuid,jsonb_build_array(
      jsonb_build_object('message_id',failed_bare_message,'relation','preserve'),
      jsonb_build_object('message_id',discussion_message,'relation','preserve'),
      jsonb_build_object('message_id',agree_message,'relation','preserve')));
  review_context:=public.loomic_get_contextual_image_confirmation_review(owner_id,session_id,canvas_id,confirm_run);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(review_context->'messages') message
    WHERE message->>'id'=cta_message::text AND message->>'role'='assistant') THEN
    RAISE EXCEPTION 'natural CTA message missing from bounded review context';
  END IF;
  -- This call represents a positive server-side semantic review of cta_message.
  bound_id:=public.loomic_bind_reviewed_contextual_image_confirmation(
    owner_id,session_id,canvas_id,confirm_run,(proposal->>'id')::uuid,cta_message);
  IF bound_id IS DISTINCT FROM (proposal->>'id')::uuid THEN RAISE EXCEPTION 'contextual bare confirmation did not bind'; END IF;
  IF public.loomic_get_current_image_proposal(session_id,canvas_id,confirm_run)->>'id' IS DISTINCT FROM proposal->>'id' THEN
    RAISE EXCEPTION 'discussion-preserved proposal is not current';
  END IF;
  decided:=public.loomic_decide_current_image((proposal->>'id')::uuid,session_id,canvas_id,confirm_run,'confirm');
  IF decided->>'status' IS DISTINCT FROM 'confirmed' THEN RAISE EXCEPTION 'contextual confirmation was not decided'; END IF;
  -- Repeating the same exact decision is idempotent and returns the confirmed row.
  IF public.loomic_decide_current_image((proposal->>'id')::uuid,session_id,canvas_id,confirm_run,'confirm')->>'status'
    IS DISTINCT FROM 'confirmed' THEN RAISE EXCEPTION 'repeat confirmation was not idempotent'; END IF;

  -- A newer unclassified turn cannot inherit the prior confirmation binding.
  PERFORM public.loomic_create_run_with_request(newer_run,session_id,owner_id,
    'proposal-relation-newer',NULL,'fast','另外先聊聊落地页');
  IF public.loomic_get_current_image_proposal(session_id,canvas_id,newer_run) IS NOT NULL THEN
    RAISE EXCEPTION 'newer unclassified turn reused an older confirmation';
  END IF;

  -- A new pending proposal followed by a classified unsaved change cannot be
  -- revived by a later explicit confirmation.
  proposal:=public.loomic_propose_image(session_id,canvas_id,newer_run,
    jsonb_build_object('operation','generate','title','Second banner','prompt','orange banner','model','rollback-test','aspectRatio','16:9'),
    '{}'::jsonb);
  PERFORM public.loomic_create_run_with_request(change_run,session_id,owner_id,
    'proposal-relation-change',NULL,'fast','把背景改成绿色，先不要保存新稿');
  SELECT request_message_id INTO change_message FROM public.agent_runs WHERE id=change_run;
  PERFORM public.loomic_record_image_proposal_turn_relations(owner_id,session_id,canvas_id,change_run,
    (proposal->>'id')::uuid,jsonb_build_array(jsonb_build_object('message_id',change_message,'relation','invalidate')));
  PERFORM public.loomic_create_run_with_request(after_change_run,session_id,owner_id,
    'proposal-relation-after-change',NULL,'fast','确认生成');
  IF public.loomic_get_current_image_proposal(session_id,canvas_id,after_change_run) IS NOT NULL
    OR public.loomic_decide_current_image((proposal->>'id')::uuid,session_id,canvas_id,after_change_run,'confirm') IS NOT NULL THEN
    RAISE EXCEPTION 'unsaved change did not invalidate the old proposal';
  END IF;

  -- The server-only RPC still enforces the exact owner even under service role.
  BEGIN
    PERFORM public.loomic_bind_reviewed_contextual_image_confirmation(
      gen_random_uuid(),session_id,canvas_id,confirm_run,(proposal->>'id')::uuid,cta_message);
    RAISE EXCEPTION 'cross-owner contextual binding unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='cross-owner contextual binding unexpectedly succeeded' THEN RAISE; END IF;
    IF SQLERRM<>'image_proposal_relation_forbidden' THEN
      RAISE EXCEPTION 'cross-owner check failed for the wrong reason: %',SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'PASS: semantic CTA context, discussion->bare confirm, newer-turn, owner scope and repeat idempotence';
END $$;
ROLLBACK;
