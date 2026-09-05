\set ON_ERROR_STOP on
\pset pager off

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.qa_assert(condition boolean, message text)
RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'QA assertion failed: %', message; END IF;
END; $$;

CREATE OR REPLACE FUNCTION pg_temp.qa_expect_error(statement text, expected_message text)
RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  BEGIN EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    IF position(expected_message IN SQLERRM)=0 THEN RAISE EXCEPTION 'QA expected %, got %',expected_message,SQLERRM; END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'QA expected %, statement succeeded',expected_message;
END; $$;

INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES
('00000000-0000-0000-0000-000000000000','51000000-0000-4000-8000-000000000001','authenticated','authenticated','catalog-owner@local.test','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','51000000-0000-4000-8000-000000000002','authenticated','authenticated','catalog-member@local.test','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','51000000-0000-4000-8000-000000000003','authenticated','authenticated','catalog-other@local.test','',now(),'{}','{}',now(),now());
INSERT INTO public.workspaces(id,type,name,owner_user_id) VALUES
('52000000-0000-4000-8000-000000000001','team','Catalog A','51000000-0000-4000-8000-000000000001'),
('52000000-0000-4000-8000-000000000002','team','Catalog B','51000000-0000-4000-8000-000000000003');
INSERT INTO public.workspace_members(workspace_id,user_id,role) VALUES
('52000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001','owner'),
('52000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000002','member'),
('52000000-0000-4000-8000-000000000002','51000000-0000-4000-8000-000000000003','owner');
INSERT INTO public.asset_objects(id,scope,workspace_id,bucket,object_path,mime_type,byte_size,created_by) VALUES
('53000000-0000-4000-8000-000000000001','workspace','52000000-0000-4000-8000-000000000001','workspace-assets','52000000-0000-4000-8000-000000000001/source.png','image/png',100,'51000000-0000-4000-8000-000000000001'),
('53000000-0000-4000-8000-000000000002','workspace','52000000-0000-4000-8000-000000000001','workspace-assets','52000000-0000-4000-8000-000000000001/preview.png','image/png',50,'51000000-0000-4000-8000-000000000001'),
('53000000-0000-4000-8000-000000000003','workspace','52000000-0000-4000-8000-000000000002','workspace-assets','52000000-0000-4000-8000-000000000002/foreign.png','image/png',50,'51000000-0000-4000-8000-000000000003');

SELECT pg_temp.qa_assert(
  NOT has_function_privilege('authenticated','public.loomic_catalog_create(uuid,text,text,uuid,jsonb,uuid)','EXECUTE')
  AND has_function_privilege('service_role','public.loomic_catalog_create(uuid,text,text,uuid,jsonb,uuid)','EXECUTE')
  AND has_function_privilege('service_role','public.loomic_resource_import_manifest_enqueue(uuid,text,uuid,jsonb,uuid)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.loomic_resource_import_manifest_enqueue(uuid,text,uuid,jsonb,uuid)','EXECUTE')
  AND has_function_privilege('authenticated','public.loomic_resource_favorite_set(uuid,boolean)','EXECUTE')
  AND NOT has_table_privilege('authenticated','public.catalog_mutation_requests','SELECT'),
  'catalog grant matrix must keep mutations service-controlled'
);

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);

SELECT public.loomic_catalog_create(
  '54000000-0000-4000-8000-000000000001','category','workspace','52000000-0000-4000-8000-000000000001',
  '{"parent_id":null,"name":"Marketing","slug":"marketing","sort_order":1}',
  '51000000-0000-4000-8000-000000000001'
) AS value \gset category_
SELECT public.loomic_catalog_create(
  '54000000-0000-4000-8000-000000000002','tag','workspace','52000000-0000-4000-8000-000000000001',
  '{"name":"Gold","slug":"gold"}','51000000-0000-4000-8000-000000000001'
) AS value \gset tag_

