-- Persist workflow coordination independently from model-authored brief
-- replacement. Task revision and workflow revision form a compare-and-swap
-- boundary so concurrent job callbacks cannot silently lose each other.
CREATE OR REPLACE FUNCTION public.loomic_agent_task_update_brief(
  p_run uuid,
  p_brief jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  task public.agent_design_tasks;
  preserved_workflow jsonb;
  next_brief jsonb;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  task := private.loomic_agent_task_lock(p_run);
  IF task.id IS NULL THEN
    RAISE EXCEPTION 'agent_task_run_invalid';
  END IF;
  IF p_brief IS NULL OR jsonb_typeof(p_brief) <> 'object' THEN
    RAISE EXCEPTION 'agent_task_brief_invalid';
  END IF;
  preserved_workflow := task.brief->'agentWorkflow';
  next_brief := (p_brief - 'agentWorkflow') || CASE
    WHEN preserved_workflow IS NULL THEN '{}'::jsonb
    ELSE jsonb_build_object('agentWorkflow', preserved_workflow)
  END;
  IF octet_length(next_brief::text) > 80000 THEN
    RAISE EXCEPTION 'agent_task_brief_invalid';
  END IF;
  UPDATE public.agent_design_tasks
  SET brief = next_brief, updated_at = now()
  WHERE id = task.id
  RETURNING * INTO task;
  RETURN private.loomic_agent_task_snapshot(task);
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_agent_task_update_workflow(
  p_run uuid,
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
  task public.agent_design_tasks;
  current_workflow jsonb;
  current_revision integer;
  next_brief jsonb;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  task := private.loomic_agent_task_lock(p_run);
  IF task.id IS NULL THEN
    RAISE EXCEPTION 'agent_task_run_invalid';
  END IF;
  IF task.revision IS DISTINCT FROM p_task_revision THEN
    RAISE EXCEPTION 'agent_workflow_task_revision_conflict';
  END IF;
  IF p_workflow IS NULL
    OR jsonb_typeof(p_workflow) <> 'object'
    OR octet_length(p_workflow::text) > 15000
    OR p_workflow->>'version' <> '1'
    OR p_workflow->>'taskId' IS DISTINCT FROM task.id::text
    OR p_workflow->>'taskRevision' IS DISTINCT FROM task.revision::text
    OR p_workflow->>'runId' IS DISTINCT FROM task.current_run_id::text
    OR COALESCE(p_workflow->>'workflowRevision', '') !~ '^[1-9][0-9]{0,8}$'
  THEN
    RAISE EXCEPTION 'agent_workflow_invalid';
  END IF;

  current_workflow := task.brief->'agentWorkflow';
  IF current_workflow IS NULL THEN
    IF p_expected_workflow_revision IS NOT NULL
      OR (p_workflow->>'workflowRevision')::integer <> 1
    THEN
      RAISE EXCEPTION 'agent_workflow_revision_conflict';
    END IF;
  ELSE
    IF jsonb_typeof(current_workflow) <> 'object'
      OR COALESCE(current_workflow->>'workflowRevision', '') !~ '^[1-9][0-9]{0,8}$'
    THEN
      RAISE EXCEPTION 'agent_workflow_stored_invalid';
    END IF;
    current_revision := (current_workflow->>'workflowRevision')::integer;
    IF p_expected_workflow_revision IS NULL
      OR current_revision IS DISTINCT FROM p_expected_workflow_revision
      OR (p_workflow->>'workflowRevision')::integer <> current_revision + 1
    THEN
      RAISE EXCEPTION 'agent_workflow_revision_conflict';
    END IF;
  END IF;

  next_brief := COALESCE(task.brief, '{}'::jsonb)
    || jsonb_build_object('agentWorkflow', p_workflow);
  IF octet_length(next_brief::text) > 80000 THEN
    RAISE EXCEPTION 'agent_task_brief_invalid';
  END IF;
  UPDATE public.agent_design_tasks
  SET brief = next_brief, updated_at = now()
  WHERE id = task.id
  RETURNING * INTO task;
  RETURN private.loomic_agent_task_snapshot(task);
END;
$$;

REVOKE ALL ON FUNCTION public.loomic_agent_task_update_workflow(
  uuid, integer, integer, jsonb
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.loomic_agent_task_update_workflow(
  uuid, integer, integer, jsonb
) TO service_role;
