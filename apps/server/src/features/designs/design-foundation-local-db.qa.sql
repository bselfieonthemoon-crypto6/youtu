\set ON_ERROR_STOP on
\pset pager off

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.qa_assert(condition boolean, message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF condition IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'QA assertion failed: %', message;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.qa_expect_error(statement text, expected_message text)
RETURNS void
LANGUAGE plpgsql
AS $$
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

CREATE OR REPLACE FUNCTION pg_temp.qa_statement_rejected(statement text)
RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    RETURN true;
  END;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.qa_design_object_base(
  object_id text,
  object_type text,
  z_index integer
)
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT jsonb_build_object(
    'objectId', object_id,
    'objectVersion', 1,
    'type', object_type,
    'zIndex', z_index,
    'x', z_index * 10,
    'y', z_index * 10,
    'width', 100,
    'height', 80,
    'rotation', 0,
    'opacity', 1,
    'locked', false,
    'visible', true
  );
$$;

CREATE OR REPLACE FUNCTION pg_temp.qa_design_scene(objects jsonb)
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT jsonb_build_object(
    'schemaVersion', 1,
    'engine', 'fabric',
    'canvas', jsonb_build_object(
      'width', 1080, 'height', 1080, 'background', '#ffffff'
    ),
    'objects', objects
  );
$$;

-- Deterministic local-only principals and tenancy fixtures. The auth trigger also
-- creates personal workspaces; the QA assertions use the explicit team workspaces.
INSERT INTO auth.users(
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'design-owner@local.test', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'design-admin@local.test', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333333', 'authenticated', 'authenticated', 'design-member@local.test', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '44444444-4444-4444-4444-444444444444', 'authenticated', 'authenticated', 'design-other-owner@local.test', '', now(), '{}', '{}', now(), now());

INSERT INTO public.workspaces(id, type, name, owner_user_id) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'team', 'Design QA Workspace A', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'team', 'Design QA Workspace B', '44444444-4444-4444-4444-444444444444');

INSERT INTO public.workspace_members(workspace_id, user_id, role) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'admin'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'member'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '44444444-4444-4444-4444-444444444444', 'owner');

INSERT INTO public.projects(id, workspace_id, name, slug, created_by) VALUES
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Design QA Project A', 'design-qa-a', '11111111-1111-1111-1111-111111111111'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Design QA Project B', 'design-qa-b', '44444444-4444-4444-4444-444444444444');

INSERT INTO public.canvases(id, project_id, name, is_primary, created_by, content) VALUES
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'Design QA Canvas A', true, '11111111-1111-1111-1111-111111111111', '{"elements":[],"appState":{}}'),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'Design QA Canvas B', true, '44444444-4444-4444-4444-444444444444', '{"elements":[],"appState":{}}');

-- Tables, FORCE RLS, and grants.
SELECT pg_temp.qa_assert(
  NOT EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'platform_admins', 'design_documents', 'design_creation_requests',
      'design_nodes', 'design_document_versions', 'design_document_asset_refs',
      'design_document_font_refs', 'design_templates', 'design_template_asset_refs',
      'text_presets', 'design_resources', 'font_families', 'font_faces',
      'resource_categories', 'resource_tags', 'resource_tag_links',
      'resource_favorites', 'resource_recent_uses', 'resource_import_jobs',
      'resource_import_items', 'job_target_finalizations', 'design_event_outbox'
    ]) AS expected(table_name)
    LEFT JOIN pg_class c ON c.relname = expected.table_name
    LEFT JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE c.oid IS NULL OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity
  ),
  'every design foundation table must exist with RLS and FORCE RLS'
);