SELECT public.loomic_catalog_create(
  '54000000-0000-4000-8000-000000000003','resource','workspace','52000000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'kind','image','name','Hero','description',NULL,
    'asset_object_id','53000000-0000-4000-8000-000000000001',
    'preview_asset_object_id','53000000-0000-4000-8000-000000000002',
    'width',800,'height',600,'checksum_sha256',repeat('a',64),
    'category_id',:'category_value'::jsonb->>'entity_id',
    'tag_ids',jsonb_build_array(:'tag_value'::jsonb->>'entity_id'),
    'source_url','https://assets.example.com/hero.png',
    'license_name','CC-BY-4.0',
    'license_url','https://creativecommons.org/licenses/by/4.0/',
    'usage_restrictions',NULL
  ),'51000000-0000-4000-8000-000000000001'
) AS value \gset resource_
SELECT public.loomic_catalog_create(
  '54000000-0000-4000-8000-000000000003','resource','workspace','52000000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'kind','image','name','Hero','description',NULL,
    'asset_object_id','53000000-0000-4000-8000-000000000001',
    'preview_asset_object_id','53000000-0000-4000-8000-000000000002',
    'width',800,'height',600,'checksum_sha256',repeat('a',64),
    'category_id',:'category_value'::jsonb->>'entity_id',
    'tag_ids',jsonb_build_array(:'tag_value'::jsonb->>'entity_id'),
    'source_url','https://assets.example.com/hero.png',
    'license_name','CC-BY-4.0',
    'license_url','https://creativecommons.org/licenses/by/4.0/',
    'usage_restrictions',NULL
  ),'51000000-0000-4000-8000-000000000001'
) AS value \gset resource_replay_
SELECT pg_temp.qa_assert(
  (:'resource_value'::jsonb->>'entity_id')=(:'resource_replay_value'::jsonb->>'entity_id')
  AND (:'resource_replay_value'::jsonb->>'replayed')::boolean
  AND (SELECT count(*)=1 FROM public.resource_tag_links WHERE resource_id=(:'resource_value'::jsonb->>'entity_id')::uuid),
  'resource create must be replayable and sync taxonomy atomically'
);

SELECT pg_temp.qa_expect_error(format(
  'SELECT public.loomic_catalog_create(%L::uuid,%L,%L,%L::uuid,%L::jsonb,%L::uuid)',
  '54000000-0000-4000-8000-000000000004','resource','workspace','52000000-0000-4000-8000-000000000001',
  '{"kind":"image","name":"Forbidden","asset_object_id":"53000000-0000-4000-8000-000000000001","tag_ids":[]}',
  '51000000-0000-4000-8000-000000000002'
),'catalog_write_forbidden');

SELECT public.loomic_catalog_update(
  '54000000-0000-4000-8000-000000000005','resource',(:'resource_value'::jsonb->>'entity_id')::uuid,0,
  '{"name":"Hero updated"}','51000000-0000-4000-8000-000000000001'
) AS value \gset update_
SELECT pg_temp.qa_expect_error(format(
  'SELECT public.loomic_catalog_update(%L::uuid,%L,%L::uuid,0,%L::jsonb,%L::uuid)',
  '54000000-0000-4000-8000-000000000006','resource',:'resource_value'::jsonb->>'entity_id','{"name":"stale"}',
  '51000000-0000-4000-8000-000000000001'
),'catalog_revision_conflict');
SELECT public.loomic_catalog_set_status(
  '54000000-0000-4000-8000-000000000007','resource',(:'resource_value'::jsonb->>'entity_id')::uuid,1,
  'pending_review','51000000-0000-4000-8000-000000000001'
) AS value \gset review_
SELECT public.loomic_catalog_set_status(
  '54000000-0000-4000-8000-000000000008','resource',(:'resource_value'::jsonb->>'entity_id')::uuid,2,
  'published','51000000-0000-4000-8000-000000000001'
) AS value \gset published_
SELECT pg_temp.qa_assert((:'published_value'::jsonb->>'revision')::bigint=3,'status changes must advance CAS revision');
SELECT public.loomic_catalog_update(
  '54000000-0000-4000-8000-000000000005','resource',(:'resource_value'::jsonb->>'entity_id')::uuid,0,
  '{"name":"Hero updated"}','51000000-0000-4000-8000-000000000001'
) AS value \gset update_replay_
SELECT public.loomic_catalog_set_status(
  '54000000-0000-4000-8000-000000000007','resource',(:'resource_value'::jsonb->>'entity_id')::uuid,1,
  'pending_review','51000000-0000-4000-8000-000000000001'
) AS value \gset review_replay_
SELECT pg_temp.qa_assert(
  (:'update_replay_value'::jsonb->>'replayed')::boolean
  AND (:'review_replay_value'::jsonb->>'replayed')::boolean,
  'completed mutations must replay even after later revisions exist'
);

