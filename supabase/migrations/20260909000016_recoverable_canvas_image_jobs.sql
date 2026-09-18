-- Select only canvas image jobs whose complete asset set is still live before
-- applying the recovery batch limit. This prevents permanently deleted or
-- missing historical assets from starving later recoverable deliveries.
CREATE OR REPLACE FUNCTION public.loomic_recoverable_canvas_image_jobs(
  p_limit integer DEFAULT 100
)
RETURNS SETOF public.background_jobs
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'recovery_limit_invalid';
  END IF;

  RETURN QUERY
  SELECT job.*
  FROM public.background_jobs AS job
  WHERE job.status = 'succeeded'
    AND job.job_type = 'image_generation'
    AND job.target_kind = 'canvas'
    AND job.canvas_id IS NOT NULL
    AND (
      job.result->>'canvas_finalized_at' IS NULL
      OR (
        job.session_id IS NOT NULL
        AND job.result->>'chat_finalized_at' IS NULL
      )
    )
    AND (
      job.payload->'target' IS NULL
      OR jsonb_typeof(job.payload->'target') IS DISTINCT FROM 'object'
      OR NOT (job.payload->'target' ? 'kind')
      OR (
        job.payload#>>'{target,kind}' = 'canvas'
        AND job.payload#>>'{target,canvas_id}' = job.canvas_id::text
      )
    )
    -- Keep the bounded batch for jobs the application finalizer can actually
    -- consume. Historical success rows with partial provider metadata must
    -- not repeatedly occupy all 100 recovery slots.
    AND jsonb_typeof(job.result) = 'object'
    AND jsonb_typeof(job.result->'asset_id') = 'string'
    AND jsonb_typeof(job.result->'object_path') = 'string'
    AND jsonb_typeof(job.result->'width') = 'number'
    AND jsonb_typeof(job.result->'height') = 'number'
    AND jsonb_typeof(job.result->'mime_type') = 'string'
    AND EXISTS (
      SELECT 1
      FROM public.asset_objects AS asset
      WHERE asset.id::text = job.result->>'asset_id'
        AND asset.workspace_id = job.workspace_id
        AND asset.deletion_pending_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(job.result->'layers') = 'array'
            THEN job.result->'layers'
          ELSE '[]'::jsonb
        END
      ) AS layer(value)
      WHERE layer.value->>'asset_id' IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.asset_objects AS layer_asset
          WHERE layer_asset.id::text = layer.value->>'asset_id'
            AND layer_asset.workspace_id = job.workspace_id
            AND layer_asset.deletion_pending_at IS NULL
        )
    )
    AND (
      job.result->>'canvas_finalized_at' IS NOT NULL
      OR job.payload->>'operation' IS DISTINCT FROM 'split_layers'
      OR (
        jsonb_array_length(
          CASE
            WHEN jsonb_typeof(job.result->'layers') = 'array'
              THEN job.result->'layers'
            ELSE '[]'::jsonb
          END
        ) > 0
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(job.result->'layers') = 'array'
                THEN job.result->'layers'
              ELSE '[]'::jsonb
            END
          ) AS layer(value)
          WHERE jsonb_typeof(layer.value) IS DISTINCT FROM 'object'
            OR jsonb_typeof(layer.value->'asset_id') IS DISTINCT FROM 'string'
            OR jsonb_typeof(layer.value->'object_path') IS DISTINCT FROM 'string'
            OR jsonb_typeof(layer.value->'width') IS DISTINCT FROM 'number'
            OR jsonb_typeof(layer.value->'height') IS DISTINCT FROM 'number'
        )
      )
    )
  ORDER BY job.completed_at ASC NULLS FIRST, job.id ASC
  LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.loomic_recoverable_canvas_image_jobs(integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.loomic_recoverable_canvas_image_jobs(integer)
  TO service_role;

-- Apply the same pre-LIMIT rule to design chat completion. A pending or
-- missing target-finalization row is not actionable and must not hide a later
-- terminal delivery forever.
CREATE OR REPLACE FUNCTION public.loomic_recoverable_design_image_chats(
  p_limit integer DEFAULT 100
)
RETURNS SETOF public.background_jobs
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'recovery_limit_invalid';
  END IF;

  RETURN QUERY
  SELECT job.*
  FROM public.background_jobs AS job
  WHERE job.status = 'succeeded'
    AND job.job_type = 'image_generation'
    AND job.target_kind = 'design'
    AND job.design_id IS NOT NULL
    AND job.session_id IS NOT NULL
    AND job.result->>'chat_finalized_at' IS NULL
    AND jsonb_typeof(job.result) = 'object'
    AND jsonb_typeof(job.result->'asset_id') = 'string'
    AND jsonb_typeof(job.result->'signed_url') = 'string'
    AND jsonb_typeof(job.result->'width') = 'number'
    AND jsonb_typeof(job.result->'height') = 'number'
    AND jsonb_typeof(job.result->'mime_type') = 'string'
    AND EXISTS (
      SELECT 1
      FROM public.asset_objects AS asset
      WHERE asset.id::text = job.result->>'asset_id'
        AND asset.workspace_id = job.workspace_id
        AND asset.deletion_pending_at IS NULL
    )
    AND EXISTS (
      SELECT 1
      FROM public.job_target_finalizations AS finalization
      WHERE finalization.job_id = job.id
        AND finalization.target_kind = 'design'
        AND finalization.target_id = job.design_id
        AND finalization.status IN ('completed', 'needs_attention', 'failed')
    )
  ORDER BY job.completed_at ASC NULLS FIRST, job.id ASC
  LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.loomic_recoverable_design_image_chats(integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.loomic_recoverable_design_image_chats(integer)
  TO service_role;
