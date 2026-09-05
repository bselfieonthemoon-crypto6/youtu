-- Server-only workspace provider configuration backed by Supabase Vault.
-- The first supported adapter is deliberately limited to OpenAI-compatible APIs.

CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

CREATE TABLE public.workspace_provider_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  adapter text NOT NULL DEFAULT 'openai_compatible'
    CHECK (adapter = 'openai_compatible'),
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 100),
  base_url text NOT NULL CHECK (char_length(base_url) BETWEEN 1 AND 500),
  enabled boolean NOT NULL DEFAULT true,
  api_key_secret_id uuid NOT NULL,
  api_key_last_four text NOT NULL CHECK (char_length(api_key_last_four) BETWEEN 1 AND 4),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_tested_at timestamptz,
  last_test_status text NOT NULL DEFAULT 'never'
    CHECK (last_test_status IN ('never', 'succeeded', 'failed')),
  last_test_error_code text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, display_name)
);

CREATE INDEX workspace_provider_configs_workspace_idx
  ON public.workspace_provider_configs(workspace_id, created_at);

CREATE TRIGGER workspace_provider_configs_updated_at
  BEFORE UPDATE ON public.workspace_provider_configs
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);

CREATE TABLE public.workspace_provider_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_config_id uuid NOT NULL
    REFERENCES public.workspace_provider_configs(id) ON DELETE CASCADE,
  upstream_model_id text NOT NULL
    CHECK (char_length(btrim(upstream_model_id)) BETWEEN 1 AND 200),
  display_name text NOT NULL
    CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 200),
  modality text NOT NULL CHECK (modality IN ('text', 'image', 'video')),
  enabled boolean NOT NULL DEFAULT true,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (
      jsonb_typeof(capabilities) = 'array'
      AND capabilities <@ '["text", "vision_input", "image_generation", "video_generation"]'::jsonb
    ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_config_id, upstream_model_id, modality)
);

CREATE INDEX workspace_provider_models_config_idx
  ON public.workspace_provider_models(provider_config_id, created_at);

CREATE TRIGGER workspace_provider_models_updated_at
  BEFORE UPDATE ON public.workspace_provider_models
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);