SELECT public.loomic_catalog_create(
  '54000000-0000-4000-8000-000000000009','template','workspace','52000000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'name','Hero template','description',NULL,
    'preview_asset_object_id','53000000-0000-4000-8000-000000000002','category_id',NULL,'tag_ids','[]'::jsonb,
    'scene',jsonb_build_object(
      'schemaVersion',1,'engine','fabric','canvas',jsonb_build_object('width',800,'height',600,'background','#ffffff'),
      'objects',jsonb_build_array(jsonb_build_object(
        'objectId','55000000-0000-4000-8000-000000000001','objectVersion',1,'type','image','zIndex',0,
        'x',0,'y',0,'width',800,'height',600,'rotation',0,'opacity',1,'locked',false,'visible',true,
        'assetObjectId','53000000-0000-4000-8000-000000000001',
        'resourceId',:'resource_value'::jsonb->>'entity_id','fit','cover','flipX',false,'flipY',false
      ))
    )
  ),'51000000-0000-4000-8000-000000000001'
) AS value \gset template_
SELECT pg_temp.qa_assert(
  (SELECT resource_id=(:'resource_value'::jsonb->>'entity_id')::uuid FROM public.design_template_asset_refs WHERE template_id=(:'template_value'::jsonb->>'entity_id')::uuid),
  'template scene refs must be normalized with resource identity'
);
SELECT public.loomic_catalog_create(
  '54000000-0000-4000-8000-000000000020','text_preset','workspace','52000000-0000-4000-8000-000000000001',
  jsonb_build_object('name','Unlicensed text','style',jsonb_build_object(
    'schemaVersion',1,
    'objects',jsonb_build_array(jsonb_build_object(
      'objectId','55000000-0000-4000-8000-000000000020','objectVersion',1,'zIndex',0,'type','text',
      'text','Unlicensed','x',0,'y',0,'width',240,'height',48,'rotation',0,'opacity',1,
      'locked',false,'visible',true,'fontFamily','Arial','fontSize',24,'fontWeight',400,
      'fontStyle','normal','textAlign','left','lineHeight',1.2,'charSpacing',0,
      'fill',jsonb_build_object('kind','solid','color','#000000')
    ))
  ),
    'preview_asset_object_id','53000000-0000-4000-8000-000000000002','tag_ids','[]'::jsonb),
  '51000000-0000-4000-8000-000000000001'
) AS value \gset text_preset_
SELECT public.loomic_catalog_create(
  '54000000-0000-4000-8000-000000000021','font_family','workspace','52000000-0000-4000-8000-000000000001',
  '{"name":"Unlicensed Sans"}','51000000-0000-4000-8000-000000000001'
) AS value \gset font_family_
SELECT public.loomic_catalog_create(
  '54000000-0000-4000-8000-000000000022','font_face','workspace','52000000-0000-4000-8000-000000000001',
  jsonb_build_object('family_id',:'font_family_value'::jsonb->>'entity_id',
    'asset_object_id','53000000-0000-4000-8000-000000000001','style','normal','weight',400,
    'format','ttf','checksum_sha256',repeat('b',64),'allow_web_embed',true),
  '51000000-0000-4000-8000-000000000001'
) AS value \gset font_face_
RESET ROLE;
SELECT pg_temp.qa_assert(
  private.loomic_catalog_publishable('resource',(:'resource_value'::jsonb->>'entity_id')::uuid)
  AND NOT private.loomic_catalog_publishable('template',(:'template_value'::jsonb->>'entity_id')::uuid)
  AND NOT private.loomic_catalog_publishable('text_preset',(:'text_preset_value'::jsonb->>'entity_id')::uuid)
  AND NOT private.loomic_catalog_publishable('font_family',(:'font_family_value'::jsonb->>'entity_id')::uuid)
  AND NOT private.loomic_catalog_publishable('font_face',(:'font_face_value'::jsonb->>'entity_id')::uuid)
  AND private.loomic_catalog_license_is_verifiable('Owned original',NULL,NULL,'Owned by this workspace')
  AND NOT private.loomic_catalog_license_is_verifiable('Unknown',NULL,NULL,NULL),
  'resource, template, text preset and font publication must require verifiable authorization'
);
SET LOCAL ROLE service_role;
SELECT public.loomic_catalog_set_status(
  '54000000-0000-4000-8000-000000000023','template',(:'template_value'::jsonb->>'entity_id')::uuid,0,
  'pending_review','51000000-0000-4000-8000-000000000001'
);
SELECT pg_temp.qa_expect_error(format(
  'SELECT public.loomic_catalog_set_status(%L::uuid,%L,%L::uuid,1,%L,%L::uuid)',
  '54000000-0000-4000-8000-000000000024','template',:'template_value'::jsonb->>'entity_id','published',
  '51000000-0000-4000-8000-000000000001'
),'catalog_publication_dependencies_unavailable');
SELECT pg_temp.qa_expect_error(format(
  'SELECT public.loomic_catalog_set_deleted(%L::uuid,%L,%L::uuid,3,true,%L::uuid)',
  '54000000-0000-4000-8000-000000000010','resource',:'resource_value'::jsonb->>'entity_id','51000000-0000-4000-8000-000000000001'
),'catalog_entity_in_use');

