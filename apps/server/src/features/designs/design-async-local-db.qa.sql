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
  ('00000000-0000-0000-0000-000000000000','91000000-0000-4000-8000-000000000001','authenticated','authenticated','async-owner@local.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','91000000-0000-4000-8000-000000000002','authenticated','authenticated','async-member@local.test','',now(),'{}','{}',now(),now());

INSERT INTO public.workspaces(id, type, name, owner_user_id) VALUES
  ('92000000-0000-4000-8000-000000000001','team','Async QA','91000000-0000-4000-8000-000000000001');
INSERT INTO public.workspace_members(workspace_id, user_id, role) VALUES
  ('92000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001','owner'),
  ('92000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000002','member');
INSERT INTO public.projects(id, workspace_id, name, slug, created_by) VALUES
  ('93000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001','Async QA Project','async-qa','91000000-0000-4000-8000-000000000001');
INSERT INTO public.canvases(id, project_id, name, is_primary, created_by, content) VALUES
  ('94000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001','Async QA Canvas',true,'91000000-0000-4000-8000-000000000001','{"elements":[],"appState":{}}');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SELECT public.loomic_design_create(
  '95000000-0000-4000-8000-000000000001',
  '94000000-0000-4000-8000-000000000001',0,'async-source-node',
  'Async source',1080,1080,10,20,320,320,'#ffffff',NULL
) AS value
\gset created_
RESET ROLE;

SELECT (:'created_value'::jsonb->>'design_id')::uuid AS value
\gset source_
SELECT pg_temp.qa_assert(
  (:'created_value'::jsonb->>'canvas_revision')::bigint=1,
  'design create fixture must advance Canvas revision'
);

-- Rename uses CAS, has stable replay semantics, and writes one lifecycle event.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT public.loomic_design_rename(
  :'source_value'::uuid,0,'95000000-0000-4000-8000-000000000002',
  'Renamed source','91000000-0000-4000-8000-000000000001'
) AS value
\gset renamed_
SELECT public.loomic_design_rename(
  :'source_value'::uuid,0,'95000000-0000-4000-8000-000000000002',
  'Renamed source','91000000-0000-4000-8000-000000000001'
) AS value
\gset renamed_replay_
RESET ROLE;

SELECT pg_temp.qa_assert(
  (:'renamed_value'::jsonb->>'revision')::bigint=1
  AND (:'renamed_replay_value'::jsonb->>'replayed')::boolean
  AND (SELECT count(*)=1 FROM public.design_event_outbox
       WHERE design_id=:'source_value'::uuid AND payload->>'updateType'='renamed'),
  'rename must be CAS-protected and replay without duplicate outbox rows'
);

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT pg_temp.qa_expect_error(
  format(
    'SELECT public.loomic_design_rename(%L::uuid,0,%L::uuid,%L,%L::uuid)',
    :'source_value','95000000-0000-4000-8000-000000000003','stale rename',
    '91000000-0000-4000-8000-000000000001'
  ),
  'design_revision_conflict'
);
RESET ROLE;

-- Copy atomically clones the document and binds the new Canvas node.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT public.loomic_design_copy(
  '95000000-0000-4000-8000-000000000004',:'source_value'::uuid,
  '94000000-0000-4000-8000-000000000001',1,'async-copy-node','Async copy',
  400,20,320,320,'91000000-0000-4000-8000-000000000001'
) AS value
\gset copied_
SELECT public.loomic_design_copy(
  '95000000-0000-4000-8000-000000000004',:'source_value'::uuid,
  '94000000-0000-4000-8000-000000000001',1,'async-copy-node','Async copy',
  400,20,320,320,'91000000-0000-4000-8000-000000000001'
) AS value
\gset copied_replay_
RESET ROLE;

