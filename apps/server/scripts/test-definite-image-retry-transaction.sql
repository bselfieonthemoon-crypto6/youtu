-- Run only after 20260911000009_definite_image_retry.sql is applied locally.
-- Uses the known failed QA job as evidence and rolls every write back.
BEGIN;
DO $$
DECLARE
  source_id uuid := '9d267e7b-51d3-4d29-a381-dcb1b9f7d226';
  source_job public.background_jobs;
  source_proposal public.image_generation_proposals;
  retry_run uuid := gen_random_uuid();
  retry_one jsonb;
  retry_two jsonb;
  other_session uuid := gen_random_uuid();
  other_run uuid := gen_random_uuid();
BEGIN
  SELECT * INTO source_job FROM public.background_jobs WHERE id=source_id;
  SELECT * INTO source_proposal FROM public.image_generation_proposals WHERE id=source_id;
  IF source_job.id IS NULL OR source_proposal.id IS NULL THEN
    RAISE EXCEPTION 'QA source job/proposal missing';
  END IF;

  PERFORM set_config('request.jwt.claim.sub',source_job.created_by::text,true);
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',source_job.created_by,'role','authenticated')::text,true);
  PERFORM public.loomic_create_run_with_request(
    retry_run,source_job.session_id,source_job.created_by,'retry-rollback-test',NULL,'fast','确认生成'
  );

  UPDATE public.background_jobs SET created_at=now()+interval '1 minute' WHERE id=source_id;
  BEGIN
    PERFORM public.loomic_retry_definite_image_failure(
      source_id,source_job.session_id,source_proposal.canvas_id,retry_run
    );
    RAISE EXCEPTION 'same-turn request was retried';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%image_retry_new_user_turn_required%' THEN RAISE; END IF;
  END;
  UPDATE public.background_jobs SET created_at=source_job.created_at WHERE id=source_id;

  -- A generic unknown 503 with no complete legacy fingerprint must stay blocked.
  UPDATE public.background_jobs SET error_message='503 upstream unavailable: no available channel' WHERE id=source_id;
  BEGIN
    PERFORM public.loomic_retry_definite_image_failure(
      source_id,source_job.session_id,source_proposal.canvas_id,retry_run
    );
    RAISE EXCEPTION 'unknown provider result was retried';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%image_retry_result_not_definite%' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.image_generation_proposals WHERE retry_of=source_id) THEN
    RAISE EXCEPTION 'unknown provider result created a retry proposal';
  END IF;

  UPDATE public.background_jobs SET error_message=source_job.error_message WHERE id=source_id;
  retry_one:=public.loomic_retry_definite_image_failure(
    source_id,source_job.session_id,source_proposal.canvas_id,retry_run
  );
  retry_two:=public.loomic_retry_definite_image_failure(
    source_id,source_job.session_id,source_proposal.canvas_id,retry_run
  );
  IF retry_one->>'id' IS DISTINCT FROM retry_two->>'id' THEN
    RAISE EXCEPTION 'same retry request produced two proposal ids';
  END IF;
  IF (retry_one->>'id')::uuid=source_id OR retry_one->'input' IS DISTINCT FROM to_jsonb(source_proposal.input)
    OR retry_one->>'retry_of' IS DISTINCT FROM source_id::text THEN
    RAISE EXCEPTION 'retry did not preserve the frozen plan and lineage';
  END IF;
  IF (SELECT count(*) FROM public.image_generation_proposals
      WHERE retry_of=source_id AND requirement_message_id=(retry_one->>'requirement_message_id')::uuid)<>1 THEN
    RAISE EXCEPTION 'same-run retry idempotency failed';
  END IF;

  INSERT INTO public.chat_sessions(id,canvas_id,created_by,title)
    VALUES(other_session,source_proposal.canvas_id,source_job.created_by,'retry cross-session rollback test');
  PERFORM public.loomic_create_run_with_request(
    other_run,other_session,source_job.created_by,'retry-cross-session-test',NULL,'fast','确认生成'
  );
  BEGIN
    PERFORM public.loomic_retry_definite_image_failure(
      source_id,other_session,source_proposal.canvas_id,other_run
    );
    RAISE EXCEPTION 'cross-session retry succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%image_retry_current_proposal_required%' THEN RAISE; END IF;
  END;

  RAISE NOTICE 'PASS: unknown blocked; definite legacy rejection cloned once; frozen input preserved; cross-session retry denied';
END $$;
ROLLBACK;
