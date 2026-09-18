\set ON_ERROR_STOP on

-- Transactional data acceptance for the recovery selector. It exercises the
-- real replica schema and leaves functions, jobs and assets unchanged.
BEGIN;
\ir ../migrations/20260909000016_recoverable_canvas_image_jobs.sql

DO $$
DECLARE
  base_job public.background_jobs%ROWTYPE;
  live_asset uuid := gen_random_uuid();
  live_layer_asset uuid := gen_random_uuid();
  deleting_asset uuid := gen_random_uuid();
  live_job uuid := gen_random_uuid();
  deleting_job uuid := gen_random_uuid();
  wrong_target_job uuid := gen_random_uuid();
  missing_layer_job uuid := gen_random_uuid();
  incomplete_layer_job uuid := gen_random_uuid();
  malformed_layers_job uuid := gen_random_uuid();
  cross_workspace_asset uuid;
  cross_workspace_job uuid := gen_random_uuid();
  design_session uuid;
  v_design_id uuid;
  design_marker text := gen_random_uuid()::text;
  design_live_job uuid := gen_random_uuid();
  selected_design_ids uuid[];
  selected_ids uuid[];
BEGIN
  SELECT * INTO base_job
  FROM public.background_jobs
  WHERE canvas_id IS NOT NULL AND project_id IS NOT NULL
  LIMIT 1;
  IF base_job.id IS NULL THEN
    RAISE EXCEPTION 'fixture_requires_one_canvas_job';
  END IF;
  SELECT job.session_id, design.id
    INTO design_session, v_design_id
  FROM public.background_jobs AS job
  JOIN public.design_documents AS design
    ON design.workspace_id = job.workspace_id
   AND design.project_id = base_job.project_id
   AND design.deleted_at IS NULL
  WHERE job.session_id IS NOT NULL
    AND job.workspace_id = base_job.workspace_id
  LIMIT 1;
  IF design_session IS NULL OR v_design_id IS NULL THEN
    RAISE EXCEPTION 'fixture_requires_session_and_design';
  END IF;
  SELECT id INTO cross_workspace_asset
  FROM public.asset_objects
  WHERE workspace_id IS DISTINCT FROM base_job.workspace_id
    AND deletion_pending_at IS NULL
  LIMIT 1;
  IF cross_workspace_asset IS NULL THEN
    RAISE EXCEPTION 'fixture_requires_cross_workspace_asset';
  END IF;

  INSERT INTO public.asset_objects(
    id, workspace_id, project_id, bucket, object_path, mime_type,
    byte_size, created_by, deletion_pending_at
  ) VALUES
    (live_asset, base_job.workspace_id, base_job.project_id, 'project-assets',
      'test/000016/live-main-' || live_asset || '.png', 'image/png', 1,
      base_job.created_by, NULL),
    (live_layer_asset, base_job.workspace_id, base_job.project_id, 'project-assets',
      'test/000016/live-layer-' || live_layer_asset || '.png', 'image/png', 1,
      base_job.created_by, NULL),
    (deleting_asset, base_job.workspace_id, base_job.project_id, 'project-assets',
      'test/000016/deleting-' || deleting_asset || '.png', 'image/png', 1,
      base_job.created_by, now());

  -- These 100 oldest jobs deliberately reference UUIDs absent from
  -- asset_objects. They must be filtered before LIMIT rather than starving the
  -- valid 101st candidate.
  INSERT INTO public.background_jobs(
    id, workspace_id, project_id, canvas_id, target_kind, session_id,
    queue_name, job_type, status, payload, result, created_by, completed_at
  )
  SELECT
    gen_random_uuid(), base_job.workspace_id, base_job.project_id,
    base_job.canvas_id, 'canvas', NULL, 'image_generation_jobs',
    'image_generation', 'succeeded',
    jsonb_build_object('target', jsonb_build_object(
      'kind', 'canvas', 'canvas_id', base_job.canvas_id
    )),
    jsonb_build_object(
      'asset_id', gen_random_uuid(), 'object_path', 'missing.png',
      'width', 1, 'height', 1, 'mime_type', 'image/png'
    ),
    base_job.created_by, now() - interval '2 days' + make_interval(secs => sequence)
  FROM generate_series(1, 100) AS sequence;

  -- These rows have a live asset but incomplete result JSON. They are the
  -- historical shape that used to throw in the application finalizer and
  -- could starve a later complete job forever.
  INSERT INTO public.background_jobs(
    id, workspace_id, project_id, canvas_id, target_kind, session_id,
    queue_name, job_type, status, payload, result, created_by, completed_at
  )
  SELECT
    gen_random_uuid(), base_job.workspace_id, base_job.project_id,
    base_job.canvas_id, 'canvas', NULL, 'image_generation_jobs',
    'image_generation', 'succeeded', '{}'::jsonb,
    jsonb_build_object(
      'asset_id', live_asset, 'width', 1, 'height', 1,
      'mime_type', 'image/png'
    ),
    base_job.created_by, now() - interval '36 hours' + make_interval(secs => sequence)
  FROM generate_series(1, 100) AS sequence;

  INSERT INTO public.background_jobs(
    id, workspace_id, project_id, canvas_id, target_kind, session_id,
    queue_name, job_type, status, payload, result, created_by, completed_at
  ) VALUES
    (live_job, base_job.workspace_id, base_job.project_id, base_job.canvas_id,
      'canvas', NULL, 'image_generation_jobs', 'image_generation', 'succeeded',
      jsonb_build_object('target', jsonb_build_object(
        'kind', 'canvas', 'canvas_id', base_job.canvas_id
      )),
      jsonb_build_object(
        'asset_id', live_asset, 'object_path', 'live.png', 'width', 1,
        'height', 1, 'mime_type', 'image/png', 'layers', jsonb_build_array(
          jsonb_build_object(
            'asset_id', live_layer_asset, 'object_path', 'live-layer.png',
            'width', 1, 'height', 1
          )
        )
      ), base_job.created_by, now() - interval '1 day'),
    (deleting_job, base_job.workspace_id, base_job.project_id, base_job.canvas_id,
      'canvas', NULL, 'image_generation_jobs', 'image_generation', 'succeeded',
      '{}'::jsonb,
      jsonb_build_object(
        'asset_id', deleting_asset, 'object_path', 'deleting.png', 'width', 1,
        'height', 1, 'mime_type', 'image/png'
      ), base_job.created_by, now() - interval '23 hours'),
    (wrong_target_job, base_job.workspace_id, base_job.project_id, base_job.canvas_id,
      'canvas', NULL, 'image_generation_jobs', 'image_generation', 'succeeded',
      jsonb_build_object('target', jsonb_build_object(
        'kind', 'canvas', 'canvas_id', gen_random_uuid()
      )),
      jsonb_build_object(
        'asset_id', live_asset, 'object_path', 'wrong-target.png', 'width', 1,
        'height', 1, 'mime_type', 'image/png'
      ), base_job.created_by, now() - interval '22 hours'),
    (missing_layer_job, base_job.workspace_id, base_job.project_id, base_job.canvas_id,
      'canvas', NULL, 'image_generation_jobs', 'image_generation', 'succeeded',
      '{}'::jsonb,
      jsonb_build_object(
        'asset_id', live_asset, 'object_path', 'missing-layer.png', 'width', 1,
        'height', 1, 'mime_type', 'image/png', 'layers', jsonb_build_array(
          jsonb_build_object('asset_id', gen_random_uuid())
        )
      ), base_job.created_by, now() - interval '21 hours'),
    (incomplete_layer_job, base_job.workspace_id, base_job.project_id, base_job.canvas_id,
      'canvas', NULL, 'image_generation_jobs', 'image_generation', 'succeeded',
      jsonb_build_object('operation', 'split_layers'),
      jsonb_build_object(
        'asset_id', live_asset, 'object_path', 'incomplete-layer.png', 'width', 1,
        'height', 1, 'mime_type', 'image/png', 'layers', jsonb_build_array(
          jsonb_build_object('asset_id', live_layer_asset, 'width', 1, 'height', 1)
        )
      ), base_job.created_by, now() - interval '20 hours'),
    (malformed_layers_job, base_job.workspace_id, base_job.project_id, base_job.canvas_id,
      'canvas', NULL, 'image_generation_jobs', 'image_generation', 'succeeded',
      jsonb_build_object('operation', 'split_layers'),
      jsonb_build_object(
        'asset_id', live_asset, 'object_path', 'malformed-layers.png', 'width', 1,
        'height', 1, 'mime_type', 'image/png', 'layers',
        jsonb_build_object('unexpected', 'object')
      ), base_job.created_by, now() - interval '19 hours'),
    (cross_workspace_job, base_job.workspace_id, base_job.project_id, base_job.canvas_id,
      'canvas', NULL, 'image_generation_jobs', 'image_generation', 'succeeded',
      '{}'::jsonb,
      jsonb_build_object(
        'asset_id', cross_workspace_asset, 'object_path', 'foreign.png',
        'width', 1, 'height', 1, 'mime_type', 'image/png'
      ), base_job.created_by, now() - interval '18 hours');

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  SELECT array_agg(id ORDER BY id) INTO selected_ids
  FROM public.loomic_recoverable_canvas_image_jobs(100)
  WHERE id IN (
    live_job, deleting_job, wrong_target_job, missing_layer_job,
    incomplete_layer_job, malformed_layers_job, cross_workspace_job
  );
  IF selected_ids IS DISTINCT FROM ARRAY[live_job] THEN
    RAISE EXCEPTION 'unexpected_recovery_candidates: %', selected_ids;
  END IF;

  -- One hundred older design jobs have only a pending finalization. They must
  -- not hide the later job whose target finalization is terminal.
  INSERT INTO public.background_jobs(
    id, workspace_id, project_id, canvas_id, design_id, target_kind, session_id,
    queue_name, job_type, status, payload, result, created_by, completed_at
  )
  SELECT
    gen_random_uuid(), base_job.workspace_id, base_job.project_id, NULL,
    v_design_id, 'design', design_session, 'image_generation_jobs',
    'image_generation', 'succeeded',
    jsonb_build_object('recovery_test', design_marker),
    jsonb_build_object(
      'asset_id', live_asset, 'object_path', 'design-pending.png',
      'signed_url', 'https://example.invalid/design-pending.png',
      'width', 1, 'height', 1, 'mime_type', 'image/png'
    ),
    base_job.created_by, now() - interval '2 days' + make_interval(secs => sequence)
  FROM generate_series(1, 100) AS sequence;

  INSERT INTO public.job_target_finalizations(
    job_id, workspace_id, target_kind, target_id, status, command_id
  )
  SELECT id, workspace_id, 'design', v_design_id, 'pending', gen_random_uuid()
  FROM public.background_jobs
  WHERE payload->>'recovery_test' = design_marker;

  INSERT INTO public.background_jobs(
    id, workspace_id, project_id, canvas_id, design_id, target_kind, session_id,
    queue_name, job_type, status, payload, result, created_by, completed_at
  ) VALUES (
    design_live_job, base_job.workspace_id, base_job.project_id, NULL,
    v_design_id, 'design', design_session, 'image_generation_jobs',
    'image_generation', 'succeeded',
    jsonb_build_object('recovery_test', design_marker),
    jsonb_build_object(
      'asset_id', live_asset, 'object_path', 'design-terminal.png',
      'signed_url', 'https://example.invalid/design-terminal.png',
      'width', 1, 'height', 1, 'mime_type', 'image/png'
    ), base_job.created_by, now() - interval '1 day'
  );
  INSERT INTO public.job_target_finalizations(
    job_id, workspace_id, target_kind, target_id, status, command_id, result
  ) VALUES (
    design_live_job, base_job.workspace_id, 'design', v_design_id, 'completed',
    gen_random_uuid(), jsonb_build_object('design_id', v_design_id)
  );

  SELECT array_agg(id ORDER BY id) INTO selected_design_ids
  FROM public.loomic_recoverable_design_image_chats(100)
  WHERE payload->>'recovery_test' = design_marker;
  IF selected_design_ids IS DISTINCT FROM ARRAY[design_live_job] THEN
    RAISE EXCEPTION 'unexpected_design_recovery_candidates: %', selected_design_ids;
  END IF;

  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  BEGIN
    PERFORM public.loomic_recoverable_canvas_image_jobs(100);
    RAISE EXCEPTION 'authenticated_role_was_not_rejected';
  EXCEPTION WHEN insufficient_privilege THEN
      NULL;
  END;
  BEGIN
    PERFORM public.loomic_recoverable_design_image_chats(100);
    RAISE EXCEPTION 'authenticated_design_role_was_not_rejected';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;

ROLLBACK;
SELECT 'recoverable canvas image job data acceptance passed and was rolled back' AS result;