CREATE TABLE public.workspace_provider_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  provider_config_id uuid REFERENCES public.workspace_provider_configs(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN (
    'created', 'updated', 'key_rotated', 'deleted', 'test_succeeded', 'test_failed'
  )),
  request_id text,
  safe_details jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(safe_details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workspace_provider_audit_workspace_idx
  ON public.workspace_provider_audit_events(workspace_id, created_at DESC);

ALTER TABLE public.workspace_provider_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_provider_configs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_provider_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_provider_models FORCE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_provider_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_provider_audit_events FORCE ROW LEVEL SECURITY;

-- No client policies exist. All access is mediated by the authenticated server,
-- which verifies owner/admin membership before using its service-role client.
REVOKE ALL ON public.workspace_provider_configs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.workspace_provider_models FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.workspace_provider_audit_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_provider_configs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_provider_models TO service_role;
GRANT SELECT, INSERT ON public.workspace_provider_audit_events TO service_role;

-- Vault is not an exposed PostgREST schema. Narrow wrappers let only the
-- service role create, rotate, read, and clean up provider secrets.
CREATE OR REPLACE FUNCTION public.loomic_provider_secret_create(
  p_secret text,
  p_name text,
  p_description text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  result uuid;
BEGIN
  SELECT vault.create_secret(p_secret, p_name, p_description) INTO result;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_provider_secret_update(
  p_secret_id uuid,
  p_secret text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM vault.update_secret(p_secret_id, new_secret := p_secret);
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_provider_secret_read(
  p_secret_id uuid
) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT decrypted_secret
  FROM vault.decrypted_secrets
  WHERE id = p_secret_id
$$;

CREATE OR REPLACE FUNCTION public.loomic_provider_secret_delete(
  p_secret_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM vault.secrets WHERE id = p_secret_id;
END;
$$;

-- Configs may also disappear through workspace cascade deletion, bypassing the
-- explicit config-delete RPC. Always clean up the referenced Vault row at the
-- table boundary. The explicit RPC deletes it first; this second delete is an
-- intentional no-op in that path.
CREATE OR REPLACE FUNCTION public.loomic_provider_config_cleanup_secret()
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

CREATE TRIGGER workspace_provider_configs_cleanup_secret
  BEFORE DELETE ON public.workspace_provider_configs
  FOR EACH ROW EXECUTE FUNCTION public.loomic_provider_config_cleanup_secret();

-- Delete the Vault secret, append a non-secret audit record, and delete the
-- provider config in one database transaction. Any failure rolls everything back.
CREATE OR REPLACE FUNCTION public.loomic_provider_config_delete(
  p_workspace_id uuid,
  p_provider_config_id uuid,
  p_actor_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  secret_id uuid;
BEGIN
  SELECT api_key_secret_id INTO secret_id
  FROM public.workspace_provider_configs
  WHERE id = p_provider_config_id AND workspace_id = p_workspace_id
  FOR UPDATE;
  IF secret_id IS NULL THEN
    RETURN false;
  END IF;

  DELETE FROM vault.secrets WHERE id = secret_id;
  INSERT INTO public.workspace_provider_audit_events (
    workspace_id, provider_config_id, actor_user_id, action, safe_details
  ) VALUES (
    p_workspace_id, p_provider_config_id, p_actor_user_id, 'deleted', '{}'::jsonb
  );
  DELETE FROM public.workspace_provider_configs
  WHERE id = p_provider_config_id AND workspace_id = p_workspace_id;
  RETURN true;
END;
$$;

-- CAS-protected provider update. Vault rotation, model replacement, config
-- update, and audit append share one transaction, so conflicts cannot rotate
-- a key and failed model inserts cannot erase the previous model set.
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
  SELECT * INTO current_row
  FROM public.workspace_provider_configs
  WHERE id = p_provider_config_id AND workspace_id = p_workspace_id
  FOR UPDATE;
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
    last_tested_at = CASE
      WHEN p_new_secret IS NOT NULL OR p_base_url IS DISTINCT FROM current_row.base_url THEN NULL
      ELSE last_tested_at END,
    last_test_status = CASE
      WHEN p_new_secret IS NOT NULL OR p_base_url IS DISTINCT FROM current_row.base_url THEN 'never'
      ELSE last_test_status END,
    last_test_error_code = CASE
      WHEN p_new_secret IS NOT NULL OR p_base_url IS DISTINCT FROM current_row.base_url THEN NULL
      ELSE last_test_error_code END
  WHERE id = p_provider_config_id;

  IF p_models IS NOT NULL THEN
    DELETE FROM public.workspace_provider_models
    WHERE provider_config_id = p_provider_config_id;
    FOR model_row IN SELECT value FROM jsonb_array_elements(p_models)
    LOOP
      INSERT INTO public.workspace_provider_models (
        provider_config_id, upstream_model_id, display_name, modality, enabled, capabilities
      ) VALUES (
        p_provider_config_id,
        model_row->>'upstreamModelId',
        model_row->>'displayName',
        model_row->>'modality',
        COALESCE((model_row->>'enabled')::boolean, false),
        COALESCE(model_row->'capabilities', '[]'::jsonb)
      );
    END LOOP;
  END IF;

  INSERT INTO public.workspace_provider_audit_events (
    workspace_id, provider_config_id, actor_user_id, action, safe_details
  ) VALUES (
    p_workspace_id, p_provider_config_id, p_actor_user_id, 'updated',
    jsonb_build_object(
      'baseUrlChanged', p_base_url IS DISTINCT FROM current_row.base_url,
      'enabled', p_enabled,
      'modelsChanged', p_models IS NOT NULL
    )
  );
  IF p_new_secret IS NOT NULL THEN
    INSERT INTO public.workspace_provider_audit_events (
      workspace_id, provider_config_id, actor_user_id, action, safe_details
    ) VALUES (
      p_workspace_id, p_provider_config_id, p_actor_user_id, 'key_rotated', '{}'::jsonb
    );
  END IF;
  RETURN 'updated';
END;
$$;

REVOKE ALL ON FUNCTION public.loomic_provider_secret_create(text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loomic_provider_secret_update(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loomic_provider_secret_read(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loomic_provider_secret_delete(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loomic_provider_config_cleanup_secret()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loomic_provider_config_delete(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loomic_provider_config_update(
  uuid, uuid, bigint, text, text, boolean, text, text, jsonb, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_provider_secret_create(text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.loomic_provider_secret_update(uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.loomic_provider_secret_read(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.loomic_provider_secret_delete(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.loomic_provider_config_delete(uuid, uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.loomic_provider_config_update(
  uuid, uuid, bigint, text, text, boolean, text, text, jsonb, uuid
) TO service_role;
