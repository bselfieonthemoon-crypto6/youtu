\set ON_ERROR_STOP on
BEGIN;

DO $qa$
DECLARE
  text_id uuid := 'a7200000-0000-4000-8000-000000000001';
  image_id uuid := 'a7200000-0000-4000-8000-000000000002';
  scene jsonb;
  variables jsonb;
BEGIN
  scene := jsonb_build_object(
    'schemaVersion',1,'engine','fabric',
    'canvas',jsonb_build_object('width',400,'height',300,'background',NULL),
    'objects',jsonb_build_array(
      jsonb_build_object(
        'objectId',text_id,'objectVersion',1,'type','text','name','Headline','role','title',
        'x',0,'y',0,'width',200,'height',50,'rotation',0,'opacity',1,'zIndex',0,
        'locked',false,'visible',true,'text','Old','fontFamily','Inter','fontSize',32,
        'fontWeight',700,'fontStyle','normal','textAlign','left','lineHeight',1.2,
        'charSpacing',0,'fill',jsonb_build_object('kind','solid','color','#000')
      ),
      jsonb_build_object(
        'objectId',image_id,'objectVersion',1,'type','image','name','Hero','role','product',
        'x',0,'y',50,'width',300,'height',200,'rotation',0,'opacity',1,'zIndex',1,
        'locked',false,'visible',true,
        'assetObjectId','a7200000-0000-4000-8000-000000000003','fit','cover'
      )
    )
  );
  variables := jsonb_build_array(
    jsonb_build_object('key','headline','label','Headline','type','text','required',true,
      'target',jsonb_build_object('object_id',text_id,'property','text')),
    jsonb_build_object('key','hero','label','Hero','type','image','required',false,
      'target',jsonb_build_object('object_id',image_id,'property','asset_object_id')),
    jsonb_build_object('key','brand','label','Brand color','type','color','required',false,
      'target',jsonb_build_object('object_id',text_id,'property','fill'),'default_value','#f00'),
    jsonb_build_object('key','font','label','Font','type','font','required',false,
      'target',jsonb_build_object('object_id',text_id,'property','font_face_id'),
      'default_value',jsonb_build_object(
        'font_face_id','a7200000-0000-4000-8000-000000000004','font_family','Inter'))
  );
  PERFORM private.loomic_validate_template_variables(scene,variables);

  BEGIN
    PERFORM private.loomic_validate_template_variables(
      scene, variables || variables->0
    );
    RAISE EXCEPTION 'duplicate key accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;

  BEGIN
    PERFORM private.loomic_validate_template_variables(
      scene,
      jsonb_build_array(jsonb_build_object(
        'key','bad','label','Bad','type','image','required',true,
        'target',jsonb_build_object('object_id',text_id,'property','asset_object_id')
      ))
    );
    RAISE EXCEPTION 'incompatible target accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;

  BEGIN
    PERFORM private.loomic_validate_template_variables(
      scene,
      jsonb_build_array(jsonb_build_object(
        'key','unknown','label','Unknown','type','text','required',true,'extra',true,
        'target',jsonb_build_object('object_id',text_id,'property','text')
      ))
    );
    RAISE EXCEPTION 'unknown field accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
END;
$qa$;

ROLLBACK;
