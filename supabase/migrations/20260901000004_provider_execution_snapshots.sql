-- Immutable, execution-specific provider snapshots.
-- Public clients only know workspace:<catalog_key>. Provider config ids,
-- revisions, Vault ids, and decrypted keys stay behind service-role RPCs.

ALTER TABLE public.workspace_provider_models
  ADD COLUMN catalog_key uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE public.workspace_provider_models
  ADD CONSTRAINT workspace_provider_models_catalog_key_key UNIQUE (catalog_key);

CREATE TABLE public.provider_execution_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  provider_config_id uuid NOT NULL,
  provider_revision bigint NOT NULL CHECK (provider_revision > 0),
  catalog_key uuid NOT NULL,
  adapter text NOT NULL CHECK (adapter = 'openai_compatible'),
  base_url text NOT NULL CHECK (char_length(base_url) BETWEEN 1 AND 500),
  upstream_model_id text NOT NULL CHECK (char_length(btrim(upstream_model_id)) BETWEEN 1 AND 200),
  modality text NOT NULL CHECK (modality IN ('text', 'image', 'video')),
  capabilities jsonb NOT NULL CHECK (
    jsonb_typeof(capabilities) = 'array'
    AND capabilities <@ '["text", "vision_input", "image_generation", "video_generation"]'::jsonb
  ),
  billing_credits_cost integer CHECK (billing_credits_cost IS NULL OR billing_credits_cost >= 0),
  billing_pricing_version text CHECK (
    billing_pricing_version IS NULL OR char_length(billing_pricing_version) BETWEEN 1 AND 100
  ),
  billing_unit text CHECK (
    billing_unit IS NULL OR billing_unit IN ('request', 'image', 'second', 'token', 'unknown')
  ),
  agent_run_id uuid REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  background_job_id uuid REFERENCES public.background_jobs(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (agent_run_id IS NOT NULL AND background_job_id IS NULL)
    OR (agent_run_id IS NULL AND background_job_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX provider_execution_snapshots_agent_run_key
  ON public.provider_execution_snapshots(agent_run_id)
  WHERE agent_run_id IS NOT NULL;

CREATE UNIQUE INDEX provider_execution_snapshots_background_job_key
  ON public.provider_execution_snapshots(background_job_id)
  WHERE background_job_id IS NOT NULL;

CREATE INDEX provider_execution_snapshots_workspace_created_idx
  ON public.provider_execution_snapshots(workspace_id, created_at DESC);

-- Vault ids are deliberately separated from the immutable safe snapshot.
CREATE TABLE public.provider_execution_credentials (
  snapshot_id uuid PRIMARY KEY
    REFERENCES public.provider_execution_snapshots(id) ON DELETE CASCADE,
  api_key_secret_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.provider_execution_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_execution_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE public.provider_execution_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_execution_credentials FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.provider_execution_snapshots FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.provider_execution_credentials FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.provider_execution_snapshots TO service_role;
GRANT SELECT, INSERT, DELETE ON public.provider_execution_credentials TO service_role;

CREATE OR REPLACE FUNCTION public.loomic_provider_snapshot_forbid_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_snapshot_immutable';
END;
$$;

CREATE TRIGGER provider_execution_snapshots_immutable
  BEFORE UPDATE ON public.provider_execution_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.loomic_provider_snapshot_forbid_update();

CREATE OR REPLACE FUNCTION public.loomic_provider_snapshot_cleanup_secret()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM vault.secrets WHERE id = OLD.api_key_secret_id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER provider_execution_credentials_cleanup_secret
  BEFORE DELETE ON public.provider_execution_credentials
  FOR EACH ROW EXECUTE FUNCTION public.loomic_provider_snapshot_cleanup_secret();

-- Create and bind a snapshot in one transaction. The caller supplies only the
-- opaque catalog key, never a config id, revision, upstream id, or secret id.
CREATE OR REPLACE FUNCTION public.loomic_provider_snapshot_create(
  p_workspace_id uuid,
  p_catalog_key uuid,
  p_agent_run_id uuid DEFAULT NULL,
  p_background_job_id uuid DEFAULT NULL,
  p_billing_credits_cost integer DEFAULT NULL,
  p_billing_pricing_version text DEFAULT NULL,
  p_billing_unit text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  snapshot_id uuid := gen_random_uuid();
  copied_secret_id uuid;
  decrypted_key text;
  target_workspace_id uuid;
  target_job_type text;
  config_row public.workspace_provider_configs%ROWTYPE;
  model_row public.workspace_provider_models%ROWTYPE;
BEGIN
  IF (p_agent_run_id IS NULL) = (p_background_job_id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'provider_snapshot_invalid_target';
  END IF;

  IF p_agent_run_id IS NOT NULL THEN
    SELECT p.workspace_id INTO target_workspace_id
    FROM public.agent_runs ar
    JOIN public.chat_sessions cs ON cs.id = ar.session_id
    JOIN public.canvases c ON c.id = cs.canvas_id
    JOIN public.projects p ON p.id = c.project_id
    WHERE ar.id = p_agent_run_id;
  ELSE
    SELECT workspace_id, job_type::text INTO target_workspace_id, target_job_type
    FROM public.background_jobs
    WHERE id = p_background_job_id;
  END IF;

  IF target_workspace_id IS NULL OR target_workspace_id IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'provider_snapshot_target_not_found';
  END IF;

  SELECT m.* INTO model_row
  FROM public.workspace_provider_models m
  JOIN public.workspace_provider_configs c ON c.id = m.provider_config_id
  WHERE m.catalog_key = p_catalog_key
    AND c.workspace_id = p_workspace_id
    AND c.enabled = true
    AND m.enabled = true
  FOR SHARE OF m;

  IF model_row.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'provider_snapshot_model_not_found';
  END IF;

  SELECT * INTO config_row
  FROM public.workspace_provider_configs
  WHERE id = model_row.provider_config_id
    AND workspace_id = p_workspace_id
    AND enabled = true
  FOR SHARE;

  IF config_row.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'provider_snapshot_model_not_found';
  END IF;
  IF config_row.last_test_status <> 'succeeded' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_snapshot_config_not_verified';
  END IF;

  IF p_agent_run_id IS NOT NULL AND (
    model_row.modality <> 'text'
    OR NOT (model_row.capabilities ? 'text')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'provider_snapshot_modality_mismatch';
  END IF;
  IF p_background_job_id IS NOT NULL AND (
    target_job_type NOT IN ('image_generation', 'video_generation')
    OR (target_job_type = 'image_generation' AND (
      model_row.modality <> 'image'
      OR NOT (model_row.capabilities ? 'image_generation')
    ))
    OR (target_job_type = 'video_generation' AND (
      model_row.modality <> 'video'
      OR NOT (model_row.capabilities ? 'video_generation')
    ))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'provider_snapshot_modality_mismatch';
  END IF;

  SELECT decrypted_secret INTO decrypted_key
  FROM vault.decrypted_secrets
  WHERE id = config_row.api_key_secret_id;

  IF decrypted_key IS NULL OR decrypted_key = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'provider_snapshot_secret_unavailable';
  END IF;

  SELECT vault.create_secret(
    decrypted_key,
    'loomic-provider-snapshot-' || snapshot_id::text,
    'Ephemeral execution credential snapshot'
  ) INTO copied_secret_id;

  INSERT INTO public.provider_execution_snapshots (
    id, workspace_id, provider_config_id, provider_revision, catalog_key,
    adapter, base_url, upstream_model_id, modality, capabilities,
    billing_credits_cost, billing_pricing_version, billing_unit,
    agent_run_id, background_job_id
  ) VALUES (
    snapshot_id, p_workspace_id, config_row.id, config_row.revision, model_row.catalog_key,
    config_row.adapter, config_row.base_url, model_row.upstream_model_id,
    model_row.modality, model_row.capabilities,
    p_billing_credits_cost, p_billing_pricing_version, p_billing_unit,
    p_agent_run_id, p_background_job_id
  );

  INSERT INTO public.provider_execution_credentials (snapshot_id, api_key_secret_id)
  VALUES (snapshot_id, copied_secret_id);

  RETURN snapshot_id;
END;
$$;

-- Resolve by workspace and exact target. Current provider config state is not
-- consulted: a queued execution keeps its copied credential across rotation or
-- config deletion. Missing/released snapshots fail closed in the service.
CREATE OR REPLACE FUNCTION public.loomic_provider_job_snapshot_resolve(
  p_workspace_id uuid,
  p_background_job_id uuid
) RETURNS TABLE (
  snapshot_id uuid,
  provider_config_id uuid,
  provider_revision bigint,
  catalog_key uuid,
  adapter text,
  base_url text,
  upstream_model_id text,
  modality text,
  capabilities jsonb,
  billing_credits_cost integer,
  billing_pricing_version text,
  billing_unit text,
  api_key text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT s.id, s.provider_config_id, s.provider_revision, s.catalog_key,
    s.adapter, s.base_url, s.upstream_model_id, s.modality, s.capabilities,
    s.billing_credits_cost, s.billing_pricing_version, s.billing_unit,
    d.decrypted_secret
  FROM public.provider_execution_snapshots s
  JOIN public.provider_execution_credentials ec ON ec.snapshot_id = s.id
  JOIN vault.decrypted_secrets d ON d.id = ec.api_key_secret_id
  WHERE s.workspace_id = p_workspace_id
    AND s.background_job_id = p_background_job_id
$$;

CREATE OR REPLACE FUNCTION public.loomic_provider_run_snapshot_resolve(
  p_workspace_id uuid,
  p_agent_run_id uuid
) RETURNS TABLE (
  snapshot_id uuid,
  provider_config_id uuid,
  provider_revision bigint,
  catalog_key uuid,
  adapter text,
  base_url text,
  upstream_model_id text,
  modality text,
  capabilities jsonb,
  billing_credits_cost integer,
  billing_pricing_version text,
  billing_unit text,
  api_key text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT s.id, s.provider_config_id, s.provider_revision, s.catalog_key,
    s.adapter, s.base_url, s.upstream_model_id, s.modality, s.capabilities,
    s.billing_credits_cost, s.billing_pricing_version, s.billing_unit,
    d.decrypted_secret
  FROM public.provider_execution_snapshots s
  JOIN public.provider_execution_credentials ec ON ec.snapshot_id = s.id
  JOIN vault.decrypted_secrets d ON d.id = ec.api_key_secret_id
  WHERE s.workspace_id = p_workspace_id
    AND s.agent_run_id = p_agent_run_id
$$;

CREATE OR REPLACE FUNCTION public.loomic_provider_snapshot_release(
  p_workspace_id uuid,
  p_snapshot_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  snapshot_row public.provider_execution_snapshots%ROWTYPE;
  target_status text;
BEGIN
  SELECT * INTO snapshot_row
  FROM public.provider_execution_snapshots
  WHERE id = p_snapshot_id AND workspace_id = p_workspace_id
  FOR SHARE;

  IF snapshot_row.id IS NULL THEN RETURN false; END IF;

  IF snapshot_row.background_job_id IS NOT NULL THEN
    SELECT CASE
      WHEN status::text = 'failed' AND attempt_count < max_attempts THEN 'retryable_failed'
      ELSE status::text
    END INTO target_status
    FROM public.background_jobs WHERE id = snapshot_row.background_job_id;
    IF target_status IS NULL OR target_status NOT IN ('succeeded', 'failed', 'canceled', 'dead_letter') THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_snapshot_target_not_terminal';
    END IF;
  ELSE
    SELECT status INTO target_status
    FROM public.agent_runs WHERE id = snapshot_row.agent_run_id;
    IF target_status IS NULL OR target_status NOT IN ('completed', 'failed', 'canceled') THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_snapshot_target_not_terminal';
    END IF;
  END IF;

  DELETE FROM public.provider_execution_credentials WHERE snapshot_id = p_snapshot_id;
  RETURN FOUND;
END;
$$;

-- Always destroy the ephemeral Vault copy when the target becomes terminal.
-- A failed job remains retryable until its attempt budget is exhausted.
CREATE OR REPLACE FUNCTION public.loomic_provider_snapshot_release_on_job_terminal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status::text IN ('succeeded', 'canceled', 'dead_letter')
    OR (NEW.status::text = 'failed' AND NEW.attempt_count >= NEW.max_attempts)
  THEN
    DELETE FROM public.provider_execution_credentials ec
    USING public.provider_execution_snapshots s
    WHERE ec.snapshot_id = s.id AND s.background_job_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_snapshot_release_job_terminal
  AFTER UPDATE OF status, attempt_count, max_attempts ON public.background_jobs
  FOR EACH ROW EXECUTE FUNCTION public.loomic_provider_snapshot_release_on_job_terminal();

CREATE OR REPLACE FUNCTION public.loomic_provider_snapshot_release_on_run_terminal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status IN ('completed', 'failed', 'canceled') THEN
    DELETE FROM public.provider_execution_credentials ec
    USING public.provider_execution_snapshots s
    WHERE ec.snapshot_id = s.id AND s.agent_run_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_snapshot_release_run_terminal
  AFTER UPDATE OF status ON public.agent_runs
  FOR EACH ROW EXECUTE FUNCTION public.loomic_provider_snapshot_release_on_run_terminal();

-- Preserve public catalog keys while atomically replacing a config's model set.
CREATE OR REPLACE FUNCTION public.loomic_provider_config_update(
  p_workspace_id uuid,
  p_provider_config_id uuid,
  p_expected_revision bigint,
  p_display_name text,
  p_base_url text,
  p_enabled boolean,
  p_new_secret text DEFAULT NULL,
  p_new_secret_last_four text DEFAULT NULL,
  p_models jsonb DEFAULT NULL,
  p_actor_user_id uuid DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_row public.workspace_provider_configs%ROWTYPE;
  model_row jsonb;
BEGIN
  SELECT * INTO current_row FROM public.workspace_provider_configs
  WHERE id = p_provider_config_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF current_row.id IS NULL THEN RETURN 'not_found'; END IF;
  IF current_row.revision <> p_expected_revision THEN RETURN 'conflict'; END IF;

  IF p_new_secret IS NOT NULL THEN
    PERFORM vault.update_secret(current_row.api_key_secret_id, new_secret := p_new_secret);
  END IF;

  UPDATE public.workspace_provider_configs SET
    display_name = p_display_name,
    base_url = p_base_url,
    enabled = p_enabled,
    api_key_last_four = COALESCE(p_new_secret_last_four, api_key_last_four),
    revision = revision + 1,
    updated_by = p_actor_user_id,
    last_tested_at = CASE WHEN p_new_secret IS NOT NULL OR p_base_url IS DISTINCT FROM current_row.base_url THEN NULL ELSE last_tested_at END,
    last_test_status = CASE WHEN p_new_secret IS NOT NULL OR p_base_url IS DISTINCT FROM current_row.base_url THEN 'never' ELSE last_test_status END,
    last_test_error_code = CASE WHEN p_new_secret IS NOT NULL OR p_base_url IS DISTINCT FROM current_row.base_url THEN NULL ELSE last_test_error_code END
  WHERE id = p_provider_config_id;

  IF p_models IS NOT NULL THEN
    DELETE FROM public.workspace_provider_models existing
    WHERE existing.provider_config_id = p_provider_config_id
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_models) incoming
        WHERE incoming->>'upstreamModelId' = existing.upstream_model_id
          AND incoming->>'modality' = existing.modality
      );

    FOR model_row IN SELECT value FROM jsonb_array_elements(p_models)
    LOOP
      INSERT INTO public.workspace_provider_models (
        provider_config_id, upstream_model_id, display_name, modality, enabled, capabilities
      ) VALUES (
        p_provider_config_id, model_row->>'upstreamModelId', model_row->>'displayName',
        model_row->>'modality', COALESCE((model_row->>'enabled')::boolean, false),
        COALESCE(model_row->'capabilities', '[]'::jsonb)
      )
      ON CONFLICT (provider_config_id, upstream_model_id, modality) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        enabled = EXCLUDED.enabled,
        capabilities = EXCLUDED.capabilities;
    END LOOP;
  END IF;

  INSERT INTO public.workspace_provider_audit_events (
    workspace_id, provider_config_id, actor_user_id, action, safe_details
  ) VALUES (
    p_workspace_id, p_provider_config_id, p_actor_user_id, 'updated',
    jsonb_build_object(
      'baseUrlChanged', p_base_url IS DISTINCT FROM current_row.base_url,
      'enabled', p_enabled, 'modelsChanged', p_models IS NOT NULL
    )
  );
  IF p_new_secret IS NOT NULL THEN
    INSERT INTO public.workspace_provider_audit_events (
      workspace_id, provider_config_id, actor_user_id, action, safe_details
    ) VALUES (p_workspace_id, p_provider_config_id, p_actor_user_id, 'key_rotated', '{}'::jsonb);
  END IF;
  RETURN 'updated';
END;
$$;

REVOKE ALL ON FUNCTION public.loomic_provider_snapshot_forbid_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loomic_provider_snapshot_cleanup_secret() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loomic_provider_snapshot_create(uuid, uuid, uuid, uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loomic_provider_job_snapshot_resolve(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loomic_provider_run_snapshot_resolve(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loomic_provider_snapshot_release(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loomic_provider_snapshot_release_on_job_terminal() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loomic_provider_snapshot_release_on_run_terminal() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.loomic_provider_snapshot_create(uuid, uuid, uuid, uuid, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.loomic_provider_job_snapshot_resolve(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.loomic_provider_run_snapshot_resolve(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.loomic_provider_snapshot_release(uuid, uuid) TO service_role;
