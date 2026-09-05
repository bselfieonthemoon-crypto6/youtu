-- Stage 4: canonical, deterministic canvas.update scale semantics.
-- This migration is additive because the foundation migration may already be
-- applied in deployed environments.

CREATE OR REPLACE FUNCTION private.loomic_apply_canvas_update(
  p_scene jsonb,
  p_command jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  previous_width double precision := (p_scene#>>'{canvas,width}')::double precision;
  previous_height double precision := (p_scene#>>'{canvas,height}')::double precision;
  next_width double precision := COALESCE((p_command->>'width')::double precision, previous_width);
  next_height double precision := COALESCE((p_command->>'height')::double precision, previous_height);
  scale_factor double precision;
  offset_x double precision;
  offset_y double precision;
  object_data jsonb;
  scaled_object jsonb;
  scaled_shadow jsonb;
  scaled_objects jsonb := '[]'::jsonb;
  next_canvas jsonb := p_scene->'canvas';
BEGIN
  IF p_command->>'action' IS DISTINCT FROM 'canvas.update'
    OR next_width <= 0
    OR next_height <= 0
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_canvas_update_invalid';
  END IF;

  IF p_command ? 'width' THEN
    next_canvas := jsonb_set(next_canvas, '{width}', p_command->'width', true);
  END IF;
  IF p_command ? 'height' THEN
    next_canvas := jsonb_set(next_canvas, '{height}', p_command->'height', true);
  END IF;
  IF p_command ? 'background' THEN
    next_canvas := jsonb_set(next_canvas, '{background}', p_command->'background', true);
  END IF;

  IF p_command->>'resize_mode' IS DISTINCT FROM 'scale'
    OR (next_width = previous_width AND next_height = previous_height)
  THEN
    RETURN jsonb_set(p_scene, '{canvas}', next_canvas, true);
  END IF;

  scale_factor := LEAST(next_width / previous_width, next_height / previous_height);
  offset_x := (next_width - previous_width * scale_factor) / 2;
  offset_y := (next_height - previous_height * scale_factor) / 2;

  FOR object_data IN
    SELECT value FROM jsonb_array_elements(p_scene->'objects')
  LOOP
    scaled_object := object_data;
    scaled_object := jsonb_set(
      scaled_object, '{x}',
      to_jsonb((object_data->>'x')::double precision * scale_factor + offset_x), true
    );
    scaled_object := jsonb_set(
      scaled_object, '{y}',
      to_jsonb((object_data->>'y')::double precision * scale_factor + offset_y), true
    );
    scaled_object := jsonb_set(
      scaled_object, '{width}',
      to_jsonb((object_data->>'width')::double precision * scale_factor), true
    );
    scaled_object := jsonb_set(
      scaled_object, '{height}',
      to_jsonb((object_data->>'height')::double precision * scale_factor), true
    );
    scaled_object := jsonb_set(
      scaled_object, '{objectVersion}',
      to_jsonb((object_data->>'objectVersion')::integer + 1), true
    );

    IF object_data->>'type' IN ('line', 'arrow') THEN
      scaled_object := jsonb_set(
        scaled_object, '{x1}',
        to_jsonb((object_data->>'x1')::double precision * scale_factor + offset_x), true
      );
      scaled_object := jsonb_set(
        scaled_object, '{y1}',
        to_jsonb((object_data->>'y1')::double precision * scale_factor + offset_y), true
      );
      scaled_object := jsonb_set(
        scaled_object, '{x2}',
        to_jsonb((object_data->>'x2')::double precision * scale_factor + offset_x), true
      );
      scaled_object := jsonb_set(
        scaled_object, '{y2}',
        to_jsonb((object_data->>'y2')::double precision * scale_factor + offset_y), true
      );
      scaled_object := jsonb_set(
        scaled_object, '{strokeWidth}',
        to_jsonb((object_data->>'strokeWidth')::double precision * scale_factor), true
      );
    ELSIF object_data->>'type' IN ('text', 'textbox') THEN
      scaled_object := jsonb_set(
        scaled_object, '{fontSize}',
        to_jsonb((object_data->>'fontSize')::double precision * scale_factor), true
      );
      IF object_data ? 'strokeWidth' THEN
        scaled_object := jsonb_set(
          scaled_object, '{strokeWidth}',
          to_jsonb((object_data->>'strokeWidth')::double precision * scale_factor), true
        );
      END IF;
      IF object_data->>'type' = 'textbox' AND object_data ? 'minWidth' THEN
        scaled_object := jsonb_set(
          scaled_object, '{minWidth}',
          to_jsonb((object_data->>'minWidth')::double precision * scale_factor), true
        );
      END IF;
    ELSIF object_data->>'type' IN ('rect', 'circle', 'triangle') THEN
      scaled_object := jsonb_set(
        scaled_object, '{strokeWidth}',
        to_jsonb((object_data->>'strokeWidth')::double precision * scale_factor), true
      );
      IF object_data->>'type' = 'rect' AND object_data ? 'radiusX' THEN
        scaled_object := jsonb_set(
          scaled_object, '{radiusX}',
          to_jsonb((object_data->>'radiusX')::double precision * scale_factor), true
        );
      END IF;
      IF object_data->>'type' = 'rect' AND object_data ? 'radiusY' THEN
        scaled_object := jsonb_set(
          scaled_object, '{radiusY}',
          to_jsonb((object_data->>'radiusY')::double precision * scale_factor), true
        );
      END IF;
    END IF;

    IF jsonb_typeof(object_data->'shadow') = 'object' THEN
      scaled_shadow := object_data->'shadow';
      scaled_shadow := jsonb_set(
        scaled_shadow, '{blur}',
        to_jsonb((scaled_shadow->>'blur')::double precision * scale_factor), true
      );
      scaled_shadow := jsonb_set(
        scaled_shadow, '{offsetX}',
        to_jsonb((scaled_shadow->>'offsetX')::double precision * scale_factor), true
      );
      scaled_shadow := jsonb_set(
        scaled_shadow, '{offsetY}',
        to_jsonb((scaled_shadow->>'offsetY')::double precision * scale_factor), true
      );
      scaled_object := jsonb_set(scaled_object, '{shadow}', scaled_shadow, true);
    END IF;

    scaled_objects := scaled_objects || jsonb_build_array(scaled_object);
  END LOOP;

  RETURN jsonb_set(
    jsonb_set(p_scene, '{canvas}', next_canvas, true),
    '{objects}', scaled_objects, true
  );
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range OR division_by_zero THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_canvas_update_invalid';
END;
$$;

REVOKE ALL ON FUNCTION private.loomic_apply_canvas_update(jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.loomic_apply_canvas_update(jsonb, jsonb)
  TO service_role;

-- Preserve all established mutation checks and change only the canvas.update
-- branch. The guarded source rewrite intentionally fails the migration if an
-- unexpected predecessor definition is installed instead of silently weakening
-- validation.
DO $migration$
DECLARE
  function_signature regprocedure :=
    'public.loomic_design_mutate(uuid,bigint,uuid,jsonb,jsonb,text,uuid,uuid,uuid)'::regprocedure;
  function_definition text := pg_get_functiondef(function_signature);
  declaration_needle text := $needle$  scene_replace_requested boolean := false;$needle$;
  branch_start_needle text := $needle$    ELSIF action_name = 'canvas.update' THEN
      IF (command ? 'width' AND (command->>'width')::integer <> next_width)$needle$;
  branch_start_replacement text := $replacement$    ELSIF action_name = 'canvas.update' THEN
      IF command->>'resize_mode' = 'scale' THEN
        IF jsonb_array_length(p_commands) <> 1 THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_canvas_scale_must_be_exclusive';
        END IF;
        expected_scaled_scene := private.loomic_apply_canvas_update(design_row.scene, command);
        IF p_next_scene IS DISTINCT FROM expected_scaled_scene THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_canvas_scale_mismatch';
        END IF;
        expected_canvas := expected_scaled_scene->'canvas';
        FOR object_ref IN
          SELECT value FROM jsonb_array_elements(expected_scaled_scene->'objects')
        LOOP
          target_object_id := object_ref->>'objectId';
          exact_objects := exact_objects || jsonb_build_object(target_object_id, object_ref);
        END LOOP;
      ELSE
      IF (command ? 'width' AND (command->>'width')::integer <> next_width)$replacement$;
  branch_end_needle text := $needle$      IF command ? 'background' THEN
        expected_canvas := jsonb_set(expected_canvas, '{background}', command->'background', true);
      END IF;
    ELSIF action_name = 'scene.replace' THEN$needle$;
  branch_end_replacement text := $replacement$      IF command ? 'background' THEN
        expected_canvas := jsonb_set(expected_canvas, '{background}', command->'background', true);
      END IF;
      END IF;
    ELSIF action_name = 'scene.replace' THEN$replacement$;
BEGIN
  IF position(declaration_needle IN function_definition) = 0
    OR position(branch_start_needle IN function_definition) = 0
    OR position(branch_end_needle IN function_definition) = 0
  THEN
    RAISE EXCEPTION 'unexpected loomic_design_mutate predecessor; refusing unsafe rewrite';
  END IF;

  function_definition := replace(
    function_definition,
    declaration_needle,
    declaration_needle || E'\n  expected_scaled_scene jsonb;'
  );
  function_definition := replace(
    function_definition, branch_start_needle, branch_start_replacement
  );
  function_definition := replace(
    function_definition, branch_end_needle, branch_end_replacement
  );
  EXECUTE function_definition;
END;
$migration$;

REVOKE ALL ON FUNCTION public.loomic_design_mutate(
  uuid, bigint, uuid, jsonb, jsonb, text, uuid, uuid, uuid
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.loomic_design_mutate(
  uuid, bigint, uuid, jsonb, jsonb, text, uuid, uuid, uuid
) TO service_role;
