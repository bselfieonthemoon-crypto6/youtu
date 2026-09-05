-- Stage 7 hardening: bind catalog provenance to the exact persisted asset and
-- make template-variable defaults participate in authoritative dependency
-- validation and garbage-collection references.

CREATE OR REPLACE FUNCTION private.validate_design_reference_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  source_resource_scope text;
  source_resource_workspace_id uuid;
  source_resource_status text;
  source_resource_deleted_at timestamptz;
  source_resource_asset_object_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'design_document_asset_refs' THEN
    IF NOT private.loomic_asset_is_usable(NEW.asset_object_id, NEW.workspace_id) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'design_asset_workspace_mismatch';
    END IF;
    IF NEW.resource_id IS NOT NULL THEN
      SELECT scope, workspace_id, status, deleted_at, asset_object_id
      INTO source_resource_scope, source_resource_workspace_id,
        source_resource_status, source_resource_deleted_at,
        source_resource_asset_object_id
      FROM public.design_resources
      WHERE id = NEW.resource_id;
      IF source_resource_scope IS NULL
        OR source_resource_deleted_at IS NOT NULL
        OR source_resource_asset_object_id IS DISTINCT FROM NEW.asset_object_id
        OR (
          source_resource_scope = 'workspace'
          AND source_resource_workspace_id IS DISTINCT FROM NEW.workspace_id
        )
        OR (source_resource_scope = 'platform' AND source_resource_status <> 'published')
      THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'design_resource_workspace_mismatch';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'design_document_font_refs' THEN
    IF NOT private.loomic_font_is_usable(NEW.font_face_id, NEW.workspace_id) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'design_font_workspace_mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.loomic_validate_template_variable_dependencies(
  p_scope text,
  p_workspace_id uuid,
  p_variables jsonb
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  variable jsonb;
  default_value jsonb;
  asset_id uuid;
  resource_id uuid;
  font_id uuid;
  dependency_ok boolean;
