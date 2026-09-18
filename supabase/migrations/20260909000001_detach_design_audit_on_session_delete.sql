-- Deleting a chat must not delete the designs it edited, or be blocked by the
-- retained design audit receipt. Keep original audit IDs for idempotent replay;
-- nullable live links describe whether the execution ledger still exists.
ALTER TABLE public.design_agent_tool_requests
  ADD COLUMN live_agent_run_id uuid,
  ADD COLUMN live_tool_execution_id uuid;
UPDATE public.design_agent_tool_requests
  SET live_agent_run_id=agent_run_id,live_tool_execution_id=tool_execution_id;
ALTER TABLE public.design_agent_tool_requests
  DROP CONSTRAINT design_agent_tool_requests_agent_run_id_fkey,
  DROP CONSTRAINT design_agent_tool_requests_tool_execution_id_fkey,
  ADD CONSTRAINT design_agent_tool_requests_live_agent_run_id_fkey
    FOREIGN KEY(live_agent_run_id) REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  ADD CONSTRAINT design_agent_tool_requests_live_tool_execution_id_fkey
    FOREIGN KEY(live_tool_execution_id) REFERENCES public.tool_executions(id) ON DELETE SET NULL;
CREATE INDEX design_agent_tool_requests_live_run_idx
  ON public.design_agent_tool_requests(live_agent_run_id) WHERE live_agent_run_id IS NOT NULL;
CREATE INDEX design_agent_tool_requests_live_tool_idx
  ON public.design_agent_tool_requests(live_tool_execution_id) WHERE live_tool_execution_id IS NOT NULL;
COMMENT ON COLUMN public.design_agent_tool_requests.agent_run_id IS
  'Immutable historical run identifier; live_agent_run_id is cleared when its chat session is deleted.';
COMMENT ON COLUMN public.design_agent_tool_requests.tool_execution_id IS
  'Immutable audit/idempotency key; live_tool_execution_id is cleared when its execution is deleted.';

-- A session removes runs and their tools together. Either SET NULL action may
-- execute first, so validate their final detached state at transaction end.
ALTER TABLE public.design_document_versions
  ALTER CONSTRAINT design_document_versions_agent_run_id_fkey DEFERRABLE INITIALLY DEFERRED,
  ALTER CONSTRAINT design_document_versions_tool_execution_id_fkey DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION private.loomic_bind_design_request_live_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    -- Callers cannot create a detached receipt for an execution that never existed.
    NEW.live_agent_run_id:=NEW.agent_run_id;
    NEW.live_tool_execution_id:=NEW.tool_execution_id;
  ELSIF NEW.agent_run_id IS DISTINCT FROM OLD.agent_run_id
    OR NEW.tool_execution_id IS DISTINCT FROM OLD.tool_execution_id
    OR (NEW.live_agent_run_id IS DISTINCT FROM OLD.live_agent_run_id AND NOT (
      NEW.live_agent_run_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.agent_runs r WHERE r.id=OLD.live_agent_run_id)))
    OR (NEW.live_tool_execution_id IS DISTINCT FROM OLD.live_tool_execution_id AND NOT (
      NEW.live_tool_execution_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.tool_executions e WHERE e.id=OLD.live_tool_execution_id)))
  THEN RAISE EXCEPTION 'agent_design_audit_identity_immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER design_agent_tool_requests_live_audit
  BEFORE INSERT OR UPDATE ON public.design_agent_tool_requests
  FOR EACH ROW EXECUTE FUNCTION private.loomic_bind_design_request_live_audit();
REVOKE ALL ON FUNCTION private.loomic_bind_design_request_live_audit() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.loomic_validate_agent_design_version()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE request_row public.design_agent_tool_requests%ROWTYPE; context_workspace_id uuid;
BEGIN
  -- Existing SET NULL foreign keys detach only their own links after a parent
  -- deletion. Preserve all scene, command, actor, revision and timestamp fields.
  -- Clearing a link while the parent still exists does not get this exception.
  IF TG_OP='UPDATE' AND OLD.actor_kind='agent'
    AND (to_jsonb(NEW)-'agent_run_id'-'tool_execution_id') IS NOT DISTINCT FROM
      (to_jsonb(OLD)-'agent_run_id'-'tool_execution_id')
    AND (NEW.agent_run_id IS NOT DISTINCT FROM OLD.agent_run_id OR (
      NEW.agent_run_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.agent_runs r WHERE r.id=OLD.agent_run_id)))
    AND (NEW.tool_execution_id IS NOT DISTINCT FROM OLD.tool_execution_id OR (
      NEW.tool_execution_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.tool_executions e WHERE e.id=OLD.tool_execution_id)))
  THEN RETURN NEW; END IF;
  IF NEW.actor_kind='agent' THEN
    IF NEW.actor_user_id IS NULL OR NEW.agent_run_id IS NULL OR NEW.tool_execution_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='agent_design_audit_required';
    END IF;
    SELECT * INTO request_row FROM public.design_agent_tool_requests request
      WHERE request.tool_execution_id=NEW.tool_execution_id AND request.agent_run_id=NEW.agent_run_id
        AND request.actor_user_id=NEW.actor_user_id AND request.design_id=NEW.design_id
        AND request.idempotency_key=NEW.idempotency_key;
    IF request_row.tool_execution_id IS NULL OR request_row.operation NOT IN ('manipulate_design','apply_design_template') THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='agent_design_audit_mismatch';
    END IF;
    context_workspace_id:=private.loomic_agent_design_context_workspace(NEW.agent_run_id,NEW.tool_execution_id,
      NEW.actor_user_id,request_row.operation,request_row.destructive_confirmed);
    IF context_workspace_id IS DISTINCT FROM NEW.workspace_id OR request_row.workspace_id IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='agent_design_workspace_mismatch';
    END IF;
  ELSIF NEW.agent_run_id IS NOT NULL OR NEW.tool_execution_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='non_agent_design_audit_invalid';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.loomic_validate_agent_design_version() FROM PUBLIC,anon,authenticated;
NOTIFY pgrst,'reload schema';
