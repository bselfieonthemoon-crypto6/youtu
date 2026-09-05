-- Stage 2 async worker recovery helpers. Queue delivery is at-least-once;
-- durable job state and the worker claim gate provide execution idempotency.

CREATE INDEX IF NOT EXISTS background_jobs_design_preview_recovery_idx
  ON public.background_jobs(created_at, id)
  WHERE job_type = 'design_preview' AND status = 'queued';

CREATE INDEX IF NOT EXISTS background_jobs_design_finalization_recovery_idx
  ON public.background_jobs(completed_at, id)
  WHERE job_type = 'image_generation'
    AND status = 'succeeded'
    AND target_kind = 'design';

CREATE OR REPLACE FUNCTION public.loomic_design_preview_mark_error(
  p_job_id uuid,
  p_error_code text,
  p_error_message text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  job_row public.background_jobs%ROWTYPE;
  design_row public.design_documents%ROWTYPE;
  frozen_revision bigint;
  updated boolean := false;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF p_job_id IS NULL
    OR NULLIF(btrim(COALESCE(p_error_code, '')), '') IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_preview_failure_invalid';
  END IF;

  SELECT * INTO job_row
  FROM public.background_jobs j
  WHERE j.id = p_job_id
  FOR UPDATE;

  IF job_row.id IS NULL
    OR job_row.job_type <> 'design_preview'
    OR job_row.target_kind <> 'design'
    OR job_row.design_id IS NULL
    OR job_row.status NOT IN ('failed', 'dead_letter', 'canceled')
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'design_preview_job_not_failed';
  END IF;

  BEGIN
    frozen_revision := (job_row.payload->>'revision')::bigint;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_preview_job_payload_invalid';
  END;
  IF frozen_revision IS NULL OR frozen_revision < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_preview_job_payload_invalid';
  END IF;

  SELECT * INTO design_row
  FROM public.design_documents d
  WHERE d.id = job_row.design_id
    AND d.workspace_id = job_row.workspace_id
  FOR UPDATE;

  IF design_row.id IS NOT NULL
    AND design_row.deleted_at IS NULL
    AND design_row.revision = frozen_revision
    AND design_row.preview_status = 'queued'
  THEN
    UPDATE public.design_documents
    SET preview_status = 'error'
    WHERE id = design_row.id;
    updated := true;
  END IF;

  RETURN jsonb_build_object(
    'job_id', p_job_id,
    'design_id', job_row.design_id,
    'revision', frozen_revision,
    'updated', updated,
    'error_code', left(btrim(p_error_code), 120),
    'error_message', left(COALESCE(p_error_message, ''), 2000)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_design_finalization_candidates(
  p_limit integer DEFAULT 100
)
RETURNS SETOF public.background_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_finalization_scan_limit_invalid';
  END IF;

  RETURN QUERY
  SELECT j.*
  FROM public.background_jobs j
  LEFT JOIN public.job_target_finalizations f
    ON f.job_id = j.id
    AND f.target_kind = 'design'
    AND f.target_id = j.design_id
  WHERE j.status = 'succeeded'
    AND j.job_type = 'image_generation'
    AND j.target_kind = 'design'
    AND j.design_id IS NOT NULL
    AND (
      f.id IS NULL
      OR f.status = 'failed'
      OR (f.status = 'running' AND f.updated_at < now() - interval '5 minutes')
    )
  ORDER BY COALESCE(f.updated_at, j.completed_at, j.updated_at), j.id
  LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.loomic_design_preview_mark_error(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.loomic_design_finalization_candidates(integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.loomic_design_preview_mark_error(uuid, text, text),
  public.loomic_design_finalization_candidates(integer)
  TO service_role;
