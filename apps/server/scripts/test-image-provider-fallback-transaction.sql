-- Run only after 20260911000010_image_provider_fallback.sql is applied.
-- Uses the known local QA provider rows and rolls every fixture/snapshot/Vault
-- credential back. It never selects or prints a decrypted credential.
BEGIN;
DO $$
DECLARE
  requested_catalog constant uuid := 'cd9fbe33-92f9-4979-85fc-59901ddd9f32';
  expected_fallback constant uuid := '29a0cb35-0794-4239-9a95-948c8cf93705';
  source_job_id constant uuid := '9d267e7b-51d3-4d29-a381-dcb1b9f7d226';
  source_job public.background_jobs%ROWTYPE;
  source_proposal public.image_generation_proposals%ROWTYPE;
  requested_model public.workspace_provider_models%ROWTYPE;
  requested_config public.workspace_provider_configs%ROWTYPE;
  fallback_model public.workspace_provider_models%ROWTYPE;
  fallback_config public.workspace_provider_configs%ROWTYPE;
  test_job uuid := gen_random_uuid();
  first_plan uuid[];
  replay_plan uuid[];
  approved_cost integer := 20;
BEGIN
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  SELECT * INTO source_job FROM public.background_jobs WHERE id=source_job_id;
  SELECT * INTO source_proposal FROM public.image_generation_proposals WHERE id=source_job_id;
  SELECT m.* INTO requested_model FROM public.workspace_provider_models m
    WHERE m.catalog_key=requested_catalog;
  SELECT * INTO requested_config FROM public.workspace_provider_configs
    WHERE id=requested_model.provider_config_id;
  SELECT m.* INTO fallback_model FROM public.workspace_provider_models m
    WHERE m.catalog_key=expected_fallback;
  SELECT * INTO fallback_config FROM public.workspace_provider_configs
    WHERE id=fallback_model.provider_config_id;
  IF source_job.id IS NULL OR source_proposal.id IS NULL OR requested_model.id IS NULL
    OR fallback_model.id IS NULL OR requested_config.id IS NULL OR fallback_config.id IS NULL
  THEN RAISE EXCEPTION 'QA source/provider fixture missing'; END IF;
  IF source_job.workspace_id IS DISTINCT FROM requested_config.workspace_id
    OR requested_config.workspace_id IS DISTINCT FROM fallback_config.workspace_id
    OR requested_model.upstream_model_id IS DISTINCT FROM fallback_model.upstream_model_id
  THEN RAISE EXCEPTION 'QA providers are not same-workspace exact-upstream alternatives'; END IF;
  IF requested_config.enabled OR NOT fallback_config.enabled OR NOT fallback_model.enabled
    OR fallback_config.last_test_status IS DISTINCT FROM 'succeeded'
  THEN RAISE EXCEPTION 'QA disabled/active provider fixture changed'; END IF;

  INSERT INTO public.background_jobs(
    id,workspace_id,project_id,session_id,queue_name,job_type,payload,created_by
  ) VALUES (
    test_job,source_job.workspace_id,source_job.project_id,source_job.session_id,
    'image_generation_jobs','image_generation',jsonb_build_object(
      'prompt','fallback transaction test','model','workspace:'||requested_catalog::text,
      'operation','generate','aspect_ratio','1:1','quality','hd'
    ),source_job.created_by
  );
  -- Insert after the job so this fixture does not depend on the production
  -- frozen-proposal trigger shape; the plan RPC still enforces its approved cap.
  INSERT INTO public.image_generation_proposals(
    id,session_id,canvas_id,created_by,origin_run_id,input,details,
    approved_cost,status,expires_at
  ) VALUES (
    test_job,source_proposal.session_id,source_proposal.canvas_id,
    source_proposal.created_by,source_proposal.origin_run_id,
    jsonb_build_object('prompt','fallback transaction test',
      'model','workspace:'||requested_catalog::text,'operation','generate',
      'aspectRatio','1:1','quality','hd'),
    '{}'::jsonb,approved_cost,'confirmed',now()+interval '1 hour'
  );

  BEGIN
    PERFORM public.loomic_image_provider_plan_create(
      source_job.workspace_id,test_job,requested_catalog,approved_cost+1,'credits-v1','image'
    );
    RAISE EXCEPTION 'plan exceeded approved cost';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%image_provider_plan_exceeds_approved_cost%' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.provider_execution_snapshots WHERE background_job_id=test_job) THEN
    RAISE EXCEPTION 'rejected over-cap plan left snapshots';
  END IF;

  first_plan:=public.loomic_image_provider_plan_create(
    source_job.workspace_id,test_job,requested_catalog,approved_cost,'credits-v1','image'
  );
  replay_plan:=public.loomic_image_provider_plan_create(
    source_job.workspace_id,test_job,requested_catalog,approved_cost,'credits-v1','image'
  );
  IF first_plan IS DISTINCT FROM replay_plan OR cardinality(first_plan)<1 OR cardinality(first_plan)>8 THEN
    RAISE EXCEPTION 'plan creation is not bounded/idempotent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.provider_execution_snapshots
    WHERE background_job_id=test_job AND execution_stage='generation'
      AND provider_model_catalog_key=expected_fallback
  ) THEN RAISE EXCEPTION 'active exact-upstream fallback was not frozen'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.provider_execution_snapshots
    WHERE background_job_id=test_job AND execution_stage='generation'
      AND provider_model_catalog_key=requested_catalog
  ) THEN RAISE EXCEPTION 'disabled requested provider was frozen as executable'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.provider_execution_snapshots s
    WHERE s.background_job_id=test_job AND s.execution_stage='generation' AND (
      s.catalog_key IS DISTINCT FROM requested_catalog
      OR s.upstream_model_id IS DISTINCT FROM requested_model.upstream_model_id
      OR s.billing_credits_cost IS DISTINCT FROM approved_cost
      OR s.billing_pricing_version IS DISTINCT FROM 'credits-v1'
      OR s.billing_unit IS DISTINCT FROM 'image'
      OR s.attempt_ordinal<0 OR s.attempt_ordinal>=8
    )
  ) THEN RAISE EXCEPTION 'frozen plan identity/billing is invalid'; END IF;
  IF (SELECT count(*) FROM public.provider_execution_snapshots
      WHERE background_job_id=test_job AND execution_stage='generation')
    IS DISTINCT FROM
    (SELECT count(*) FROM public.provider_execution_credentials c
      JOIN public.provider_execution_snapshots s ON s.id=c.snapshot_id
      WHERE s.background_job_id=test_job AND s.execution_stage='generation')
  THEN RAISE EXCEPTION 'a frozen attempt is missing its credential binding'; END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT attempt_ordinal,row_number() OVER(ORDER BY attempt_ordinal)-1 AS expected
      FROM public.provider_execution_snapshots
      WHERE background_job_id=test_job AND execution_stage='generation'
    ) q WHERE q.attempt_ordinal<>q.expected
  ) THEN RAISE EXCEPTION 'attempt ordinals are not contiguous from zero'; END IF;
  IF (SELECT count(*) FROM public.loomic_image_provider_plan_resolve(
      source_job.workspace_id,test_job)) IS DISTINCT FROM cardinality(first_plan)
  THEN RAISE EXCEPTION 'resolved plan silently dropped an attempt'; END IF;
  RAISE NOTICE 'PASS: disabled original skipped; exact-upstream tested fallback frozen; cap enforced; idempotency, credentials and ordinals verified';
END $$;
ROLLBACK;
