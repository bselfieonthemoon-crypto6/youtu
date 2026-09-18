-- Preparing an intent is a read-only observation. Only explicit activation may
-- advance the task revision, supersede proposals, or invalidate an old run.
-- Existing begin remains available for callers already authorized to activate.
CREATE FUNCTION public.loomic_agent_task_prepare(p_user uuid,p_session uuid,p_canvas uuid,p_run uuid,
  p_prompt text,p_target jsonb DEFAULT NULL,p_correction_of uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE task public.agent_design_tasks; mapped public.agent_design_task_runs; canvas public.canvases;
  target_value jsonb; design public.design_documents; element jsonb; object_id text; hash_value text;
  candidate jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'agent_task_service_role_forbidden'; END IF;
  IF p_prompt IS NULL OR char_length(btrim(p_prompt)) NOT BETWEEN 1 AND 20000 THEN
    RAISE EXCEPTION 'agent_task_prompt_invalid';
  END IF;
  -- No row locks and no mutations: STABLE keeps all observations within the
  -- read snapshot. activate obtains locks and revalidates this evidence later.
  IF NOT EXISTS (SELECT 1 FROM public.chat_sessions s
    WHERE s.id=p_session AND s.created_by=p_user AND s.canvas_id=p_canvas)
  THEN RAISE EXCEPTION 'agent_task_session_forbidden'; END IF;
  SELECT * INTO canvas FROM public.canvases WHERE id=p_canvas;
  IF canvas.id IS NULL OR NOT EXISTS (SELECT 1 FROM public.workspace_members m
      WHERE m.workspace_id=canvas.workspace_id AND m.user_id=p_user AND m.role IN ('owner','admin'))
    OR NOT EXISTS (SELECT 1 FROM public.agent_runs r WHERE r.id=p_run AND r.created_by=p_user
      AND r.session_id=p_session AND r.status IN ('accepted','running'))
  THEN RAISE EXCEPTION 'agent_task_run_forbidden'; END IF;
  SELECT * INTO task FROM public.agent_design_tasks WHERE session_id=p_session;
  IF task.id IS NOT NULL AND (task.created_by IS DISTINCT FROM p_user OR task.canvas_id IS DISTINCT FROM p_canvas)
  THEN RAISE EXCEPTION 'agent_task_session_forbidden'; END IF;
  hash_value:=md5(jsonb_build_object('prompt',p_prompt,'target',p_target,'correction',p_correction_of)::text);
  SELECT * INTO mapped FROM public.agent_design_task_runs WHERE run_id=p_run;
  IF mapped.run_id IS NOT NULL THEN
    IF mapped.request_hash<>hash_value OR task.id IS DISTINCT FROM mapped.task_id THEN
      RAISE EXCEPTION 'agent_task_run_conflict';
    END IF;
    IF task.current_run_id IS DISTINCT FROM p_run OR task.revision IS DISTINCT FROM mapped.revision THEN
      RAISE EXCEPTION 'agent_task_superseded';
    END IF;
  ELSIF p_correction_of IS NOT NULL AND (task.id IS NULL OR task.current_run_id IS DISTINCT FROM p_correction_of) THEN
    RAISE EXCEPTION 'agent_task_correction_conflict';
  END IF;
  target_value:=CASE WHEN p_correction_of IS NOT NULL AND p_target IS NULL THEN task.target ELSE p_target END;
  IF target_value IS NULL OR jsonb_typeof(target_value)<>'object'
    OR COALESCE(target_value->>'kind','') NOT IN ('design','canvas_image')
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(target_value) k WHERE k NOT IN ('kind','designId','objectIds','elementId','assetId'))
  THEN RAISE EXCEPTION 'agent_task_target_invalid'; END IF;
  IF target_value->>'kind'='design' THEN
    IF target_value ? 'assetId' OR private.try_parse_uuid(target_value->>'designId') IS NULL THEN
      RAISE EXCEPTION 'agent_task_target_invalid';
    END IF;
    SELECT * INTO design FROM public.design_documents d WHERE d.id=private.try_parse_uuid(target_value->>'designId')
      AND d.workspace_id=canvas.workspace_id AND d.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM public.design_nodes n WHERE n.design_id=d.id AND n.canvas_id=p_canvas AND n.deleted_at IS NULL);
    IF design.id IS NULL THEN RAISE EXCEPTION 'agent_task_target_forbidden'; END IF;
    IF target_value ? 'objectIds' THEN
      IF jsonb_typeof(target_value->'objectIds')<>'array' OR jsonb_array_length(target_value->'objectIds') NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'agent_task_target_invalid';
      END IF;
      FOR object_id IN SELECT jsonb_array_elements_text(target_value->'objectIds') LOOP
        IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(design.scene->'objects') o WHERE o->>'objectId'=object_id) THEN
          RAISE EXCEPTION 'agent_task_target_forbidden';
        END IF;
      END LOOP;
    END IF;
  ELSE
    IF target_value ? 'designId' OR target_value ? 'objectIds'
      OR NOT (target_value ? 'elementId') OR NOT (target_value ? 'assetId')
      OR jsonb_typeof(target_value->'elementId')<>'string' OR COALESCE(target_value->>'elementId','')=''
      OR jsonb_typeof(target_value->'assetId')<>'string' OR COALESCE(target_value->>'assetId','')=''
    THEN RAISE EXCEPTION 'agent_task_target_invalid'; END IF;
    SELECT e INTO element FROM jsonb_array_elements(COALESCE(canvas.content->'elements','[]'::jsonb)) e
      WHERE e->>'id'=target_value->>'elementId' AND e->>'type'='image' AND COALESCE((e->>'isDeleted')::boolean,false)=false;
    IF element IS NULL THEN RAISE EXCEPTION 'agent_task_target_forbidden'; END IF;
    IF COALESCE(canvas.content->'files'->(element->>'fileId')->>'assetId',element#>>'{customData,assetId}')
      IS DISTINCT FROM target_value->>'assetId' THEN RAISE EXCEPTION 'agent_task_target_forbidden'; END IF;
  END IF;
  IF mapped.run_id IS NOT NULL THEN
    candidate:=private.loomic_agent_task_snapshot(task);
  ELSE
    candidate:=jsonb_build_object(
      'id',COALESCE(task.id,p_run),'revision',COALESCE(task.revision,0)+1,
      'runId',p_run,'sessionId',p_session,'canvasId',p_canvas,
      'goal',CASE WHEN p_correction_of IS NULL THEN p_prompt ELSE task.goal END,
      'corrections',CASE WHEN p_correction_of IS NULL THEN '[]'::jsonb ELSE task.corrections||jsonb_build_array(p_prompt) END,
      'target',target_value,'brief',NULL);
  END IF;
  RETURN jsonb_build_object('snapshot',candidate,'baseTaskId',task.id,'baseRevision',task.revision,'baseRunId',task.current_run_id);
END $$;

CREATE FUNCTION public.loomic_agent_task_activate(p_user uuid,p_session uuid,p_canvas uuid,p_run uuid,
  p_prompt text,p_target jsonb,p_correction_of uuid,p_prepared jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE task public.agent_design_tasks; mapped public.agent_design_task_runs; fresh jsonb; locked_base jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'agent_task_service_role_forbidden'; END IF;
  IF p_prepared IS NULL OR jsonb_typeof(p_prepared)<>'object' OR jsonb_typeof(p_prepared->'snapshot') IS DISTINCT FROM 'object'
    OR NOT (p_prepared ?& ARRAY['snapshot','baseTaskId','baseRevision','baseRunId'])
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_prepared) k WHERE k NOT IN ('snapshot','baseTaskId','baseRevision','baseRunId'))
  THEN RAISE EXCEPTION 'agent_task_preparation_invalid'; END IF;
  -- Exactly the same order as begin, including the absent-task first-create
  -- case. A stale request cannot pass a preflight then overwrite a newer task.
  PERFORM 1 FROM public.chat_sessions s WHERE s.id=p_session AND s.created_by=p_user AND s.canvas_id=p_canvas FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'agent_task_session_forbidden'; END IF;
  SELECT * INTO task FROM public.agent_design_tasks WHERE session_id=p_session FOR UPDATE;
  SELECT * INTO mapped FROM public.agent_design_task_runs WHERE run_id=p_run;
  IF mapped.run_id IS NOT NULL THEN
    -- A retry of this already-activated run may return its current snapshot,
    -- never activate a second transition. prepare rechecks hash, ownership,
    -- target and that this run has not been superseded.
    fresh:=public.loomic_agent_task_prepare(p_user,p_session,p_canvas,p_run,p_prompt,p_target,p_correction_of);
    IF ((fresh->'snapshot')-'id'-'brief') IS DISTINCT FROM ((p_prepared->'snapshot')-'id'-'brief')
      OR COALESCE(p_prepared#>>'{snapshot,id}','') NOT IN (p_run::text,task.id::text)
    THEN RAISE EXCEPTION 'agent_task_activation_conflict'; END IF;
    RETURN public.loomic_agent_task_begin(p_user,p_session,p_canvas,p_run,p_prompt,p_target,p_correction_of);
  END IF;
  locked_base:=jsonb_build_object('baseTaskId',task.id,'baseRevision',task.revision,'baseRunId',task.current_run_id);
  IF locked_base IS DISTINCT FROM (p_prepared-'snapshot') THEN
    RAISE EXCEPTION 'agent_task_activation_conflict';
  END IF;
  fresh:=public.loomic_agent_task_prepare(p_user,p_session,p_canvas,p_run,p_prompt,p_target,p_correction_of);
  IF fresh IS DISTINCT FROM p_prepared THEN RAISE EXCEPTION 'agent_task_activation_conflict'; END IF;
  -- begin keeps its existing permission/target checks, immutable run attribution
  -- and proposal invalidation. All changes are in this locked transaction.
  RETURN public.loomic_agent_task_begin(p_user,p_session,p_canvas,p_run,p_prompt,p_target,p_correction_of);
END $$;

REVOKE ALL ON FUNCTION public.loomic_agent_task_prepare(uuid,uuid,uuid,uuid,text,jsonb,uuid),
  public.loomic_agent_task_activate(uuid,uuid,uuid,uuid,text,jsonb,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_agent_task_prepare(uuid,uuid,uuid,uuid,text,jsonb,uuid),
  public.loomic_agent_task_activate(uuid,uuid,uuid,uuid,text,jsonb,uuid,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