BEGIN
  FOR variable IN SELECT value FROM jsonb_array_elements(p_variables)
  LOOP
    IF NOT (variable ? 'default_value') THEN CONTINUE; END IF;
    default_value := variable->'default_value';
    IF variable->>'type' = 'image' THEN
      asset_id := private.try_parse_uuid(default_value->>'asset_object_id');
      resource_id := private.try_parse_uuid(default_value->>'resource_id');
      SELECT EXISTS (
        SELECT 1 FROM public.asset_objects ao
        WHERE ao.id = asset_id
          AND ao.deletion_pending_at IS NULL
          AND ao.scope = p_scope
          AND ao.workspace_id IS NOT DISTINCT FROM p_workspace_id
          AND (
            resource_id IS NULL OR EXISTS (
              SELECT 1 FROM public.design_resources r
              WHERE r.id = resource_id
                AND r.asset_object_id = ao.id
                AND r.deleted_at IS NULL
                AND r.scope = p_scope
                AND r.workspace_id IS NOT DISTINCT FROM p_workspace_id
                AND (
                  (p_scope = 'platform' AND r.status = 'published')
                  OR (p_scope = 'workspace' AND r.status IN ('draft','pending_review','published'))
                )
            )
          )
      ) INTO dependency_ok;
      IF NOT dependency_ok THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'template_variable_image_dependency_unavailable';
      END IF;
    ELSIF variable->>'type' = 'font' THEN
      font_id := private.try_parse_uuid(default_value->>'font_face_id');
      SELECT EXISTS (
        SELECT 1
        FROM public.font_faces ff
        JOIN public.font_families family ON family.id = ff.family_id
        JOIN public.asset_objects ao ON ao.id = ff.asset_object_id
        WHERE ff.id = font_id
          AND ff.deleted_at IS NULL
          AND family.deleted_at IS NULL
          AND ao.deletion_pending_at IS NULL
          AND ff.scope = p_scope
          AND ff.workspace_id IS NOT DISTINCT FROM p_workspace_id
          AND family.scope = p_scope
          AND family.workspace_id IS NOT DISTINCT FROM p_workspace_id
          AND ao.scope = p_scope
          AND ao.workspace_id IS NOT DISTINCT FROM p_workspace_id
          AND family.name = default_value->>'font_family'
          AND (
            (p_scope = 'platform' AND ff.status = 'published' AND family.status = 'published')
            OR (p_scope = 'workspace'
              AND ff.status IN ('draft','pending_review','published')
              AND family.status IN ('draft','pending_review','published'))
          )
      ) INTO dependency_ok;
      IF NOT dependency_ok THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'template_variable_font_dependency_unavailable';
      END IF;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION private.loomic_validate_template_variables_trigger()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  PERFORM private.loomic_validate_template_variables(NEW.scene, NEW.variables);
  PERFORM private.loomic_validate_template_variable_dependencies(
    NEW.scope, NEW.workspace_id, NEW.variables
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.loomic_sync_template_variable_references()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  variable jsonb;
  default_value jsonb;
  target_object_id text;
  asset_id uuid;
  resource_id uuid;
  font_id uuid;
BEGIN
  DELETE FROM public.design_template_asset_refs
  WHERE template_id = NEW.id AND slot LIKE 'variable:%';

  IF TG_OP = 'UPDATE' THEN
    FOR variable IN
      SELECT value FROM jsonb_array_elements(OLD.variables)
      WHERE value->>'type' = 'font' AND value ? 'default_value'
    LOOP
      target_object_id := variable#>>'{target,object_id}';
      font_id := private.try_parse_uuid(variable#>>'{default_value,font_face_id}');
      DELETE FROM public.design_template_font_refs reference
      WHERE reference.template_id = NEW.id
        AND reference.object_id = target_object_id
        AND reference.font_face_id = font_id
        AND NOT EXISTS (
          SELECT 1 FROM private.loomic_scene_objects(NEW.scene) scene_object
          WHERE scene_object.object_data->>'objectId' = target_object_id
            AND private.try_parse_uuid(scene_object.object_data->>'fontFaceId') = font_id
        );
    END LOOP;
  END IF;

  FOR variable IN SELECT value FROM jsonb_array_elements(NEW.variables)
  LOOP
    IF NOT (variable ? 'default_value') THEN CONTINUE; END IF;
    default_value := variable->'default_value';
    target_object_id := variable#>>'{target,object_id}';
    IF variable->>'type' = 'image' THEN
      asset_id := private.try_parse_uuid(default_value->>'asset_object_id');
      resource_id := private.try_parse_uuid(default_value->>'resource_id');
      INSERT INTO public.design_template_asset_refs(
        template_id, object_id, slot, asset_object_id, resource_id
      ) VALUES (
        NEW.id, target_object_id, 'variable:' || (variable->>'key'), asset_id, resource_id
      ) ON CONFLICT (template_id, object_id, slot) DO UPDATE
      SET asset_object_id = EXCLUDED.asset_object_id,
          resource_id = EXCLUDED.resource_id;
    ELSIF variable->>'type' = 'font' THEN
      font_id := private.try_parse_uuid(default_value->>'font_face_id');
      INSERT INTO public.design_template_font_refs(template_id, object_id, font_face_id)
      VALUES (NEW.id, target_object_id, font_id)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS design_templates_sync_variable_references
  ON public.design_templates;
CREATE CONSTRAINT TRIGGER design_templates_sync_variable_references
AFTER INSERT OR UPDATE ON public.design_templates
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION private.loomic_sync_template_variable_references();

REVOKE ALL ON FUNCTION private.loomic_validate_template_variable_dependencies(text,uuid,jsonb),
  private.loomic_sync_template_variable_references()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.loomic_validate_template_variable_dependencies(text,uuid,jsonb),
  private.loomic_sync_template_variable_references()
  TO service_role;
