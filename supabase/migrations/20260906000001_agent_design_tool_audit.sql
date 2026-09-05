-- Stage 6: bind Agent design mutations to the authoritative run/tool ledger.
-- The existing design mutator remains the sole scene/reference/outbox writer;
-- this migration adds an audited, tool-execution-idempotent entry point.

CREATE TABLE public.design_agent_tool_requests (
  tool_execution_id uuid PRIMARY KEY
    REFERENCES public.tool_executions(id) ON DELETE RESTRICT,
  agent_run_id uuid NOT NULL
    REFERENCES public.agent_runs(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL
    REFERENCES auth.users(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL
    REFERENCES public.workspaces(id) ON DELETE CASCADE,
  design_id uuid REFERENCES public.design_documents(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN (
    'inspect_design', 'get_design_objects', 'manipulate_design',
    'search_design_resources', 'apply_design_template', 'export_design'
  )),
  expected_revision bigint CHECK (
    expected_revision IS NULL OR expected_revision >= 0
  ),
  idempotency_key uuid,
  template_id uuid REFERENCES public.design_templates(id) ON DELETE RESTRICT,
  expected_template_revision bigint CHECK (
    expected_template_revision IS NULL OR expected_template_revision >= 0
  ),
  confirmation_id uuid,
  destructive_confirmed boolean NOT NULL DEFAULT false,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{32}$'),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT design_agent_tool_requests_mutation_shape_check CHECK (
    operation NOT IN ('manipulate_design', 'apply_design_template')
    OR (
      design_id IS NOT NULL
      AND expected_revision IS NOT NULL
      AND idempotency_key IS NOT NULL
    )
  ),
  CONSTRAINT design_agent_tool_requests_template_shape_check CHECK (
    (operation = 'apply_design_template'
      AND template_id IS NOT NULL
      AND expected_template_revision IS NOT NULL)
    OR (operation <> 'apply_design_template'
      AND template_id IS NULL
      AND expected_template_revision IS NULL)
  ),
  CONSTRAINT design_agent_tool_requests_confirmation_pair_check CHECK (
    (confirmation_id IS NULL AND NOT destructive_confirmed)
    OR (confirmation_id IS NOT NULL AND destructive_confirmed)
  )
);

CREATE INDEX design_agent_tool_requests_design_created_idx
  ON public.design_agent_tool_requests(design_id, created_at DESC)
  WHERE design_id IS NOT NULL;
CREATE INDEX design_agent_tool_requests_run_created_idx
  ON public.design_agent_tool_requests(agent_run_id, created_at DESC);
CREATE UNIQUE INDEX design_agent_tool_requests_design_idempotency_key
  ON public.design_agent_tool_requests(design_id, idempotency_key)
  WHERE design_id IS NOT NULL AND idempotency_key IS NOT NULL;

ALTER TABLE public.design_agent_tool_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_agent_tool_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.design_agent_tool_requests
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.loomic_agent_design_context_workspace(
  p_agent_run_id uuid,
  p_tool_execution_id uuid,
  p_actor_user_id uuid,
  p_tool_name text,
  p_allow_completed boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  workspace_id_value uuid;
BEGIN
  SELECT c.workspace_id
  INTO workspace_id_value
  FROM public.tool_executions execution
  JOIN public.agent_runs run ON run.id = execution.run_id
  JOIN public.chat_sessions session ON session.id = run.session_id
  JOIN public.canvases c ON c.id = session.canvas_id
  WHERE execution.id = p_tool_execution_id
    AND execution.run_id = p_agent_run_id
    AND execution.requested_by = p_actor_user_id
    AND execution.tool_name = p_tool_name
    -- A frozen destructive proposal is executed by agent.confirm_action after
    -- the original tool/run may already have completed. Failed/canceled ledger
    -- entries remain ineligible, while running and completed entries preserve
    -- the same actor/run/tool/workspace identity.
    AND (
      execution.status = 'running'
      OR (p_allow_completed AND execution.status = 'completed')
    )
    AND run.created_by = p_actor_user_id
    AND (
      run.status = 'running'
      OR (p_allow_completed AND run.status = 'completed')
    );

  IF workspace_id_value IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'agent_design_execution_invalid';
  END IF;
  RETURN workspace_id_value;
END;
$$;

REVOKE ALL ON FUNCTION private.loomic_agent_design_context_workspace(
  uuid, uuid, uuid, text, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.loomic_agent_design_context_workspace(
  uuid, uuid, uuid, text, boolean
) TO service_role;

CREATE UNIQUE INDEX design_document_versions_tool_execution_key
  ON public.design_document_versions(tool_execution_id)
  WHERE tool_execution_id IS NOT NULL;

CREATE OR REPLACE FUNCTION private.loomic_validate_agent_design_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  request_row public.design_agent_tool_requests%ROWTYPE;
  context_workspace_id uuid;
BEGIN
  IF NEW.actor_kind = 'agent' THEN
    IF NEW.actor_user_id IS NULL
      OR NEW.agent_run_id IS NULL
      OR NEW.tool_execution_id IS NULL
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'agent_design_audit_required';
    END IF;

    SELECT * INTO request_row
    FROM public.design_agent_tool_requests request
    WHERE request.tool_execution_id = NEW.tool_execution_id
      AND request.agent_run_id = NEW.agent_run_id
      AND request.actor_user_id = NEW.actor_user_id
      AND request.design_id = NEW.design_id
      AND request.idempotency_key = NEW.idempotency_key;
    IF request_row.tool_execution_id IS NULL
      OR request_row.operation NOT IN (
        'manipulate_design', 'apply_design_template'
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'agent_design_audit_mismatch';
    END IF;

    context_workspace_id := private.loomic_agent_design_context_workspace(
      NEW.agent_run_id,
      NEW.tool_execution_id,
      NEW.actor_user_id,
      request_row.operation,
      request_row.destructive_confirmed
    );
    IF context_workspace_id IS DISTINCT FROM NEW.workspace_id
      OR request_row.workspace_id IS DISTINCT FROM NEW.workspace_id
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'agent_design_workspace_mismatch';
    END IF;
  ELSIF NEW.agent_run_id IS NOT NULL OR NEW.tool_execution_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'non_agent_design_audit_invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS design_document_versions_validate_agent
  ON public.design_document_versions;
CREATE TRIGGER design_document_versions_validate_agent
BEFORE INSERT OR UPDATE OF
  actor_kind, actor_user_id, agent_run_id, tool_execution_id,
  design_id, workspace_id, idempotency_key
ON public.design_document_versions
FOR EACH ROW EXECUTE FUNCTION private.loomic_validate_agent_design_version();

CREATE OR REPLACE FUNCTION public.loomic_agent_design_mutate(
  p_operation text,
  p_design_id uuid,
  p_expected_revision bigint,
  p_idempotency_key uuid,
  p_commands jsonb,
  p_next_scene jsonb,
  p_actor_user_id uuid,
  p_agent_run_id uuid,
  p_tool_execution_id uuid,
  p_template_id uuid DEFAULT NULL,
  p_expected_template_revision bigint DEFAULT NULL,
  p_confirmation_id uuid DEFAULT NULL,
  p_destructive_confirmed boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  design_row public.design_documents%ROWTYPE;
  template_row public.design_templates%ROWTYPE;
  request_row public.design_agent_tool_requests%ROWTYPE;
  context_workspace_id uuid;
  input_hash_value text;
  result_value jsonb;
  is_destructive boolean;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF p_operation NOT IN ('manipulate_design', 'apply_design_template')
    OR p_design_id IS NULL
    OR p_expected_revision IS NULL OR p_expected_revision < 0
    OR p_idempotency_key IS NULL
    OR p_actor_user_id IS NULL
    OR p_agent_run_id IS NULL
    OR p_tool_execution_id IS NULL
    OR jsonb_typeof(p_commands) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_commands) NOT BETWEEN 1 AND 500
    OR jsonb_typeof(p_next_scene) IS DISTINCT FROM 'object'
    OR (p_destructive_confirmed AND p_confirmation_id IS NULL)
    OR (NOT p_destructive_confirmed AND p_confirmation_id IS NOT NULL)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'agent_design_mutation_invalid';
  END IF;

  is_destructive := p_operation = 'apply_design_template' OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_commands) command
    WHERE command->>'action' IN ('object.remove', 'scene.replace')
  );
  IF is_destructive
    AND (NOT p_destructive_confirmed OR p_confirmation_id IS NULL)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'agent_design_confirmation_required';
  END IF;
  IF NOT is_destructive
    AND (p_destructive_confirmed OR p_confirmation_id IS NOT NULL)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'agent_design_confirmation_invalid';
  END IF;

  IF p_operation = 'manipulate_design'
    AND (p_template_id IS NOT NULL OR p_expected_template_revision IS NOT NULL)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'agent_design_template_invalid';
  END IF;

  input_hash_value := md5(jsonb_build_object(
    'operation', p_operation,
    'design_id', p_design_id,
    'expected_revision', p_expected_revision,
    'idempotency_key', p_idempotency_key,
    'commands', p_commands,
    'template_id', p_template_id,
    'expected_template_revision', p_expected_template_revision
  )::text);

  SELECT * INTO request_row
  FROM public.design_agent_tool_requests request
  WHERE request.design_id = p_design_id
    AND request.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF request_row.tool_execution_id IS NOT NULL THEN
    IF request_row.actor_user_id IS DISTINCT FROM p_actor_user_id
      OR request_row.design_id IS DISTINCT FROM p_design_id
      OR request_row.operation IS DISTINCT FROM p_operation
      OR request_row.idempotency_key IS DISTINCT FROM p_idempotency_key
      OR request_row.input_hash IS DISTINCT FROM input_hash_value
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'agent_design_idempotency_conflict';
    END IF;
    IF request_row.result IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'agent_design_request_in_progress';
    END IF;
    RETURN jsonb_set(request_row.result, '{replayed}', 'true'::jsonb, true);
  END IF;

  SELECT * INTO design_row
  FROM public.design_documents design
  WHERE design.id = p_design_id
    AND design.deleted_at IS NULL;
  IF design_row.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'design_not_found';
  END IF;

  context_workspace_id := private.loomic_agent_design_context_workspace(
    p_agent_run_id,
    p_tool_execution_id,
    p_actor_user_id,
    p_operation,
    p_destructive_confirmed
  );
  IF context_workspace_id IS DISTINCT FROM design_row.workspace_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'agent_design_workspace_mismatch';
  END IF;

  IF p_operation = 'apply_design_template' THEN
    IF p_template_id IS NULL OR p_expected_template_revision IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'agent_design_template_invalid';
    END IF;
    SELECT * INTO template_row
    FROM public.design_templates template
    WHERE template.id = p_template_id
      AND template.deleted_at IS NULL
    FOR SHARE;
    IF template_row.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'design_template_not_found';
    END IF;
    IF template_row.revision IS DISTINCT FROM p_expected_template_revision THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'design_template_revision_conflict';
    END IF;
    IF NOT (
      (template_row.scope = 'platform' AND template_row.status = 'published')
      OR (
        template_row.scope = 'workspace'
        AND template_row.workspace_id = design_row.workspace_id
        AND template_row.status NOT IN ('rejected', 'disabled')
      )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'design_template_forbidden';
    END IF;
    IF jsonb_array_length(p_commands) <> 1
      OR p_commands#>>'{0,action}' <> 'scene.replace'
      OR p_commands#>'{0,scene}' IS DISTINCT FROM template_row.scene
      OR p_next_scene IS DISTINCT FROM template_row.scene
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'agent_design_template_scene_mismatch';
    END IF;
  END IF;

  INSERT INTO public.design_agent_tool_requests(
    tool_execution_id,
    agent_run_id,
    actor_user_id,
    workspace_id,
    design_id,
    operation,
    expected_revision,
    idempotency_key,
    template_id,
    expected_template_revision,
    confirmation_id,
    destructive_confirmed,
    input_hash
  ) VALUES (
    p_tool_execution_id,
    p_agent_run_id,
    p_actor_user_id,
    design_row.workspace_id,
    p_design_id,
    p_operation,
    p_expected_revision,
    p_idempotency_key,
    p_template_id,
    p_expected_template_revision,
    p_confirmation_id,
    p_destructive_confirmed,
    input_hash_value
  )
  ON CONFLICT DO NOTHING;

  SELECT * INTO request_row
  FROM public.design_agent_tool_requests request
  WHERE request.design_id = p_design_id
    AND request.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF request_row.actor_user_id IS DISTINCT FROM p_actor_user_id
    OR request_row.design_id IS DISTINCT FROM p_design_id
    OR request_row.operation IS DISTINCT FROM p_operation
    OR request_row.idempotency_key IS DISTINCT FROM p_idempotency_key
    OR request_row.input_hash IS DISTINCT FROM input_hash_value
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'agent_design_idempotency_conflict';
  END IF;
  IF request_row.result IS NOT NULL THEN
    RETURN jsonb_set(request_row.result, '{replayed}', 'true'::jsonb, true);
  END IF;

  result_value := public.loomic_design_mutate(
    p_design_id,
    p_expected_revision,
    p_idempotency_key,
    p_commands,
    p_next_scene,
    'agent',
    p_actor_user_id,
    p_agent_run_id,
    p_tool_execution_id
  ) || jsonb_build_object(
    'status', 'applied',
    'template_id', p_template_id
  );

  IF p_operation = 'manipulate_design' THEN
    result_value := result_value - 'template_id';
  END IF;
  UPDATE public.design_agent_tool_requests
  SET result = result_value,
      completed_at = now()
  WHERE tool_execution_id = p_tool_execution_id;

  RETURN result_value;
END;
$$;

REVOKE ALL ON FUNCTION public.loomic_agent_design_mutate(
  text, uuid, bigint, uuid, jsonb, jsonb, uuid, uuid, uuid,
  uuid, bigint, uuid, boolean
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.loomic_agent_design_mutate(
  text, uuid, bigint, uuid, jsonb, jsonb, uuid, uuid, uuid,
  uuid, bigint, uuid, boolean
) TO service_role;
CREATE UNIQUE INDEX IF NOT EXISTS background_jobs_design_image_idempotency_key
  ON public.background_jobs(
    design_id,
    created_by,
    ((payload->'target'->>'idempotency_key'))
  )
  WHERE job_type = 'image_generation'
    AND target_kind = 'design'
    AND design_id IS NOT NULL
    AND payload->'target' ? 'idempotency_key';
