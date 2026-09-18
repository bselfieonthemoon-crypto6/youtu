\set ON_ERROR_STOP on
BEGIN;

DO $qa$
DECLARE
  base_rect jsonb := jsonb_build_object(
    'objectId','a7140000-0000-4000-8000-000000000001',
    'objectVersion',1,'type','rect','x',0,'y',0,'width',100,'height',100,
    'rotation',0,'opacity',1,'zIndex',0,'locked',false,'visible',true,
    'fill',NULL,'stroke',NULL,'strokeWidth',0,'radiusX',0,'radiusY',0
  );
  base_scene jsonb;
  candidate_scene jsonb;
  patched jsonb;
  invalid_animation jsonb;
  invalid_cases jsonb[] := ARRAY[
    'true'::jsonb,
    '{}'::jsonb,
    '{"type":"pulse","durationMs":500,"amount":1}'::jsonb,
    '{"type":"float","durationMs":499.99,"amount":1}'::jsonb,
    '{"type":"float","durationMs":10000.01,"amount":1}'::jsonb,
    '{"type":"scale","durationMs":500,"amount":0.99}'::jsonb,
    '{"type":"scale","durationMs":500,"amount":100.01}'::jsonb,
    '{"type":"float","durationMs":"500","amount":1}'::jsonb,
    '{"type":"float","durationMs":500,"amount":"1"}'::jsonb,
    '{"type":"float","durationMs":500,"amount":1,"unknown":true}'::jsonb,
    '{"type":"float","durationMs":1e1000,"amount":1}'::jsonb,
    '{"type":"float","durationMs":500,"amount":1e1000}'::jsonb
  ];
BEGIN
  base_scene := jsonb_build_object(
    'schemaVersion',1,'engine','fabric',
    'canvas',jsonb_build_object('width',100,'height',100,'background',NULL),
    'objects',jsonb_build_array(base_rect)
  );

  -- Missing, explicit null, both animation variants, and inclusive numeric
  -- bounds are valid. Fractional values are valid because the contract is a
  -- finite number contract rather than an integer contract.
  PERFORM private.loomic_validate_design_scene(base_scene, 100, 100);
  PERFORM private.loomic_validate_design_scene(
    jsonb_set(base_scene, '{objects,0,animation}', 'null'::jsonb), 100, 100
  );
  PERFORM private.loomic_validate_design_scene(
    jsonb_set(base_scene, '{objects,0,animation}',
      '{"type":"float","durationMs":500,"amount":1}'::jsonb), 100, 100
  );
  PERFORM private.loomic_validate_design_scene(
    jsonb_set(base_scene, '{objects,0,animation}',
      '{"type":"scale","durationMs":10000,"amount":100}'::jsonb), 100, 100
  );
  PERFORM private.loomic_validate_design_scene(
    jsonb_set(base_scene, '{objects,0,animation}',
      '{"type":"float","durationMs":500.5,"amount":1.25}'::jsonb), 100, 100
  );

  FOREACH invalid_animation IN ARRAY invalid_cases
  LOOP
    candidate_scene := jsonb_set(
      base_scene, '{objects,0,animation}', invalid_animation, true
    );
    BEGIN
      PERFORM private.loomic_validate_design_scene(candidate_scene, 100, 100);
      RAISE EXCEPTION 'invalid animation accepted: %', invalid_animation;
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;
  END LOOP;

  -- Animation is a common patch field and preserves the standard version bump.
  patched := private.loomic_apply_object_patch(
    base_rect,
    jsonb_build_object(
      'object_type','rect',
      'animation',jsonb_build_object(
        'type','float','durationMs',750,'amount',12.5
      )
    )
  );
  IF patched->'animation' IS DISTINCT FROM
      '{"type":"float","durationMs":750,"amount":12.5}'::jsonb
    OR (patched->>'objectVersion')::integer <> 2
  THEN
    RAISE EXCEPTION 'animation patch mapping failed';
  END IF;
  PERFORM private.loomic_validate_design_scene(
    jsonb_set(base_scene, '{objects,0}', patched), 100, 100
  );

  patched := private.loomic_apply_object_patch(
    patched,
    '{"object_type":"rect","animation":null}'::jsonb
  );
  IF jsonb_typeof(patched->'animation') <> 'null'
    OR (patched->>'objectVersion')::integer <> 3
  THEN
    RAISE EXCEPTION 'nullable animation patch failed';
  END IF;
  PERFORM private.loomic_validate_design_scene(
    jsonb_set(base_scene, '{objects,0}', patched), 100, 100
  );

  -- The pre-existing common patch allowlist must remain strict.
  BEGIN
    PERFORM private.loomic_apply_object_patch(
      base_rect,
      '{"object_type":"rect","unknown_animation_field":true}'::jsonb
    );
    RAISE EXCEPTION 'unknown patch field accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  -- A patch can only construct the candidate object; the canonical scene
  -- validator remains responsible for rejecting malformed field values.
  patched := private.loomic_apply_object_patch(
    base_rect,
    '{"object_type":"rect","animation":{"type":"float","durationMs":499,"amount":1}}'::jsonb
  );
  BEGIN
    PERFORM private.loomic_validate_design_scene(
      jsonb_set(base_scene, '{objects,0}', patched), 100, 100
    );
    RAISE EXCEPTION 'invalid patched animation accepted by scene validator';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  -- Removing animation before delegation must not relax any older allowlist.
  BEGIN
    candidate_scene := jsonb_set(
      base_scene, '{objects,0,unknownLegacyField}', 'true'::jsonb, true
    );
    candidate_scene := jsonb_set(
      candidate_scene, '{objects,0,animation}',
      '{"type":"scale","durationMs":500,"amount":1}'::jsonb, true
    );
    PERFORM private.loomic_validate_design_scene(candidate_scene, 100, 100);
    RAISE EXCEPTION 'unknown legacy object field accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END;
$qa$;

ROLLBACK;
