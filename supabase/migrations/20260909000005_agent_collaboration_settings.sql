-- Collaboration settings are workspace-scoped; existing owner/admin RLS applies.
CREATE OR REPLACE FUNCTION public.loomic_valid_agent_collaboration(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE role_name text; ref jsonb;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object'
    OR value - ARRAY['enabled','maxParallel','maxTasksPerRun','timeoutMs','roleModels'] <> '{}'::jsonb
    OR NOT value ?& ARRAY['enabled','maxParallel','maxTasksPerRun','timeoutMs','roleModels']
    OR jsonb_typeof(value->'enabled') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(value->'maxParallel') IS DISTINCT FROM 'number'
    OR jsonb_typeof(value->'maxTasksPerRun') IS DISTINCT FROM 'number'
    OR jsonb_typeof(value->'timeoutMs') IS DISTINCT FROM 'number'
    OR (value->>'maxParallel')::numeric NOT BETWEEN 1 AND 3
    OR (value->>'maxTasksPerRun')::numeric NOT BETWEEN 1 AND 8
    OR (value->>'timeoutMs')::numeric NOT BETWEEN 10000 AND 120000
    OR (value->>'maxParallel')::numeric <> trunc((value->>'maxParallel')::numeric)
    OR (value->>'maxTasksPerRun')::numeric <> trunc((value->>'maxTasksPerRun')::numeric)
    OR (value->>'timeoutMs')::numeric <> trunc((value->>'timeoutMs')::numeric)
    OR jsonb_typeof(value->'roleModels') IS DISTINCT FROM 'object'
    OR (value->'roleModels') - ARRAY['reference_analysis','design_planning','design_review'] <> '{}'::jsonb
    OR NOT (value->'roleModels') ?& ARRAY['reference_analysis','design_planning','design_review']
  THEN RETURN false; END IF;
  FOREACH role_name IN ARRAY ARRAY['reference_analysis','design_planning','design_review'] LOOP
    ref := value->'roleModels'->role_name;
    IF ref <> 'null'::jsonb AND (
      jsonb_typeof(ref) <> 'string' OR (value->'roleModels'->>role_name) !~* '^workspace:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

ALTER TABLE public.workspace_settings ADD COLUMN agent_collaboration jsonb NOT NULL DEFAULT
  '{"enabled":true,"maxParallel":2,"maxTasksPerRun":6,"timeoutMs":90000,"roleModels":{"reference_analysis":null,"design_planning":null,"design_review":null}}'::jsonb
  CHECK (public.loomic_valid_agent_collaboration(agent_collaboration));

CREATE OR REPLACE FUNCTION public.loomic_validate_agent_role_models()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE ref text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.agent_collaboration IS NOT DISTINCT FROM OLD.agent_collaboration THEN
    RETURN NEW;
  END IF;
  FOR ref IN SELECT v FROM jsonb_each_text(NEW.agent_collaboration->'roleModels') AS entries(k,v) WHERE v IS NOT NULL LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.workspace_provider_models m
      JOIN public.workspace_provider_configs c ON c.id = m.provider_config_id
      WHERE m.catalog_key = substring(ref FROM 11)::uuid
        AND c.workspace_id = NEW.workspace_id AND c.enabled AND c.last_test_status = 'succeeded'
        AND m.enabled AND m.modality = 'text' AND m.capabilities ? 'text'
    ) THEN RAISE EXCEPTION 'settings_model_not_accessible' USING ERRCODE = '22023'; END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_settings_agent_models BEFORE INSERT OR UPDATE ON public.workspace_settings
  FOR EACH ROW EXECUTE FUNCTION public.loomic_validate_agent_role_models();
REVOKE ALL ON FUNCTION public.loomic_validate_agent_role_models() FROM PUBLIC, anon, authenticated;
NOTIFY pgrst, 'reload schema';
