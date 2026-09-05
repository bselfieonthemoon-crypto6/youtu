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
) VALUES
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'binding-a@local.test', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'binding-b@local.test', '', now(), '{}', '{}', now(), now());

INSERT INTO public.workspaces(id, type, name, owner_user_id) VALUES
  ('c2000000-0000-0000-0000-000000000001', 'team', 'Binding QA A', 'c1000000-0000-0000-0000-000000000001'),
  ('c2000000-0000-0000-0000-000000000002', 'team', 'Binding QA B', 'c1000000-0000-0000-0000-000000000002');
INSERT INTO public.workspace_members(workspace_id, user_id, role) VALUES
  ('c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'owner'),
  ('c2000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000002', 'owner');
INSERT INTO public.projects(id, workspace_id, name, slug, created_by) VALUES
  ('c3000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 'Binding Project A', 'binding-a', 'c1000000-0000-0000-0000-000000000001'),
  ('c3000000-0000-0000-0000-000000000003', 'c2000000-0000-0000-0000-000000000001', 'Binding Project A2', 'binding-a2', 'c1000000-0000-0000-0000-000000000001'),
  ('c3000000-0000-0000-0000-000000000002', 'c2000000-0000-0000-0000-000000000002', 'Binding Project B', 'binding-b', 'c1000000-0000-0000-0000-000000000002');

INSERT INTO public.canvases(id, project_id, name, is_primary, created_by, content) VALUES (
  'c4000000-0000-0000-0000-000000000001',
  'c3000000-0000-0000-0000-000000000001',
  'Binding Canvas A', true, 'c1000000-0000-0000-0000-000000000001',
  jsonb_build_object('appState', '{}'::jsonb, 'elements', jsonb_build_array(
    jsonb_build_object('id','attach-node','isDeleted',false,'customData',jsonb_build_object('kind','loomic-design','schemaVersion',1,'designId','c5000000-0000-0000-0000-000000000001','revision',0,'previewAssetObjectId',NULL,'previewRevision',0)),
    jsonb_build_object('id','cross-node','isDeleted',false,'customData',jsonb_build_object('kind','loomic-design','schemaVersion',1,'designId','c5000000-0000-0000-0000-000000000006','revision',0,'previewAssetObjectId',NULL,'previewRevision',0)),
    jsonb_build_object('id','duplicate-a','isDeleted',false,'customData',jsonb_build_object('kind','loomic-design','schemaVersion',1,'designId','c5000000-0000-0000-0000-000000000002','revision',0,'previewAssetObjectId',NULL,'previewRevision',0)),
    jsonb_build_object('id','duplicate-b','isDeleted',false,'customData',jsonb_build_object('kind','loomic-design','schemaVersion',1,'designId','c5000000-0000-0000-0000-000000000002','revision',0,'previewAssetObjectId',NULL,'previewRevision',0)),
    jsonb_build_object('id','deleted-node','isDeleted',false,'customData',jsonb_build_object('kind','loomic-design','schemaVersion',1,'designId','c5000000-0000-0000-0000-000000000003','revision',0,'previewAssetObjectId',NULL,'previewRevision',0)),
    jsonb_build_object('id','bound-node','isDeleted',false,'customData',jsonb_build_object('kind','loomic-design','schemaVersion',1,'designId','c5000000-0000-0000-0000-000000000006','revision',99,'previewAssetObjectId',NULL,'previewRevision',0)),
    jsonb_build_object('id','bound-deleted-node','isDeleted',false,'customData',jsonb_build_object('kind','loomic-design','schemaVersion',1,'designId','c5000000-0000-0000-0000-000000000007','revision',0,'previewAssetObjectId',NULL,'previewRevision',0)),
    jsonb_build_object('id','cross-project-bound','isDeleted',false,'customData',jsonb_build_object('kind','loomic-design','schemaVersion',1,'designId','c5000000-0000-0000-0000-000000000008','revision',0,'previewAssetObjectId',NULL,'previewRevision',0))
  ))
);

INSERT INTO public.design_documents(
  id, workspace_id, project_id, name, scene, width, height, revision,
  created_by, deleted_at, purge_after
) VALUES
  ('c5000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000001','Attach','{"schemaVersion":1,"engine":"fabric","canvas":{},"objects":[]}',100,100,0,'c1000000-0000-0000-0000-000000000001',NULL,NULL),
  ('c5000000-0000-0000-0000-000000000002','c2000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000001','Duplicate','{"schemaVersion":1,"engine":"fabric","canvas":{},"objects":[]}',100,100,0,'c1000000-0000-0000-0000-000000000001',NULL,NULL),
  ('c5000000-0000-0000-0000-000000000003','c2000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000001','Deleted','{"schemaVersion":1,"engine":"fabric","canvas":{},"objects":[]}',100,100,0,'c1000000-0000-0000-0000-000000000001',now(),now()+interval '30 days'),
  ('c5000000-0000-0000-0000-000000000004','c2000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000001','Bound','{"schemaVersion":1,"engine":"fabric","canvas":{},"objects":[]}',100,100,0,'c1000000-0000-0000-0000-000000000001',NULL,NULL),
  ('c5000000-0000-0000-0000-000000000005','c2000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000001','Orphan','{"schemaVersion":1,"engine":"fabric","canvas":{},"objects":[]}',100,100,0,'c1000000-0000-0000-0000-000000000001',NULL,NULL),
  ('c5000000-0000-0000-0000-000000000006','c2000000-0000-0000-0000-000000000002','c3000000-0000-0000-0000-000000000002','Cross tenant','{"schemaVersion":1,"engine":"fabric","canvas":{},"objects":[]}',100,100,0,'c1000000-0000-0000-0000-000000000002',NULL,NULL),
  ('c5000000-0000-0000-0000-000000000007','c2000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000001','Bound deleted','{"schemaVersion":1,"engine":"fabric","canvas":{},"objects":[]}',100,100,0,'c1000000-0000-0000-0000-000000000001',now(),now()+interval '30 days'),
  ('c5000000-0000-0000-0000-000000000008','c2000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000003','Cross project','{"schemaVersion":1,"engine":"fabric","canvas":{},"objects":[]}',100,100,0,'c1000000-0000-0000-0000-000000000001',NULL,NULL);

INSERT INTO public.design_document_versions(
  design_id, workspace_id, revision, command_batch, changed_object_ids,
  actor_kind, idempotency_key
)
SELECT id, workspace_id, 0, '[]'::jsonb, ARRAY[]::uuid[], 'system', extensions.gen_random_uuid()
FROM public.design_documents
WHERE id::text LIKE 'c5000000-%';

INSERT INTO public.design_nodes(canvas_id, element_id, design_id, workspace_id) VALUES
  ('c4000000-0000-0000-0000-000000000001','bound-node','c5000000-0000-0000-0000-000000000004','c2000000-0000-0000-0000-000000000001'),
  ('c4000000-0000-0000-0000-000000000001','missing-node','c5000000-0000-0000-0000-000000000005','c2000000-0000-0000-0000-000000000001'),
  ('c4000000-0000-0000-0000-000000000001','bound-deleted-node','c5000000-0000-0000-0000-000000000007','c2000000-0000-0000-0000-000000000001');

SELECT pg_temp.qa_expect_error(
  $$INSERT INTO public.design_nodes(canvas_id,element_id,design_id,workspace_id)
    VALUES ('c4000000-0000-0000-0000-000000000001','cross-project-trigger',
      'c5000000-0000-0000-0000-000000000008','c2000000-0000-0000-0000-000000000001')$$,
  'design_node_project_mismatch'
);
-- Simulate a legacy corrupt row that predates the new trigger so the RPC's
-- defensive branch is exercised as well.
ALTER TABLE public.design_nodes DISABLE TRIGGER design_nodes_validate_project;
INSERT INTO public.design_nodes(canvas_id, element_id, design_id, workspace_id) VALUES
  ('c4000000-0000-0000-0000-000000000001','cross-project-bound','c5000000-0000-0000-0000-000000000008','c2000000-0000-0000-0000-000000000001');
ALTER TABLE public.design_nodes ENABLE TRIGGER design_nodes_validate_project;

SELECT pg_temp.qa_assert(
  has_function_privilege('service_role', 'public.loomic_design_binding_reconcile(integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.loomic_design_binding_reconcile(integer)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.loomic_design_binding_reconcile(integer)', 'EXECUTE'),
  'binding reconciler RPC must remain service-only'
);

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);

CREATE TEMP TABLE qa_first_result AS
SELECT public.loomic_design_binding_reconcile(50) AS value;

RESET ROLE;

SELECT pg_temp.qa_assert(
  (SELECT count(*) = 1 FROM public.design_nodes WHERE design_id='c5000000-0000-0000-0000-000000000001' AND deleted_at IS NULL),
  'same-project metadata must attach'
);
SELECT pg_temp.qa_assert(
  (SELECT count(*) = 1 FROM public.design_nodes WHERE design_id='c5000000-0000-0000-0000-000000000002' AND deleted_at IS NULL),
  'duplicate metadata must produce only one live binding'
);
SELECT pg_temp.qa_assert(
  NOT EXISTS (SELECT 1 FROM public.design_nodes WHERE design_id='c5000000-0000-0000-0000-000000000006'),
  'cross-workspace metadata must never attach'
);
SELECT pg_temp.qa_assert(
  (SELECT deleted_at IS NOT NULL AND revision=1 FROM public.design_documents WHERE id='c5000000-0000-0000-0000-000000000005'),
  'missing authoritative node must soft-delete orphan design once'
);
SELECT pg_temp.qa_assert(
  (SELECT deleted_at IS NOT NULL FROM public.design_nodes WHERE element_id='missing-node'),
  'missing authoritative node must retire binding'
);
SELECT pg_temp.qa_assert(
  (SELECT content#>>'{elements,5,customData,designId}'='c5000000-0000-0000-0000-000000000004' FROM public.canvases WHERE id='c4000000-0000-0000-0000-000000000001'),
  'existing binding must override tampered metadata'
);
SELECT pg_temp.qa_assert(
  (SELECT (content#>>'{elements,1,isDeleted}')::boolean AND (content#>>'{elements,3,isDeleted}')::boolean AND (content#>>'{elements,4,isDeleted}')::boolean AND (content#>>'{elements,6,isDeleted}')::boolean FROM public.canvases WHERE id='c4000000-0000-0000-0000-000000000001'),
  'invalid, duplicate, deleted, and bound-deleted nodes must be retired'
);
SELECT pg_temp.qa_assert(
  (SELECT deleted_at IS NOT NULL FROM public.design_nodes WHERE element_id='cross-project-bound')
  AND (SELECT deleted_at IS NULL FROM public.design_documents WHERE id='c5000000-0000-0000-0000-000000000008')
  AND (SELECT (content#>>'{elements,7,isDeleted}')::boolean FROM public.canvases WHERE id='c4000000-0000-0000-0000-000000000001'),
  'same-workspace cross-project authoritative binding must be retired without deleting its design'
);
SELECT pg_temp.qa_assert(
  (SELECT (value->>'attached')::integer=2 AND (value->>'orphaned')::integer=1 AND (value->>'rejected')::integer>=4 FROM qa_first_result),
  'result counters must describe repairs'
);

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
CREATE TEMP TABLE qa_second_result AS
SELECT public.loomic_design_binding_reconcile(50) AS value;
RESET ROLE;

SELECT pg_temp.qa_assert(
  (SELECT revision=1 FROM public.design_documents WHERE id='c5000000-0000-0000-0000-000000000005'),
  'repeat reconciliation must not increment orphan revision again'
);
SELECT pg_temp.qa_assert(
  (SELECT (value->>'attached')::integer=0 AND (value->>'orphaned')::integer=0 AND (value->>'rejected')::integer=0 FROM qa_second_result),
  'repeat reconciliation must be idempotent'
);

-- More candidates than p_limit must all become reachable across cursor batches.
UPDATE public.design_binding_reconcile_state
SET cursor_updated_at=NULL, cursor_canvas_id=NULL WHERE singleton;
INSERT INTO public.canvases(id, project_id, name, is_primary, created_by, content)
SELECT
  ('c6000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,
  'c3000000-0000-0000-0000-000000000001', 'Cursor '||n, false,
  'c1000000-0000-0000-0000-000000000001',
  jsonb_build_object('appState','{}'::jsonb,'elements',jsonb_build_array(
    jsonb_build_object('id','invalid-'||n,'isDeleted',false,'customData',jsonb_build_object(
      'kind','loomic-design','schemaVersion',1,'designId','not-a-uuid','revision',0,
      'previewAssetObjectId',NULL,'previewRevision',0
    ))
  ))
FROM generate_series(1,3) n;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT public.loomic_design_binding_reconcile(1) FROM generate_series(1,10);
RESET ROLE;
SELECT pg_temp.qa_assert(
  NOT EXISTS (
    SELECT 1
    FROM public.canvases c
    CROSS JOIN LATERAL jsonb_array_elements(c.content->'elements') e
    WHERE c.id::text LIKE 'c6000000-%'
      AND COALESCE((e->>'isDeleted')::boolean,false)=false
  ),
  'durable cursor must reach candidates beyond p_limit'
);

\echo 'PASS CAN-03/04/07/08/09 binding reconciliation behavior'
ROLLBACK;
