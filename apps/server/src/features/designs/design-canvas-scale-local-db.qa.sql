\set ON_ERROR_STOP on
\pset pager off

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.qa_assert(condition boolean, message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'QA assertion failed: %', message;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.qa_expect_error(statement text, expected_message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    IF position(expected_message IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'QA expected error containing %, got %', expected_message, SQLERRM;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'QA expected error containing %, but statement succeeded', expected_message;
END;
$$;

INSERT INTO auth.users(
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  '00000000-0000-0000-0000-000000000000',
  'a1000000-0000-4000-8000-000000000001',
  'authenticated','authenticated','scale-owner@local.test','',now(),'{}','{}',now(),now()
);
INSERT INTO public.workspaces(id, type, name, owner_user_id) VALUES (
  'a2000000-0000-4000-8000-000000000001','team','Scale QA',
  'a1000000-0000-4000-8000-000000000001'
);
INSERT INTO public.workspace_members(workspace_id, user_id, role) VALUES (
  'a2000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001','owner'
);
INSERT INTO public.projects(id, workspace_id, name, slug, created_by) VALUES (
  'a3000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000001','Scale QA Project','scale-qa',
  'a1000000-0000-4000-8000-000000000001'
);
INSERT INTO public.canvases(id, project_id, name, is_primary, created_by, content) VALUES (
  'a4000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000001','Scale QA Canvas',true,
  'a1000000-0000-4000-8000-000000000001','{"elements":[],"appState":{}}'
);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
SELECT public.loomic_design_create(
  'a5000000-0000-4000-8000-000000000001',
  'a4000000-0000-4000-8000-000000000001',0,'scale-node',
  'Scale design',400,400,10,20,320,320,NULL,NULL
) AS value
\gset created_
RESET ROLE;

SELECT (:'created_value'::jsonb->>'design_id')::uuid AS value
\gset design_

-- Establish a persisted 100x100 square at v4. Version 4 is intentional so
-- the scale/undo/redo sequence can assert v5/v6/v7 in higher layers.
UPDATE public.design_documents
SET scene = '{
  "schemaVersion":1,
  "engine":"fabric",
  "canvas":{"width":400,"height":400,"background":null},
  "objects":[{
    "objectId":"a6000000-0000-4000-8000-000000000001",
    "objectVersion":4,
    "type":"rect",
    "x":50,"y":50,"width":100,"height":100,
    "rotation":0,"opacity":1,"zIndex":0,"locked":false,"visible":true,
    "fill":{"kind":"solid","color":"#ff0000"},
    "stroke":null,"strokeWidth":0,"shadow":null
  }]
}'::jsonb,
revision = 4
WHERE id = :'design_value'::uuid;

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT public.loomic_design_mutate(
  :'design_value'::uuid,
  4,
  'a7000000-0000-4000-8000-000000000001',
  '[{"action":"canvas.update","width":800,"height":400,"resize_mode":"scale"}]'::jsonb,
  '{
    "schemaVersion":1,
    "engine":"fabric",
    "canvas":{"width":800,"height":400,"background":null},
    "objects":[{
      "objectId":"a6000000-0000-4000-8000-000000000001",
      "objectVersion":5,
      "type":"rect",
      "x":250,"y":50,"width":100,"height":100,
      "rotation":0,"opacity":1,"zIndex":0,"locked":false,"visible":true,
      "fill":{"kind":"solid","color":"#ff0000"},
      "stroke":null,"strokeWidth":0,"shadow":null
    }]
  }'::jsonb,
  'user','a1000000-0000-4000-8000-000000000001',NULL,NULL
) AS value
\gset scaled_
SELECT public.loomic_design_mutate(
  :'design_value'::uuid,
  4,
  'a7000000-0000-4000-8000-000000000001',
  '[{"action":"canvas.update","width":800,"height":400,"resize_mode":"scale"}]'::jsonb,
  '{
    "schemaVersion":1,
    "engine":"fabric",
    "canvas":{"width":800,"height":400,"background":null},
    "objects":[{
      "objectId":"a6000000-0000-4000-8000-000000000001",
      "objectVersion":5,
      "type":"rect",
      "x":250,"y":50,"width":100,"height":100,
      "rotation":0,"opacity":1,"zIndex":0,"locked":false,"visible":true,
      "fill":{"kind":"solid","color":"#ff0000"},
      "stroke":null,"strokeWidth":0,"shadow":null
    }]
  }'::jsonb,
  'user','a1000000-0000-4000-8000-000000000001',NULL,NULL
) AS value
\gset replayed_
RESET ROLE;

SELECT pg_temp.qa_assert(
  (:'scaled_value'::jsonb->>'revision')::bigint = 5
  AND (:'replayed_value'::jsonb->>'replayed')::boolean
  AND (SELECT scene#>>'{canvas,width}' = '800'
       AND scene#>>'{objects,0,x}' = '250'
       AND scene#>>'{objects,0,width}' = '100'
       AND scene#>>'{objects,0,height}' = '100'
       AND scene#>>'{objects,0,objectVersion}' = '5'
       FROM public.design_documents WHERE id = :'design_value'::uuid),
  'scale must fit-center without stretching and increment objectVersion once'
);
SELECT pg_temp.qa_assert(
  (SELECT command_batch#>>'{0,action}' = 'canvas.update'
   FROM public.design_document_versions
   WHERE design_id = :'design_value'::uuid AND revision = 5),
  'persisted history must retain the canvas.update command'
);

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT pg_temp.qa_expect_error(
  format(
    $sql$SELECT public.loomic_design_mutate(
      %L::uuid,5,%L::uuid,
      '[{"action":"canvas.update","width":400,"height":400,"resize_mode":"scale"}]'::jsonb,
      %L::jsonb,'user',%L::uuid,NULL,NULL
    )$sql$,
    :'design_value','a7000000-0000-4000-8000-000000000002',
    '{"schemaVersion":1,"engine":"fabric","canvas":{"width":400,"height":400,"background":null},"objects":[{"objectId":"a6000000-0000-4000-8000-000000000001","objectVersion":6,"type":"rect","x":50,"y":50,"width":200,"height":100,"rotation":0,"opacity":1,"zIndex":0,"locked":false,"visible":true,"fill":{"kind":"solid","color":"#ff0000"},"stroke":null,"strokeWidth":0,"shadow":null}]}',
    'a1000000-0000-4000-8000-000000000001'
  ),
  'design_canvas_scale_mismatch'
);
RESET ROLE;

ROLLBACK;
