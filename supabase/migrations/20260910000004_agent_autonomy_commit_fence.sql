-- Bind each automatic side effect to the exact lease that authorized it.
-- Final write triggers retain the same task/grant locks as stop until commit.
CREATE TABLE public.agent_autonomy_tool_leases (
 tool_execution_id uuid PRIMARY KEY REFERENCES public.tool_executions(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES public.agent_task_autonomy(session_id) ON DELETE CASCADE,
 created_by uuid NOT NULL REFERENCES auth.users(id), claim_token uuid NOT NULL
);
CREATE TABLE public.agent_autonomy_image_leases (
 proposal_id uuid PRIMARY KEY REFERENCES public.image_generation_proposals(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES public.agent_task_autonomy(session_id) ON DELETE CASCADE,
 created_by uuid NOT NULL REFERENCES auth.users(id), claim_token uuid NOT NULL
);
ALTER TABLE public.agent_autonomy_tool_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_autonomy_tool_leases FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_autonomy_image_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_autonomy_image_leases FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_autonomy_tool_leases,public.agent_autonomy_image_leases FROM PUBLIC,anon,authenticated;

CREATE FUNCTION private.loomic_assert_autonomy_commit(p_user uuid,p_session uuid,p_token uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF public.loomic_agent_autonomy('active',p_user,p_session,jsonb_build_object('token',p_token)) IS NULL
 THEN RAISE EXCEPTION 'autonomy_authorization_expired'; END IF;
END $$;

CREATE FUNCTION public.loomic_autonomy_start_tool(
 p_user uuid,p_session uuid,p_token uuid,p_execution uuid,p_name text,p_input jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE grant_row public.agent_task_autonomy; execution public.tool_executions; BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
 PERFORM private.loomic_assert_autonomy_commit(p_user,p_session,p_token);
 SELECT * INTO grant_row FROM public.agent_task_autonomy WHERE session_id=p_session;
 IF p_execution IS NULL OR p_name IS NULL OR char_length(p_name) NOT BETWEEN 1 AND 200
   OR (p_input IS NOT NULL AND (jsonb_typeof(p_input)<>'object' OR octet_length(p_input::text)>100000))
 THEN RAISE EXCEPTION 'autonomy_tool_invalid'; END IF;
 INSERT INTO public.tool_executions(id,run_id,requested_by,tool_call_id,tool_name,status,input,retryable)
 VALUES(p_execution,grant_row.origin_run_id,p_user,p_execution::text,p_name,'running',p_input,false)
 ON CONFLICT(id) DO NOTHING;
 SELECT * INTO execution FROM public.tool_executions WHERE id=p_execution;
 IF execution.run_id IS DISTINCT FROM grant_row.origin_run_id OR execution.requested_by IS DISTINCT FROM p_user
   OR execution.tool_name IS DISTINCT FROM p_name OR execution.input IS DISTINCT FROM p_input
 THEN RAISE EXCEPTION 'autonomy_tool_binding_conflict'; END IF;
 INSERT INTO public.agent_autonomy_tool_leases(tool_execution_id,session_id,created_by,claim_token)
 VALUES(p_execution,p_session,p_user,p_token) ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM public.agent_autonomy_tool_leases WHERE tool_execution_id=p_execution
   AND session_id=p_session AND created_by=p_user AND claim_token=p_token)
 THEN RAISE EXCEPTION 'autonomy_tool_binding_conflict'; END IF;
 RETURN jsonb_build_object('id',p_execution);
END $$;

CREATE FUNCTION public.loomic_autonomy_reserve_image(p_user uuid,p_session uuid,p_token uuid,p_proposal uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
 IF public.loomic_agent_autonomy('image',p_user,p_session,
   jsonb_build_object('token',p_token,'proposalId',p_proposal)) IS NULL
 THEN RAISE EXCEPTION 'autonomy_authorization_expired'; END IF;
 INSERT INTO public.agent_autonomy_image_leases(proposal_id,session_id,created_by,claim_token)
 VALUES(p_proposal,p_session,p_user,p_token)
 ON CONFLICT(proposal_id) DO UPDATE SET claim_token=excluded.claim_token
 WHERE agent_autonomy_image_leases.session_id=excluded.session_id AND agent_autonomy_image_leases.created_by=excluded.created_by;
 IF NOT FOUND THEN RAISE EXCEPTION 'autonomy_proposal_out_of_scope'; END IF;
END $$;

CREATE FUNCTION private.loomic_guard_autonomy_design_commit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE binding public.agent_autonomy_tool_leases; BEGIN
 IF NEW.actor_kind<>'agent' THEN RETURN NEW; END IF;
 SELECT * INTO binding FROM public.agent_autonomy_tool_leases WHERE tool_execution_id=NEW.tool_execution_id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 -- A later explicit product confirmation is independent user authority. The
 -- existing task/target fences still run, and the frozen commands must match.
 IF EXISTS(SELECT 1 FROM public.design_agent_tool_requests request
   JOIN public.agent_action_confirmations confirmation ON confirmation.confirmation_id=request.confirmation_id
   WHERE request.tool_execution_id=NEW.tool_execution_id AND request.destructive_confirmed
     AND confirmation.tool_execution_id=NEW.tool_execution_id AND confirmation.origin_run_id=NEW.agent_run_id
     AND confirmation.user_id=NEW.actor_user_id AND confirmation.confirmed_at IS NOT NULL
     AND confirmation.status IN ('executing','applied')
     AND confirmation.payload->>'design_id'=NEW.design_id::text
     AND confirmation.payload->>'idempotency_key'=NEW.idempotency_key::text
     AND confirmation.payload->'commands'=NEW.command_batch)
 THEN RETURN NEW; END IF;
 PERFORM private.loomic_assert_autonomy_commit(binding.created_by,binding.session_id,binding.claim_token);
 RETURN NEW;
END $$;
CREATE TRIGGER agent_autonomy_design_commit BEFORE INSERT ON public.design_document_versions
 FOR EACH ROW EXECUTE FUNCTION private.loomic_guard_autonomy_design_commit();

CREATE FUNCTION private.loomic_guard_autonomy_image_commit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE binding public.agent_autonomy_image_leases; BEGIN
 -- Already queued requests can finish and refund independently of the lease.
 -- For new submissions, even this final UPDATE rolls back the entire billing
 -- and PGMQ transaction if stop won the task/grant lock first.
 IF TG_OP='UPDATE' THEN
   IF OLD.image_enqueued_at IS NOT NULL OR (NEW.credits_cost IS NOT DISTINCT FROM OLD.credits_cost
     AND NEW.image_enqueued_at IS NOT DISTINCT FROM OLD.image_enqueued_at) THEN RETURN NEW; END IF;
 END IF;
 SELECT * INTO binding FROM public.agent_autonomy_image_leases WHERE proposal_id=NEW.id;
 IF FOUND THEN PERFORM private.loomic_assert_autonomy_commit(binding.created_by,binding.session_id,binding.claim_token); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_autonomy_image_commit BEFORE INSERT OR UPDATE ON public.background_jobs
 FOR EACH ROW EXECUTE FUNCTION private.loomic_guard_autonomy_image_commit();

-- Automatic tools retain the canonical intent run, which has completed before
-- a scheduler can claim. Only an exact server-issued tool lease may use that
-- completed origin for a new ordinary mutation; no general status relaxation.
CREATE OR REPLACE FUNCTION private.loomic_agent_design_context_workspace(
 p_agent_run_id uuid,p_tool_execution_id uuid,p_actor_user_id uuid,p_tool_name text,p_allow_completed boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE workspace_id_value uuid; binding public.agent_autonomy_tool_leases; BEGIN
 SELECT * INTO binding FROM public.agent_autonomy_tool_leases WHERE tool_execution_id=p_tool_execution_id;
 IF FOUND AND NOT p_allow_completed THEN
   PERFORM private.loomic_assert_autonomy_commit(binding.created_by,binding.session_id,binding.claim_token);
 END IF;
 SELECT canvas.workspace_id INTO workspace_id_value
 FROM public.tool_executions execution JOIN public.agent_runs run ON run.id=execution.run_id
 JOIN public.chat_sessions session ON session.id=run.session_id JOIN public.canvases canvas ON canvas.id=session.canvas_id
 WHERE execution.id=p_tool_execution_id AND execution.run_id=p_agent_run_id
   AND execution.requested_by=p_actor_user_id AND execution.tool_name=p_tool_name
   AND (execution.status='running' OR (p_allow_completed AND execution.status='completed'))
   AND run.created_by=p_actor_user_id
   AND (run.status='running' OR (run.status='completed' AND (p_allow_completed OR
     (binding.tool_execution_id IS NOT NULL AND binding.created_by=p_actor_user_id AND binding.session_id=run.session_id))));
 IF workspace_id_value IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='agent_design_execution_invalid'; END IF;
 RETURN workspace_id_value;
END $$;

REVOKE ALL ON FUNCTION private.loomic_assert_autonomy_commit(uuid,uuid,uuid),
 private.loomic_guard_autonomy_design_commit(),private.loomic_guard_autonomy_image_commit(),
 public.loomic_autonomy_start_tool(uuid,uuid,uuid,uuid,text,jsonb),
 public.loomic_autonomy_reserve_image(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_autonomy_start_tool(uuid,uuid,uuid,uuid,text,jsonb),
 public.loomic_autonomy_reserve_image(uuid,uuid,uuid,uuid) TO service_role;
-- Existing audited context functions may be owned by the migration postgres
-- role while this migration is installed by supabase_admin.
GRANT EXECUTE ON FUNCTION private.loomic_assert_autonomy_commit(uuid,uuid,uuid) TO postgres;
NOTIFY pgrst,'reload schema';
