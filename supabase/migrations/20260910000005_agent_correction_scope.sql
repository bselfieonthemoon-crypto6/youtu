-- A correction without a new explicit target scope may retain the exact prior
-- authenticated scope. This preflight is read-only: activation still validates
-- every returned target again before persisting it for the new task revision.
CREATE FUNCTION private.loomic_agent_target_scope_is_current(
  p_task public.agent_design_tasks,p_user uuid,p_candidate jsonb
) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE origin_canvas public.canvases; design_id_value uuid; element jsonb;
BEGIN
  SELECT * INTO origin_canvas FROM public.canvases WHERE id=p_task.canvas_id;
  IF origin_canvas.id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.workspace_members member
    WHERE member.workspace_id=origin_canvas.workspace_id AND member.user_id=p_user
      AND member.role IN ('owner','admin')
  ) THEN RETURN false; END IF;
  IF jsonb_typeof(p_candidate)<>'object' OR COALESCE(p_candidate->>'kind','') NOT IN ('design','canvas_image')
  THEN RETURN false; END IF;

  IF p_candidate->>'kind'='design' THEN
    design_id_value:=private.try_parse_uuid(p_candidate->>'designId');
    IF design_id_value IS NULL OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(p_candidate) key
      WHERE key NOT IN ('kind','designId','objectIds','elementId')
    ) OR (p_candidate ? 'elementId' AND (
      jsonb_typeof(p_candidate->'elementId')<>'string'
      OR char_length(p_candidate->>'elementId') NOT BETWEEN 1 AND 200
    )) THEN RETURN false; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.design_documents design
      JOIN public.design_nodes node ON node.design_id=design.id
        AND node.workspace_id=design.workspace_id AND node.deleted_at IS NULL
      JOIN public.canvases target_canvas ON target_canvas.id=node.canvas_id
        AND target_canvas.workspace_id=node.workspace_id
      WHERE design.id=design_id_value AND design.deleted_at IS NULL
        AND design.workspace_id=origin_canvas.workspace_id
        AND design.project_id=origin_canvas.project_id
        AND target_canvas.project_id=origin_canvas.project_id
        AND (NOT (p_candidate ? 'elementId') OR node.element_id=p_candidate->>'elementId')
    ) THEN RETURN false; END IF;
    IF p_candidate ? 'objectIds' THEN
      IF jsonb_typeof(p_candidate->'objectIds')<>'array'
        OR jsonb_array_length(p_candidate->'objectIds') NOT BETWEEN 1 AND 100
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(p_candidate->'objectIds') value
          WHERE jsonb_typeof(value)<>'string' OR private.try_parse_uuid(trim(both '"' from value::text)) IS NULL
        )
        OR (SELECT count(*) FROM jsonb_array_elements_text(p_candidate->'objectIds'))
          <> (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(p_candidate->'objectIds') value)
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(p_candidate->'objectIds') requested(object_id)
          WHERE NOT EXISTS (
            SELECT 1 FROM public.design_documents design,
              jsonb_array_elements(COALESCE(design.scene->'objects','[]'::jsonb)) object
            WHERE design.id=design_id_value AND design.deleted_at IS NULL
              AND object->>'objectId'=requested.object_id
          )
        )
      THEN RETURN false; END IF;
    END IF;
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_candidate) key
    WHERE key NOT IN ('kind','elementId','assetId')
  ) OR NOT (p_candidate ?& ARRAY['elementId','assetId'])
    OR jsonb_typeof(p_candidate->'elementId')<>'string'
    OR char_length(p_candidate->>'elementId') NOT BETWEEN 1 AND 200
    OR private.try_parse_uuid(p_candidate->>'assetId') IS NULL
  THEN RETURN false; END IF;
  SELECT value INTO element
  FROM jsonb_array_elements(COALESCE(origin_canvas.content->'elements','[]'::jsonb)) value
  WHERE value->>'id'=p_candidate->>'elementId' AND value->>'type'='image'
    AND COALESCE((value->>'isDeleted')::boolean,false)=false;
  RETURN element IS NOT NULL AND COALESCE(
    origin_canvas.content->'files'->(element->>'fileId')->>'assetId',
    element#>>'{customData,assetId}'
  ) IS NOT DISTINCT FROM p_candidate->>'assetId';
END $$;

CREATE FUNCTION public.loomic_agent_target_scope_prepare_correction(
  p_user uuid,p_session uuid,p_canvas uuid,p_run uuid,p_correction_of uuid,
  p_task_revision bigint,p_primary_target jsonb
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE task public.agent_design_tasks; targets jsonb;
BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF p_run IS NULL OR p_correction_of IS NULL OR p_run=p_correction_of
    OR p_task_revision IS NULL OR p_task_revision<=1
  THEN RAISE EXCEPTION 'agent_target_scope_correction_invalid'; END IF;
  SELECT * INTO task FROM public.agent_design_tasks WHERE current_run_id=p_correction_of;
  IF task.id IS NULL OR task.created_by IS DISTINCT FROM p_user
    OR task.session_id IS DISTINCT FROM p_session OR task.canvas_id IS DISTINCT FROM p_canvas
  THEN RAISE EXCEPTION 'agent_target_scope_forbidden'; END IF;
  IF p_task_revision IS DISTINCT FROM task.revision+1
    OR NOT private.loomic_agent_target_subset(p_primary_target,task.target)
    OR NOT private.loomic_agent_target_subset(task.target,p_primary_target)
    OR COALESCE(p_primary_target->>'elementId','') IS DISTINCT FROM COALESCE(task.target->>'elementId','')
  THEN RAISE EXCEPTION 'agent_target_scope_correction_conflict'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_runs run WHERE run.id=p_run AND run.created_by=p_user
      AND run.session_id=p_session AND run.status IN ('accepted','running')
  ) THEN RAISE EXCEPTION 'agent_target_scope_forbidden'; END IF;

  SELECT jsonb_agg(scope.target ORDER BY scope.target_index) INTO targets
  FROM public.agent_task_target_scopes scope
  WHERE scope.task_id=task.id AND scope.task_revision=task.revision
    AND scope.created_by=p_user AND scope.session_id=p_session;
  targets:=COALESCE(targets,jsonb_build_array(task.target));
  -- Do not silently drop a revoked, deleted, moved, foreign, or malformed
  -- destination. The correction remains unprepared until the user supplies a
  -- new explicit scope or the resource becomes valid again.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(targets) candidate
    WHERE NOT private.loomic_agent_target_scope_is_current(task,p_user,candidate)
  ) THEN RAISE EXCEPTION 'agent_target_scope_forbidden'; END IF;
  RETURN targets;
END $$;

REVOKE ALL ON FUNCTION private.loomic_agent_target_scope_is_current(public.agent_design_tasks,uuid,jsonb),
  public.loomic_agent_target_scope_prepare_correction(uuid,uuid,uuid,uuid,uuid,bigint,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_agent_target_scope_prepare_correction(uuid,uuid,uuid,uuid,uuid,bigint,jsonb)
  TO service_role;
NOTIFY pgrst,'reload schema';
