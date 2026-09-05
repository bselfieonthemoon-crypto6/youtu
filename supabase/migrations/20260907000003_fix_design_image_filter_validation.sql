-- Stage 7 gate fix: keep the database image-filter contract aligned with the
-- shared scene schema. Numeric filters use normalized strengths while the two
-- color-mode filters are explicit booleans.
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
    IF filter_key IN ('grayscale', 'sepia') THEN
      IF jsonb_typeof(p_value->filter_key) <> 'boolean' THEN RETURN false; END IF;
      CONTINUE;
    END IF;

    IF jsonb_typeof(p_value->filter_key) <> 'number' THEN RETURN false; END IF;
    filter_value := (p_value->>filter_key)::double precision;
    IF filter_key IN ('brightness', 'contrast', 'saturation') THEN
      IF filter_value NOT BETWEEN -1 AND 1 THEN RETURN false; END IF;
    ELSIF filter_key = 'blur' AND filter_value NOT BETWEEN 0 AND 1 THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION private.loomic_valid_image_filters(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.loomic_valid_image_filters(jsonb)
  TO service_role;
