-- Stage 5 hardening: fence import workers by lease token and require
-- verifiable authorization metadata before any catalog entity is published.

ALTER TABLE public.resource_import_items
  ADD COLUMN claim_token uuid;

CREATE INDEX resource_import_items_claim_token_idx
  ON public.resource_import_items(import_job_id, claim_token)
  WHERE status IN ('pending', 'running');

CREATE OR REPLACE FUNCTION private.loomic_catalog_license_is_verifiable(
  p_license_name text,
  p_source_url text,
  p_license_url text,
  p_usage_restrictions text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    NULLIF(btrim(p_license_name), '') IS NOT NULL
    AND (
      (
        p_source_url ~* '^https?://[^[:space:]]+$'
        AND p_license_url ~* '^https?://[^[:space:]]+$'
      )
      OR NULLIF(btrim(p_usage_restrictions), '') IS NOT NULL
    ),
    false
  );
$$;

CREATE OR REPLACE FUNCTION private.loomic_catalog_publishable(
  p_entity_kind text,
  p_entity_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  ok boolean := false;
BEGIN
  CASE p_entity_kind
    WHEN 'resource' THEN
      SELECT private.loomic_catalog_license_is_verifiable(
          r.license_name, r.source_url, r.license_url, r.usage_restrictions
        )
        AND r.preview_asset_object_id IS NOT NULL
        AND ao.deletion_pending_at IS NULL
        AND pa.deletion_pending_at IS NULL
        AND ao.scope = r.scope
        AND ao.workspace_id IS NOT DISTINCT FROM r.workspace_id
        AND pa.scope = r.scope
        AND pa.workspace_id IS NOT DISTINCT FROM r.workspace_id
      INTO ok
      FROM public.design_resources r
      JOIN public.asset_objects ao ON ao.id = r.asset_object_id
      JOIN public.asset_objects pa ON pa.id = r.preview_asset_object_id
      WHERE r.id = p_entity_id AND r.deleted_at IS NULL;
    WHEN 'template' THEN
      SELECT private.loomic_catalog_license_is_verifiable(
          t.license_name, t.source_url, t.license_url, t.usage_restrictions
        )
        AND t.preview_asset_object_id IS NOT NULL
        AND pa.deletion_pending_at IS NULL
        AND pa.scope = t.scope
        AND pa.workspace_id IS NOT DISTINCT FROM t.workspace_id
        AND NOT EXISTS (
          SELECT 1
          FROM public.design_template_asset_refs ar
          JOIN public.asset_objects ao ON ao.id = ar.asset_object_id
          LEFT JOIN public.design_resources r ON r.id = ar.resource_id
          WHERE ar.template_id = t.id
            AND (
              ao.deletion_pending_at IS NOT NULL
              OR ao.scope <> t.scope
              OR ao.workspace_id IS DISTINCT FROM t.workspace_id
              OR (
                ar.resource_id IS NOT NULL
                AND (r.deleted_at IS NOT NULL OR r.status <> 'published')
              )
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.design_template_font_refs fr
          JOIN public.font_faces ff ON ff.id = fr.font_face_id
          JOIN public.font_families f ON f.id = ff.family_id
          WHERE fr.template_id = t.id
            AND (
              ff.deleted_at IS NOT NULL
              OR ff.status <> 'published'
              OR NOT ff.allow_web_embed
              OR f.deleted_at IS NOT NULL
              OR f.status <> 'published'
            )
        )
      INTO ok
      FROM public.design_templates t
      JOIN public.asset_objects pa ON pa.id = t.preview_asset_object_id
      WHERE t.id = p_entity_id AND t.deleted_at IS NULL;
    WHEN 'text_preset' THEN
      SELECT private.loomic_catalog_license_is_verifiable(
          t.license_name, t.source_url, t.license_url, t.usage_restrictions
        )
        AND t.preview_asset_object_id IS NOT NULL
        AND pa.deletion_pending_at IS NULL
        AND pa.scope = t.scope
        AND pa.workspace_id IS NOT DISTINCT FROM t.workspace_id
        AND NOT EXISTS (
          SELECT 1
          FROM public.text_preset_font_refs fr
          JOIN public.font_faces ff ON ff.id = fr.font_face_id
          JOIN public.font_families f ON f.id = ff.family_id
          WHERE fr.text_preset_id = t.id
            AND (
              ff.deleted_at IS NOT NULL
              OR ff.status <> 'published'
              OR NOT ff.allow_web_embed
              OR f.deleted_at IS NOT NULL
              OR f.status <> 'published'
            )
        )
      INTO ok
      FROM public.text_presets t
      JOIN public.asset_objects pa ON pa.id = t.preview_asset_object_id
      WHERE t.id = p_entity_id AND t.deleted_at IS NULL;
    WHEN 'font_face' THEN
      SELECT private.loomic_catalog_license_is_verifiable(
          f.license_name, f.source_url, f.license_url, f.usage_restrictions
        )
        AND ff.allow_web_embed
        AND ff.checksum_sha256 ~ '^[a-f0-9]{64}$'
        AND ao.deletion_pending_at IS NULL
        AND ao.scope = ff.scope
        AND ao.workspace_id IS NOT DISTINCT FROM ff.workspace_id
        AND f.deleted_at IS NULL
      INTO ok
      FROM public.font_faces ff
      JOIN public.font_families f ON f.id = ff.family_id
      JOIN public.asset_objects ao ON ao.id = ff.asset_object_id
      WHERE ff.id = p_entity_id AND ff.deleted_at IS NULL;
    WHEN 'font_family' THEN
      SELECT private.loomic_catalog_license_is_verifiable(
          f.license_name, f.source_url, f.license_url, f.usage_restrictions
        )
        AND EXISTS (
          SELECT 1
          FROM public.font_faces ff
          WHERE ff.family_id = f.id
            AND ff.deleted_at IS NULL
            AND ff.status = 'published'
            AND ff.allow_web_embed
        )
      INTO ok
      FROM public.font_families f
      WHERE f.id = p_entity_id AND f.deleted_at IS NULL;
    WHEN 'category', 'tag' THEN
      ok := true;
    ELSE
      ok := false;
  END CASE;
  RETURN COALESCE(ok, false);
END;
$$;

-- Existing published records without a verifiable authorization record are
-- deliberately disabled rather than silently grandfathered into public use.
UPDATE public.design_resources r
SET status = 'disabled', revision = revision + 1
WHERE r.status = 'published'
  AND NOT private.loomic_catalog_publishable('resource', r.id);

UPDATE public.font_faces ff
SET status = 'disabled', revision = revision + 1
WHERE ff.status = 'published'
  AND NOT private.loomic_catalog_publishable('font_face', ff.id);

UPDATE public.font_families f
SET status = 'disabled', revision = revision + 1
WHERE f.status = 'published'
  AND NOT private.loomic_catalog_publishable('font_family', f.id);

UPDATE public.design_templates t
SET status = 'disabled', revision = revision + 1
WHERE t.status = 'published'
  AND NOT private.loomic_catalog_publishable('template', t.id);

UPDATE public.text_presets t
SET status = 'disabled', revision = revision + 1
WHERE t.status = 'published'
  AND NOT private.loomic_catalog_publishable('text_preset', t.id);

ALTER TABLE public.design_resources
  ADD CONSTRAINT design_resources_published_license_check CHECK (
    status <> 'published'
    OR private.loomic_catalog_license_is_verifiable(
      license_name, source_url, license_url, usage_restrictions
    )
  );

ALTER TABLE public.design_templates
  ADD CONSTRAINT design_templates_published_license_check CHECK (
    status <> 'published'
    OR private.loomic_catalog_license_is_verifiable(
      license_name, source_url, license_url, usage_restrictions
    )
  );

ALTER TABLE public.text_presets
  ADD CONSTRAINT text_presets_published_license_check CHECK (
    status <> 'published'
    OR private.loomic_catalog_license_is_verifiable(
      license_name, source_url, license_url, usage_restrictions
    )
  );

ALTER TABLE public.font_families
  ADD CONSTRAINT font_families_published_license_check CHECK (
    status <> 'published'
    OR private.loomic_catalog_license_is_verifiable(
      license_name, source_url, license_url, usage_restrictions
    )
  );

CREATE OR REPLACE FUNCTION private.loomic_validate_font_face_publication_license()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'published' AND NOT EXISTS (
    SELECT 1
    FROM public.font_families f
    WHERE f.id = NEW.family_id
      AND f.deleted_at IS NULL
      AND private.loomic_catalog_license_is_verifiable(
        f.license_name, f.source_url, f.license_url, f.usage_restrictions
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'catalog_publication_authorization_unavailable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER font_faces_validate_publication_license
BEFORE INSERT OR UPDATE OF status, family_id ON public.font_faces
FOR EACH ROW EXECUTE FUNCTION private.loomic_validate_font_face_publication_license();

CREATE OR REPLACE FUNCTION private.loomic_protect_published_font_face_license()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.font_faces ff
    WHERE ff.family_id = NEW.id
      AND ff.deleted_at IS NULL
      AND ff.status = 'published'
  ) AND NOT private.loomic_catalog_license_is_verifiable(
    NEW.license_name, NEW.source_url, NEW.license_url, NEW.usage_restrictions
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'catalog_publication_authorization_unavailable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER font_families_protect_published_face_license
BEFORE UPDATE OF license_name, source_url, license_url, usage_restrictions, deleted_at
ON public.font_families
FOR EACH ROW EXECUTE FUNCTION private.loomic_protect_published_font_face_license();

CREATE OR REPLACE FUNCTION public.loomic_resource_import_claim(
  p_claim_token uuid,
  p_limit integer DEFAULT 10
)
RETURNS SETOF public.resource_import_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF p_claim_token IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'resource_import_claim_invalid';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT j.id
    FROM public.resource_import_jobs j
    WHERE j.attempt_count < 3
      AND (
        (j.status = 'queued' AND j.available_at <= now())
        OR (
          j.status = 'running'
          AND j.claimed_at < now() - interval '5 minutes'
        )
      )
    ORDER BY j.created_at, j.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), claimed_jobs AS (
    UPDATE public.resource_import_jobs j
    SET status = 'running',
        started_at = COALESCE(j.started_at, now()),
        claimed_at = now(),
        claim_token = p_claim_token,
        attempt_count = j.attempt_count + 1
    FROM candidates c
    WHERE j.id = c.id
    RETURNING j.*
  ), claimed_items AS (
    UPDATE public.resource_import_items i
    SET status = 'running', claim_token = p_claim_token
    FROM claimed_jobs j
    WHERE i.import_job_id = j.id
      AND i.status IN ('pending', 'running')
    RETURNING i.id
  ), item_barrier AS (
    SELECT count(*) AS claimed_item_count FROM claimed_items
  )
  SELECT j.*
  FROM claimed_jobs j
  CROSS JOIN item_barrier;
END;
$$;

REVOKE ALL ON FUNCTION public.loomic_resource_import_finalize_item(
  uuid, uuid, text, text, uuid, uuid, text, text
) FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION public.loomic_resource_import_finalize_item(
  uuid, uuid, text, text, uuid, uuid, text, text
);

CREATE FUNCTION public.loomic_resource_import_finalize_item(
  p_import_job_id uuid,
  p_claim_token uuid,
  p_item_id uuid,
  p_status text,
  p_result_entity_kind text,
  p_result_entity_id uuid,
  p_asset_object_id uuid,
  p_error_code text,
  p_error_message text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  item_row public.resource_import_items%ROWTYPE;
  job_row public.resource_import_jobs%ROWTYPE;
  result_row record;
  completed_count integer;
  failed_count integer;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF p_status NOT IN ('imported', 'duplicate', 'failed', 'rejected') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'resource_import_item_status_invalid';
  END IF;

  SELECT * INTO job_row
  FROM public.resource_import_jobs
  WHERE id = p_import_job_id
  FOR UPDATE;
  IF job_row.id IS NULL OR job_row.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'resource_import_lost_lease';
  END IF;

  SELECT * INTO item_row
  FROM public.resource_import_items
  WHERE id = p_item_id AND import_job_id = p_import_job_id
  FOR UPDATE;
  IF item_row.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'resource_import_item_not_found';
  END IF;
  IF item_row.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'resource_import_lost_lease';
  END IF;
  IF item_row.status IN ('imported', 'duplicate', 'failed', 'rejected') THEN
    RETURN jsonb_build_object(
      'item_id', item_row.id,
      'status', item_row.status,
      'job_status', job_row.status,
      'replayed', true
    );
  END IF;
  IF job_row.status <> 'running' THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'resource_import_lost_lease';
  END IF;

  IF p_status IN ('imported', 'duplicate') THEN
    IF p_result_entity_kind IS NULL OR p_result_entity_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'resource_import_result_required';
    END IF;
    SELECT * INTO result_row
    FROM private.loomic_catalog_record(p_result_entity_kind, p_result_entity_id);
    IF result_row IS NULL
      OR result_row.deleted_at IS NOT NULL
      OR result_row.scope IS DISTINCT FROM job_row.scope
      OR result_row.workspace_id IS DISTINCT FROM job_row.workspace_id
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'resource_import_result_scope_mismatch';
    END IF;
  ELSIF p_result_entity_kind IS NOT NULL OR p_result_entity_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'resource_import_result_invalid';
  END IF;

  UPDATE public.resource_import_items
  SET status = p_status,
      result_entity_kind = p_result_entity_kind,
      result_entity_id = p_result_entity_id,
      resource_id = CASE
        WHEN p_result_entity_kind = 'resource' THEN p_result_entity_id
        ELSE NULL
      END,
      asset_object_id = COALESCE(p_asset_object_id, asset_object_id),
      error_code = p_error_code,
      error_message = p_error_message,
      attempt_count = attempt_count + 1,
      completed_at = now()
  WHERE id = p_item_id
    AND claim_token = p_claim_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'resource_import_lost_lease';
  END IF;

  SELECT count(*) FILTER (WHERE status IN ('imported', 'duplicate')),
         count(*) FILTER (WHERE status IN ('failed', 'rejected'))
  INTO completed_count, failed_count
  FROM public.resource_import_items
  WHERE import_job_id = p_import_job_id;

  UPDATE public.resource_import_jobs
  SET completed_items = completed_count,
      failed_items = failed_count
  WHERE id = p_import_job_id
    AND status = 'running'
    AND claim_token = p_claim_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'resource_import_lost_lease';
  END IF;

  RETURN jsonb_build_object(
    'item_id', p_item_id,
    'status', p_status,
    'job_status', 'running',
    'replayed', false
  );
END;
$$;

CREATE FUNCTION public.loomic_resource_import_defer(
  p_import_job_id uuid,
  p_claim_token uuid,
  p_error_message text,
  p_delay_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  job_row public.resource_import_jobs%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF p_delay_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'resource_import_defer_invalid';
  END IF;
  SELECT * INTO job_row
  FROM public.resource_import_jobs
  WHERE id = p_import_job_id
  FOR UPDATE;
  IF job_row.id IS NULL OR job_row.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'resource_import_lost_lease';
  END IF;
  IF job_row.status = 'queued' THEN
    RETURN jsonb_build_object(
      'import_job_id', job_row.id,
      'status', job_row.status,
      'replayed', true
    );
  END IF;
  IF job_row.status <> 'running' THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'resource_import_lost_lease';
  END IF;

  UPDATE public.resource_import_items
  SET status = 'pending'
  WHERE import_job_id = p_import_job_id
    AND status = 'running'
    AND claim_token = p_claim_token;
  UPDATE public.resource_import_jobs
  SET status = 'queued',
      available_at = now() + make_interval(secs => p_delay_seconds),
      claimed_at = NULL,
      last_error = left(COALESCE(p_error_message, 'import_retry_requested'), 2000)
  WHERE id = p_import_job_id
    AND status = 'running'
    AND claim_token = p_claim_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'resource_import_lost_lease';
  END IF;
  RETURN jsonb_build_object(
    'import_job_id', p_import_job_id,
    'status', 'queued',
    'replayed', false
  );
END;
$$;

CREATE FUNCTION public.loomic_resource_import_complete(
  p_import_job_id uuid,
  p_claim_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  job_row public.resource_import_jobs%ROWTYPE;
  completed_count integer;
  failed_count integer;
  pending_count integer;
  final_status text;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  SELECT * INTO job_row
  FROM public.resource_import_jobs
  WHERE id = p_import_job_id
  FOR UPDATE;
  IF job_row.id IS NULL OR job_row.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'resource_import_lost_lease';
  END IF;
  IF job_row.status IN ('completed', 'failed') THEN
    RETURN jsonb_build_object(
      'import_job_id', job_row.id,
      'status', job_row.status,
      'replayed', true
    );
  END IF;
  IF job_row.status <> 'running' THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'resource_import_lost_lease';
  END IF;

  SELECT count(*) FILTER (WHERE status IN ('imported', 'duplicate')),
         count(*) FILTER (WHERE status IN ('failed', 'rejected')),
         count(*) FILTER (WHERE status IN ('pending', 'running'))
  INTO completed_count, failed_count, pending_count
  FROM public.resource_import_items
  WHERE import_job_id = p_import_job_id;
  IF pending_count <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'resource_import_incomplete';
  END IF;
  final_status := CASE WHEN failed_count > 0 THEN 'failed' ELSE 'completed' END;

  UPDATE public.resource_import_jobs
  SET completed_items = completed_count,
      failed_items = failed_count,
      status = final_status,
      completed_at = now(),
      claimed_at = NULL
  WHERE id = p_import_job_id
    AND status = 'running'
    AND claim_token = p_claim_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'resource_import_lost_lease';
  END IF;
  RETURN jsonb_build_object(
    'import_job_id', p_import_job_id,
    'status', final_status,
    'completed_items', completed_count,
    'failed_items', failed_count,
    'replayed', false
  );
END;
$$;

REVOKE ALL ON FUNCTION private.loomic_catalog_license_is_verifiable(
  text, text, text, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_validate_font_face_publication_license()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_protect_published_font_face_license()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.loomic_catalog_license_is_verifiable(
  text, text, text, text
) TO service_role;

REVOKE ALL ON FUNCTION public.loomic_resource_import_claim(uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.loomic_resource_import_finalize_item(
  uuid, uuid, uuid, text, text, uuid, uuid, text, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.loomic_resource_import_defer(
  uuid, uuid, text, integer
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.loomic_resource_import_complete(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.loomic_resource_import_claim(uuid, integer),
  public.loomic_resource_import_finalize_item(
    uuid, uuid, uuid, text, text, uuid, uuid, text, text
  ),
  public.loomic_resource_import_defer(uuid, uuid, text, integer),
  public.loomic_resource_import_complete(uuid, uuid)
TO service_role;
