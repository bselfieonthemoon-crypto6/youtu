-- agent_runs is a private execution ledger. A policy joining it as the user
-- sees zero rows, including the user's own records. Check it in a narrowly
-- scoped definer predicate while retaining current project/workspace access.
CREATE FUNCTION private.loomic_can_read_agent_delegation(p_run uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.agent_runs r
    JOIN public.chat_sessions s ON s.id=r.session_id
    JOIN public.canvases c ON c.id=s.canvas_id
    JOIN public.projects p ON p.id=c.project_id
    JOIN public.workspace_members m ON m.workspace_id=p.workspace_id AND m.user_id=auth.uid()
    WHERE r.id=p_run AND r.created_by=auth.uid() AND private.is_project_member(p.id)
  )
$$;
REVOKE ALL ON FUNCTION private.loomic_can_read_agent_delegation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.loomic_can_read_agent_delegation(uuid) TO authenticated, service_role;
DROP POLICY agent_delegations_read ON public.agent_delegations;
CREATE POLICY agent_delegations_read ON public.agent_delegations FOR SELECT TO authenticated
  USING (created_by=auth.uid() AND private.loomic_can_read_agent_delegation(run_id));

-- Disabling is always possible even if a saved role model was subsequently
-- unpublished. Retain the selection; re-enabling still requires valid models.
CREATE OR REPLACE FUNCTION public.loomic_validate_agent_role_models()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE ref text;
BEGIN
  IF NOT (NEW.agent_collaboration->>'enabled')::boolean THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.agent_collaboration IS NOT DISTINCT FROM OLD.agent_collaboration THEN RETURN NEW; END IF;
  FOR ref IN SELECT v FROM jsonb_each_text(NEW.agent_collaboration->'roleModels') AS entries(k,v) WHERE v IS NOT NULL LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.workspace_provider_models m JOIN public.workspace_provider_configs c ON c.id=m.provider_config_id
      WHERE m.catalog_key=substring(ref FROM 11)::uuid AND c.workspace_id=NEW.workspace_id
        AND c.enabled AND c.last_test_status='succeeded' AND m.enabled AND m.modality='text' AND m.capabilities ? 'text'
    ) THEN RAISE EXCEPTION 'settings_model_not_accessible' USING ERRCODE = '22023'; END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
NOTIFY pgrst, 'reload schema';
