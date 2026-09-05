-- Private media delivery and reference-aware garbage collection.

UPDATE storage.buckets
SET public = false
WHERE id = 'canvases';

-- The existing project-assets bucket contains the public home-page seed
-- gallery. Keep that bucket public and isolate all user-owned media instead.
INSERT INTO storage.buckets (id, name, public)
VALUES ('workspace-assets', 'workspace-assets', false)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name, public = false;

ALTER TABLE public.asset_objects
  DROP CONSTRAINT IF EXISTS asset_objects_bucket_check;
ALTER TABLE public.asset_objects
  ADD CONSTRAINT asset_objects_bucket_check
  CHECK (bucket IN ('project-assets', 'workspace-assets', 'user-avatars'));

DROP POLICY IF EXISTS "workspace_assets_select_member" ON storage.objects;
CREATE POLICY "workspace_assets_select_member"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'workspace-assets'
  AND private.is_workspace_member(private.try_parse_uuid((storage.foldername(name))[1]))
);

DROP POLICY IF EXISTS "workspace_assets_insert_admin" ON storage.objects;
CREATE POLICY "workspace_assets_insert_admin"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'workspace-assets'
  AND private.is_workspace_admin_or_owner(private.try_parse_uuid((storage.foldername(name))[1]))
);

DROP POLICY IF EXISTS "workspace_assets_update_admin" ON storage.objects;
CREATE POLICY "workspace_assets_update_admin"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'workspace-assets'
  AND private.is_workspace_admin_or_owner(private.try_parse_uuid((storage.foldername(name))[1]))
)
WITH CHECK (
  bucket_id = 'workspace-assets'
  AND private.is_workspace_admin_or_owner(private.try_parse_uuid((storage.foldername(name))[1]))
);

DROP POLICY IF EXISTS "workspace_assets_delete_admin" ON storage.objects;
CREATE POLICY "workspace_assets_delete_admin"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'workspace-assets'
  AND private.is_workspace_admin_or_owner(private.try_parse_uuid((storage.foldername(name))[1]))
);

DROP POLICY IF EXISTS "canvases_select_public" ON storage.objects;
DROP POLICY IF EXISTS "canvases_insert_authenticated" ON storage.objects;

CREATE POLICY "canvases_select_member"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'canvases'
  AND private.is_workspace_member(
    private.try_parse_uuid((storage.foldername(name))[1])
  )
);

CREATE POLICY "canvases_insert_admin"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'canvases'
  AND private.is_workspace_admin_or_owner(
    private.try_parse_uuid((storage.foldername(name))[1])
  )
);

CREATE POLICY "canvases_delete_admin"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'canvases'
  AND private.is_workspace_admin_or_owner(
    private.try_parse_uuid((storage.foldername(name))[1])
  )
);

ALTER TABLE public.asset_objects
  ADD COLUMN IF NOT EXISTS deletion_pending_at timestamptz;

