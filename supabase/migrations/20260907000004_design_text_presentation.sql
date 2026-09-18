BEGIN;
ALTER FUNCTION private.loomic_validate_design_scene(jsonb, integer, integer)
  RENAME TO loomic_validate_design_scene_before_text_presentation;
CREATE FUNCTION private.loomic_validate_design_scene(p_scene jsonb, p_width integer, p_height integer)
RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE base_scene jsonb;
BEGIN
  base_scene := p_scene;
  IF jsonb_typeof(p_scene->'objects') = 'array' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_scene->'objects') o
      WHERE o->>'type' IN ('text','textbox') AND (
        (o ? 'paintFirst' AND (jsonb_typeof(o->'paintFirst') <> 'string' OR o->>'paintFirst' NOT IN ('fill','stroke')))
        OR (o ? 'splitByGrapheme' AND jsonb_typeof(o->'splitByGrapheme') <> 'boolean')
      )
    ) THEN
      RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='design_objects_invalid';
    END IF;
    SELECT jsonb_set(p_scene, '{objects}', COALESCE(jsonb_agg(
      CASE WHEN o->>'type' IN ('text','textbox') THEN o - ARRAY['paintFirst','splitByGrapheme'] ELSE o END
      ORDER BY n), '[]'::jsonb)) INTO base_scene
      FROM jsonb_array_elements(p_scene->'objects') WITH ORDINALITY AS entries(o,n);
  END IF;
  PERFORM private.loomic_validate_design_scene_before_text_presentation(base_scene,p_width,p_height);
END;
$$;
REVOKE ALL ON FUNCTION private.loomic_validate_design_scene(jsonb, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.loomic_validate_design_scene(jsonb, integer, integer) TO service_role;
COMMIT;