SELECT public.loomic_resource_import_create(
  '54000000-0000-4000-8000-000000000011','workspace','52000000-0000-4000-8000-000000000001','url',
  '{"source_urls":["https://example.com/a.svg","https://example.com/b.svg"]}',
  '51000000-0000-4000-8000-000000000001'
) AS value \gset import_
SELECT public.loomic_resource_import_claim('54000000-0000-4000-8000-000000000012',10);
SELECT pg_temp.qa_assert(
  (SELECT status='running' AND attempt_count=1 AND total_items=2
     AND claim_token='54000000-0000-4000-8000-000000000012'
   FROM public.resource_import_jobs WHERE id=(:'import_value'::jsonb->>'import_job_id')::uuid)
  AND (SELECT bool_and(claim_token='54000000-0000-4000-8000-000000000012')
       FROM public.resource_import_items WHERE import_job_id=(:'import_value'::jsonb->>'import_job_id')::uuid),
  'import claim must lease the job and its pending items with one token'
);
UPDATE public.resource_import_jobs SET claimed_at=now()-interval '6 minutes'
WHERE id=(:'import_value'::jsonb->>'import_job_id')::uuid;
SELECT public.loomic_resource_import_claim('54000000-0000-4000-8000-000000000013',10);
SELECT id AS value FROM public.resource_import_items
WHERE import_job_id=(:'import_value'::jsonb->>'import_job_id')::uuid ORDER BY source_key LIMIT 1 \gset import_item_
SELECT pg_temp.qa_expect_error(format(
  'SELECT public.loomic_resource_import_finalize_item(%L::uuid,%L::uuid,%L::uuid,%L,NULL,NULL,NULL,%L,%L)',
  :'import_value'::jsonb->>'import_job_id','54000000-0000-4000-8000-000000000012',:'import_item_value','rejected','unsafe_svg','stale worker'
),'resource_import_lost_lease');
SELECT pg_temp.qa_expect_error(format(
  'SELECT public.loomic_resource_import_defer(%L::uuid,%L::uuid,%L,1)',
  :'import_value'::jsonb->>'import_job_id','54000000-0000-4000-8000-000000000012','stale worker'
),'resource_import_lost_lease');
SELECT pg_temp.qa_expect_error(format(
  'SELECT public.loomic_resource_import_complete(%L::uuid,%L::uuid)',
  :'import_value'::jsonb->>'import_job_id','54000000-0000-4000-8000-000000000012'
),'resource_import_lost_lease');

