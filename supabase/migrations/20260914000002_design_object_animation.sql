-- Persist optional per-object animation metadata while preserving the complete
-- scene validator and object-patch allowlists established by earlier stages.
BEGIN;

ALTER FUNCTION private.loomic_validate_design_scene(jsonb, integer, integer)
  RENAME TO loomic_validate_design_scene_before_object_animation;

CREATE OR REPLACE FUNCTION private.loomic_valid_design_animation(p_value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  duration_ms numeric;
  amount numeric;
BEGIN
  IF jsonb_typeof(p_value) <> 'object'
    OR NOT private.loomic_jsonb_object_has_only_keys(
      p_value, ARRAY['type', 'durationMs', 'amount']
    )
    OR NOT (p_value ?& ARRAY['type', 'durationMs', 'amount'])
    OR jsonb_typeof(p_value->'type') <> 'string'
    OR p_value->>'type' NOT IN ('float', 'scale')
    OR NOT private.loomic_valid_finite_json_number(p_value->'durationMs')
    OR NOT private.loomic_valid_finite_json_number(p_value->'amount')
  THEN
    RETURN false;
  END IF;

  duration_ms := (p_value->>'durationMs')::numeric;
  amount := (p_value->>'amount')::numeric;
  RETURN duration_ms BETWEEN 500 AND 10000
    AND amount BETWEEN 1 AND 100;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION private.loomic_valid_design_animation(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.loomic_valid_design_animation(jsonb)
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
    WHERE jsonb_typeof(object_data) = 'object'
      AND object_data ? 'animation'
      AND jsonb_typeof(object_data->'animation') <> 'null'
      AND NOT private.loomic_valid_design_animation(object_data->'animation')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_objects_invalid';
  END IF;

  -- Delegate the entire prior scene to the preceding validator after removing
  -- only the newly sanctioned key. Non-object array entries remain untouched
  -- so the prior validator continues to reject them.
  IF jsonb_typeof(p_scene) = 'object'
    AND jsonb_typeof(p_scene->'objects') = 'array'
  THEN
    SELECT jsonb_set(
      p_scene,
      '{objects}',
      COALESCE(jsonb_agg(
        CASE
          WHEN jsonb_typeof(object_data) = 'object'
            THEN object_data - 'animation'
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

  PERFORM private.loomic_validate_design_scene_before_object_animation(
    base_scene,
    p_width,
    p_height
  );
END;
$$;

REVOKE ALL ON FUNCTION private.loomic_validate_design_scene_before_object_animation(
  jsonb, integer, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_validate_design_scene(jsonb, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.loomic_validate_design_scene_before_object_animation(
  jsonb, integer, integer
), private.loomic_validate_design_scene(jsonb, integer, integer)
  TO service_role;

-- Add animation to the common patch allowlist without replacing any current
-- per-type fields, key mappings, version increments, or validation behavior.
DO $migration$
DECLARE
  function_signature regprocedure :=
    'private.loomic_apply_object_patch(jsonb,jsonb)'::regprocedure;
  function_definition text := pg_get_functiondef(function_signature);
  allowlist_needle text := $needle$    'z_index', 'locked', 'visible'
  ];$needle$;
  allowlist_replacement text := $replacement$    'z_index', 'locked', 'visible', 'animation'
  ];$replacement$;
BEGIN
  IF position(allowlist_needle IN function_definition) = 0 THEN
    RAISE EXCEPTION 'design object patch allowlist shape changed';
  END IF;

  function_definition := replace(
    function_definition,
    allowlist_needle,
    allowlist_replacement
  );
  EXECUTE function_definition;
END;
$migration$;

REVOKE ALL ON FUNCTION private.loomic_apply_object_patch(jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.loomic_apply_object_patch(jsonb, jsonb)
  TO service_role;

COMMIT;
