-- Stage 7: persist advanced image presentation fields without weakening the
-- Stage 6 scene allowlist. The previous validator remains the source of truth
-- for the complete base scene and every non-image object.

ALTER FUNCTION private.loomic_validate_design_scene(jsonb, integer, integer)
  RENAME TO loomic_validate_design_scene_stage6;

CREATE OR REPLACE FUNCTION private.loomic_valid_finite_json_number(p_value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  RETURN jsonb_typeof(p_value) = 'number'
    AND abs((p_value#>>'{}')::numeric)
      <= 1.7976931348623157e308::numeric;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION private.loomic_valid_image_paint(p_value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT private.loomic_valid_paint(p_value)
    AND (
      p_value->>'kind' <> 'linear'
      OR private.loomic_valid_finite_json_number(p_value->'angle')
    );
$$;

CREATE OR REPLACE FUNCTION private.loomic_valid_image_shadow(p_value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT private.loomic_valid_shadow(p_value)
    AND private.loomic_valid_finite_json_number(p_value->'blur')
    AND private.loomic_valid_finite_json_number(p_value->'offsetX')
    AND private.loomic_valid_finite_json_number(p_value->'offsetY')
    AND private.loomic_valid_finite_json_number(p_value->'opacity');
$$;

CREATE OR REPLACE FUNCTION private.loomic_valid_image_crop(p_value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  crop_x double precision;
  crop_y double precision;
  crop_width double precision;
  crop_height double precision;
BEGIN
  IF jsonb_typeof(p_value) <> 'object'
    OR NOT private.loomic_jsonb_object_has_only_keys(
      p_value, ARRAY['x', 'y', 'width', 'height']
    )
    OR NOT (p_value ?& ARRAY['x', 'y', 'width', 'height'])
    OR jsonb_typeof(p_value->'x') <> 'number'
    OR jsonb_typeof(p_value->'y') <> 'number'
    OR jsonb_typeof(p_value->'width') <> 'number'
    OR jsonb_typeof(p_value->'height') <> 'number'
  THEN RETURN false; END IF;

  crop_x := (p_value->>'x')::double precision;
  crop_y := (p_value->>'y')::double precision;
  crop_width := (p_value->>'width')::double precision;
  crop_height := (p_value->>'height')::double precision;
  RETURN crop_x BETWEEN 0 AND 1
    AND crop_y BETWEEN 0 AND 1
    AND crop_width > 0 AND crop_width <= 1
    AND crop_height > 0 AND crop_height <= 1
    AND crop_x + crop_width <= 1
    AND crop_y + crop_height <= 1;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION private.loomic_valid_image_mask(p_value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  mask_shape text;
  mask_x double precision;
  mask_y double precision;
  mask_width double precision;
  mask_height double precision;
  mask_radius double precision;
BEGIN
  IF jsonb_typeof(p_value) <> 'object'
    OR NOT private.loomic_jsonb_object_has_only_keys(
      p_value, ARRAY['shape', 'x', 'y', 'width', 'height', 'radius']
    )
    OR NOT (p_value ?& ARRAY['shape', 'x', 'y', 'width', 'height'])
    OR jsonb_typeof(p_value->'shape') <> 'string'
    OR jsonb_typeof(p_value->'x') <> 'number'
    OR jsonb_typeof(p_value->'y') <> 'number'
    OR jsonb_typeof(p_value->'width') <> 'number'
    OR jsonb_typeof(p_value->'height') <> 'number'
    OR (p_value ? 'radius' AND jsonb_typeof(p_value->'radius') <> 'number')
  THEN RETURN false; END IF;

  mask_shape := p_value->>'shape';
  mask_x := (p_value->>'x')::double precision;
  mask_y := (p_value->>'y')::double precision;
  mask_width := (p_value->>'width')::double precision;
  mask_height := (p_value->>'height')::double precision;

  IF mask_shape NOT IN ('rect', 'ellipse', 'rounded_rect')
    OR mask_x NOT BETWEEN 0 AND 1
    OR mask_y NOT BETWEEN 0 AND 1
    OR mask_width <= 0 OR mask_width > 1
    OR mask_height <= 0 OR mask_height > 1
    OR mask_x + mask_width > 1
    OR mask_y + mask_height > 1
    OR (mask_shape <> 'rounded_rect' AND p_value ? 'radius')
  THEN RETURN false; END IF;

  IF p_value ? 'radius' THEN
    mask_radius := (p_value->>'radius')::double precision;
    IF mask_radius NOT BETWEEN 0 AND 0.5 THEN RETURN false; END IF;
  END IF;
  RETURN true;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION private.loomic_valid_image_filters(p_value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  filter_key text;
  filter_value double precision;
BEGIN
  IF jsonb_typeof(p_value) <> 'object'
    OR p_value = '{}'::jsonb
    OR NOT private.loomic_jsonb_object_has_only_keys(
      p_value, ARRAY['brightness', 'contrast', 'saturation', 'blur', 'grayscale', 'sepia']
    )
  THEN RETURN false; END IF;

  FOR filter_key IN SELECT jsonb_object_keys(p_value)
  LOOP
    IF jsonb_typeof(p_value->filter_key) <> 'number' THEN RETURN false; END IF;
    filter_value := (p_value->>filter_key)::double precision;
    IF filter_key IN ('brightness', 'contrast', 'saturation') THEN
      IF filter_value NOT BETWEEN -1 AND 1 THEN RETURN false; END IF;
    ELSIF filter_value NOT BETWEEN 0 AND 1 THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION private.loomic_valid_image_crop(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_valid_image_mask(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_valid_image_filters(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_valid_finite_json_number(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_valid_image_paint(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_valid_image_shadow(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.loomic_valid_finite_json_number(jsonb),
  private.loomic_valid_image_paint(jsonb),
  private.loomic_valid_image_shadow(jsonb),
  private.loomic_valid_image_crop(jsonb),
  private.loomic_valid_image_mask(jsonb),
  private.loomic_valid_image_filters(jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION private.loomic_validate_design_scene(
  p_scene jsonb,
  p_width integer,
  p_height integer
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  base_scene jsonb;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(p_scene) = 'object'
          AND jsonb_typeof(p_scene->'objects') = 'array'
        THEN p_scene->'objects'
        ELSE '[]'::jsonb
      END
    ) AS objects(object_data)
    WHERE object_data->>'type' = 'image'
      AND (
        (object_data ? 'crop'
          AND jsonb_typeof(object_data->'crop') <> 'null'
          AND NOT private.loomic_valid_image_crop(object_data->'crop'))
        OR (object_data ? 'mask'
          AND jsonb_typeof(object_data->'mask') <> 'null'
          AND NOT private.loomic_valid_image_mask(object_data->'mask'))
        OR (object_data ? 'filters'
          AND jsonb_typeof(object_data->'filters') <> 'null'
          AND NOT private.loomic_valid_image_filters(object_data->'filters'))
        OR (object_data ? 'stroke'
          AND jsonb_typeof(object_data->'stroke') <> 'null'
          AND NOT private.loomic_valid_image_paint(object_data->'stroke'))
        OR (object_data ? 'strokeWidth' AND (
          NOT private.loomic_valid_finite_json_number(object_data->'strokeWidth')
          OR (object_data->>'strokeWidth')::double precision < 0
        ))
        OR (object_data ? 'shadow'
          AND jsonb_typeof(object_data->'shadow') <> 'null'
          AND NOT private.loomic_valid_image_shadow(object_data->'shadow'))
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_objects_invalid';
  END IF;

  -- The Stage 6 validator still rejects every unknown key. Remove only the six
  -- newly sanctioned keys, and only from image objects, before delegating.
  IF jsonb_typeof(p_scene) = 'object'
    AND jsonb_typeof(p_scene->'objects') = 'array'
  THEN
    SELECT jsonb_set(
      p_scene,
      '{objects}',
      COALESCE(jsonb_agg(
        CASE WHEN object_data->>'type' = 'image'
          THEN object_data - ARRAY['crop', 'mask', 'filters', 'stroke', 'strokeWidth', 'shadow']
          ELSE object_data
        END ORDER BY ordinal
      ), '[]'::jsonb),
      false
    )
    INTO base_scene
    FROM jsonb_array_elements(p_scene->'objects')
      WITH ORDINALITY AS objects(object_data, ordinal);
  ELSE
    base_scene := p_scene;
  END IF;

  PERFORM private.loomic_validate_design_scene_stage6(base_scene, p_width, p_height);
END;
$$;

REVOKE ALL ON FUNCTION private.loomic_validate_design_scene_stage6(jsonb, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_validate_design_scene(jsonb, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.loomic_validate_design_scene_stage6(jsonb, integer, integer),
  private.loomic_validate_design_scene(jsonb, integer, integer)
  TO service_role;

CREATE OR REPLACE FUNCTION private.loomic_apply_object_patch(
  p_object jsonb,
  p_patch jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  result jsonb := p_object;
  object_type text := p_object->>'type';
  patch_key text;
  target_key text;
  allowed_keys text[] := ARRAY[
    'name', 'x', 'y', 'width', 'height', 'rotation', 'opacity',
    'z_index', 'locked', 'visible'
  ];
BEGIN
  IF jsonb_typeof(p_object) <> 'object'
    OR jsonb_typeof(p_patch) <> 'object'
    OR p_patch->>'object_type' IS DISTINCT FROM object_type
    OR (SELECT count(*) FROM jsonb_object_keys(p_patch)) < 2
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_object_patch_invalid';
  END IF;

  allowed_keys := allowed_keys || CASE object_type
    WHEN 'image' THEN ARRAY[
      'asset_object_id', 'resource_id', 'fit', 'flip_x', 'flip_y',
      'crop', 'mask', 'filters', 'stroke', 'stroke_width', 'shadow'
    ]
    WHEN 'svg' THEN ARRAY['asset_object_id', 'resource_id', 'flip_x', 'flip_y']
    WHEN 'text' THEN ARRAY[
      'text', 'font_face_id', 'font_family', 'font_size', 'font_weight',
      'font_style', 'text_align', 'line_height', 'char_spacing', 'fill',
      'stroke', 'stroke_width', 'shadow'
    ]
    WHEN 'textbox' THEN ARRAY[
      'text', 'font_face_id', 'font_family', 'font_size', 'font_weight',
      'font_style', 'text_align', 'line_height', 'char_spacing', 'fill',
      'stroke', 'stroke_width', 'shadow', 'min_width'
    ]
    WHEN 'rect' THEN ARRAY['fill', 'stroke', 'stroke_width', 'shadow', 'radius_x', 'radius_y']
    WHEN 'circle' THEN ARRAY['fill', 'stroke', 'stroke_width', 'shadow']
    WHEN 'triangle' THEN ARRAY['fill', 'stroke', 'stroke_width', 'shadow']
    WHEN 'line' THEN ARRAY['stroke', 'stroke_width', 'x1', 'y1', 'x2', 'y2']
    WHEN 'arrow' THEN ARRAY[
      'stroke', 'stroke_width', 'x1', 'y1', 'x2', 'y2', 'arrow_start', 'arrow_end'
    ]
    WHEN 'group' THEN ARRAY[]::text[]
    ELSE ARRAY[]::text[]
  END;

  FOR patch_key IN SELECT jsonb_object_keys(p_patch - 'object_type')
  LOOP
    IF NOT (patch_key = ANY(allowed_keys)) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_object_patch_field_not_allowed';
    END IF;
    target_key := CASE patch_key
      WHEN 'z_index' THEN 'zIndex'
      WHEN 'asset_object_id' THEN 'assetObjectId'
      WHEN 'resource_id' THEN 'resourceId'
      WHEN 'flip_x' THEN 'flipX'
      WHEN 'flip_y' THEN 'flipY'
      WHEN 'font_face_id' THEN 'fontFaceId'
      WHEN 'font_family' THEN 'fontFamily'
      WHEN 'font_size' THEN 'fontSize'
      WHEN 'font_weight' THEN 'fontWeight'
      WHEN 'font_style' THEN 'fontStyle'
      WHEN 'text_align' THEN 'textAlign'
      WHEN 'line_height' THEN 'lineHeight'
      WHEN 'char_spacing' THEN 'charSpacing'
      WHEN 'stroke_width' THEN 'strokeWidth'
      WHEN 'min_width' THEN 'minWidth'
      WHEN 'radius_x' THEN 'radiusX'
      WHEN 'radius_y' THEN 'radiusY'
      WHEN 'arrow_start' THEN 'arrowStart'
      WHEN 'arrow_end' THEN 'arrowEnd'
      ELSE patch_key
    END;
    result := jsonb_set(result, ARRAY[target_key], p_patch->patch_key, true);
  END LOOP;

  result := jsonb_set(
    result,
    '{objectVersion}',
    to_jsonb((p_object->>'objectVersion')::integer + 1),
    true
  );
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION private.loomic_apply_object_patch(jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.loomic_apply_object_patch(jsonb, jsonb)
  TO service_role;
