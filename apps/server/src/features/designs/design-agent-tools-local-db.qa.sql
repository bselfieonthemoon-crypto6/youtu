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

CREATE OR REPLACE FUNCTION pg_temp.qa_rect(object_id text, object_version integer)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'objectId', object_id,
    'objectVersion', object_version,
    'zIndex', 0,
    'type', 'rect',
    'x', 10,
    'y', 20,
    'width', 100,
    'height', 80,
    'rotation', 0,
    'opacity', 1,
    'locked', false,
    'visible', true,
    'fill', jsonb_build_object('kind', 'solid', 'color', '#ff0000'),
    'stroke', NULL,
    'strokeWidth', 0
  );
$$;

CREATE OR REPLACE FUNCTION pg_temp.qa_scene(background text, objects jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'schemaVersion', 1,
    'engine', 'fabric',
    'canvas', jsonb_build_object(
      'width', 1080,
      'height', 1080,
      'background', background
    ),
    'objects', objects
  );
$$;

INSERT INTO auth.users(
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('00000000-0000-0000-0000-000000000000','a6010000-0000-4000-8000-000000000001','authenticated','authenticated','agent-design-a@local.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','a6010000-0000-4000-8000-000000000002','authenticated','authenticated','agent-design-b@local.test','',now(),'{}','{}',now(),now());

INSERT INTO public.workspaces(id, type, name, owner_user_id) VALUES
  ('a6020000-0000-4000-8000-000000000001','team','Agent Design A','a6010000-0000-4000-8000-000000000001'),
  ('a6020000-0000-4000-8000-000000000002','team','Agent Design B','a6010000-0000-4000-8000-000000000002');
INSERT INTO public.workspace_members(workspace_id, user_id, role) VALUES
  ('a6020000-0000-4000-8000-000000000001','a6010000-0000-4000-8000-000000000001','owner'),
  ('a6020000-0000-4000-8000-000000000002','a6010000-0000-4000-8000-000000000002','owner');
INSERT INTO public.projects(id, workspace_id, name, slug, created_by) VALUES
  ('a6030000-0000-4000-8000-000000000001','a6020000-0000-4000-8000-000000000001','Agent Design A','agent-design-a','a6010000-0000-4000-8000-000000000001'),
  ('a6030000-0000-4000-8000-000000000002','a6020000-0000-4000-8000-000000000002','Agent Design B','agent-design-b','a6010000-0000-4000-8000-000000000002');
INSERT INTO public.canvases(id, project_id, name, is_primary, created_by, content) VALUES
  ('a6040000-0000-4000-8000-000000000001','a6030000-0000-4000-8000-000000000001','Agent Canvas A',true,'a6010000-0000-4000-8000-000000000001','{"elements":[],"appState":{}}'),
  ('a6040000-0000-4000-8000-000000000002','a6030000-0000-4000-8000-000000000002','Agent Canvas B',true,'a6010000-0000-4000-8000-000000000002','{"elements":[],"appState":{}}');

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a6010000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
SELECT public.loomic_design_create(
  'a6050000-0000-4000-8000-000000000001',
  'a6040000-0000-4000-8000-000000000001',
  0,
  'agent-design-node',
  'Agent design fixture',
  1080,
  1080,
  0,
  0,
  320,
  320,
  '#ffffff',
  NULL
) AS value
\gset created_
RESET ROLE;

SELECT (:'created_value'::jsonb->>'design_id')::uuid AS value
\gset design_

INSERT INTO public.chat_sessions(id, canvas_id, title, created_by, thread_id) VALUES
  ('a6060000-0000-4000-8000-000000000001','a6040000-0000-4000-8000-000000000001','Agent A','a6010000-0000-4000-8000-000000000001','agent-design-thread-a'),
  ('a6060000-0000-4000-8000-000000000002','a6040000-0000-4000-8000-000000000002','Agent B','a6010000-0000-4000-8000-000000000002','agent-design-thread-b');
INSERT INTO public.agent_runs(
  id, session_id, thread_id, status, execution_mode, created_by, started_at
) VALUES
  ('a6070000-0000-4000-8000-000000000001','a6060000-0000-4000-8000-000000000001','agent-design-thread-a','running','fast','a6010000-0000-4000-8000-000000000001',now()),
  ('a6070000-0000-4000-8000-000000000002','a6060000-0000-4000-8000-000000000002','agent-design-thread-b','running','fast','a6010000-0000-4000-8000-000000000002',now());
INSERT INTO public.tool_executions(
  id, run_id, tool_call_id, tool_name, status, requested_by
) VALUES
  ('a6080000-0000-4000-8000-000000000001','a6070000-0000-4000-8000-000000000001','add-rect','manipulate_design','running','a6010000-0000-4000-8000-000000000001'),
  ('a6080000-0000-4000-8000-000000000002','a6070000-0000-4000-8000-000000000001','stale-change','manipulate_design','running','a6010000-0000-4000-8000-000000000001'),
  ('a6080000-0000-4000-8000-000000000003','a6070000-0000-4000-8000-000000000001','remove-rect','manipulate_design','running','a6010000-0000-4000-8000-000000000001'),
  ('a6080000-0000-4000-8000-000000000004','a6070000-0000-4000-8000-000000000001','apply-template','apply_design_template','running','a6010000-0000-4000-8000-000000000001'),
  ('a6080000-0000-4000-8000-000000000005','a6070000-0000-4000-8000-000000000002','cross-tenant','manipulate_design','running','a6010000-0000-4000-8000-000000000002');

SELECT pg_temp.qa_assert(
  has_function_privilege(
    'service_role',
    'public.loomic_agent_design_mutate(text,uuid,bigint,uuid,jsonb,jsonb,uuid,uuid,uuid,uuid,bigint,uuid,boolean)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.loomic_agent_design_mutate(text,uuid,bigint,uuid,jsonb,jsonb,uuid,uuid,uuid,uuid,bigint,uuid,boolean)',
    'EXECUTE'
  )
  AND NOT has_table_privilege(
    'authenticated',
    'public.design_agent_tool_requests',
    'SELECT'
  ),
  'agent design audit records and mutation RPC must remain server-only'
);

-- First agent mutation commits exactly one document revision, history row and
-- outbox event. The tool execution UUID is the authoritative audit identity.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT public.loomic_agent_design_mutate(
  'manipulate_design',
  :'design_value'::uuid,
  0,
  'a6090000-0000-4000-8000-000000000001',
  jsonb_build_array(jsonb_build_object(
    'action','object.add',
    'object',pg_temp.qa_rect('a6100000-0000-4000-8000-000000000001',1)
  )),
  pg_temp.qa_scene(
    '#ffffff',
    jsonb_build_array(pg_temp.qa_rect('a6100000-0000-4000-8000-000000000001',1))
  ),
  'a6010000-0000-4000-8000-000000000001',
  'a6070000-0000-4000-8000-000000000001',
  'a6080000-0000-4000-8000-000000000001'
) AS value
\gset first_
RESET ROLE;

SELECT pg_temp.qa_assert(
  (:'first_value'::jsonb->>'revision')::bigint = 1
  AND NOT (:'first_value'::jsonb->>'replayed')::boolean
  AND (SELECT count(*) = 1 FROM public.design_agent_tool_requests
       WHERE tool_execution_id = 'a6080000-0000-4000-8000-000000000001')
  AND (SELECT count(*) = 1 FROM public.design_document_versions
       WHERE design_id = :'design_value'::uuid AND revision = 1
         AND actor_kind = 'agent'
         AND agent_run_id = 'a6070000-0000-4000-8000-000000000001'
         AND tool_execution_id = 'a6080000-0000-4000-8000-000000000001')
  AND (SELECT count(*) = 1 FROM public.design_event_outbox
       WHERE design_id = :'design_value'::uuid AND revision = 1)
  AND (SELECT jsonb_array_length(scene->'objects') = 1
       FROM public.design_documents WHERE id = :'design_value'::uuid),
  'agent mutation must atomically write one object, audited version and outbox event'
);

-- Exact tool replay works even after the tool ledger reached a terminal state;
-- changed input under the same execution is rejected.
UPDATE public.tool_executions
SET status = 'completed', finished_at = now()
WHERE id = 'a6080000-0000-4000-8000-000000000001';
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT public.loomic_agent_design_mutate(
  'manipulate_design',
  :'design_value'::uuid,
  0,
  'a6090000-0000-4000-8000-000000000001',
  jsonb_build_array(jsonb_build_object(
    'action','object.add',
    'object',pg_temp.qa_rect('a6100000-0000-4000-8000-000000000001',1)
  )),
  pg_temp.qa_scene(
    '#ffffff',
    jsonb_build_array(pg_temp.qa_rect('a6100000-0000-4000-8000-000000000001',1))
  ),
  'a6010000-0000-4000-8000-000000000001',
  'a6070000-0000-4000-8000-000000000001',
  'a6080000-0000-4000-8000-000000000001'
) AS value
\gset replay_
SELECT pg_temp.qa_expect_error(
  format(
    $sql$SELECT public.loomic_agent_design_mutate(
      'manipulate_design',%L::uuid,1,%L::uuid,
      '[{"action":"canvas.update","background":"#eeeeee"}]'::jsonb,
      pg_temp.qa_scene('#eeeeee',jsonb_build_array(
        pg_temp.qa_rect('a6100000-0000-4000-8000-000000000001',1)
      )),%L::uuid,%L::uuid,%L::uuid
    )$sql$,
    :'design_value',
    'a6090000-0000-4000-8000-000000000099',
    'a6010000-0000-4000-8000-000000000001',
    'a6070000-0000-4000-8000-000000000001',
    'a6080000-0000-4000-8000-000000000001'
  ),
  'agent_design_idempotency_conflict'
);
RESET ROLE;

SELECT pg_temp.qa_assert(
  (:'replay_value'::jsonb->>'replayed')::boolean
  AND (SELECT revision = 1 FROM public.design_documents WHERE id = :'design_value'::uuid)
  AND (SELECT count(*) = 1 FROM public.design_document_versions
       WHERE design_id = :'design_value'::uuid AND revision > 0),
  'same tool execution must replay without a duplicate revision'
);

-- A human write wins first; the stale Agent CAS must fail and roll its audit row
-- back rather than overwriting the human revision.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT public.loomic_design_mutate(
  :'design_value'::uuid,
  1,
  'a6090000-0000-4000-8000-000000000002',
  '[{"action":"canvas.update","background":"#eeeeee"}]'::jsonb,
  pg_temp.qa_scene(
    '#eeeeee',
    jsonb_build_array(pg_temp.qa_rect('a6100000-0000-4000-8000-000000000001',1))
  ),
  'user',
  'a6010000-0000-4000-8000-000000000001',
  NULL,
  NULL
);
SELECT pg_temp.qa_expect_error(
  format(
    $sql$SELECT public.loomic_agent_design_mutate(
      'manipulate_design',%L::uuid,1,%L::uuid,
      '[{"action":"canvas.update","background":"#dddddd"}]'::jsonb,
      pg_temp.qa_scene('#dddddd',jsonb_build_array(
        pg_temp.qa_rect('a6100000-0000-4000-8000-000000000001',1)
      )),%L::uuid,%L::uuid,%L::uuid
    )$sql$,
    :'design_value',
    'a6090000-0000-4000-8000-000000000003',
    'a6010000-0000-4000-8000-000000000001',
    'a6070000-0000-4000-8000-000000000001',
    'a6080000-0000-4000-8000-000000000002'
  ),
  'design_revision_conflict'
);
RESET ROLE;

SELECT pg_temp.qa_assert(
  (SELECT revision = 2 AND scene#>>'{canvas,background}' = '#eeeeee'
   FROM public.design_documents WHERE id = :'design_value'::uuid)
  AND NOT EXISTS (
    SELECT 1 FROM public.design_agent_tool_requests
    WHERE tool_execution_id = 'a6080000-0000-4000-8000-000000000002'
  ),
  'human CAS winner must remain authoritative and stale agent audit must roll back'
);

-- Cross-tenant execution context and unconfirmed destructive calls are rejected
-- before any persistent request/version/outbox side effect.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT pg_temp.qa_expect_error(
  format(
    $sql$SELECT public.loomic_agent_design_mutate(
      'manipulate_design',%L::uuid,2,%L::uuid,
      '[{"action":"canvas.update","background":"#dddddd"}]'::jsonb,
      pg_temp.qa_scene('#dddddd',jsonb_build_array(
        pg_temp.qa_rect('a6100000-0000-4000-8000-000000000001',1)
      )),%L::uuid,%L::uuid,%L::uuid
    )$sql$,
    :'design_value',
    'a6090000-0000-4000-8000-000000000004',
    'a6010000-0000-4000-8000-000000000002',
    'a6070000-0000-4000-8000-000000000002',
    'a6080000-0000-4000-8000-000000000005'
  ),
  'agent_design_workspace_mismatch'
);
SELECT pg_temp.qa_expect_error(
  format(
    $sql$SELECT public.loomic_agent_design_mutate(
      'manipulate_design',%L::uuid,2,%L::uuid,
      '[{"action":"object.remove","object_id":"a6100000-0000-4000-8000-000000000001","expected_object_version":1}]'::jsonb,
      pg_temp.qa_scene('#eeeeee','[]'::jsonb),%L::uuid,%L::uuid,%L::uuid
    )$sql$,
    :'design_value',
    'a6090000-0000-4000-8000-000000000005',
    'a6010000-0000-4000-8000-000000000001',
    'a6070000-0000-4000-8000-000000000001',
    'a6080000-0000-4000-8000-000000000003'
  ),
  'agent_design_confirmation_required'
);
SELECT pg_temp.qa_expect_error(
  format(
    $sql$SELECT public.loomic_agent_design_mutate(
      'manipulate_design',%L::uuid,2,%L::uuid,
      '[{"action":"canvas.update","background":"#dddddd"}]'::jsonb,
      pg_temp.qa_scene('#dddddd',jsonb_build_array(
        pg_temp.qa_rect('a6100000-0000-4000-8000-000000000001',1)
      )),%L::uuid,%L::uuid,%L::uuid,NULL,NULL,%L::uuid,true
    )$sql$,
    :'design_value',
    'a6090000-0000-4000-8000-000000000008',
    'a6010000-0000-4000-8000-000000000001',
    'a6070000-0000-4000-8000-000000000001',
    'a6080000-0000-4000-8000-000000000002',
    'a6120000-0000-4000-8000-000000000008'
  ),
  'agent_design_confirmation_invalid'
);
RESET ROLE;

SELECT pg_temp.qa_assert(
  NOT EXISTS (
    SELECT 1 FROM public.design_agent_tool_requests
    WHERE tool_execution_id IN (
      'a6080000-0000-4000-8000-000000000003',
      'a6080000-0000-4000-8000-000000000005'
    )
  )
  AND (SELECT revision = 2 FROM public.design_documents WHERE id = :'design_value'::uuid),
  'rejected cross-tenant and unconfirmed mutations must have no side effects'
);

-- Applying a template is always destructive. The confirmed frozen execution may
-- run after its original tool and Agent run completed, and exact replay is still
-- keyed by that same tool execution UUID.
INSERT INTO public.design_templates(
  id,scope,workspace_id,name,scene,width,height,status,created_by,revision
) VALUES (
  'a6110000-0000-4000-8000-000000000001',
  'workspace',
  'a6020000-0000-4000-8000-000000000001',
  'Agent template',
  pg_temp.qa_scene(
    '#000000',
    jsonb_build_array(pg_temp.qa_rect('a6100000-0000-4000-8000-000000000002',1))
  ),
  1080,
  1080,
  'draft',
  'a6010000-0000-4000-8000-000000000001',
  0
);
UPDATE public.tool_executions
SET status = 'completed', finished_at = now()
WHERE id = 'a6080000-0000-4000-8000-000000000004';
UPDATE public.agent_runs
SET status = 'completed', completed_at = now()
WHERE id = 'a6070000-0000-4000-8000-000000000001';

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT public.loomic_agent_design_mutate(
  'apply_design_template',
  :'design_value'::uuid,
  2,
  'a6090000-0000-4000-8000-000000000006',
  jsonb_build_array(jsonb_build_object(
    'action','scene.replace',
    'scene',pg_temp.qa_scene(
      '#000000',
      jsonb_build_array(pg_temp.qa_rect('a6100000-0000-4000-8000-000000000002',1))
    )
  )),
  pg_temp.qa_scene(
    '#000000',
    jsonb_build_array(pg_temp.qa_rect('a6100000-0000-4000-8000-000000000002',1))
  ),
  'a6010000-0000-4000-8000-000000000001',
  'a6070000-0000-4000-8000-000000000001',
  'a6080000-0000-4000-8000-000000000004',
  'a6110000-0000-4000-8000-000000000001',
  0,
  'a6120000-0000-4000-8000-000000000001',
  true
) AS value
\gset applied_
SELECT public.loomic_agent_design_mutate(
  'apply_design_template',
  :'design_value'::uuid,
  2,
  'a6090000-0000-4000-8000-000000000006',
  jsonb_build_array(jsonb_build_object(
    'action','scene.replace',
    'scene',pg_temp.qa_scene(
      '#000000',
      jsonb_build_array(pg_temp.qa_rect('a6100000-0000-4000-8000-000000000002',1))
    )
  )),
  pg_temp.qa_scene(
    '#000000',
    jsonb_build_array(pg_temp.qa_rect('a6100000-0000-4000-8000-000000000002',1))
  ),
  'a6010000-0000-4000-8000-000000000001',
  'a6070000-0000-4000-8000-000000000001',
  'a6080000-0000-4000-8000-000000000004',
  'a6110000-0000-4000-8000-000000000001',
  0,
  'a6120000-0000-4000-8000-000000000001',
  true
) AS value
\gset applied_replay_
RESET ROLE;

SELECT pg_temp.qa_assert(
  (:'applied_value'::jsonb->>'revision')::bigint = 3
  AND NOT (:'applied_value'::jsonb->>'replayed')::boolean
  AND (:'applied_replay_value'::jsonb->>'replayed')::boolean
  AND (SELECT count(*) = 1 FROM public.design_document_versions
       WHERE tool_execution_id = 'a6080000-0000-4000-8000-000000000004')
  AND (SELECT count(*) = 1 FROM public.design_event_outbox
       WHERE design_id = :'design_value'::uuid AND revision = 3)
  AND (SELECT scene#>>'{canvas,background}' = '#000000'
       AND jsonb_array_length(scene->'objects') = 1
       FROM public.design_documents WHERE id = :'design_value'::uuid),
  'confirmed template apply must work after run completion and replay once'
);

-- No service may bypass the audited wrapper by labeling a core mutation as Agent.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT pg_temp.qa_expect_error(
  format(
    $sql$SELECT public.loomic_design_mutate(
      %L::uuid,3,%L::uuid,
      '[{"action":"canvas.update","background":"#ffffff"}]'::jsonb,
      pg_temp.qa_scene('#ffffff',jsonb_build_array(
        pg_temp.qa_rect('a6100000-0000-4000-8000-000000000002',1)
      )),
      'agent',%L::uuid,NULL,NULL
    )$sql$,
    :'design_value',
    'a6090000-0000-4000-8000-000000000007',
    'a6010000-0000-4000-8000-000000000001'
  ),
  'agent_design_audit_required'
);
RESET ROLE;

SELECT pg_temp.qa_assert(
  (SELECT revision = 3 FROM public.design_documents WHERE id = :'design_value'::uuid)
  AND (SELECT count(*) = 1 FROM public.design_document_versions
       WHERE tool_execution_id = 'a6080000-0000-4000-8000-000000000004')
  AND to_regclass('public.background_jobs_design_export_idempotency_key') IS NOT NULL
  AND to_regclass('public.job_target_finalizations_command_key') IS NOT NULL,
  'audit bypass must roll back and existing export/finalizer dedupe gates remain active'
);

\echo 'PASS Stage6 Agent design CAS, confirmation, audit, replay and tenant isolation'

ROLLBACK;