SELECT pg_temp.qa_assert(
  (:'copied_value'::jsonb->>'canvas_revision')::bigint=2
  AND (:'copied_replay_value'::jsonb->>'replayed')::boolean
  AND (:'copied_value'::jsonb->>'design_id')=('' || (:'copied_replay_value'::jsonb->>'design_id'))
  AND (SELECT count(*)=1 FROM public.design_nodes WHERE element_id='async-copy-node'),
  'copy must atomically bind once and replay the same design'
);

-- Delete and restore retain the same design/binding and are independently replayable.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT public.loomic_design_soft_delete(
  :'source_value'::uuid,1,'95000000-0000-4000-8000-000000000005',
  '91000000-0000-4000-8000-000000000001'
) AS value
\gset deleted_
SELECT public.loomic_design_soft_delete(
  :'source_value'::uuid,1,'95000000-0000-4000-8000-000000000005',
  '91000000-0000-4000-8000-000000000001'
) AS value
\gset deleted_replay_
SELECT public.loomic_design_restore(
  :'source_value'::uuid,2,'95000000-0000-4000-8000-000000000006',
  '91000000-0000-4000-8000-000000000001'
) AS value
\gset restored_
SELECT public.loomic_design_restore(
  :'source_value'::uuid,2,'95000000-0000-4000-8000-000000000006',
  '91000000-0000-4000-8000-000000000001'
) AS value
\gset restored_replay_
RESET ROLE;

SELECT pg_temp.qa_assert(
  (:'deleted_value'::jsonb->>'revision')::bigint=2
  AND (:'deleted_replay_value'::jsonb->>'replayed')::boolean
  AND (:'restored_value'::jsonb->>'revision')::bigint=3
  AND (:'restored_replay_value'::jsonb->>'replayed')::boolean
  AND (SELECT deleted_at IS NULL FROM public.design_documents WHERE id=:'source_value'::uuid)
  AND (SELECT deleted_at IS NULL FROM public.design_nodes WHERE design_id=:'source_value'::uuid),
  'delete/restore must retain one identity and replay without duplicate mutation'
);

-- A member may enqueue a frozen revision, but stale completion can never win.
INSERT INTO public.asset_objects(
  id,scope,workspace_id,project_id,bucket,object_path,mime_type,created_by
) VALUES (
  '96000000-0000-4000-8000-000000000001','workspace',
  '92000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001',
  'workspace-assets','92000000-0000-4000-8000-000000000001/async-preview.png',
  'image/png','91000000-0000-4000-8000-000000000001'
);

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT public.loomic_design_preview_queue(
  :'source_value'::uuid,3,'95000000-0000-4000-8000-000000000007',
  '97000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000002'
) AS value
\gset preview_queue_
SELECT public.loomic_design_preview_queue(
  :'source_value'::uuid,3,'95000000-0000-4000-8000-000000000007',
  '97000000-0000-4000-8000-000000000002','91000000-0000-4000-8000-000000000002'
) AS value
\gset preview_queue_replay_
SELECT public.loomic_design_rename(
  :'source_value'::uuid,3,'95000000-0000-4000-8000-000000000008',
  'Revision four','91000000-0000-4000-8000-000000000001'
) AS value
\gset revision_four_
SELECT public.loomic_design_preview_commit(
  :'source_value'::uuid,3,'95000000-0000-4000-8000-000000000009',
  '96000000-0000-4000-8000-000000000001',3,
  '91000000-0000-4000-8000-000000000002'
) AS value
\gset stale_commit_
SELECT public.loomic_design_preview_queue(
  :'source_value'::uuid,4,'95000000-0000-4000-8000-000000000010',
  '97000000-0000-4000-8000-000000000003','91000000-0000-4000-8000-000000000002'
) AS value
\gset current_queue_
SELECT public.loomic_design_preview_commit(
  :'source_value'::uuid,4,'95000000-0000-4000-8000-000000000011',
  '96000000-0000-4000-8000-000000000001',4,
  '91000000-0000-4000-8000-000000000002'
) AS value
\gset current_commit_
RESET ROLE;

