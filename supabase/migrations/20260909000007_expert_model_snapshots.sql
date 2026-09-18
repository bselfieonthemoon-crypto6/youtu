-- Every independently configured expert gets its own immutable provider snapshot.
-- Never reuse/overwrite the parent run's snapshot or expose keys to users/tools.
CREATE TABLE public.agent_expert_model_snapshots (
  delegation_id uuid PRIMARY KEY REFERENCES public.agent_delegations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  provider_config_id uuid NOT NULL,
  provider_revision bigint NOT NULL CHECK (provider_revision > 0),
  catalog_key uuid NOT NULL,
  base_url text NOT NULL,
  upstream_model_id text NOT NULL,
  capabilities jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.agent_expert_model_credentials (
  delegation_id uuid PRIMARY KEY REFERENCES public.agent_expert_model_snapshots(delegation_id) ON DELETE CASCADE,
  api_key_secret_id uuid NOT NULL UNIQUE
);
ALTER TABLE public.agent_expert_model_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_expert_model_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_expert_model_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_expert_model_credentials FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_expert_model_snapshots, public.agent_expert_model_credentials FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.agent_expert_model_snapshots, public.agent_expert_model_credentials TO service_role;
CREATE TRIGGER expert_model_snapshot_immutable BEFORE UPDATE ON public.agent_expert_model_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.loomic_provider_snapshot_forbid_update();
CREATE TRIGGER expert_model_credential_cleanup BEFORE DELETE ON public.agent_expert_model_credentials
  FOR EACH ROW EXECUTE FUNCTION public.loomic_provider_snapshot_cleanup_secret();

CREATE FUNCTION public.loomic_expert_model_snapshot_resolve(
  p_delegation uuid, p_run uuid, p_workspace uuid, p_role text, p_catalog_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  d public.agent_delegations; t public.agent_design_tasks;
  s public.agent_expert_model_snapshots;
  m public.workspace_provider_models; c public.workspace_provider_configs;
  key_value text; copied_secret uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  SELECT task.* INTO t FROM public.agent_design_tasks task
    JOIN public.agent_delegations delegation ON delegation.task_id=task.id
    WHERE delegation.id=p_delegation FOR UPDATE OF task;
  SELECT * INTO d FROM public.agent_delegations WHERE id=p_delegation FOR UPDATE;
  IF d.id IS NULL OR d.run_id IS DISTINCT FROM p_run OR d.role IS DISTINCT FROM p_role
    OR d.model_ref IS DISTINCT FROM 'workspace:'||p_catalog_key::text OR d.status <> 'running'
    OR t.current_run_id IS DISTINCT FROM p_run OR t.revision IS DISTINCT FROM d.task_revision
    OR NOT EXISTS (
      SELECT 1 FROM public.agent_runs r
      JOIN public.chat_sessions cs ON cs.id=r.session_id
      JOIN public.canvases canvas ON canvas.id=cs.canvas_id
      JOIN public.projects project ON project.id=canvas.project_id
      JOIN public.workspace_members member ON member.workspace_id=project.workspace_id AND member.user_id=d.created_by
      WHERE r.id=p_run AND r.status IN ('accepted','running') AND project.workspace_id=p_workspace
    ) THEN RAISE EXCEPTION 'expert_model_target_invalid'; END IF;

  SELECT * INTO s FROM public.agent_expert_model_snapshots WHERE delegation_id=p_delegation;
  IF s.delegation_id IS NOT NULL THEN
    IF s.workspace_id IS DISTINCT FROM p_workspace OR s.catalog_key IS DISTINCT FROM p_catalog_key THEN
      RAISE EXCEPTION 'expert_model_snapshot_conflict';
    END IF;
  ELSE
    SELECT model.* INTO m FROM public.workspace_provider_models model
      JOIN public.workspace_provider_configs config ON config.id=model.provider_config_id
      WHERE model.catalog_key=p_catalog_key AND config.workspace_id=p_workspace
        AND model.enabled AND model.modality='text' AND model.capabilities ? 'text'
      FOR SHARE OF model;
    IF m.id IS NULL THEN RAISE EXCEPTION 'expert_model_not_accessible'; END IF;
    SELECT * INTO c FROM public.workspace_provider_configs WHERE id=m.provider_config_id
      AND workspace_id=p_workspace AND enabled AND last_test_status='succeeded' FOR SHARE;
    IF c.id IS NULL THEN RAISE EXCEPTION 'expert_model_not_accessible'; END IF;
    SELECT decrypted_secret INTO key_value FROM vault.decrypted_secrets WHERE id=c.api_key_secret_id;
    IF key_value IS NULL OR key_value='' THEN RAISE EXCEPTION 'expert_model_secret_unavailable'; END IF;
    SELECT vault.create_secret(key_value,'loomic-expert-'||p_delegation::text,'Ephemeral read-only expert credential') INTO copied_secret;
    INSERT INTO public.agent_expert_model_snapshots(delegation_id,workspace_id,provider_config_id,provider_revision,catalog_key,base_url,upstream_model_id,capabilities)
      VALUES(p_delegation,p_workspace,c.id,c.revision,m.catalog_key,c.base_url,m.upstream_model_id,m.capabilities) RETURNING * INTO s;
    INSERT INTO public.agent_expert_model_credentials(delegation_id,api_key_secret_id) VALUES(p_delegation,copied_secret);
  END IF;
  SELECT secret.decrypted_secret INTO key_value FROM public.agent_expert_model_credentials credential
    JOIN vault.decrypted_secrets secret ON secret.id=credential.api_key_secret_id
    WHERE credential.delegation_id=p_delegation;
  IF key_value IS NULL OR key_value='' THEN RAISE EXCEPTION 'expert_model_snapshot_released'; END IF;
  RETURN jsonb_build_object('modelRef','workspace:'||s.catalog_key::text,'upstreamModelId',s.upstream_model_id,
    'baseUrl',s.base_url,'apiKey',key_value,'providerRevision',s.provider_revision,'capabilities',s.capabilities);
END;
$$;

CREATE FUNCTION private.loomic_expert_model_release_on_terminal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status <> 'running' THEN
    DELETE FROM public.agent_expert_model_credentials WHERE delegation_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER expert_model_release_terminal AFTER UPDATE OF status ON public.agent_delegations
  FOR EACH ROW EXECUTE FUNCTION private.loomic_expert_model_release_on_terminal();
REVOKE ALL ON FUNCTION private.loomic_expert_model_release_on_terminal() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loomic_expert_model_snapshot_resolve(uuid,uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_expert_model_snapshot_resolve(uuid,uuid,uuid,text,uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