CREATE TABLE public.asset_references (
  asset_id uuid NOT NULL REFERENCES public.asset_objects(id) ON DELETE CASCADE,
  canvas_id uuid NOT NULL REFERENCES public.canvases(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  element_id text NOT NULL CHECK (char_length(element_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (canvas_id, element_id),
  UNIQUE (asset_id, canvas_id, element_id)
);

CREATE INDEX asset_references_asset_id_idx ON public.asset_references(asset_id);
ALTER TABLE public.asset_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_references FORCE ROW LEVEL SECURITY;

CREATE POLICY "asset_references_select_member"
ON public.asset_references FOR SELECT TO authenticated
USING (private.is_workspace_member(workspace_id));

REVOKE INSERT, UPDATE, DELETE ON public.asset_references
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.loomic_canvas_asset_refs_replace(
  p_canvas_id uuid,
  p_refs jsonb
) RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_workspace_id uuid;
  ref jsonb;
  ref_asset_id uuid;
  old_asset_ids uuid[];
  orphan_candidates uuid[];
BEGIN
  IF jsonb_typeof(p_refs) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'asset_refs_invalid';
  END IF;

  SELECT p.workspace_id INTO target_workspace_id
  FROM public.canvases c
  JOIN public.projects p ON p.id = c.project_id
  WHERE c.id = p_canvas_id
  FOR UPDATE OF c;

  IF target_workspace_id IS NULL
    OR NOT private.is_workspace_member(target_workspace_id)
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'canvas_not_found';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT asset_id), ARRAY[]::uuid[])
  INTO old_asset_ids
  FROM public.asset_references
  WHERE canvas_id = p_canvas_id;

  -- Lock every incoming asset in deterministic order. Pending/deleted and
  -- cross-workspace assets can never acquire a new reference.
  FOR ref_asset_id IN
    SELECT DISTINCT (value->>'assetId')::uuid
    FROM jsonb_array_elements(p_refs)
    ORDER BY 1
  LOOP
    PERFORM 1 FROM public.asset_objects
    WHERE id = ref_asset_id
      AND workspace_id = target_workspace_id
      AND deletion_pending_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'asset_ref_not_available';
    END IF;
  END LOOP;

  DELETE FROM public.asset_references WHERE canvas_id = p_canvas_id;

  FOR ref IN SELECT value FROM jsonb_array_elements(p_refs)
  LOOP
    INSERT INTO public.asset_references(asset_id, canvas_id, workspace_id, element_id)
    VALUES (
      (ref->>'assetId')::uuid,
      p_canvas_id,
      target_workspace_id,
      ref->>'elementId'
    )
    ON CONFLICT (canvas_id, element_id) DO UPDATE
    SET asset_id = EXCLUDED.asset_id, workspace_id = EXCLUDED.workspace_id;
  END LOOP;

  SELECT COALESCE(array_agg(candidate), ARRAY[]::uuid[])
  INTO orphan_candidates
  FROM unnest(old_asset_ids) candidate
  WHERE NOT EXISTS (
    SELECT 1 FROM public.asset_references ar WHERE ar.asset_id = candidate
  );

  RETURN orphan_candidates;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_orphan_asset_claim(
  p_asset_id uuid
) RETURNS TABLE(bucket text, object_path text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  asset_row public.asset_objects%ROWTYPE;
BEGIN
  SELECT * INTO asset_row FROM public.asset_objects
  WHERE id = p_asset_id FOR UPDATE;

  IF asset_row.id IS NULL
    OR NOT private.is_workspace_member(asset_row.workspace_id)
    OR EXISTS (SELECT 1 FROM public.asset_references WHERE asset_id = p_asset_id)
  THEN
    RETURN;
  END IF;

  UPDATE public.asset_objects
  SET deletion_pending_at = COALESCE(deletion_pending_at, now())
  WHERE id = p_asset_id;

  RETURN QUERY SELECT asset_row.bucket, asset_row.object_path;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_canvas_asset_ref_upsert(
  p_canvas_id uuid,
  p_asset_id uuid,
  p_element_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_workspace_id uuid;
BEGIN
  SELECT p.workspace_id INTO target_workspace_id
  FROM public.canvases c
  JOIN public.projects p ON p.id = c.project_id
  WHERE c.id = p_canvas_id;
  IF target_workspace_id IS NULL
    OR NOT private.is_workspace_member(target_workspace_id)
  THEN RETURN false; END IF;

  PERFORM 1 FROM public.asset_objects
  WHERE id = p_asset_id
    AND workspace_id = target_workspace_id
    AND deletion_pending_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  INSERT INTO public.asset_references(asset_id, canvas_id, workspace_id, element_id)
  VALUES (p_asset_id, p_canvas_id, target_workspace_id, p_element_id)
  ON CONFLICT (canvas_id, element_id) DO UPDATE
  SET asset_id = EXCLUDED.asset_id, workspace_id = EXCLUDED.workspace_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_orphan_asset_finalize(
  p_asset_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  deleted_id uuid;
BEGIN
  DELETE FROM public.asset_objects ao
  WHERE ao.id = p_asset_id
    AND ao.deletion_pending_at IS NOT NULL
    AND private.is_workspace_member(ao.workspace_id)
    AND NOT EXISTS (
      SELECT 1 FROM public.asset_references ar WHERE ar.asset_id = ao.id
    )
  RETURNING ao.id INTO deleted_id;
  RETURN deleted_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.loomic_canvas_asset_refs_replace(uuid, jsonb)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.loomic_orphan_asset_claim(uuid)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.loomic_canvas_asset_ref_upsert(uuid, uuid, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.loomic_orphan_asset_finalize(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.loomic_canvas_asset_refs_replace(uuid, jsonb)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.loomic_orphan_asset_claim(uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.loomic_canvas_asset_ref_upsert(uuid, uuid, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.loomic_orphan_asset_finalize(uuid)
  TO authenticated, service_role;

-- Backfill generated assets already present on live canvas elements.
UPDATE public.canvases c
SET content = jsonb_set(
  c.content,
  '{elements}',
  COALESCE((
    SELECT jsonb_agg(
      CASE
        WHEN private.try_parse_uuid(element#>>'{customData,sourceJobId}') IS NOT NULL
          AND job.asset_id IS NOT NULL
        THEN jsonb_set(element, '{customData,assetId}', to_jsonb(job.asset_id::text), true)
        ELSE element
      END
      ORDER BY ordinal
    )
    FROM jsonb_array_elements(COALESCE(c.content->'elements', '[]'::jsonb))
      WITH ORDINALITY AS items(element, ordinal)
    LEFT JOIN LATERAL (
      SELECT private.try_parse_uuid(j.result->>'asset_id') AS asset_id
      FROM public.background_jobs j
      WHERE j.id = private.try_parse_uuid(element#>>'{customData,sourceJobId}')
    ) job ON true
  ), '[]'::jsonb),
  true
)
WHERE jsonb_typeof(c.content->'elements') = 'array';

INSERT INTO public.asset_references(asset_id, canvas_id, workspace_id, element_id)
SELECT DISTINCT
  private.try_parse_uuid(j.result->>'asset_id'),
  c.id,
  p.workspace_id,
  element->>'id'
FROM public.canvases c
JOIN public.projects p ON p.id = c.project_id
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.content->'elements', '[]'::jsonb)) element
JOIN public.background_jobs j
  ON j.id = private.try_parse_uuid(element#>>'{customData,sourceJobId}')
JOIN public.asset_objects ao
  ON ao.id = private.try_parse_uuid(j.result->>'asset_id')
WHERE COALESCE((element->>'isDeleted')::boolean, false) = false
  AND ao.workspace_id = p.workspace_id
  AND element->>'id' IS NOT NULL
ON CONFLICT (canvas_id, element_id) DO NOTHING;
