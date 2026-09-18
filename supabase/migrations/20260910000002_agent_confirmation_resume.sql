-- Durable destructive design confirmations. The frozen mutation request and
-- workflow binding survive an API restart; replay uses the original
-- idempotency key and never broadens the confirmed target.
CREATE TABLE public.agent_action_confirmations (
  confirmation_id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind='design_mutation'),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  canvas_id uuid NOT NULL REFERENCES public.canvases(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES public.agent_design_tasks(id) ON DELETE CASCADE,
  task_revision bigint NOT NULL,
  origin_run_id uuid NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  tool_execution_id uuid NOT NULL REFERENCES public.tool_executions(id) ON DELETE CASCADE,
  workflow_step_id text CHECK (workflow_step_id IS NULL OR workflow_step_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  details jsonb NOT NULL CHECK (jsonb_typeof(details)='object' AND octet_length(details::text)<=10000),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=80000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','executing','applied','canceled')),
  claim_token uuid,
  claimed_at timestamptz,
  result jsonb CHECK (result IS NULL OR (jsonb_typeof(result)='object' AND octet_length(result::text)<=30000)),
  completion_done boolean NOT NULL DEFAULT false,
  confirmed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('executing','applied') OR confirmed_at IS NOT NULL),
  CHECK ((status='applied')=(result IS NOT NULL)),
  CHECK (NOT completion_done OR status='applied')
);
CREATE INDEX agent_action_confirmations_pending
  ON public.agent_action_confirmations(user_id,canvas_id,expires_at)
  WHERE status IN ('pending','executing');
CREATE INDEX agent_action_confirmations_recovery
  ON public.agent_action_confirmations(user_id,session_id,updated_at)
  WHERE (status='applied' AND completion_done=false) OR status='executing'
    OR (status='pending' AND confirmed_at IS NOT NULL);
ALTER TABLE public.agent_action_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_action_confirmations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_action_confirmations FROM PUBLIC,anon,authenticated;

CREATE FUNCTION private.loomic_agent_action_confirmation_snapshot(row_value public.agent_action_confirmations)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT jsonb_build_object(
    'confirmationId',row_value.confirmation_id,'kind',row_value.kind,
    'userId',row_value.user_id,'workspaceId',row_value.workspace_id,
    'sessionId',row_value.session_id,'canvasId',row_value.canvas_id,
    'taskId',row_value.task_id,'taskRevision',row_value.task_revision,
    'originRunId',row_value.origin_run_id,'toolExecutionId',row_value.tool_execution_id,
    'workflowStepId',row_value.workflow_step_id,
    'details',row_value.details,'payload',row_value.payload,'status',row_value.status,
    'claimToken',row_value.claim_token,'result',row_value.result,
    'completionDone',row_value.completion_done,'confirmedAt',row_value.confirmed_at,
    'expiresAt',row_value.expires_at
  );
$$;