SELECT pg_temp.qa_assert(
  (:'preview_queue_value'::jsonb->>'status')='queued'
  AND (:'preview_queue_replay_value'::jsonb->>'replayed')::boolean
  AND (:'preview_queue_replay_value'::jsonb->>'job_id')=(:'preview_queue_value'::jsonb->>'job_id')
  AND NOT (:'stale_commit_value'::jsonb->>'committed')::boolean
  AND (:'current_commit_value'::jsonb->>'committed')::boolean
  AND (SELECT preview_status='ready' AND preview_revision=4
       AND preview_asset_object_id='96000000-0000-4000-8000-000000000001'
       FROM public.design_documents WHERE id=:'source_value'::uuid),
  'preview queue must freeze revision and stale completion must not overwrite current state'
);

-- If queue publication or rendering ultimately fails, only the still-current
-- queued revision may transition to an explicit preview error.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT public.loomic_design_rename(
  :'source_value'::uuid,4,'95000000-0000-4000-8000-000000000012',
  'Preview error fixture','91000000-0000-4000-8000-000000000001'
) AS value
\gset revision_five_
SELECT public.loomic_design_preview_queue(
  :'source_value'::uuid,5,'95000000-0000-4000-8000-000000000013',
  '97000000-0000-4000-8000-000000000004','91000000-0000-4000-8000-000000000002'
) AS value
\gset failed_preview_queue_
UPDATE public.background_jobs
SET status='dead_letter', failed_at=now(),
    error_code='design_renderer_unavailable',
    error_message='renderer unavailable'
WHERE id='97000000-0000-4000-8000-000000000004';
SELECT public.loomic_design_preview_mark_error(
  '97000000-0000-4000-8000-000000000004',
  'design_renderer_unavailable','renderer unavailable'
) AS value
\gset preview_error_
RESET ROLE;

SELECT pg_temp.qa_assert(
  (:'revision_five_value'::jsonb->>'revision')::bigint=5
  AND (:'failed_preview_queue_value'::jsonb->>'status')='queued'
  AND (:'preview_error_value'::jsonb->>'updated')::boolean
  AND (SELECT preview_status='error' AND revision=5
       FROM public.design_documents WHERE id=:'source_value'::uuid),
  'terminal preview jobs must mark only their frozen current queued revision as error'
);

-- Reference reconciliation removes stale materialized refs using scene authority.
INSERT INTO public.design_document_asset_refs(
  design_id,workspace_id,object_id,slot,asset_object_id
) VALUES (
  :'source_value'::uuid,'92000000-0000-4000-8000-000000000001',
  'stale-ref','source','96000000-0000-4000-8000-000000000001'
);
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT public.loomic_design_reconcile_references(:'source_value'::uuid);
RESET ROLE;
SELECT pg_temp.qa_assert(
  NOT EXISTS (SELECT 1 FROM public.design_document_asset_refs
              WHERE design_id=:'source_value'::uuid AND object_id='stale-ref'),
  'reference reconciler must remove refs absent from the authoritative scene'
);

INSERT INTO public.background_jobs(
  id,workspace_id,project_id,canvas_id,target_kind,design_id,queue_name,
  job_type,status,payload,created_by
) VALUES (
  '97000000-0000-4000-8000-000000000010',
  '92000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000001',NULL,'design',:'source_value'::uuid,
  'design_export_jobs','design_export','queued',
  jsonb_build_object(
    'design_id',:'source_value','revision',4,
    'idempotency_key','97000000-0000-4000-8000-000000000099',
    'requested_by','91000000-0000-4000-8000-000000000002',
    'format','png','multiplier',1,'transparent',true
  ),
  '91000000-0000-4000-8000-000000000002'
);
SELECT pg_temp.qa_expect_error(
  format($sql$INSERT INTO public.background_jobs(
    id,workspace_id,project_id,canvas_id,target_kind,design_id,queue_name,
    job_type,status,payload,created_by
  ) SELECT
    '97000000-0000-4000-8000-000000000011',workspace_id,project_id,canvas_id,
    target_kind,design_id,queue_name,job_type,status,payload,created_by
  FROM public.background_jobs WHERE id='97000000-0000-4000-8000-000000000010'$sql$),
  'background_jobs_design_export_idempotency_key'
);

