-- B6c: platform storage health - occupancy, orphan inventory and queue views.
--
-- Section seven of the plan. `asset_objects` / `asset_references` had no management
-- surface at all, and the deletion machinery is spread across `design-export-gc.ts`,
-- `canvas-asset-references.ts` and the upload delete functions.
--
-- The important discovery, made by measuring before designing: the authoritative
-- "is this asset still referenced" check (`private.loomic_asset_has_live_references`)
-- is far too slow to run per row. It is ten EXISTS subqueries, and the last one scans
-- `background_jobs.result` jsonb. Measured on the local replica (5735 assets):
--
--   * the authoritative check over every asset:      115 seconds
--   * a set-based candidate query over every asset:   0.02 seconds
--   * the authoritative check for a 50-row page:      1.0 second
--
-- So this migration is deliberately two-tier. The LIST is the cheap set-based
-- candidate query; the authoritative check runs only for the rows a page actually
-- returns (`confirmed_orphan`), and again inside the purge path. On the same replica
-- the three tiers measure: 5419 assets have no `asset_references` row at all, the full
-- column candidate query narrows that to 1307, and the authoritative check says 1298 -
-- so nine candidates are kept alive only by a job result jsonb. The candidate query
-- over-reports (which is the safe direction) and never decides on its own.
--
-- Nothing here deletes storage. The purge path reuses the existing pipeline
-- (`loomic_orphan_asset_claim` -> the server removes the object -> 
-- `loomic_orphan_asset_finalize`) so an interrupted purge leaves the asset in the
-- pending queue instead of leaking an object.

CREATE OR REPLACE FUNCTION private.admin_write_asset_audit(
  p_actor_user_id uuid,
  p_action text,
  p_asset_id uuid,
  p_reason text,
  p_before jsonb,
  p_after jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.admin_audit_events
    (actor_user_id, action, target_kind, target_id, workspace_id, reason, before, after)
  VALUES
    (p_actor_user_id, p_action, 'asset', p_asset_id::text, NULL, btrim(p_reason), p_before, p_after);
END;
$$;

REVOKE ALL ON FUNCTION private.admin_write_asset_audit(uuid, text, uuid, text, jsonb, jsonb) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Occupancy
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_asset_overview(
  p_actor_user_id uuid,
  p_workspace_limit integer DEFAULT 10
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_workspace_limit integer := LEAST(GREATEST(COALESCE(p_workspace_limit, 10), 1), 100);
  v_total_objects bigint;
  v_total_bytes bigint;
  v_pending integer;
  v_gc_eligible integer;
  v_gc_claimed integer;
  v_buckets jsonb;
  v_scopes jsonb;
  v_workspaces jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;

  SELECT count(*), COALESCE(sum(ao.byte_size), 0),
         count(*) FILTER (WHERE ao.deletion_pending_at IS NOT NULL),
         count(*) FILTER (WHERE ao.gc_eligible_at IS NOT NULL),
         count(*) FILTER (WHERE ao.gc_claim_token IS NOT NULL)
    INTO v_total_objects, v_total_bytes, v_pending, v_gc_eligible, v_gc_claimed
    FROM public.asset_objects ao;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'bucket', b.bucket, 'scope', b.scope, 'objects', b.objects, 'bytes', b.bytes,
           'pendingCount', b.pending, 'gcEligibleCount', b.gc_eligible, 'claimedCount', b.claimed)
           ORDER BY b.bytes DESC, b.bucket), '[]'::jsonb)
    INTO v_buckets
    FROM (
      SELECT ao.bucket, ao.scope,
             count(*) AS objects, COALESCE(sum(ao.byte_size), 0) AS bytes,
             count(*) FILTER (WHERE ao.deletion_pending_at IS NOT NULL) AS pending,
             count(*) FILTER (WHERE ao.gc_eligible_at IS NOT NULL) AS gc_eligible,
             count(*) FILTER (WHERE ao.gc_claim_token IS NOT NULL) AS claimed
      FROM public.asset_objects ao
      GROUP BY ao.bucket, ao.scope
    ) b;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'scope', s.scope, 'objects', s.objects, 'bytes', s.bytes) ORDER BY s.bytes DESC), '[]'::jsonb)
    INTO v_scopes
    FROM (
      SELECT ao.scope, count(*) AS objects, COALESCE(sum(ao.byte_size), 0) AS bytes
      FROM public.asset_objects ao
      GROUP BY ao.scope
    ) s;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'workspaceId', w.workspace_id, 'workspaceName', w.name,
           'objects', w.objects, 'bytes', w.bytes) ORDER BY w.bytes DESC), '[]'::jsonb)
    INTO v_workspaces
    FROM (
      SELECT ao.workspace_id, ws.name,
             count(*) AS objects, COALESCE(sum(ao.byte_size), 0) AS bytes
      FROM public.asset_objects ao
      LEFT JOIN public.workspaces ws ON ws.id = ao.workspace_id
      GROUP BY ao.workspace_id, ws.name
      ORDER BY COALESCE(sum(ao.byte_size), 0) DESC
      LIMIT v_workspace_limit
    ) w;

  RETURN jsonb_build_object(
    'totalObjects', v_total_objects,
    'totalBytes', v_total_bytes,
    'pendingCount', v_pending,
    'gcEligibleCount', v_gc_eligible,
    'gcClaimedCount', v_gc_claimed,
    'buckets', v_buckets,
    'scopes', v_scopes,
    'workspaces', v_workspaces
  );
