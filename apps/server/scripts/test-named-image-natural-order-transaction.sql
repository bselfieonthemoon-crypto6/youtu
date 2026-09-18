-- Run only after 20260912000001_named_image_natural_order.sql is applied.
-- Creates isolated conversations and rolls every write back. It exercises the
-- public decision function, not only the private parser.
BEGIN;
DO $$
DECLARE
  owner_id uuid;
  canvas_id uuid;
  session_id uuid := gen_random_uuid();
  wrong_title_session uuid := gen_random_uuid();
  latest_session uuid := gen_random_uuid();
  other_session uuid := gen_random_uuid();
  requirement_run uuid := gen_random_uuid();
  confirmation_run uuid := gen_random_uuid();
  wrong_requirement_run uuid := gen_random_uuid();
  wrong_confirmation_run uuid := gen_random_uuid();
  first_requirement_run uuid := gen_random_uuid();
  second_requirement_run uuid := gen_random_uuid();
  latest_confirmation_run uuid := gen_random_uuid();
  cross_session_run uuid := gen_random_uuid();
  proposal jsonb;
  wrong_proposal jsonb;
  first_proposal jsonb;
  second_proposal jsonb;
  result jsonb;
  random_actor uuid := gen_random_uuid();
  unsafe_case text;
BEGIN
  SELECT c.created_by,c.id INTO owner_id,canvas_id
  FROM public.canvases c
  JOIN public.workspace_members member
    ON member.workspace_id=c.workspace_id AND member.user_id=c.created_by
  WHERE c.created_by='541006fa-d2a1-4305-be55-b6263c27a1e3'::uuid
    AND c.id='51deede3-b8b6-4a19-8a53-78ed36b4e7b3'::uuid
  ORDER BY c.created_at,c.id LIMIT 1;
  IF owner_id IS NULL THEN RAISE EXCEPTION 'rollback fixture needs one owned workspace canvas'; END IF;

  PERFORM set_config('request.jwt.claim.sub',owner_id::text,true);
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',owner_id,'role','authenticated')::text,true);
  FOREACH unsafe_case IN ARRAY ARRAY[
    '确认生成北岸烘焙这张海报？',
    '确认生成如果免费北岸烘焙这张海报',
    '确认生成北岸烘焙改成蓝色这张海报',
    '确认生成北岸烘焙这张海报，比例改成16:9',
    '确认生成北岸烘焙这张海报，另外改成蓝色',
    '确认生成北岸烘焙这两张海报'
  ] LOOP
    IF private.loomic_classify_image_message(unsafe_case)='confirm' THEN
      RAISE EXCEPTION 'unsafe natural-order approval: %',unsafe_case;
    END IF;
  END LOOP;
  INSERT INTO public.chat_sessions(id,canvas_id,created_by,title) VALUES
    (session_id,canvas_id,owner_id,'named natural-order success rollback test'),
    (wrong_title_session,canvas_id,owner_id,'named natural-order wrong title rollback test'),
    (latest_session,canvas_id,owner_id,'named natural-order latest rollback test'),
    (other_session,canvas_id,owner_id,'named natural-order cross-session rollback test');

  -- The production failure sentence must approve the exact frozen title in one
  -- user confirmation turn.
  PERFORM public.loomic_create_run_with_request(
    requirement_run,session_id,owner_id,'named-order-requirement',NULL,'fast',
    '请为品牌北岸烘焙保存一张秋日酸面包海报方案'
  );
  proposal:=public.loomic_propose_image(
    session_id,canvas_id,requirement_run,
    jsonb_build_object('operation','generate','title','秋日酸面包 4:5 竖版海报（北岸烘焙）',
      'prompt','autumn sourdough poster','model','rollback-test','aspectRatio','4:5'),
    '{}'::jsonb
  );
  PERFORM public.loomic_create_run_with_request(
    confirmation_run,session_id,owner_id,'named-order-confirmation',NULL,'fast',
    '确认生成北岸烘焙这张海报。'
  );
  result:=public.loomic_decide_current_image(
    (proposal->>'id')::uuid,session_id,canvas_id,confirmation_run,'confirm'
  );
  IF result->>'id' IS DISTINCT FROM proposal->>'id' OR result->>'status' IS DISTINCT FROM 'confirmed' THEN
    RAISE EXCEPTION 'name-before-deictic confirmation did not approve the frozen proposal';
  END IF;

  -- A syntactically valid confirmation for another brand must not approve the
  -- locked proposal, even when its id is supplied directly.
  PERFORM public.loomic_create_run_with_request(
    wrong_requirement_run,wrong_title_session,owner_id,'named-order-wrong-requirement',NULL,'fast',
    '请保存北岸烘焙海报方案'
  );
  wrong_proposal:=public.loomic_propose_image(
    wrong_title_session,canvas_id,wrong_requirement_run,
    jsonb_build_object('operation','generate','title','秋日酸面包 4:5 竖版海报（北岸烘焙）',
      'prompt','autumn sourdough poster','model','rollback-test','aspectRatio','4:5'),
    '{}'::jsonb
  );
  PERFORM public.loomic_create_run_with_request(
    wrong_confirmation_run,wrong_title_session,owner_id,'named-order-wrong-confirmation',NULL,'fast',
    '确认生成南岸烘焙这张海报。'
  );
  IF public.loomic_decide_current_image(
    (wrong_proposal->>'id')::uuid,wrong_title_session,canvas_id,wrong_confirmation_run,'confirm'
  ) IS NOT NULL THEN RAISE EXCEPTION 'wrong immutable title was authorized'; END IF;
  IF (SELECT status FROM public.image_generation_proposals WHERE id=(wrong_proposal->>'id')::uuid) <> 'pending' THEN
    RAISE EXCEPTION 'wrong-title attempt changed the frozen proposal';
  END IF;

  -- A newer proposal supersedes the old one. Both titles contain the named
  -- brand, so rejection of the first id is a latest-proposal fence, not a title
  -- mismatch.
  PERFORM public.loomic_create_run_with_request(
    first_requirement_run,latest_session,owner_id,'named-order-first',NULL,'fast','保存北岸烘焙第一稿海报方案'
  );
  first_proposal:=public.loomic_propose_image(
    latest_session,canvas_id,first_requirement_run,
    jsonb_build_object('operation','generate','title','北岸烘焙 第一稿海报',
      'prompt','first poster','model','rollback-test','aspectRatio','4:5'),'{}'::jsonb
  );
  PERFORM public.loomic_create_run_with_request(
    second_requirement_run,latest_session,owner_id,'named-order-second',NULL,'fast','保存北岸烘焙最终稿海报方案'
  );
  second_proposal:=public.loomic_propose_image(
    latest_session,canvas_id,second_requirement_run,
    jsonb_build_object('operation','generate','title','北岸烘焙 最终稿海报',
      'prompt','final poster','model','rollback-test','aspectRatio','4:5'),'{}'::jsonb
  );
  PERFORM public.loomic_create_run_with_request(
    latest_confirmation_run,latest_session,owner_id,'named-order-latest-confirmation',NULL,'fast',
    '确认生成北岸烘焙这张海报。'
  );
  IF public.loomic_decide_current_image(
    (first_proposal->>'id')::uuid,latest_session,canvas_id,latest_confirmation_run,'confirm'
  ) IS NOT NULL THEN RAISE EXCEPTION 'superseded proposal was authorized'; END IF;
  result:=public.loomic_decide_current_image(
    (second_proposal->>'id')::uuid,latest_session,canvas_id,latest_confirmation_run,'confirm'
  );
  IF result->>'status' IS DISTINCT FROM 'confirmed' THEN RAISE EXCEPTION 'latest matching proposal was rejected'; END IF;

  -- Supplying another session cannot move the original proposal across its
  -- authenticated owner/session/canvas binding.
  PERFORM public.loomic_create_run_with_request(
    cross_session_run,other_session,owner_id,'named-order-cross-session',NULL,'fast',
    '确认生成北岸烘焙这张海报。'
  );
  IF public.loomic_decide_current_image(
    (proposal->>'id')::uuid,other_session,canvas_id,cross_session_run,'confirm'
  ) IS NOT NULL THEN RAISE EXCEPTION 'cross-session proposal was authorized'; END IF;

  BEGIN
    PERFORM public.loomic_decide_current_image(
      (proposal->>'id')::uuid,session_id,gen_random_uuid(),confirmation_run,'confirm'
    );
    RAISE EXCEPTION 'cross-canvas proposal was authorized';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%image_session_forbidden%' THEN RAISE; END IF;
  END;

  PERFORM set_config('request.jwt.claim.sub',random_actor::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',random_actor,'role','authenticated')::text,true);
  BEGIN
    PERFORM public.loomic_decide_current_image(
      (proposal->>'id')::uuid,session_id,canvas_id,confirmation_run,'confirm'
    );
    RAISE EXCEPTION 'cross-owner proposal was authorized';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%image_session_forbidden%' THEN RAISE; END IF;
  END;

  RAISE NOTICE 'PASS: natural order confirmed once; wrong title, stale proposal, cross-owner/session/canvas denied';
END $$;
ROLLBACK;