-- Recovery scans return actionable design finalizations oldest-first while
-- excluding completed/needs-attention ledgers and active leases.
INSERT INTO public.background_jobs(
  id,workspace_id,project_id,canvas_id,target_kind,design_id,queue_name,
  job_type,status,payload,result,created_by,started_at,completed_at
) VALUES
(
  '97000000-0000-4000-8000-000000000020',
  '92000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000001',NULL,'design',:'source_value'::uuid,
  'image_generation_jobs','image_generation','succeeded',
  jsonb_build_object(
    'prompt','async recovery candidate',
    'target',jsonb_build_object(
      'kind','design','design_id',:'source_value','expected_revision',5,
      'idempotency_key','99000000-0000-4000-8000-000000000020'
    )
  ),
  jsonb_build_object(
    'asset_id','96000000-0000-4000-8000-000000000001',
    'width',1080,'height',1080,'mime_type','image/png'
  ),
  '91000000-0000-4000-8000-000000000002',now() - interval '2 minutes',now() - interval '1 minute'
),
(
  '97000000-0000-4000-8000-000000000021',
  '92000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000001',NULL,'design',:'source_value'::uuid,
  'image_generation_jobs','image_generation','succeeded',
  jsonb_build_object(
    'prompt','already finalized',
    'target',jsonb_build_object(
      'kind','design','design_id',:'source_value','expected_revision',5,
      'idempotency_key','99000000-0000-4000-8000-000000000021'
    )
  ),
  jsonb_build_object(
    'asset_id','96000000-0000-4000-8000-000000000001',
    'width',1080,'height',1080,'mime_type','image/png'
  ),
  '91000000-0000-4000-8000-000000000002',now() - interval '2 minutes',now() - interval '1 minute'
);
INSERT INTO public.job_target_finalizations(
  id,job_id,workspace_id,target_kind,target_id,status,command_id,
  result,attempt_count,completed_at
) VALUES (
  '99000000-0000-4000-8000-000000000022',
  '97000000-0000-4000-8000-000000000021',
  '92000000-0000-4000-8000-000000000001','design',:'source_value'::uuid,
  'completed','99000000-0000-4000-8000-000000000021',
  '{"replayed":false}'::jsonb,1,now()
);

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT count(*) AS value
FROM public.loomic_design_finalization_candidates(100)
WHERE id='97000000-0000-4000-8000-000000000020'
\gset finalization_candidate_
SELECT count(*) AS value
FROM public.loomic_design_finalization_candidates(100)
WHERE id='97000000-0000-4000-8000-000000000021'
\gset finalization_terminal_
RESET ROLE;

SELECT pg_temp.qa_assert(
  :'finalization_candidate_value'::integer=1
  AND :'finalization_terminal_value'::integer=0,
  'finalization recovery must include pending work and exclude terminal ledgers'
);

