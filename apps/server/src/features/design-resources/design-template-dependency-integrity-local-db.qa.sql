\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.qa_assert(condition boolean, message text)
RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'QA assertion failed: %', message; END IF;
END; $$;

CREATE OR REPLACE FUNCTION pg_temp.qa_expect_error(statement text, expected_message text)
RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  BEGIN EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    IF position(expected_message IN SQLERRM)=0 THEN
      RAISE EXCEPTION 'QA expected %, got %',expected_message,SQLERRM;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'QA expected %, statement succeeded',expected_message;
END; $$;

INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES ('00000000-0000-0000-0000-000000000000',
  'a7400000-0000-4000-8000-000000000001','authenticated','authenticated',
  'stage7-dependency@local.test','',now(),'{}','{}',now(),now());
INSERT INTO public.workspaces(id,type,name,owner_user_id)
VALUES ('a7400000-0000-4000-8000-000000000002','team','Stage 7 dependency',
  'a7400000-0000-4000-8000-000000000001');
INSERT INTO public.workspace_members(workspace_id,user_id,role)
VALUES ('a7400000-0000-4000-8000-000000000002',
  'a7400000-0000-4000-8000-000000000001','owner');
INSERT INTO public.projects(id,workspace_id,name,slug,created_by)
VALUES ('a7400000-0000-4000-8000-000000000003',
  'a7400000-0000-4000-8000-000000000002','Stage 7','stage-7',
  'a7400000-0000-4000-8000-000000000001');
INSERT INTO public.asset_objects(id,scope,workspace_id,bucket,object_path,mime_type,byte_size,created_by)
VALUES
  ('a7400000-0000-4000-8000-000000000004','workspace',
   'a7400000-0000-4000-8000-000000000002','workspace-assets','stage7/one.png',
   'image/png',10,'a7400000-0000-4000-8000-000000000001'),
  ('a7400000-0000-4000-8000-000000000005','workspace',
   'a7400000-0000-4000-8000-000000000002','workspace-assets','stage7/two.png',
   'image/png',10,'a7400000-0000-4000-8000-000000000001');
INSERT INTO public.design_resources(id,scope,workspace_id,kind,name,asset_object_id,
  width,height,checksum_sha256,created_by,updated_by)
VALUES ('a7400000-0000-4000-8000-000000000006','workspace',
  'a7400000-0000-4000-8000-000000000002','image','Stage 7 resource',
  'a7400000-0000-4000-8000-000000000004',1,1,repeat('a',64),
  'a7400000-0000-4000-8000-000000000001',
  'a7400000-0000-4000-8000-000000000001');

INSERT INTO public.design_documents(id,workspace_id,project_id,name,scene,width,height,created_by,updated_by)
VALUES ('a7400000-0000-4000-8000-000000000007',
  'a7400000-0000-4000-8000-000000000002',
  'a7400000-0000-4000-8000-000000000003','Stage 7 design',
  '{"schemaVersion":1,"engine":"fabric","canvas":{"width":1,"height":1,"background":null},"objects":[]}',
  1,1,'a7400000-0000-4000-8000-000000000001',
  'a7400000-0000-4000-8000-000000000001');

SELECT pg_temp.qa_expect_error($sql$
  INSERT INTO public.design_document_asset_refs(
    design_id,workspace_id,object_id,slot,asset_object_id,resource_id
  ) VALUES (
    'a7400000-0000-4000-8000-000000000007',
    'a7400000-0000-4000-8000-000000000002','image','source',
    'a7400000-0000-4000-8000-000000000005',
    'a7400000-0000-4000-8000-000000000006'
  )
$sql$,'design_resource_workspace_mismatch');

INSERT INTO public.design_templates(
  id,scope,workspace_id,name,scene,width,height,variables,created_by,updated_by
) VALUES (
  'a7400000-0000-4000-8000-000000000008','workspace',
  'a7400000-0000-4000-8000-000000000002','Stage 7 template',
  '{"schemaVersion":1,"engine":"fabric","canvas":{"width":1,"height":1,"background":null},"objects":[{"objectId":"a7400000-0000-4000-8000-000000000009","objectVersion":1,"type":"image","x":0,"y":0,"width":1,"height":1,"rotation":0,"opacity":1,"zIndex":0,"locked":false,"visible":true,"assetObjectId":"a7400000-0000-4000-8000-000000000004","fit":"cover"}]}',
  1,1,
  '[{"key":"hero","label":"Hero","type":"image","required":false,"target":{"object_id":"a7400000-0000-4000-8000-000000000009","property":"asset_object_id"},"default_value":{"asset_object_id":"a7400000-0000-4000-8000-000000000004","resource_id":"a7400000-0000-4000-8000-000000000006"}}]',
  'a7400000-0000-4000-8000-000000000001',
  'a7400000-0000-4000-8000-000000000001'
);
SET CONSTRAINTS design_templates_sync_variable_references IMMEDIATE;
SELECT pg_temp.qa_assert(EXISTS (
  SELECT 1 FROM public.design_template_asset_refs
  WHERE template_id='a7400000-0000-4000-8000-000000000008'
    AND slot='variable:hero'
    AND asset_object_id='a7400000-0000-4000-8000-000000000004'
    AND resource_id='a7400000-0000-4000-8000-000000000006'
), 'template image defaults must be normalized into asset refs');

SELECT pg_temp.qa_expect_error($sql$
  UPDATE public.design_templates SET variables =
    '[{"key":"hero","label":"Hero","type":"image","required":false,"target":{"object_id":"a7400000-0000-4000-8000-000000000009","property":"asset_object_id"},"default_value":{"asset_object_id":"a7400000-0000-4000-8000-000000000005","resource_id":"a7400000-0000-4000-8000-000000000006"}}]'
  WHERE id='a7400000-0000-4000-8000-000000000008'
$sql$,'template_variable_image_dependency_unavailable');

ROLLBACK;