SELECT public.loomic_resource_import_defer(
  (:'import_value'::jsonb->>'import_job_id')::uuid,
  '54000000-0000-4000-8000-000000000013','transient download',1
) AS value \gset import_deferred_
SELECT public.loomic_resource_import_defer(
  (:'import_value'::jsonb->>'import_job_id')::uuid,
  '54000000-0000-4000-8000-000000000013','transient download',1
) AS value \gset import_deferred_replay_
SELECT pg_temp.qa_assert(
  (:'import_deferred_replay_value'::jsonb->>'replayed')::boolean,
  'same-token import defer must replay'
);
UPDATE public.resource_import_jobs SET available_at=now()
WHERE id=(:'import_value'::jsonb->>'import_job_id')::uuid;
SELECT public.loomic_resource_import_claim('54000000-0000-4000-8000-000000000014',10);
SELECT pg_temp.qa_expect_error(format(
  'SELECT public.loomic_resource_import_finalize_item(%L::uuid,%L::uuid,%L::uuid,%L,NULL,NULL,NULL,%L,%L)',
  :'import_value'::jsonb->>'import_job_id','54000000-0000-4000-8000-000000000013',:'import_item_value','rejected','unsafe_svg','stale deferred worker'
),'resource_import_lost_lease');

SELECT public.loomic_resource_import_finalize_item(
  (:'import_value'::jsonb->>'import_job_id')::uuid,
  '54000000-0000-4000-8000-000000000014',:'import_item_value'::uuid,
  'rejected',NULL,NULL,NULL,'unsafe_svg','rejected'
) AS value \gset item_done_
SELECT public.loomic_resource_import_finalize_item(
  (:'import_value'::jsonb->>'import_job_id')::uuid,
  '54000000-0000-4000-8000-000000000014',:'import_item_value'::uuid,
  'rejected',NULL,NULL,NULL,'unsafe_svg','rejected'
) AS value \gset item_replay_
SELECT pg_temp.qa_assert(
  (:'item_replay_value'::jsonb->>'replayed')::boolean,
  'import finalization must replay'
);
SELECT id AS value FROM public.resource_import_items
WHERE import_job_id=(:'import_value'::jsonb->>'import_job_id')::uuid
  AND id<>:'import_item_value'::uuid LIMIT 1 \gset import_item_second_
SELECT public.loomic_resource_import_finalize_item(
  (:'import_value'::jsonb->>'import_job_id')::uuid,
  '54000000-0000-4000-8000-000000000014',:'import_item_second_value'::uuid,
  'rejected',NULL,NULL,NULL,'unsafe_svg','rejected'
);
SELECT public.loomic_resource_import_complete(
  (:'import_value'::jsonb->>'import_job_id')::uuid,
  '54000000-0000-4000-8000-000000000014'
) AS value \gset import_complete_
SELECT public.loomic_resource_import_complete(
  (:'import_value'::jsonb->>'import_job_id')::uuid,
  '54000000-0000-4000-8000-000000000014'
) AS value \gset import_complete_replay_
SELECT pg_temp.qa_assert(
  (:'import_complete_replay_value'::jsonb->>'replayed')::boolean
  AND (SELECT status='failed' AND failed_items=2
       FROM public.resource_import_jobs WHERE id=(:'import_value'::jsonb->>'import_job_id')::uuid),
  'same-token completion must replay and persist partial failure counts'
);