SELECT pg_temp.qa_assert(
  has_table_privilege('authenticated', 'public.design_documents', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.design_documents', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.design_documents', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.design_documents', 'DELETE')
  AND NOT has_table_privilege('authenticated', 'public.design_creation_requests', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.job_target_finalizations', 'SELECT'),
  'authenticated table grant matrix must be read-only/controlled-RPC'
);

SELECT pg_temp.qa_assert(
  has_function_privilege('authenticated', 'public.loomic_design_create(uuid,uuid,bigint,text,text,integer,integer,double precision,double precision,double precision,double precision,text,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.loomic_design_create(uuid,uuid,bigint,text,text,integer,integer,double precision,double precision,double precision,double precision,text,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.loomic_design_mutate(uuid,bigint,uuid,jsonb,jsonb,text,uuid,uuid,uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.loomic_design_mutate(uuid,bigint,uuid,jsonb,jsonb,text,uuid,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.loomic_asset_gc_claim(uuid,timestamptz)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.loomic_asset_gc_claim(uuid,timestamptz)', 'EXECUTE'),
  'RPC grant matrix must separate authenticated creation from service mutation/GC'
);

\echo 'PASS tables/RLS/grant matrix'

-- Every persisted Shared object variant is accepted with its canonical keys.
SELECT private.loomic_validate_design_scene(
  pg_temp.qa_design_scene(jsonb_build_array(
    pg_temp.qa_design_object_base('84000000-0000-0000-0000-000000000001', 'image', 0)
      || jsonb_build_object(
        'assetObjectId','85000000-0000-0000-0000-000000000001',
        'resourceId',NULL,'fit','cover','flipX',false,'flipY',true
      ),
    pg_temp.qa_design_object_base('84000000-0000-0000-0000-000000000002', 'svg', 1)
      || jsonb_build_object(
        'assetObjectId','85000000-0000-0000-0000-000000000002',
        'resourceId',NULL,'flipX',false,'flipY',false
      ),
    pg_temp.qa_design_object_base('84000000-0000-0000-0000-000000000003', 'text', 2)
      || jsonb_build_object(
        'text','Text','fontFaceId',NULL,'fontFamily','Arial','fontSize',24,
        'fontWeight',400,'fontStyle','normal','textAlign','left','lineHeight',1.2,
        'charSpacing',0,'fill',jsonb_build_object('kind','solid','color','#000'),
        'stroke',NULL,'strokeWidth',0,
        'shadow',jsonb_build_object(
          'color','#000','blur',2,'offsetX',1,'offsetY',1,'opacity',0.5
        )
      ),
    pg_temp.qa_design_object_base('84000000-0000-0000-0000-000000000004', 'textbox', 3)
      || jsonb_build_object(
        'text','Textbox','fontFamily','Arial','fontSize',24,'fontWeight','bold',
        'fontStyle','italic','textAlign','center','lineHeight',1.2,'charSpacing',0,
        'fill',jsonb_build_object(
          'kind','linear','angle',0,'stops',jsonb_build_array(
            jsonb_build_object('offset',0,'color','#000'),
            jsonb_build_object('offset',1,'color','#fff')
          )
        ),'minWidth',40
      ),
    pg_temp.qa_design_object_base('84000000-0000-0000-0000-000000000005', 'rect', 4)
      || jsonb_build_object(
        'fill',jsonb_build_object('kind','solid','color','#f00'),
        'stroke',NULL,'strokeWidth',1,'radiusX',4,'radiusY',4
      ),
    pg_temp.qa_design_object_base('84000000-0000-0000-0000-000000000006', 'circle', 5)
      || jsonb_build_object('fill',NULL,'stroke',NULL,'strokeWidth',0),
    pg_temp.qa_design_object_base('84000000-0000-0000-0000-000000000007', 'triangle', 6)
      || jsonb_build_object('fill',NULL,'stroke',NULL,'strokeWidth',0),
    pg_temp.qa_design_object_base('84000000-0000-0000-0000-000000000008', 'line', 7)
      || jsonb_build_object(
        'stroke',jsonb_build_object('kind','solid','color','#111'),
        'strokeWidth',2,'x1',0,'y1',0,'x2',100,'y2',80
      ),
    pg_temp.qa_design_object_base('84000000-0000-0000-0000-000000000009', 'arrow', 8)
      || jsonb_build_object(
        'stroke',jsonb_build_object('kind','solid','color','#111'),
        'strokeWidth',2,'x1',0,'y1',0,'x2',100,'y2',80,
        'arrowStart','none','arrowEnd','arrow'
      ),
    pg_temp.qa_design_object_base('84000000-0000-0000-0000-000000000010', 'group', 9)
      || jsonb_build_object(
        'childObjectIds',jsonb_build_array('84000000-0000-0000-0000-000000000005')
      )
  )),
  1080,
  1080
);

-- SQL must reject the same malformed rects rejected by Shared.
SELECT pg_temp.qa_expect_error(
  $sql$SELECT private.loomic_validate_design_scene(
    pg_temp.qa_design_scene(jsonb_build_array(
      pg_temp.qa_design_object_base('84000000-0000-0000-0000-000000000021','rect',0)
        || jsonb_build_object('fill','red','stroke',NULL,'strokeWidth',0)
    )),1080,1080
  )$sql$,
  'design_objects_invalid'
);
SELECT pg_temp.qa_expect_error(
  $sql$SELECT private.loomic_validate_design_scene(
    pg_temp.qa_design_scene(jsonb_build_array(
      pg_temp.qa_design_object_base('84000000-0000-0000-0000-000000000022','rect',0)
        || jsonb_build_object('fill',NULL,'stroke',NULL,'strokeWidth',-99)
    )),1080,1080
  )$sql$,
  'design_objects_invalid'
);
SELECT pg_temp.qa_expect_error(
  $sql$SELECT private.loomic_validate_design_scene(
    pg_temp.qa_design_scene(jsonb_build_array(
      pg_temp.qa_design_object_base('84000000-0000-0000-0000-000000000023','rect',0)
        || jsonb_build_object(
          'fill',NULL,'stroke',NULL,'strokeWidth',0,'unexpectedField',true
        )
    )),1080,1080
  )$sql$,
  'design_objects_invalid'
);

\echo 'PASS strict typed scene objects and malformed rect rejection'

-- Owner atomic creation.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
SELECT
  response->>'design_id' AS design_id,
  response->>'canvas_element_id' AS element_id,
  (response->>'canvas_revision')::bigint AS canvas_revision,
  (response->>'replayed')::boolean AS replayed
FROM (
  SELECT public.loomic_design_create(
    '10000000-0000-0000-0000-000000000001',
    'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 0, 'design-node-owner',
    'Owner design', 1080, 1080, 10, 20, 320, 320, '#ffffff', NULL
  ) AS response
) created
\gset owner_
SELECT pg_temp.qa_assert(:'owner_canvas_revision'::bigint = 1 AND NOT :'owner_replayed'::boolean, 'owner create response');
RESET ROLE;

SELECT pg_temp.qa_assert(
  (SELECT revision = 1 AND jsonb_array_length(content->'elements') = 1 FROM public.canvases WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee')
  AND (SELECT count(*) = 1 FROM public.design_documents WHERE id = :'owner_design_id'::uuid AND revision = 0)
  AND (SELECT count(*) = 1 FROM public.design_nodes WHERE design_id = :'owner_design_id'::uuid AND element_id = 'design-node-owner')
  AND (SELECT count(*) = 1 FROM public.design_document_versions WHERE design_id = :'owner_design_id'::uuid AND revision = 0)
  AND (SELECT count(*) = 1 FROM public.design_event_outbox WHERE design_id = :'owner_design_id'::uuid AND revision = 0),
  'owner creation must atomically persist document, node, version, outbox and canvas revision'
);

-- Admin creation on the same canvas at the next revision.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
SELECT public.loomic_design_create(
  '10000000-0000-0000-0000-000000000002',
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 1, 'design-node-admin',
  'Admin design', 1200, 628, 400, 20, 320, 168, '#ffffff', NULL
) AS response
\gset admin_
SELECT pg_temp.qa_assert((:'admin_response'::jsonb->>'canvas_revision')::bigint = 2, 'admin create must succeed');

-- Same request is replayed before the stale revision is considered.
SELECT public.loomic_design_create(
  '10000000-0000-0000-0000-000000000002',
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 0, 'design-node-admin',
  'Admin design', 1200, 628, 400, 20, 320, 168, '#ffffff', NULL
) AS response
\gset admin_replay_
SELECT pg_temp.qa_assert(
  (:'admin_replay_response'::jsonb->>'design_id') = (:'admin_response'::jsonb->>'design_id')
  AND (:'admin_replay_response'::jsonb->>'replayed')::boolean,
  'same create request must return the original design'
);

SELECT pg_temp.qa_expect_error(
  $$SELECT public.loomic_design_create(
    '10000000-0000-0000-0000-000000000003',
    'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 0, 'design-node-conflict',
    'Conflict design', 1080, 1080, 0, 0, 320, 320, '#ffffff', NULL
  )$$,
  'canvas_revision_conflict'
);
RESET ROLE;

SELECT pg_temp.qa_assert(
  (SELECT revision = 2 AND jsonb_array_length(content->'elements') = 2 FROM public.canvases WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee')
  AND NOT EXISTS (SELECT 1 FROM public.design_nodes WHERE element_id = 'design-node-conflict')
  AND NOT EXISTS (SELECT 1 FROM public.design_creation_requests WHERE request_id = '10000000-0000-0000-0000-000000000003'),
  'canvas revision conflict must roll back every create side effect'
);

-- A design in workspace B is used for RLS isolation checks.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', true);
SELECT public.loomic_design_create(
  '10000000-0000-0000-0000-000000000004',
  'ffffffff-ffff-ffff-ffff-ffffffffffff', 0, 'design-node-other',
  'Other design', 800, 600, 0, 0, 320, 240, '#ffffff', NULL
) AS response
\gset other_
RESET ROLE;

-- Workspace A owner cannot see or create in workspace B.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
SELECT pg_temp.qa_assert(
  (SELECT count(*) FROM public.design_documents WHERE id = (:'other_response'::jsonb->>'design_id')::uuid) = 0,
  'cross-workspace design SELECT must be hidden by RLS'
);
SELECT pg_temp.qa_expect_error(
  $$SELECT public.loomic_design_create(
    '10000000-0000-0000-0000-000000000005',
    'ffffffff-ffff-ffff-ffff-ffffffffffff', 1, 'design-node-cross',
    'Cross design', 800, 600, 0, 0, 320, 240, '#ffffff', NULL
  )$$,
  'canvas_not_found_or_forbidden'
);
RESET ROLE;

-- Plain members can read their workspace but cannot write directly or via create RPC.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
SELECT pg_temp.qa_assert(
  (SELECT count(*) FROM public.design_documents WHERE workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') = 2,
  'workspace member must read workspace designs'
);
SELECT pg_temp.qa_expect_error(
  $$SELECT public.loomic_design_create(
    '10000000-0000-0000-0000-000000000006',
    'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 2, 'design-node-member',
    'Member design', 1080, 1080, 0, 0, 320, 320, '#ffffff', NULL
  )$$,
  'canvas_not_found_or_forbidden'
);
SELECT pg_temp.qa_expect_error(
  format('UPDATE public.design_documents SET name = %L WHERE id = %L::uuid', 'forbidden', :'owner_design_id'),
  'permission denied'
);
RESET ROLE;

\echo 'PASS owner/admin create, member rejection, replay, CAS, cross-workspace RLS'

-- Service mutation: first write, idempotent replay, document CAS, and object CAS.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000000","role":"service_role"}', true);
SELECT public.loomic_design_mutate(
  :'owner_design_id'::uuid,
  0,
  '20000000-0000-0000-0000-000000000001',
  jsonb_build_array(jsonb_build_object(
    'action', 'object.add',
    'object', jsonb_build_object(
      'objectId', '90000000-0000-0000-0000-000000000001',
      'objectVersion', 1,
      'zIndex', 0,
      'type', 'text',
      'text', 'QA object',
      'x', 0, 'y', 0, 'width', 240, 'height', 48,
      'rotation', 0, 'opacity', 1, 'locked', false, 'visible', true,
      'fontFamily', 'Arial', 'fontSize', 24, 'fontWeight', 400,
      'fontStyle', 'normal', 'textAlign', 'left', 'lineHeight', 1.2,
      'charSpacing', 0,
      'fill', jsonb_build_object('kind', 'solid', 'color', '#000000')
    )
  )),
  jsonb_build_object(
    'schemaVersion', 1,
    'engine', 'fabric',
    'canvas', jsonb_build_object('width', 1080, 'height', 1080, 'background', '#ffffff'),
    'objects', jsonb_build_array(jsonb_build_object(
        'objectId', '90000000-0000-0000-0000-000000000001',
        'objectVersion', 1,
        'zIndex', 0,
        'type', 'text',
        'text', 'QA object',
        'x', 0, 'y', 0, 'width', 240, 'height', 48,
        'rotation', 0, 'opacity', 1, 'locked', false, 'visible', true,
        'fontFamily', 'Arial', 'fontSize', 24, 'fontWeight', 400,
        'fontStyle', 'normal', 'textAlign', 'left', 'lineHeight', 1.2,
        'charSpacing', 0,
        'fill', jsonb_build_object('kind', 'solid', 'color', '#000000')
    ))
  ),
  'system',
  '11111111-1111-1111-1111-111111111111',
  NULL,
  NULL
) AS response
\gset mutate_first_
SELECT pg_temp.qa_assert(
  (:'mutate_first_response'::jsonb->>'revision')::bigint = 1
  AND NOT (:'mutate_first_response'::jsonb->>'replayed')::boolean,
  'first service mutation must commit revision 1'
);

SELECT public.loomic_design_mutate(
  :'owner_design_id'::uuid,
  999,
  '20000000-0000-0000-0000-000000000001',
  '[{"action":"scene.replace","scene":{}}]'::jsonb,
  '{}'::jsonb,
  'system',
  '11111111-1111-1111-1111-111111111111',
  NULL,
  NULL
) AS response
\gset mutate_replay_
SELECT pg_temp.qa_assert(
  (:'mutate_replay_response'::jsonb->>'revision')::bigint = 1
  AND (:'mutate_replay_response'::jsonb->>'replayed')::boolean,
  'mutation idempotency must win before stale revision/payload validation'
);

SELECT pg_temp.qa_expect_error(
  format($sql$SELECT public.loomic_design_mutate(
    %L::uuid, 0, '20000000-0000-0000-0000-000000000002',
    '[{"action":"scene.replace","scene":{}}]'::jsonb, '{}'::jsonb,
    'system', '11111111-1111-1111-1111-111111111111', NULL, NULL
  )$sql$, :'owner_design_id'),
  'design_revision_conflict'
);

SELECT pg_temp.qa_expect_error(
  format($sql$SELECT public.loomic_design_mutate(
    %L::uuid, 1, '20000000-0000-0000-0000-000000000003',
    jsonb_build_array(jsonb_build_object(
      'action','object.update',
      'object_id','90000000-0000-0000-0000-000000000001',
      'expected_object_version',99,
      'patch',jsonb_build_object('object_type','text')
    )),
    jsonb_build_object(
      'schemaVersion',1,'engine','fabric',
      'canvas',jsonb_build_object('width',1080,'height',1080,'background','#ffffff'),
      'objects',jsonb_build_array(jsonb_build_object(
        'objectId','90000000-0000-0000-0000-000000000001',
        'objectVersion',100,'zIndex',0,'type','text','text','bad update',
        'x',0,'y',0,'width',240,'height',48,'rotation',0,'opacity',1,
        'locked',false,'visible',true,'fontFamily','Arial','fontSize',24,
        'fontWeight',400,'fontStyle','normal','textAlign','left',
        'lineHeight',1.2,'charSpacing',0,
        'fill',jsonb_build_object('kind','solid','color','#000000')
      ))
    ),
    'system','11111111-1111-1111-1111-111111111111',NULL,NULL
  )$sql$, :'owner_design_id'),
  'design_object_version_conflict'
);

-- next_scene is data, never authority: an update command cannot smuggle a
-- second field change or an unrelated new object into the same revision.
SELECT pg_temp.qa_expect_error(
  format($sql$
    WITH source AS (
      SELECT scene FROM public.design_documents WHERE id = %L::uuid
    )
    SELECT public.loomic_design_mutate(
      %L::uuid, 1, '20000000-0000-0000-0000-000000000004',
      '[{"action":"object.update","object_id":"90000000-0000-0000-0000-000000000001","expected_object_version":1,"patch":{"object_type":"text","x":12}}]'::jsonb,
      jsonb_set(
        jsonb_set(
          jsonb_set(scene, '{objects,0,x}', '12'::jsonb),
          '{objects,0,objectVersion}', '2'::jsonb
        ),
        '{objects,0,text}', '"tampered outside patch"'::jsonb
      ),
      'system', '11111111-1111-1111-1111-111111111111', NULL, NULL
    ) FROM source
  $sql$, :'owner_design_id', :'owner_design_id'),
  'design_object_update_mismatch'
);

SELECT pg_temp.qa_expect_error(
  format($sql$
    WITH source AS (
      SELECT jsonb_set(
        jsonb_set(scene, '{objects,0,x}', '12'::jsonb),
        '{objects,0,objectVersion}', '2'::jsonb
      ) AS next_scene
      FROM public.design_documents WHERE id = %L::uuid
    )
    SELECT public.loomic_design_mutate(
      %L::uuid, 1, '20000000-0000-0000-0000-000000000005',
      '[{"action":"object.update","object_id":"90000000-0000-0000-0000-000000000001","expected_object_version":1,"patch":{"object_type":"text","x":12}}]'::jsonb,
      jsonb_set(
        next_scene,
        '{objects}',
        next_scene->'objects' || jsonb_build_array(jsonb_build_object(
          'objectId','90000000-0000-0000-0000-000000000077',
          'objectVersion',77,'zIndex',1,'type','rect',
          'x',0,'y',0,'width',10,'height',10,'rotation',0,'opacity',1,
          'locked',false,'visible',true,'fill',NULL,'stroke',NULL,'strokeWidth',0
        ))
      ),
      'system', '11111111-1111-1111-1111-111111111111', NULL, NULL
    ) FROM source
  $sql$, :'owner_design_id', :'owner_design_id'),
  'design_object_order_mismatch'
);
RESET ROLE;

SELECT pg_temp.qa_assert(
  (SELECT revision = 1 FROM public.design_documents WHERE id = :'owner_design_id'::uuid)
  AND (SELECT count(*) = 1 FROM public.design_document_versions WHERE design_id = :'owner_design_id'::uuid AND revision = 1)
  AND (SELECT count(*) = 1 FROM public.design_event_outbox WHERE design_id = :'owner_design_id'::uuid AND revision = 1),
  'failed/replayed mutations must not add revisions or outbox rows'
);

\echo 'PASS service mutation replay and revision/object conflict behavior'

-- Finalization ledger uniqueness by target and by command.
INSERT INTO public.background_jobs(
  id, workspace_id, project_id, canvas_id, design_id, target_kind,
  queue_name, job_type, status, payload, result, created_by
) VALUES (
  '70000000-0000-0000-0000-000000000001',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  NULL,
  :'owner_design_id'::uuid,
  'design',
  'image_generation_jobs',
  'image_generation',
  'succeeded',
  '{}',
  '{}',
  '11111111-1111-1111-1111-111111111111'
);

INSERT INTO public.job_target_finalizations(
  job_id, workspace_id, target_kind, target_id, status, command_id
) VALUES (
  '70000000-0000-0000-0000-000000000001',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'design',
  :'owner_design_id'::uuid,
  'completed',
  '71000000-0000-0000-0000-000000000001'
);

SELECT pg_temp.qa_expect_error(
  format($sql$INSERT INTO public.job_target_finalizations(
    job_id, workspace_id, target_kind, target_id, status, command_id
  ) VALUES (
    '70000000-0000-0000-0000-000000000001',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'design', %L::uuid, 'completed', '71000000-0000-0000-0000-000000000002'
  )$sql$, :'owner_design_id'),
  'job_target_finalizations_target_key'
);

SELECT pg_temp.qa_expect_error(
  $$INSERT INTO public.job_target_finalizations(
    job_id, workspace_id, target_kind, target_id, status, command_id
  ) VALUES (
    '70000000-0000-0000-0000-000000000001',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'canvas', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'completed',
    '71000000-0000-0000-0000-000000000001'
  )$$,
  'job_target_finalizations_command_key'
);

\echo 'PASS finalization ledger uniqueness'

-- GC case 1: a new live reference after claim cancels the claim.
INSERT INTO public.asset_objects(
  id, scope, workspace_id, project_id, bucket, object_path, mime_type,
  created_by, gc_eligible_at
) VALUES (
  '80000000-0000-0000-0000-000000000001', 'workspace',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'workspace-assets', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/design-qa/gc-cancel.png',
  'image/png', '11111111-1111-1111-1111-111111111111', now() - interval '1 hour'
);

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000000","role":"service_role"}', true);
SELECT claim_token
FROM public.loomic_asset_gc_claim('80000000-0000-0000-0000-000000000001', now())
\gset gc_cancel_
RESET ROLE;
SELECT pg_temp.qa_assert(:'gc_cancel_claim_token'::uuid IS NOT NULL, 'eligible asset must be claimable');

INSERT INTO public.design_document_asset_refs(
  design_id, workspace_id, object_id, slot, asset_object_id
) VALUES (
  :'owner_design_id'::uuid,
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'gc-reference-after-claim', 'source',
  '80000000-0000-0000-0000-000000000001'
);
SELECT pg_temp.qa_assert(
  (SELECT gc_eligible_at IS NULL AND gc_claim_token IS NULL AND gc_claimed_at IS NULL
   FROM public.asset_objects WHERE id = '80000000-0000-0000-0000-000000000001'),
  'new reference must cancel an unprepared GC claim'
);

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000000","role":"service_role"}', true);
SELECT pg_temp.qa_assert(
  NOT public.loomic_asset_gc_prepare_delete(
    '80000000-0000-0000-0000-000000000001', :'gc_cancel_claim_token'::uuid
  ),
  'old claim token must not prepare a newly referenced asset'
);
RESET ROLE;

-- GC case 2: once delete is prepared, a new reference is rejected.
INSERT INTO public.asset_objects(
  id, scope, workspace_id, project_id, bucket, object_path, mime_type,
  created_by, gc_eligible_at
) VALUES (
  '80000000-0000-0000-0000-000000000002', 'workspace',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'workspace-assets', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/design-qa/gc-reject.png',
  'image/png', '11111111-1111-1111-1111-111111111111', now() - interval '1 hour'
);

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000000","role":"service_role"}', true);
SELECT claim_token
FROM public.loomic_asset_gc_claim('80000000-0000-0000-0000-000000000002', now())
\gset gc_reject_
SELECT pg_temp.qa_assert(
  public.loomic_asset_gc_prepare_delete(
    '80000000-0000-0000-0000-000000000002', :'gc_reject_claim_token'::uuid
  ),
  'claimed unreferenced asset must enter prepared-delete state'
);
RESET ROLE;

SELECT pg_temp.qa_expect_error(
  format($sql$INSERT INTO public.design_document_asset_refs(
    design_id, workspace_id, object_id, slot, asset_object_id
  ) VALUES (
    %L::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'gc-reference-after-prepare', 'source',
    '80000000-0000-0000-0000-000000000002'
  )$sql$, :'owner_design_id'),
  'asset_delete_already_prepared'
);

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000000","role":"service_role"}', true);
SELECT pg_temp.qa_assert(
  public.loomic_asset_gc_finalize(
    '80000000-0000-0000-0000-000000000002', :'gc_reject_claim_token'::uuid
  ),
  'prepared unreferenced asset must finalize with the matching token'
);
RESET ROLE;

\echo 'PASS GC cancellation and prepared-delete reference rejection'

-- Nested worker result payloads (for example layers[*].asset_id) also pin the
-- asset during the retention window.
INSERT INTO public.asset_objects(
  id, scope, workspace_id, project_id, bucket, object_path, mime_type,
  created_by, gc_eligible_at
) VALUES (
  '80000000-0000-0000-0000-000000000003', 'workspace',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'workspace-assets', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/design-qa/nested-job.png',
  'image/png', '11111111-1111-1111-1111-111111111111', now() - interval '1 hour'
);
INSERT INTO public.background_jobs(
  id, workspace_id, project_id, canvas_id, design_id, target_kind,
  queue_name, job_type, status, payload, result, created_by, completed_at
) VALUES (
  '70000000-0000-0000-0000-000000000003',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'cccccccc-cccc-cccc-cccc-cccccccccccc', NULL, :'owner_design_id'::uuid, 'design',
  'image_generation_jobs', 'image_generation', 'succeeded', '{}',
  '{"layers":[{"asset_id":"80000000-0000-0000-0000-000000000003"}]}'::jsonb,
  '11111111-1111-1111-1111-111111111111', now()
);
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000000","role":"service_role"}', true);
SELECT pg_temp.qa_assert(
  (SELECT count(*) = 0 FROM public.loomic_asset_gc_claim(
    '80000000-0000-0000-0000-000000000003', now()
  )),
  'nested job result asset references must block GC claims'
);
RESET ROLE;

\echo 'PASS nested job-result GC protection'

-- Service-role paths bypass RLS, so relational target/workspace integrity must
-- still reject cross-tenant job targets and finalization rows at the database.
SELECT pg_temp.qa_statement_rejected(
  format($sql$INSERT INTO public.background_jobs(
    id, workspace_id, project_id, canvas_id, design_id, target_kind,
    queue_name, job_type, status, payload, result, created_by
  ) VALUES (
    '70000000-0000-0000-0000-000000000002',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    NULL, %L::uuid, 'design', 'image_generation_jobs',
    'image_generation', 'succeeded', '{}', '{}',
    '11111111-1111-1111-1111-111111111111'
  )$sql$, :'other_response'::jsonb->>'design_id')
) AS rejected
\gset cross_job_

SELECT pg_temp.qa_statement_rejected(
  format($sql$INSERT INTO public.job_target_finalizations(
    job_id, workspace_id, target_kind, target_id, status, command_id
  ) VALUES (
    '70000000-0000-0000-0000-000000000001',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'design', %L::uuid, 'completed', '71000000-0000-0000-0000-000000000003'
  )$sql$, :'other_response'::jsonb->>'design_id')
) AS rejected
\gset cross_finalization_

SELECT
  :'cross_job_rejected'::boolean AS cross_job_rejected,
  :'cross_finalization_rejected'::boolean AS cross_finalization_rejected;

SELECT pg_temp.qa_assert(
  :'cross_job_rejected'::boolean,
  'background_jobs must reject a design_id from another workspace/project'
);
SELECT pg_temp.qa_assert(
  :'cross_finalization_rejected'::boolean,
  'job_target_finalizations must match the job workspace and frozen target'
);

SELECT pg_temp.qa_assert(
  pg_temp.qa_statement_rejected($sql$INSERT INTO public.background_jobs(
    id, workspace_id, project_id, canvas_id, design_id, target_kind,
    queue_name, job_type, status, payload, created_by
  ) VALUES (
    '70000000-0000-0000-0000-000000000004',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'dddddddd-dddd-dddd-dddd-dddddddddddd', NULL, NULL, 'canvas',
    'image_generation_jobs', 'image_generation', 'queued', '{}',
    '11111111-1111-1111-1111-111111111111'
  )$sql$),
  'canvas targets require a canvas id and a same-workspace project'
);
SELECT pg_temp.qa_assert(
  pg_temp.qa_statement_rejected(format($sql$INSERT INTO public.background_jobs(
    id, workspace_id, project_id, canvas_id, design_id, target_kind,
    queue_name, job_type, status, payload, created_by
  ) VALUES (
    '70000000-0000-0000-0000-000000000005',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', %L::uuid, 'design',
    'image_generation_jobs', 'image_generation', 'queued', '{}',
    '11111111-1111-1111-1111-111111111111'
  )$sql$, :'owner_design_id')),
  'design targets must not carry a canvas context in the canonical target columns'
);
SELECT pg_temp.qa_assert(
  pg_temp.qa_statement_rejected($sql$INSERT INTO public.background_jobs(
    id, workspace_id, project_id, canvas_id, design_id, target_kind,
    queue_name, job_type, status, payload, created_by
  ) VALUES (
    '70000000-0000-0000-0000-000000000006',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'dddddddd-dddd-dddd-dddd-dddddddddddd', NULL, NULL, NULL,
    'image_generation_jobs', 'image_generation', 'queued', '{}',
    '11111111-1111-1111-1111-111111111111'
  )$sql$),
  'chat-only null targets still require project/workspace consistency'
);

\echo 'PASS service-role cross-workspace job/finalization target integrity'

-- Preview state rows cannot advertise an old asset as ready or queue/error an
-- asset that already matches the document's current revision.
SELECT pg_temp.qa_assert(
  pg_temp.qa_statement_rejected(format($sql$UPDATE public.design_documents
    SET preview_asset_object_id = '80000000-0000-0000-0000-000000000001',
        preview_revision = 0, preview_status = 'ready'
    WHERE id = %L::uuid$sql$, :'owner_design_id')),
  'ready previews must exactly match the document revision'
);
SELECT pg_temp.qa_assert(
  pg_temp.qa_statement_rejected(format($sql$UPDATE public.design_documents
    SET preview_asset_object_id = '80000000-0000-0000-0000-000000000001',
        preview_revision = revision, preview_status = 'queued'
    WHERE id = %L::uuid$sql$, :'owner_design_id')),
  'queued/error previews may not claim a current-revision asset'
);

SELECT pg_temp.qa_expect_error(
  $sql$SELECT private.loomic_validate_design_scene(
    jsonb_build_object(
      'schemaVersion',1,'engine','fabric',
      'canvas',jsonb_build_object('width',100,'height',100,'background','#ffffff'),
      'objects',jsonb_build_array(
        jsonb_build_object(
          'objectId','83000000-0000-0000-0000-000000000001','objectVersion',1,
          'type','group','zIndex',0,'x',0,'y',0,'width',10,'height',10,
          'rotation',0,'opacity',1,'locked',false,'visible',true,
          'childObjectIds',jsonb_build_array('83000000-0000-0000-0000-000000000002')
        ),
        jsonb_build_object(
          'objectId','83000000-0000-0000-0000-000000000002','objectVersion',1,
          'type','group','zIndex',1,'x',0,'y',0,'width',10,'height',10,
          'rotation',0,'opacity',1,'locked',false,'visible',true,
          'childObjectIds',jsonb_build_array('83000000-0000-0000-0000-000000000001')
        )
      )
    ), 100, 100
  )$sql$,
  'design_group_cycle'
);
SELECT pg_temp.qa_expect_error(
  $sql$SELECT private.loomic_validate_design_scene(
    jsonb_build_object(
      'schemaVersion',1,'engine','fabric',
      'canvas',jsonb_build_object('width',100,'height',100,'background','#ffffff'),
      'objects',jsonb_build_array(
        jsonb_build_object(
          'objectId','83000000-0000-0000-0000-000000000011','objectVersion',1,
          'type','group','zIndex',0,'x',0,'y',0,'width',10,'height',10,
          'rotation',0,'opacity',1,'locked',false,'visible',true,
          'childObjectIds',jsonb_build_array('83000000-0000-0000-0000-000000000013')
        ),
        jsonb_build_object(
          'objectId','83000000-0000-0000-0000-000000000012','objectVersion',1,
          'type','group','zIndex',1,'x',0,'y',0,'width',10,'height',10,
          'rotation',0,'opacity',1,'locked',false,'visible',true,
          'childObjectIds',jsonb_build_array('83000000-0000-0000-0000-000000000013')
        ),
        jsonb_build_object(
          'objectId','83000000-0000-0000-0000-000000000013','objectVersion',1,
          'type','rect','zIndex',2,'x',0,'y',0,'width',10,'height',10,
          'rotation',0,'opacity',1,'locked',false,'visible',true,
          'fill',NULL,'stroke',NULL,'strokeWidth',0
        )
      )
    ), 100, 100
  )$sql$,
  'design_group_multiple_parents'
);

-- Soft-deleted documents hide all document-owned rows from authenticated
-- reads, even while retained for undo/purge processing.
UPDATE public.design_documents
SET deleted_at = now(), purge_after = now() + interval '30 days',
    deleted_by = '22222222-2222-2222-2222-222222222222'
WHERE id = (:'admin_response'::jsonb->>'design_id')::uuid;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
SELECT pg_temp.qa_assert(
  (SELECT count(*) FROM public.design_documents
    WHERE id = (:'admin_response'::jsonb->>'design_id')::uuid) = 0
  AND (SELECT count(*) FROM public.design_nodes
    WHERE design_id = (:'admin_response'::jsonb->>'design_id')::uuid) = 0
  AND (SELECT count(*) FROM public.design_document_versions
    WHERE design_id = (:'admin_response'::jsonb->>'design_id')::uuid) = 0,
  'soft-deleted design rows and owned history must be hidden'
);
RESET ROLE;

-- Platform asset metadata is visible only through a published catalog row;
-- platform administrators retain access to draft moderation assets.
INSERT INTO public.asset_objects(
  id, scope, workspace_id, project_id, bucket, object_path, mime_type, created_by
) VALUES
  ('81000000-0000-0000-0000-000000000001', 'platform', NULL, NULL,
   'platform-assets', 'catalog/draft.png', 'image/png', '11111111-1111-1111-1111-111111111111'),
  ('81000000-0000-0000-0000-000000000002', 'platform', NULL, NULL,
   'platform-assets', 'catalog/admin-draft.png', 'image/png', '22222222-2222-2222-2222-222222222222');
INSERT INTO public.design_resources(
  id, scope, workspace_id, kind, name, asset_object_id, status, created_by,
  source_url, license_name, license_url
) VALUES
  ('82000000-0000-0000-0000-000000000001', 'platform', NULL, 'image',
    'Draft resource', '81000000-0000-0000-0000-000000000001', 'draft',
    '11111111-1111-1111-1111-111111111111',
    'https://assets.example.com/draft.png', 'CC-BY-4.0',
    'https://creativecommons.org/licenses/by/4.0/');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
SELECT pg_temp.qa_assert(
  (SELECT count(*) FROM public.asset_objects
   WHERE id = '81000000-0000-0000-0000-000000000001') = 0,
  'ordinary users must not read draft platform asset metadata'
);
RESET ROLE;
UPDATE public.design_resources
SET status = 'published', published_at = now(),
    published_by = '11111111-1111-1111-1111-111111111111'
WHERE id = '82000000-0000-0000-0000-000000000001';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
SELECT pg_temp.qa_assert(
  (SELECT count(*) FROM public.asset_objects
   WHERE id = '81000000-0000-0000-0000-000000000001') = 1,
  'published platform catalog assets must be readable'
);
RESET ROLE;
INSERT INTO public.platform_admins(user_id, granted_by)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
SELECT pg_temp.qa_assert(
  (SELECT count(*) FROM public.asset_objects
   WHERE id = '81000000-0000-0000-0000-000000000002') = 1,
  'platform administrators must read draft platform asset metadata'
);
RESET ROLE;

\echo 'PASS preview state, soft-delete visibility and platform asset policy'

ROLLBACK;

\echo 'LOCAL DESIGN DATABASE QA PASSED'
