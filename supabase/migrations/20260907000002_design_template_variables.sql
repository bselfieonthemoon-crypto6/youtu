ALTER TABLE public.design_templates
  ADD COLUMN variables jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE OR REPLACE FUNCTION private.loomic_validate_template_variables(
  p_scene jsonb,
  p_variables jsonb
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  variable jsonb;
  target_object jsonb;
  variable_type text;
  target_property text;
  default_value jsonb;
BEGIN
  IF jsonb_typeof(p_variables) <> 'array'
    OR jsonb_array_length(p_variables) > 100
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'template_variables_invalid';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_variables))
    <> (SELECT count(DISTINCT value->>'key') FROM jsonb_array_elements(p_variables))
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'template_variable_key_duplicate';
  END IF;

  FOR variable IN SELECT value FROM jsonb_array_elements(p_variables)
  LOOP
    IF jsonb_typeof(variable) <> 'object'
      OR NOT private.loomic_jsonb_object_has_only_keys(
        variable, ARRAY['key','label','type','target','required','default_value']
      )
      OR NOT (variable ?& ARRAY['key','label','type','target','required'])
      OR jsonb_typeof(variable->'key') <> 'string'
      OR variable->>'key' !~ '^[a-z][a-z0-9_.-]{0,79}$'
      OR jsonb_typeof(variable->'label') <> 'string'
      OR char_length(btrim(variable->>'label')) NOT BETWEEN 1 AND 120
      OR jsonb_typeof(variable->'type') <> 'string'
      OR variable->>'type' NOT IN ('text','image','color','font')
      OR jsonb_typeof(variable->'required') <> 'boolean'
      OR jsonb_typeof(variable->'target') <> 'object'
      OR NOT private.loomic_jsonb_object_has_only_keys(
        variable->'target', ARRAY['object_id','property']
      )
      OR NOT (variable->'target' ?& ARRAY['object_id','property'])
      OR private.try_parse_uuid(variable#>>'{target,object_id}') IS NULL
    THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'template_variable_invalid';
    END IF;

    SELECT object_data INTO target_object
    FROM private.loomic_scene_objects(p_scene)
    WHERE object_data->>'objectId' = variable#>>'{target,object_id}'
    LIMIT 1;
    IF target_object IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'template_variable_target_missing';
    END IF;

    variable_type := variable->>'type';
    target_property := variable#>>'{target,property}';
    default_value := variable->'default_value';
    IF variable_type = 'text' THEN
      IF target_property <> 'text'
        OR target_object->>'type' NOT IN ('text','textbox')
        OR (variable ? 'default_value' AND (
          jsonb_typeof(default_value) <> 'string'
          OR char_length(default_value#>>'{}') > 100000
        ))
      THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'template_text_variable_invalid'; END IF;
    ELSIF variable_type = 'image' THEN
      IF target_property <> 'asset_object_id'
        OR target_object->>'type' <> 'image'
        OR (variable ? 'default_value' AND (
          jsonb_typeof(default_value) <> 'object'
          OR NOT private.loomic_jsonb_object_has_only_keys(default_value, ARRAY['asset_object_id','resource_id'])
          OR private.try_parse_uuid(default_value->>'asset_object_id') IS NULL
          OR (default_value ? 'resource_id'
            AND jsonb_typeof(default_value->'resource_id') <> 'null'
            AND private.try_parse_uuid(default_value->>'resource_id') IS NULL)
        ))
      THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'template_image_variable_invalid'; END IF;
    ELSIF variable_type = 'color' THEN
      IF target_property NOT IN ('fill','stroke')
        OR (target_property = 'fill' AND target_object->>'type' NOT IN ('text','textbox','rect','circle','triangle'))
        OR (target_property = 'stroke' AND target_object->>'type' NOT IN ('image','text','textbox','rect','circle','triangle','line','arrow'))
        OR (variable ? 'default_value' AND NOT private.loomic_valid_color(default_value))
      THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'template_color_variable_invalid'; END IF;
    ELSE
      IF target_property <> 'font_face_id'
        OR target_object->>'type' NOT IN ('text','textbox')
        OR (variable ? 'default_value' AND (
          jsonb_typeof(default_value) <> 'object'
          OR NOT private.loomic_jsonb_object_has_only_keys(default_value, ARRAY['font_face_id','font_family'])
          OR NOT (default_value ?& ARRAY['font_face_id','font_family'])
          OR private.try_parse_uuid(default_value->>'font_face_id') IS NULL
          OR jsonb_typeof(default_value->'font_family') <> 'string'
          OR char_length(btrim(default_value->>'font_family')) NOT BETWEEN 1 AND 200
        ))
      THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'template_font_variable_invalid'; END IF;
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
  RETURN NEW;
END;
$$;

CREATE TRIGGER design_templates_validate_variables
  BEFORE INSERT OR UPDATE OF scene, variables ON public.design_templates
  FOR EACH ROW EXECUTE FUNCTION private.loomic_validate_template_variables_trigger();

CREATE OR REPLACE FUNCTION public.loomic_template_variables_update(
  p_request_id uuid,
  p_template_id uuid,
  p_expected_revision bigint,
  p_variables jsonb,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  template_row public.design_templates%ROWTYPE;
  request_row public.catalog_mutation_requests%ROWTYPE;
  request_hash text;
  new_revision bigint;
  result_value jsonb;
BEGIN
  SELECT * INTO template_row FROM public.design_templates
  WHERE id = p_template_id AND deleted_at IS NULL FOR UPDATE;
  IF template_row.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'catalog_not_found';
  END IF;
  PERFORM private.loomic_assert_catalog_actor(
    template_row.scope, template_row.workspace_id, p_actor_user_id
  );
  PERFORM private.loomic_validate_template_variables(template_row.scene, p_variables);
  request_hash := md5(jsonb_build_object(
    'template_id',p_template_id,'expected_revision',p_expected_revision,'variables',p_variables
  )::text);
  INSERT INTO public.catalog_mutation_requests(
    actor_user_id,request_id,operation,entity_kind,entity_id,input_hash
  ) VALUES (p_actor_user_id,p_request_id,'update','template',p_template_id,request_hash)
  ON CONFLICT DO NOTHING;
  SELECT * INTO request_row FROM public.catalog_mutation_requests
  WHERE actor_user_id=p_actor_user_id AND request_id=p_request_id FOR UPDATE;
  IF request_row.operation <> 'update' OR request_row.entity_kind <> 'template'
    OR request_row.entity_id <> p_template_id OR request_row.input_hash <> request_hash
  THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='catalog_idempotency_conflict'; END IF;
  IF request_row.result IS NOT NULL THEN
    RETURN jsonb_set(request_row.result,'{replayed}','true'::jsonb,true);
  END IF;
  IF template_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='catalog_revision_conflict';
  END IF;
  UPDATE public.design_templates SET variables=p_variables,revision=revision+1,
    updated_by=p_actor_user_id
  WHERE id=p_template_id AND revision=p_expected_revision
  RETURNING revision INTO new_revision;
  result_value := jsonb_build_object(
    'entity_kind','template','entity_id',p_template_id,'revision',new_revision,
    'status',template_row.status,'replayed',false
  );
  UPDATE public.catalog_mutation_requests SET result=result_value,completed_at=now()
  WHERE actor_user_id=p_actor_user_id AND request_id=p_request_id;
  RETURN result_value;
END;
$$;

REVOKE ALL ON FUNCTION private.loomic_validate_template_variables(jsonb,jsonb),
  private.loomic_validate_template_variables_trigger(),
  public.loomic_template_variables_update(uuid,uuid,bigint,jsonb,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.loomic_validate_template_variables(jsonb,jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.loomic_template_variables_update(uuid,uuid,bigint,jsonb,uuid)
  TO service_role;