-- Isolate dispatcher rows, then prove lease recovery, capped retries and publish marking.
UPDATE public.design_event_outbox SET status='published',published_at=now();
INSERT INTO public.design_event_outbox(
  id,design_id,workspace_id,revision,event_type,payload,available_at
) VALUES (
  '98000000-0000-4000-8000-000000000001',:'source_value'::uuid,
   '92000000-0000-4000-8000-000000000001',98,'design.sync',
   jsonb_build_object('type','design.sync','designId',:'source_value','revision',98,'updateType','mutated','changedObjectIds','[]'::jsonb),
   '2026-09-04T00:00:00Z'
);

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT count(*) AS value FROM public.loomic_design_outbox_claim(
  1,'99000000-0000-4000-8000-000000000001','2026-09-04T00:00:00Z'
) WHERE id='98000000-0000-4000-8000-000000000001'
\gset lease_claim_
SELECT public.loomic_design_outbox_reconcile('2026-09-04T00:06:00Z') AS value
\gset lease_reconcile_
SELECT count(*) AS value FROM public.loomic_design_outbox_claim(
  1,'99000000-0000-4000-8000-000000000002','2026-09-04T00:06:00Z'
) WHERE id='98000000-0000-4000-8000-000000000001'
\gset retry_two_
SELECT public.loomic_design_outbox_mark_failed(
  '98000000-0000-4000-8000-000000000001','99000000-0000-4000-8000-000000000002',
  'socket unavailable','2026-09-04T00:06:00Z'
);
SELECT count(*) AS value FROM public.loomic_design_outbox_claim(
  1,'99000000-0000-4000-8000-000000000003','2026-09-04T00:07:00Z'
) WHERE id='98000000-0000-4000-8000-000000000001'
\gset retry_three_
SELECT public.loomic_design_outbox_mark_failed(
  '98000000-0000-4000-8000-000000000001','99000000-0000-4000-8000-000000000003',
  'socket still unavailable','2026-09-04T00:07:00Z'
);
SELECT count(*) AS value FROM public.loomic_design_outbox_claim(
  1,'99000000-0000-4000-8000-000000000004','2026-09-04T01:00:00Z'
) WHERE id='98000000-0000-4000-8000-000000000001'
\gset retry_four_

INSERT INTO public.design_event_outbox(
  id,design_id,workspace_id,revision,event_type,payload,available_at
) VALUES (
  '98000000-0000-4000-8000-000000000002',:'source_value'::uuid,
  '92000000-0000-4000-8000-000000000001',99,'design.sync',
  jsonb_build_object('type','design.sync','designId',:'source_value','revision',99,'updateType','mutated','changedObjectIds','[]'::jsonb),
  '2026-09-04T00:00:00Z'
);
SELECT count(*) AS value FROM public.loomic_design_outbox_claim(
  10,'99000000-0000-4000-8000-000000000005','2026-09-04T01:00:00Z'
) WHERE id='98000000-0000-4000-8000-000000000002'
\gset publish_claim_
SELECT public.loomic_design_outbox_mark_published(
  '98000000-0000-4000-8000-000000000002','99000000-0000-4000-8000-000000000005',
  '2026-09-04T01:00:01Z'
) AS value
\gset published_
RESET ROLE;

SELECT pg_temp.qa_assert(
  :'lease_claim_value'::integer=1
  AND :'lease_reconcile_value'::integer=1
  AND :'retry_two_value'::integer=1
  AND :'retry_three_value'::integer=1
  AND :'retry_four_value'::integer=0
  AND (SELECT attempt_count=3 AND status='failed' FROM public.design_event_outbox
       WHERE id='98000000-0000-4000-8000-000000000001'),
  'outbox lease recovery and retries must stop after three claims'
);
SELECT pg_temp.qa_assert(
  :'publish_claim_value'::integer=1
  AND :'published_value'::boolean
  AND (SELECT status='published' AND published_at IS NOT NULL
       FROM public.design_event_outbox WHERE id='98000000-0000-4000-8000-000000000002'),
  'outbox publish must require and consume the active claim token'
);

SELECT pg_temp.qa_assert(
  NOT has_function_privilege('authenticated','public.loomic_design_rename(uuid,bigint,uuid,text,uuid)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.loomic_design_preview_commit(uuid,bigint,uuid,uuid,bigint,uuid)','EXECUTE')
  AND has_function_privilege('service_role','public.loomic_design_preview_queue(uuid,bigint,uuid,uuid,uuid)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.loomic_design_preview_mark_error(uuid,text,text)','EXECUTE')
  AND has_function_privilege('service_role','public.loomic_design_finalization_candidates(integer)','EXECUTE'),
  'lifecycle and preview commit RPCs must remain server-only'
);

\echo 'PASS Stage2 lifecycle/copy/preview/outbox/reference behavior'
ROLLBACK;