CREATE FUNCTION public.loomic_create_agent_action_confirmation(
  p_confirmation uuid,p_kind text,p_user uuid,p_workspace uuid,p_session uuid,p_canvas uuid,
  p_task uuid,p_task_revision bigint,p_origin_run uuid,p_tool_execution uuid,p_workflow_step text,
  p_details jsonb,p_payload jsonb,p_expires_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task public.agent_design_tasks; row_value public.agent_action_confirmations;
BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF p_kind<>'design_mutation' OR p_expires_at<=now()
    OR p_details IS NULL OR jsonb_typeof(p_details)<>'object' OR octet_length(p_details::text)>10000
    OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>80000
    OR (p_workflow_step IS NOT NULL AND p_workflow_step !~ '^[a-z][a-z0-9_-]{0,63}$')
  THEN RAISE EXCEPTION 'agent_confirmation_invalid'; END IF;
  SELECT * INTO task FROM public.agent_design_tasks WHERE id=p_task FOR UPDATE;
  IF NOT FOUND OR task.created_by IS DISTINCT FROM p_user OR task.session_id IS DISTINCT FROM p_session
    OR task.canvas_id IS DISTINCT FROM p_canvas OR task.current_run_id IS DISTINCT FROM p_origin_run
    OR task.revision IS DISTINCT FROM p_task_revision
    OR task.target->>'kind'<>'design' OR task.target->>'designId' IS DISTINCT FROM p_payload->>'design_id'
    OR NOT EXISTS(SELECT 1 FROM public.tool_executions e WHERE e.id=p_tool_execution
      AND e.run_id=p_origin_run AND e.requested_by=p_user AND e.tool_name='manipulate_design'
      AND e.status IN ('running','completed'))
    OR NOT EXISTS(SELECT 1 FROM public.canvases c JOIN public.projects pr ON pr.id=c.project_id
      WHERE c.id=p_canvas AND pr.workspace_id=p_workspace)
  THEN RAISE EXCEPTION 'agent_confirmation_scope_mismatch'; END IF;
  INSERT INTO public.agent_action_confirmations(
    confirmation_id,kind,user_id,workspace_id,session_id,canvas_id,task_id,task_revision,
    origin_run_id,tool_execution_id,workflow_step_id,details,payload,expires_at
  ) VALUES(
    p_confirmation,p_kind,p_user,p_workspace,p_session,p_canvas,p_task,p_task_revision,
    p_origin_run,p_tool_execution,p_workflow_step,p_details,p_payload,p_expires_at
  ) RETURNING * INTO row_value;
  RETURN private.loomic_agent_action_confirmation_snapshot(row_value);
END $$;

CREATE FUNCTION public.loomic_claim_agent_action_confirmation(
  p_confirmation uuid,p_user uuid,p_canvas uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE row_value public.agent_action_confirmations; task public.agent_design_tasks; token uuid;
BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  SELECT * INTO row_value FROM public.agent_action_confirmations
    WHERE confirmation_id=p_confirmation FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','not_found'); END IF;
  IF row_value.user_id IS DISTINCT FROM p_user OR row_value.canvas_id IS DISTINCT FROM p_canvas
  THEN RAISE EXCEPTION 'confirmation_forbidden'; END IF;
  IF row_value.status='applied' THEN
    RETURN jsonb_build_object('state','applied','action',private.loomic_agent_action_confirmation_snapshot(row_value));
  END IF;
  IF row_value.status='canceled' THEN RETURN jsonb_build_object('state','canceled'); END IF;
  SELECT * INTO task FROM public.agent_design_tasks WHERE id=row_value.task_id FOR UPDATE;
  -- Expiry prevents a never-confirmed pending proposal from starting. Once a
  -- user has confirmed and a claim exists, a process crash must remain
  -- idempotently recoverable even if the UI TTL elapses meanwhile.
  IF row_value.status='pending' AND row_value.confirmed_at IS NULL AND row_value.expires_at<=now() THEN
    UPDATE public.agent_action_confirmations SET status='canceled',updated_at=now()
      WHERE confirmation_id=p_confirmation;
    RETURN jsonb_build_object('state','expired');
  END IF;
  IF NOT FOUND OR task.created_by IS DISTINCT FROM row_value.user_id
    OR task.session_id IS DISTINCT FROM row_value.session_id OR task.canvas_id IS DISTINCT FROM row_value.canvas_id
    OR task.current_run_id IS DISTINCT FROM row_value.origin_run_id OR task.revision IS DISTINCT FROM row_value.task_revision
  THEN
    UPDATE public.agent_action_confirmations SET status='canceled',updated_at=now()
      WHERE confirmation_id=p_confirmation;
    RETURN jsonb_build_object('state','stale');
  END IF;
  IF row_value.status='executing' AND row_value.claimed_at>=now()-interval '3 minutes'
  THEN RETURN jsonb_build_object('state','executing'); END IF;
  token:=extensions.gen_random_uuid();
  UPDATE public.agent_action_confirmations SET status='executing',claim_token=token,claimed_at=now(),
    confirmed_at=COALESCE(confirmed_at,now()),updated_at=now()
    WHERE confirmation_id=p_confirmation RETURNING * INTO row_value;
  RETURN jsonb_build_object('state','claimed','action',private.loomic_agent_action_confirmation_snapshot(row_value));
END $$;

CREATE FUNCTION public.loomic_list_agent_action_confirmation_recovery(
  p_user uuid,p_session uuid,p_limit integer DEFAULT 10
) RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF p_limit IS NULL OR p_limit<1 OR p_limit>10
  THEN RAISE EXCEPTION 'agent_confirmation_recovery_limit_invalid'; END IF;
  RETURN QUERY
  SELECT private.loomic_agent_action_confirmation_snapshot(c)
  FROM public.agent_action_confirmations c
  JOIN public.agent_design_tasks task ON task.id=c.task_id
  WHERE c.user_id=p_user AND c.session_id=p_session
    AND task.created_by=c.user_id AND task.session_id=c.session_id AND task.canvas_id=c.canvas_id
    AND task.current_run_id=c.origin_run_id AND task.revision=c.task_revision
    AND (
      (c.status='applied' AND c.completion_done=false)
      OR (c.status='executing' AND c.claimed_at<now()-interval '3 minutes')
      OR (c.status='pending' AND c.confirmed_at IS NOT NULL)
    )
  ORDER BY CASE WHEN c.status='applied' THEN 0 ELSE 1 END,c.updated_at,c.confirmation_id
  LIMIT p_limit;
END $$;

CREATE FUNCTION public.loomic_finish_agent_action_confirmation(
  p_confirmation uuid,p_token uuid,p_result jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF p_result IS NULL OR jsonb_typeof(p_result)<>'object' OR octet_length(p_result::text)>30000
  THEN RAISE EXCEPTION 'agent_confirmation_result_invalid'; END IF;
  UPDATE public.agent_action_confirmations SET status='applied',result=p_result,updated_at=now()
    WHERE confirmation_id=p_confirmation AND status='executing' AND claim_token=p_token;
  RETURN FOUND;
END $$;

CREATE FUNCTION public.loomic_release_agent_action_confirmation(
  p_confirmation uuid,p_token uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  UPDATE public.agent_action_confirmations
    SET status='pending',claim_token=NULL,claimed_at=NULL,updated_at=now()
    WHERE confirmation_id=p_confirmation AND status='executing' AND claim_token=p_token;
  RETURN FOUND;
END $$;

CREATE FUNCTION public.loomic_complete_agent_action_confirmation(
  p_confirmation uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  UPDATE public.agent_action_confirmations SET completion_done=true,updated_at=now()
    WHERE confirmation_id=p_confirmation AND status='applied';
  RETURN FOUND;
END $$;

CREATE FUNCTION public.loomic_cancel_agent_action_confirmation(
  p_confirmation uuid,p_user uuid,p_canvas uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  UPDATE public.agent_action_confirmations SET status='canceled',updated_at=now()
    WHERE confirmation_id=p_confirmation AND user_id=p_user AND canvas_id=p_canvas
      AND status='pending' AND confirmed_at IS NULL;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION private.loomic_agent_action_confirmation_snapshot(public.agent_action_confirmations),
  public.loomic_create_agent_action_confirmation(uuid,text,uuid,uuid,uuid,uuid,uuid,bigint,uuid,uuid,text,jsonb,jsonb,timestamptz),
  public.loomic_claim_agent_action_confirmation(uuid,uuid,uuid),
  public.loomic_list_agent_action_confirmation_recovery(uuid,uuid,integer),
  public.loomic_finish_agent_action_confirmation(uuid,uuid,jsonb),
  public.loomic_release_agent_action_confirmation(uuid,uuid),
  public.loomic_complete_agent_action_confirmation(uuid),
  public.loomic_cancel_agent_action_confirmation(uuid,uuid,uuid)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION
  public.loomic_create_agent_action_confirmation(uuid,text,uuid,uuid,uuid,uuid,uuid,bigint,uuid,uuid,text,jsonb,jsonb,timestamptz),
  public.loomic_claim_agent_action_confirmation(uuid,uuid,uuid),
  public.loomic_list_agent_action_confirmation_recovery(uuid,uuid,integer),
  public.loomic_finish_agent_action_confirmation(uuid,uuid,jsonb),
  public.loomic_release_agent_action_confirmation(uuid,uuid),
  public.loomic_complete_agent_action_confirmation(uuid),
  public.loomic_cancel_agent_action_confirmation(uuid,uuid,uuid)
TO service_role;
NOTIFY pgrst,'reload schema';