SELECT jsonb_build_array(
  jsonb_build_object(
    'source_key','category:icons','entity_kind','category','metadata',
    jsonb_build_object('payload',jsonb_build_object('name','Icons','slug','icons'))
  ),
  jsonb_build_object(
    'source_key','tag:featured','entity_kind','tag','metadata',
    jsonb_build_object('payload',jsonb_build_object('name','Featured','slug','featured'))
  ),
  jsonb_build_object(
    'source_key','text-preset:hero','entity_kind','text_preset','metadata',
    jsonb_build_object('payload',jsonb_build_object('name','Hero text'))
  )
) AS value \gset mixed_manifest_
SELECT public.loomic_resource_import_manifest_enqueue(
  '54000000-0000-4000-8000-000000000030','workspace','52000000-0000-4000-8000-000000000001',
  :'mixed_manifest_value'::jsonb,'51000000-0000-4000-8000-000000000001'
) AS value \gset mixed_import_
SELECT public.loomic_resource_import_manifest_enqueue(
  '54000000-0000-4000-8000-000000000030','workspace','52000000-0000-4000-8000-000000000001',
  :'mixed_manifest_value'::jsonb,'51000000-0000-4000-8000-000000000001'
) AS value \gset mixed_import_replay_
SELECT pg_temp.qa_assert(
  (:'mixed_import_replay_value'::jsonb->>'replayed')::boolean
  AND (:'mixed_import_value'::jsonb->>'import_job_id')=(:'mixed_import_replay_value'::jsonb->>'import_job_id')
  AND (SELECT source_kind='manifest' AND total_items=3
       FROM public.resource_import_jobs WHERE id=(:'mixed_import_value'::jsonb->>'import_job_id')::uuid)
  AND (SELECT count(*)=3 AND bool_and(asset_object_id IS NULL) AND bool_and(result_entity_kind IS NULL)
       FROM public.resource_import_items WHERE import_job_id=(:'mixed_import_value'::jsonb->>'import_job_id')::uuid)
  AND (SELECT array_agg(metadata->>'entity_kind' ORDER BY (metadata->>'manifest_index')::integer)
       =ARRAY['category','tag','text_preset']
       FROM public.resource_import_items WHERE import_job_id=(:'mixed_import_value'::jsonb->>'import_job_id')::uuid),
  'mixed manifest enqueue must atomically preserve metadata-only items and replay by request id'
);
SELECT pg_temp.qa_expect_error(format(
  'SELECT public.loomic_resource_import_manifest_enqueue(%L::uuid,%L,%L::uuid,%L::jsonb,%L::uuid)',
  '54000000-0000-4000-8000-000000000030','workspace','52000000-0000-4000-8000-000000000001',
  jsonb_set(:'mixed_manifest_value'::jsonb,'{0,metadata,payload,name}','"Changed"'::jsonb),
  '51000000-0000-4000-8000-000000000001'
),'catalog_idempotency_conflict');
SELECT pg_temp.qa_expect_error(format(
  'SELECT public.loomic_resource_import_manifest_enqueue(%L::uuid,%L,%L::uuid,%L::jsonb,%L::uuid)',
  '54000000-0000-4000-8000-000000000032','workspace','52000000-0000-4000-8000-000000000001',
  jsonb_build_array(
    jsonb_build_object('source_key','same','entity_kind','category','metadata','{}'::jsonb),
    jsonb_build_object('source_key',' same ','entity_kind','tag','metadata','{}'::jsonb)
  ),'51000000-0000-4000-8000-000000000001'
),'resource_import_manifest_source_key_duplicate');
SELECT pg_temp.qa_expect_error(format(
  'SELECT public.loomic_resource_import_manifest_enqueue(%L::uuid,%L,%L::uuid,%L::jsonb,%L::uuid)',
  '54000000-0000-4000-8000-000000000033','workspace','52000000-0000-4000-8000-000000000001',
  jsonb_build_array(jsonb_build_object(
    'source_key','bad-kind','entity_kind','archive','metadata','{}'::jsonb
  )),'51000000-0000-4000-8000-000000000001'
),'resource_import_manifest_invalid');
SELECT pg_temp.qa_expect_error(format(
  'SELECT public.loomic_resource_import_manifest_enqueue(%L::uuid,%L,%L::uuid,%L::jsonb,%L::uuid)',
  '54000000-0000-4000-8000-000000000034','workspace','52000000-0000-4000-8000-000000000001',
  jsonb_build_array(jsonb_build_object(
    'source_key','bad-metadata','entity_kind','resource','metadata','[]'::jsonb
  )),'51000000-0000-4000-8000-000000000001'
),'resource_import_manifest_invalid');

