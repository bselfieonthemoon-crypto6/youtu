-- Result review metadata is a continuation side effect too.  Keep the claim
-- lease check and the task brief/workflow CAS in one transaction so a user
-- stop or newer request has a total order with the write.

CREATE FUNCTION public.loomic_agent_continuation_update_brief(
  p_user uuid,
  p_job uuid,
  p_token uuid,
  p_brief jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  event public.agent_task_continuations;
  task public.agent_design_tasks;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  -- Same task -> continuation order as stop, bind and finish.
  SELECT t.* INTO task
  FROM public.agent_design_tasks t
  JOIN public.agent_task_continuations e ON e.task_id = t.id
  WHERE e.job_id = p_job AND e.created_by = p_user
  FOR UPDATE OF t;
  SELECT * INTO event
  FROM public.agent_task_continuations
  WHERE job_id = p_job AND created_by = p_user
  FOR UPDATE;
  IF task.id IS NULL OR event.job_id IS NULL OR event.status <> 'running'
    OR event.claim_token IS DISTINCT FROM p_token
    OR task.current_run_id IS DISTINCT FROM event.origin_run_id
    OR task.revision IS DISTINCT FROM event.task_revision
    OR EXISTS (
      SELECT 1 FROM public.agent_runs run
      WHERE run.id = event.origin_run_id AND run.status IN ('canceled', 'failed')
    )
  THEN
    RAISE EXCEPTION 'continuation_stopped_or_changed';
  END IF;
  RETURN public.loomic_agent_task_update_brief(event.origin_run_id, p_brief);
END;
$$;

CREATE FUNCTION public.loomic_agent_continuation_update_workflow(
  p_user uuid,
  p_job uuid,
  p_token uuid,
  p_task_revision integer,
  p_expected_workflow_revision integer,
  p_workflow jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  event public.agent_task_continuations;
  task public.agent_design_tasks;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  SELECT t.* INTO task
  FROM public.agent_design_tasks t
  JOIN public.agent_task_continuations e ON e.task_id = t.id
  WHERE e.job_id = p_job AND e.created_by = p_user
  FOR UPDATE OF t;
  SELECT * INTO event
  FROM public.agent_task_continuations
  WHERE job_id = p_job AND created_by = p_user
  FOR UPDATE;
  IF task.id IS NULL OR event.job_id IS NULL OR event.status <> 'running'
    OR event.claim_token IS DISTINCT FROM p_token
    OR task.current_run_id IS DISTINCT FROM event.origin_run_id
    OR task.revision IS DISTINCT FROM event.task_revision
    OR event.task_revision IS DISTINCT FROM p_task_revision
    OR EXISTS (
      SELECT 1 FROM public.agent_runs run
      WHERE run.id = event.origin_run_id AND run.status IN ('canceled', 'failed')
    )
  THEN
    RAISE EXCEPTION 'continuation_stopped_or_changed';
  END IF;
  RETURN public.loomic_agent_task_update_workflow(
    event.origin_run_id,
    p_task_revision,
    p_expected_workflow_revision,
    p_workflow
  );
END;
$$;

REVOKE ALL ON FUNCTION public.loomic_agent_continuation_update_brief(uuid, uuid, uuid, jsonb),
  public.loomic_agent_continuation_update_workflow(uuid, uuid, uuid, integer, integer, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_agent_continuation_update_brief(uuid, uuid, uuid, jsonb),
  public.loomic_agent_continuation_update_workflow(uuid, uuid, uuid, integer, integer, jsonb)
  TO service_role;
NOTIFY pgrst, 'reload schema';
