\set ON_ERROR_STOP on
BEGIN;

DO $qa$
DECLARE
  base_image jsonb := jsonb_build_object(
    'objectId','a7000000-0000-4000-8000-000000000001',
    'objectVersion',1,'type','image','x',0,'y',0,'width',100,'height',100,
    'rotation',0,'opacity',1,'zIndex',0,'locked',false,'visible',true,
    'assetObjectId','a7000000-0000-4000-8000-000000000002',
    'fit','cover'
  );
  valid_image jsonb;
  valid_scene jsonb;
  patched jsonb;
BEGIN
  valid_image := base_image || jsonb_build_object(
    'crop',jsonb_build_object('x',0.1,'y',0.2,'width',0.8,'height',0.7),
    'mask',jsonb_build_object(
      'shape','rounded_rect','x',0,'y',0,'width',1,'height',1,'radius',0.25
    ),
    'filters',jsonb_build_object(
      'brightness',-1,'contrast',1,'blur',0.5,'grayscale',true,'sepia',false
    ),
    'stroke',jsonb_build_object('kind','solid','color','#fff'),
    'strokeWidth',3,
    'shadow',jsonb_build_object(
      'color','#000','blur',8,'offsetX',2,'offsetY',3,'opacity',0.5
    )
  );
  valid_scene := jsonb_build_object(
    'schemaVersion',1,'engine','fabric',
    'canvas',jsonb_build_object('width',100,'height',100,'background',NULL),
    'objects',jsonb_build_array(valid_image)
  );
  PERFORM private.loomic_validate_design_scene(valid_scene, 100, 100);

  patched := private.loomic_apply_object_patch(
    base_image,
    jsonb_build_object(
      'object_type','image',
      'crop',jsonb_build_object('x',0,'y',0,'width',1,'height',1),
      'stroke_width',4
    )
  );
  IF patched->'crop' IS NULL
    OR (patched->>'strokeWidth')::numeric <> 4
    OR (patched->>'objectVersion')::integer <> 2
  THEN RAISE EXCEPTION 'advanced image patch mapping failed'; END IF;

  BEGIN
    PERFORM private.loomic_validate_design_scene(
      jsonb_set(valid_scene, '{objects,0,crop}',
        '{"x":0.5,"y":0,"width":0.6,"height":1}'::jsonb), 100, 100
    );
    RAISE EXCEPTION 'crop overflow accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;

  BEGIN
    PERFORM private.loomic_validate_design_scene(
      jsonb_set(valid_scene, '{objects,0,mask}',
        '{"shape":"ellipse","x":0,"y":0,"width":1,"height":1,"radius":0.1}'::jsonb),
      100, 100
    );
    RAISE EXCEPTION 'non-rounded mask radius accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;

  BEGIN
    PERFORM private.loomic_validate_design_scene(
      jsonb_set(valid_scene, '{objects,0,filters}', '{}'::jsonb), 100, 100
    );
    RAISE EXCEPTION 'empty filters accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;

  BEGIN
    PERFORM private.loomic_validate_design_scene(
      jsonb_set(valid_scene, '{objects,0,filters,grayscale}', '0.5'::jsonb), 100, 100
    );
    RAISE EXCEPTION 'numeric grayscale accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;

  BEGIN
    PERFORM private.loomic_validate_design_scene(
      jsonb_set(valid_scene, '{objects,0,filters,blur}', 'true'::jsonb), 100, 100
    );
    RAISE EXCEPTION 'boolean blur accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;

  BEGIN
    PERFORM private.loomic_validate_design_scene(
      jsonb_set(valid_scene, '{objects,0,strokeWidth}', '-1'::jsonb), 100, 100
    );
    RAISE EXCEPTION 'negative stroke width accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;

  BEGIN
    PERFORM private.loomic_validate_design_scene(
      jsonb_set(valid_scene, '{objects,0,strokeWidth}', '1e1000'::jsonb), 100, 100
    );
    RAISE EXCEPTION 'non-finite JavaScript stroke width accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;

  BEGIN
    PERFORM private.loomic_validate_design_scene(
      jsonb_set(valid_scene, '{objects,0,unknownStage7Field}', 'true'::jsonb), 100, 100
    );
    RAISE EXCEPTION 'unknown image field accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
END;
$qa$;

ROLLBACK;
