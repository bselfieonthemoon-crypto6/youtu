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
    OR (auth.role() <> 'service_role' AND NOT private.is_workspace_member(target_workspace_id))
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

REVOKE ALL ON FUNCTION public.loomic_canvas_asset_ref_upsert(uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.loomic_canvas_asset_ref_upsert(uuid, uuid, text)
  TO authenticated, service_role;