END;
$$;

COMMENT ON FUNCTION public.admin_asset_overview(uuid, integer) IS
  'Platform-admin storage occupancy: totals, per bucket/scope, and the heaviest workspaces, plus the deletion and GC queue counters. Read-only.';

-- ---------------------------------------------------------------------------
-- Orphan candidates
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_asset_orphan_candidates(
  p_actor_user_id uuid,
  p_bucket text DEFAULT NULL,
  p_workspace_id uuid DEFAULT NULL,
  p_min_bytes bigint DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_bucket text := nullif(btrim(COALESCE(p_bucket, '')), '');
  v_total bigint;
  v_objects jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;

  -- One statement, so the function stays STABLE (a temp table would make it a write).
  -- The cheap half of the reference graph: every column that points at an asset. The
  -- job-result jsonb is intentionally left out because scanning it per asset is what
  -- makes the authoritative check take two minutes; rows kept alive only by such a
  -- reference are caught by `confirmedOrphan` below and by the purge path, which both
  -- use the authoritative function.
  WITH referenced AS (
    SELECT asset_id AS id FROM public.asset_references
    UNION SELECT asset_object_id FROM public.design_document_asset_refs
    UNION SELECT preview_asset_object_id FROM public.design_documents WHERE preview_asset_object_id IS NOT NULL
    UNION SELECT asset_object_id FROM public.design_template_asset_refs
    UNION SELECT preview_asset_object_id FROM public.design_templates WHERE preview_asset_object_id IS NOT NULL
    UNION SELECT preview_asset_object_id FROM public.text_presets WHERE preview_asset_object_id IS NOT NULL
    UNION SELECT asset_object_id FROM public.design_resources
    UNION SELECT preview_asset_object_id FROM public.design_resources WHERE preview_asset_object_id IS NOT NULL
    UNION SELECT asset_object_id FROM public.font_faces
    UNION SELECT asset_object_id FROM public.resource_import_items
     WHERE status IN ('pending', 'running', 'imported')
  ),
  candidates AS (
    SELECT ao.id, ao.bucket, ao.object_path, ao.workspace_id, ao.scope, ao.mime_type,
           COALESCE(ao.byte_size, 0) AS byte_size, ao.created_at,
           ao.deletion_pending_at, ao.gc_eligible_at, ao.gc_claimed_at
    FROM public.asset_objects ao
    WHERE NOT EXISTS (SELECT 1 FROM referenced r WHERE r.id = ao.id)
      AND (v_bucket IS NULL OR ao.bucket = v_bucket)
      AND (p_workspace_id IS NULL OR ao.workspace_id = p_workspace_id)
      AND (p_min_bytes IS NULL OR COALESCE(ao.byte_size, 0) >= p_min_bytes)
  )
  SELECT
    (SELECT count(*) FROM candidates),
    COALESCE((
      SELECT jsonb_agg(page.row_data ORDER BY page.byte_size DESC, page.id)
      FROM (
        SELECT jsonb_build_object(
                 'id', c.id,
                 'bucket', c.bucket,
                 'objectPath', c.object_path,
                 'workspaceId', c.workspace_id,
                 'workspaceName', w.name,
                 'scope', c.scope,
                 'mimeType', c.mime_type,
                 'byteSize', c.byte_size,
                 'createdAt', c.created_at,
                 'ageDays', floor(extract(epoch FROM now() - c.created_at) / 86400)::integer,
                 'referenceCount', (SELECT count(*) FROM public.asset_references ar WHERE ar.asset_id = c.id),
                 -- Authoritative, and only affordable because this runs for one page.
                 'confirmedOrphan', NOT private.loomic_asset_has_live_references(c.id),
                 'deletionPendingAt', c.deletion_pending_at,
                 'gcEligibleAt', c.gc_eligible_at,
                 'gcClaimedAt', c.gc_claimed_at
               ) AS row_data,
               c.byte_size, c.id
        FROM candidates c
        LEFT JOIN public.workspaces w ON w.id = c.workspace_id
        ORDER BY c.byte_size DESC, c.id
        LIMIT v_limit OFFSET v_offset
      ) page
    ), '[]'::jsonb)
    INTO v_total, v_objects;

  RETURN jsonb_build_object('total', v_total, 'pageConfirmed', true, 'objects', v_objects);
END;
$$;

COMMENT ON FUNCTION public.admin_asset_orphan_candidates(uuid, text, uuid, bigint, integer, integer) IS
  'Platform-admin orphan candidates: assets no column points at, with the authoritative verdict computed for the returned page only. Read-only; the purge path re-checks.';

-- ---------------------------------------------------------------------------
-- Deletion and GC queues
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_asset_queue(
  p_actor_user_id uuid,
  p_kind text,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_kind text := nullif(btrim(COALESCE(p_kind, '')), '');
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_total bigint;
  v_objects jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  IF v_kind NOT IN ('pending_delete', 'gc_eligible', 'gc_claimed') THEN
    RAISE EXCEPTION 'UNKNOWN_KIND: kind must be pending_delete, gc_eligible or gc_claimed';
  END IF;

  -- One statement again: a temp table would make this function a write, and then it
  -- could not be STABLE.
  WITH queue AS (
    SELECT ao.* FROM public.asset_objects ao
    WHERE CASE v_kind
            WHEN 'pending_delete' THEN ao.deletion_pending_at IS NOT NULL
            WHEN 'gc_eligible' THEN ao.gc_eligible_at IS NOT NULL
            ELSE ao.gc_claim_token IS NOT NULL
          END
  )
  SELECT
    (SELECT count(*) FROM queue),
    COALESCE((
      SELECT jsonb_agg(page.row_data
               ORDER BY page.deletion_pending_at NULLS LAST, page.gc_claimed_at NULLS LAST,
                        page.byte_size DESC, page.id)
      FROM (
        SELECT jsonb_build_object(
                 'id', q.id, 'bucket', q.bucket, 'objectPath', q.object_path,
                 'workspaceId', q.workspace_id, 'workspaceName', w.name, 'scope', q.scope,
                 'mimeType', q.mime_type, 'byteSize', COALESCE(q.byte_size, 0),
                 'createdAt', q.created_at,
                 'referenceCount', (SELECT count(*) FROM public.asset_references ar WHERE ar.asset_id = q.id),
                 'confirmedOrphan', NOT private.loomic_asset_has_live_references(q.id),
                 'deletionPendingAt', q.deletion_pending_at,
                 'gcEligibleAt', q.gc_eligible_at,
                 'gcClaimedAt', q.gc_claimed_at
               ) AS row_data,
               q.deletion_pending_at, q.gc_claimed_at, COALESCE(q.byte_size, 0) AS byte_size, q.id
        FROM queue q
        LEFT JOIN public.workspaces w ON w.id = q.workspace_id
        ORDER BY q.deletion_pending_at NULLS LAST, q.gc_claimed_at NULLS LAST, COALESCE(q.byte_size, 0) DESC, q.id
        LIMIT v_limit OFFSET v_offset
      ) page
    ), '[]'::jsonb)
    INTO v_total, v_objects;

  RETURN jsonb_build_object('kind', v_kind, 'total', v_total, 'objects', v_objects);
END;
$$;

COMMENT ON FUNCTION public.admin_asset_queue(uuid, text, integer, integer) IS
  'Platform-admin view of the deletion queue: assets pending delete, GC-eligible, or GC-claimed. Read-only.';

CREATE OR REPLACE FUNCTION public.admin_asset_large_objects(
  p_actor_user_id uuid,
  p_limit integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;

  RETURN jsonb_build_object('objects', COALESCE((
    SELECT jsonb_agg(page.row_data ORDER BY page.byte_size DESC, page.id)
    FROM (
      SELECT jsonb_build_object(
               'id', ao.id, 'bucket', ao.bucket, 'objectPath', ao.object_path,
               'workspaceId', ao.workspace_id, 'workspaceName', w.name, 'scope', ao.scope,
               'mimeType', ao.mime_type, 'byteSize', COALESCE(ao.byte_size, 0),
               'createdAt', ao.created_at,
               'referenceCount', (SELECT count(*) FROM public.asset_references ar WHERE ar.asset_id = ao.id),
               'confirmedOrphan', NOT private.loomic_asset_has_live_references(ao.id),
               'deletionPendingAt', ao.deletion_pending_at,
               'gcEligibleAt', ao.gc_eligible_at,
               'gcClaimedAt', ao.gc_claimed_at
             ) AS row_data,
             COALESCE(ao.byte_size, 0) AS byte_size, ao.id
      FROM public.asset_objects ao
      LEFT JOIN public.workspaces w ON w.id = ao.workspace_id
      ORDER BY COALESCE(ao.byte_size, 0) DESC, ao.id
      LIMIT v_limit
    ) page
  ), '[]'::jsonb));
END;
$$;

COMMENT ON FUNCTION public.admin_asset_large_objects(uuid, integer) IS
  'Platform-admin ranking of the biggest stored objects, with the authoritative reference verdict for each. Read-only.';

-- ---------------------------------------------------------------------------
-- Purge (reuses the existing orphan pipeline)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_claim_orphan_asset(
  p_actor_user_id uuid,
  p_asset_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before jsonb;
  v_claim record;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  PERFORM private.admin_require_reason(p_reason);

  SELECT to_jsonb(ao) INTO v_before FROM public.asset_objects ao WHERE ao.id = p_asset_id;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_ASSET: no such stored object';
  END IF;

  -- The authoritative check lives inside `loomic_orphan_asset_claim`; a nil result
  -- means the asset still has live references (or it vanished), never "already done".
  SELECT * INTO v_claim FROM public.loomic_orphan_asset_claim(p_asset_id);
  IF v_claim IS NULL OR v_claim.bucket IS NULL THEN
    RAISE EXCEPTION 'ASSET_REFERENCED: the asset still has live references';
  END IF;

  PERFORM private.admin_write_asset_audit(
    p_actor_user_id, 'storage.orphan.claim', p_asset_id, p_reason, v_before,
    jsonb_build_object('bucket', v_claim.bucket, 'objectPath', v_claim.object_path));

  RETURN jsonb_build_object(
    'assetId', p_asset_id, 'bucket', v_claim.bucket, 'objectPath', v_claim.object_path,
    'alreadyPending', (v_before ->> 'deletion_pending_at') IS NOT NULL);
END;
$$;

COMMENT ON FUNCTION public.admin_claim_orphan_asset(uuid, uuid, text) IS
  'Platform-admin: claim an unreferenced asset for deletion through the existing orphan pipeline and audit it. Refuses (and audits nothing) when the asset is still referenced.';

CREATE OR REPLACE FUNCTION public.admin_finalize_orphan_asset(
  p_actor_user_id uuid,
  p_asset_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before jsonb;
  v_deleted boolean;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  PERFORM private.admin_require_reason(p_reason);

  SELECT to_jsonb(ao) INTO v_before FROM public.asset_objects ao WHERE ao.id = p_asset_id;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_ASSET: no such stored object';
  END IF;

  -- Refuses when the asset was never claimed, or when a reference came back in the
  -- meantime - the object may already be gone, but the row is not ours to drop.
  v_deleted := public.loomic_orphan_asset_finalize(p_asset_id);
  IF NOT v_deleted THEN
    RAISE EXCEPTION 'ASSET_FINALIZE_REFUSED: the asset is not pending deletion or is referenced again';
  END IF;

  PERFORM private.admin_write_asset_audit(
    p_actor_user_id, 'storage.orphan.purge', p_asset_id, p_reason, v_before, NULL);

  RETURN jsonb_build_object('assetId', p_asset_id, 'deleted', true);
END;
$$;

COMMENT ON FUNCTION public.admin_finalize_orphan_asset(uuid, uuid, text) IS
  'Platform-admin: drop the row of an asset whose object is already gone, through the existing orphan pipeline, and audit it. Refuses when the asset is not pending or is referenced again.';

REVOKE ALL ON FUNCTION public.admin_asset_overview(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_asset_orphan_candidates(uuid, text, uuid, bigint, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_asset_queue(uuid, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_asset_large_objects(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_claim_orphan_asset(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_finalize_orphan_asset(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_asset_overview(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_asset_orphan_candidates(uuid, text, uuid, bigint, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_asset_queue(uuid, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_asset_large_objects(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_claim_orphan_asset(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_finalize_orphan_asset(uuid, uuid, text) TO service_role;
