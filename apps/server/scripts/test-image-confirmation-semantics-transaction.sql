-- Run only after 20260911000011_image_confirmation_semantics.sql is applied.
-- Creates an isolated conversation and rolls every write back.
BEGIN;
DO $$
DECLARE
  owner_id uuid;
  canvas_id uuid;
  session_id uuid := gen_random_uuid();
  requirement_run uuid := gen_random_uuid();
  legacy_confirmation_run uuid := gen_random_uuid();
  final_confirmation_run uuid := gen_random_uuid();
  changed_run uuid := gen_random_uuid();
  after_change_run uuid := gen_random_uuid();
  proposal jsonb;
  current_proposal jsonb;
  semantic_case record;
BEGIN
  -- SEMANTIC_CASES_BEGIN
  FOR semantic_case IN SELECT * FROM (VALUES
    ('确认生成','confirm'),
    ('确认，按这次修改生成。','confirm'),
    ('同意按本次调整后的方案生成预览','confirm'),
    ('确认，按上述方案生成。','confirm'),
    ('就按这个方案生成吧','confirm'),
    ('好的，按这个方案生成','confirm'),
    ('确认生成刚才保存的 Northstar Logo 方案，按该方案生成一张。','confirm'),
    ('确认执行这个透明 PNG 去背景方案，其他两个 JPG 暂不执行。','confirm'),
    ('取消生成','cancel'),
    ('不要生成','cancel'),
    ('好的','acknowledge'),
    ('收到。','acknowledge'),
    ('确认生成吗？','question'),
    ('可以生成吗','question'),
    ('确认，按这次修改生成吗？','question'),
    ('好的，按这个方案生成吗','question'),
    ('确认，但请改成绿色后生成。','change'),
    ('确认生成，但是换成 16:9。','change'),
    ('好的，按这个方案生成，但换成绿色','change'),
    ('确认按本次修改生成两张','change'),
    ('确认，按这次修改生成，不过再加一行文字。','change'),
    ('如果免费就确认生成','other'),
    ('好的，如果免费就按这个方案生成','other'),
    ('不确认，按这次修改生成。','change'),
    ('确认','other'),
    ('稍后再说','other')
  ) AS cases(prompt,expected)
  LOOP
    IF private.loomic_classify_image_message(semantic_case.prompt) IS DISTINCT FROM semantic_case.expected THEN
      RAISE EXCEPTION 'semantic mismatch for "%": expected %, got %',semantic_case.prompt,semantic_case.expected,
        private.loomic_classify_image_message(semantic_case.prompt);
    END IF;
  END LOOP;
  -- SEMANTIC_CASES_END

  SELECT c.created_by,c.id INTO owner_id,canvas_id
  FROM public.canvases c
  JOIN public.workspace_members member
    ON member.workspace_id=c.workspace_id AND member.user_id=c.created_by
  WHERE c.created_by IS NOT NULL
  ORDER BY c.created_at,c.id LIMIT 1;
  IF owner_id IS NULL THEN RAISE EXCEPTION 'rollback fixture needs one owned workspace canvas'; END IF;

  PERFORM set_config('request.jwt.claim.sub',owner_id::text,true);
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',owner_id,'role','authenticated')::text,true);
  INSERT INTO public.chat_sessions(id,canvas_id,created_by,title)
    VALUES(session_id,canvas_id,owner_id,'confirmation semantics rollback test');

  PERFORM public.loomic_create_run_with_request(
    requirement_run,session_id,owner_id,'confirmation-semantics-requirement',NULL,'fast','生成一张红色方形 Logo'
  );
  proposal:=public.loomic_propose_image(
    session_id,canvas_id,requirement_run,
    jsonb_build_object('operation','generate','title','Rollback Logo','prompt','red square logo','model','rollback-test','aspectRatio','1:1'),
    '{}'::jsonb
  );

  -- Simulate the historical failed runtime turn: the user confirmed naturally,
  -- but no proposal decision/write happened. The saved pending row must remain
  -- resolvable both on that turn and on the following canonical confirmation.
  PERFORM public.loomic_create_run_with_request(
    legacy_confirmation_run,session_id,owner_id,'confirmation-semantics-natural',NULL,'fast','确认，按这次修改生成。'
  );
  current_proposal:=public.loomic_get_current_image_proposal(session_id,canvas_id,legacy_confirmation_run);
  IF current_proposal->>'id' IS DISTINCT FROM proposal->>'id' OR current_proposal->>'status' IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'natural confirmation hid or revived the saved pending proposal';
  END IF;
  PERFORM public.loomic_create_run_with_request(
    final_confirmation_run,session_id,owner_id,'confirmation-semantics-final',NULL,'fast','确认生成'
  );
  current_proposal:=public.loomic_get_current_image_proposal(session_id,canvas_id,final_confirmation_run);
  IF current_proposal->>'id' IS DISTINCT FROM proposal->>'id' OR current_proposal->>'status' IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'later explicit confirmation could not recover saved pending proposal';
  END IF;

  -- An actual changed requirement is not a decision and permanently separates
  -- later free-text confirmation from the stale proposal.
  PERFORM public.loomic_create_run_with_request(
    changed_run,session_id,owner_id,'confirmation-semantics-change',NULL,'fast','确认，但请改成绿色后生成。'
  );
  PERFORM public.loomic_create_run_with_request(
    after_change_run,session_id,owner_id,'confirmation-semantics-after-change',NULL,'fast','确认生成'
  );
  IF public.loomic_get_current_image_proposal(session_id,canvas_id,after_change_run) IS NOT NULL THEN
    RAISE EXCEPTION 'later confirmation restored a proposal across a changed requirement';
  END IF;

  RAISE NOTICE 'PASS: natural revision confirmation preserves pending; question/negation/change denied; changed requirement stays stale';
END $$;
ROLLBACK;
