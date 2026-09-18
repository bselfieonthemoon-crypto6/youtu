-- Verified model context limits are metadata, never provider credentials.
CREATE FUNCTION public.loomic_valid_context_profile(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF value IS NULL THEN RETURN true; END IF;
  RETURN COALESCE(jsonb_typeof(value)='object'
    AND value - ARRAY['contextWindowTokens','maxInputTokens','maxOutputTokens','profileSource','verifiedAt','profileVersion','imageTokensPerImage'] = '{}'::jsonb
    AND value ?& ARRAY['contextWindowTokens','maxInputTokens','maxOutputTokens','profileSource','verifiedAt','profileVersion']
    AND jsonb_typeof(value->'contextWindowTokens')='number'
    AND jsonb_typeof(value->'maxInputTokens')='number'
    AND jsonb_typeof(value->'maxOutputTokens')='number'
    AND jsonb_typeof(value->'profileSource')='string'
    AND jsonb_typeof(value->'profileVersion')='string'
    AND jsonb_typeof(value->'verifiedAt')='string'
    AND (value->>'contextWindowTokens')::numeric BETWEEN 8192 AND 4000000
    AND (value->>'maxInputTokens')::numeric BETWEEN 1024 AND (value->>'contextWindowTokens')::numeric
    AND (value->>'maxOutputTokens')::numeric BETWEEN 256 AND 1000000
    AND (value->>'maxOutputTokens')::numeric < (value->>'contextWindowTokens')::numeric
    AND (value->>'contextWindowTokens')::numeric = trunc((value->>'contextWindowTokens')::numeric)
    AND (value->>'maxInputTokens')::numeric = trunc((value->>'maxInputTokens')::numeric)
    AND (value->>'maxOutputTokens')::numeric = trunc((value->>'maxOutputTokens')::numeric)
    AND length(btrim(value->>'profileSource')) BETWEEN 1 AND 500
    AND btrim(value->>'profileSource') <> 'unverified'
    AND length(btrim(value->>'profileVersion')) BETWEEN 1 AND 100
    AND value->>'verifiedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
    AND isfinite((value->>'verifiedAt')::timestamptz)
    AND (NOT value ? 'imageTokensPerImage' OR (
      jsonb_typeof(value->'imageTokensPerImage')='number'
      AND
      (value->>'imageTokensPerImage')::numeric BETWEEN 1 AND 100000
      AND (value->>'imageTokensPerImage')::numeric=trunc((value->>'imageTokensPerImage')::numeric))),false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;
ALTER TABLE public.workspace_provider_models ADD COLUMN context_profile jsonb
  CHECK (public.loomic_valid_context_profile(context_profile) IS TRUE AND (context_profile IS NULL OR modality='text'));
ALTER TABLE public.provider_execution_snapshots ADD COLUMN context_profile jsonb
  CHECK (public.loomic_valid_context_profile(context_profile) IS TRUE);
ALTER TABLE public.agent_expert_model_snapshots ADD COLUMN context_profile jsonb
  CHECK (public.loomic_valid_context_profile(context_profile) IS TRUE);

CREATE FUNCTION public.loomic_freeze_context_profile() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  SELECT m.context_profile INTO NEW.context_profile FROM public.workspace_provider_models m
    JOIN public.workspace_provider_configs c ON c.id=m.provider_config_id
    WHERE m.catalog_key=NEW.catalog_key AND c.workspace_id=NEW.workspace_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER freeze_context_profile BEFORE INSERT ON public.provider_execution_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.loomic_freeze_context_profile();
CREATE TRIGGER freeze_expert_context_profile BEFORE INSERT ON public.agent_expert_model_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.loomic_freeze_context_profile();
REVOKE ALL ON FUNCTION public.loomic_freeze_context_profile() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.loomic_provider_context_profile(p_workspace uuid, p_snapshot uuid DEFAULT NULL, p_delegation uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF (p_snapshot IS NULL) = (p_delegation IS NULL) THEN RAISE EXCEPTION 'context_profile_target_invalid'; END IF;
  IF p_snapshot IS NOT NULL THEN
    SELECT context_profile INTO result FROM public.provider_execution_snapshots
      WHERE id=p_snapshot AND workspace_id=p_workspace;
  ELSE
    SELECT context_profile INTO result FROM public.agent_expert_model_snapshots
      WHERE delegation_id=p_delegation AND workspace_id=p_workspace;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'context_profile_not_found'; END IF;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.loomic_provider_context_profile(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_provider_context_profile(uuid,uuid,uuid) TO service_role;

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
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  -- Recheck current management authority inside the write transaction. The
  -- existing HTTP service supplies the authenticated actor for every update.
  PERFORM 1 FROM public.workspace_members WHERE workspace_id=p_workspace_id
    AND user_id=p_actor_user_id AND role IN ('owner','admin') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'provider_config_forbidden'; END IF;
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
        provider_config_id, upstream_model_id, display_name, modality, enabled, capabilities, context_profile
      ) VALUES (
        p_provider_config_id, model_row->>'upstreamModelId', model_row->>'displayName',
        model_row->>'modality', COALESCE((model_row->>'enabled')::boolean, false),
        COALESCE(model_row->'capabilities', '[]'::jsonb), NULLIF(model_row->'contextProfile', 'null'::jsonb)
      )
      ON CONFLICT (provider_config_id, upstream_model_id, modality) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        enabled = EXCLUDED.enabled,
        capabilities = EXCLUDED.capabilities,
        context_profile = CASE WHEN model_row ? 'contextProfile' THEN EXCLUDED.context_profile ELSE workspace_provider_models.context_profile END;
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
NOTIFY pgrst, 'reload schema';