SELECT public.loomic_resource_import_claim('54000000-0000-4000-8000-000000000031',10);
SELECT public.loomic_resource_import_finalize_item(
  (:'mixed_import_value'::jsonb->>'import_job_id')::uuid,'54000000-0000-4000-8000-000000000031',
  (SELECT id FROM public.resource_import_items WHERE import_job_id=(:'mixed_import_value'::jsonb->>'import_job_id')::uuid AND source_key='category:icons'),
  'duplicate','category',(:'category_value'::jsonb->>'entity_id')::uuid,NULL,NULL,NULL
);
SELECT public.loomic_resource_import_finalize_item(
  (:'mixed_import_value'::jsonb->>'import_job_id')::uuid,'54000000-0000-4000-8000-000000000031',
  (SELECT id FROM public.resource_import_items WHERE import_job_id=(:'mixed_import_value'::jsonb->>'import_job_id')::uuid AND source_key='tag:featured'),
  'duplicate','tag',(:'tag_value'::jsonb->>'entity_id')::uuid,NULL,NULL,NULL
);
SELECT public.loomic_resource_import_finalize_item(
  (:'mixed_import_value'::jsonb->>'import_job_id')::uuid,'54000000-0000-4000-8000-000000000031',
  (SELECT id FROM public.resource_import_items WHERE import_job_id=(:'mixed_import_value'::jsonb->>'import_job_id')::uuid AND source_key='text-preset:hero'),
  'duplicate','text_preset',(:'text_preset_value'::jsonb->>'entity_id')::uuid,NULL,NULL,NULL
);
SELECT public.loomic_resource_import_complete(
  (:'mixed_import_value'::jsonb->>'import_job_id')::uuid,'54000000-0000-4000-8000-000000000031'
);
SELECT pg_temp.qa_assert(
  (SELECT status='completed' AND completed_items=3 AND failed_items=0
   FROM public.resource_import_jobs WHERE id=(:'mixed_import_value'::jsonb->>'import_job_id')::uuid)
  AND (SELECT count(*)=2 FROM public.resource_import_items
       WHERE import_job_id=(:'mixed_import_value'::jsonb->>'import_job_id')::uuid
         AND result_entity_kind IN ('category','tag')),
  'mixed manifest result kinds must finalize through the existing fenced lease protocol'
);
RESET ROLE;
SELECT pg_temp.qa_assert(
  private.loomic_asset_has_live_references('53000000-0000-4000-8000-000000000001'),
  'catalog references must remain GC-visible'
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"51000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
SELECT public.loomic_resource_favorite_set((:'resource_value'::jsonb->>'entity_id')::uuid,true);
SELECT public.loomic_resource_favorite_set((:'resource_value'::jsonb->>'entity_id')::uuid,true);
SELECT public.loomic_record_resource_recent_use((:'resource_value'::jsonb->>'entity_id')::uuid,'52000000-0000-4000-8000-000000000001');
SELECT public.loomic_record_resource_recent_use((:'resource_value'::jsonb->>'entity_id')::uuid,'52000000-0000-4000-8000-000000000001');
SELECT pg_temp.qa_assert(
  (SELECT count(*)=1 FROM public.resource_favorites WHERE user_id='51000000-0000-4000-8000-000000000002')
  AND (SELECT use_count=2 FROM public.resource_recent_uses WHERE user_id='51000000-0000-4000-8000-000000000002'),
  'favorite and recent use APIs must be idempotent/upserted per user'
);
SELECT pg_temp.qa_assert(
  (SELECT count(*)=1 FROM public.design_resources WHERE id=(:'resource_value'::jsonb->>'entity_id')::uuid),
  'workspace member must discover published resources'
);
SELECT pg_temp.qa_assert(
  (SELECT count(*)=1 FROM public.loomic_design_resources_list(
    NULL,NULL,'published','Hero',NULL,NULL,'png','landscape',NULL,NULL,30
  )),
  'resource listing must apply RLS, search, format, ratio and stable keyset inputs'
);
RESET ROLE;

\echo 'PASS Stage5 catalog CAS/idempotency/RLS/references/import/favorites'
ROLLBACK;
