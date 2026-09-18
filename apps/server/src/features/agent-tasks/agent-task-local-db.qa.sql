\set ON_ERROR_STOP on
-- Run only against a disposable/local database with migration 000007 installed.
-- All fixture rows and attempted writes are rolled back. No providers or queue RPCs.
BEGIN;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '3s';
DO $$ BEGIN
  IF current_database()<>'loomic_replica_light_20260907' THEN
    RAISE EXCEPTION 'QA refuses non-local replica database';
  END IF;
END $$;
CREATE FUNCTION pg_temp.qa_assert(condition boolean,message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'QA assertion failed: %',message; END IF; END $$;
CREATE FUNCTION pg_temp.qa_error(statement text,expected text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    IF position(expected IN SQLERRM)=0 THEN RAISE EXCEPTION 'Expected %, got %',expected,SQLERRM; END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'Expected error %, but succeeded',expected;
END $$;

INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES
('00000000-0000-0000-0000-000000000000','aa010000-0000-4000-8000-000000000001','authenticated','authenticated','task-qa-a@local.test','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','aa010000-0000-4000-8000-000000000002','authenticated','authenticated','task-qa-b@local.test','',now(),'{}','{}',now(),now());
INSERT INTO public.workspaces(id,type,name,owner_user_id) VALUES
('aa020000-0000-4000-8000-000000000001','team','Task QA A','aa010000-0000-4000-8000-000000000001'),
('aa020000-0000-4000-8000-000000000002','team','Task QA B','aa010000-0000-4000-8000-000000000002');
INSERT INTO public.workspace_members(workspace_id,user_id,role) VALUES
('aa020000-0000-4000-8000-000000000001','aa010000-0000-4000-8000-000000000001','owner'),
('aa020000-0000-4000-8000-000000000002','aa010000-0000-4000-8000-000000000002','owner');
INSERT INTO public.projects(id,workspace_id,name,slug,created_by) VALUES
('aa030000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000001','Task QA A','task-qa-a','aa010000-0000-4000-8000-000000000001'),
('aa030000-0000-4000-8000-000000000002','aa020000-0000-4000-8000-000000000002','Task QA B','task-qa-b','aa010000-0000-4000-8000-000000000002');
INSERT INTO public.canvases(id,project_id,name,is_primary,created_by,content) VALUES
('aa040000-0000-4000-8000-000000000001','aa030000-0000-4000-8000-000000000001','Task QA A',true,'aa010000-0000-4000-8000-000000000001',
 '{"elements":[{"id":"source-a","type":"image","fileId":"source-file","customData":{"assetId":"aa050000-0000-4000-8000-000000000099"}}],"files":{"source-file":{"assetId":"aa050000-0000-4000-8000-000000000001"}},"appState":{}}'),
('aa040000-0000-4000-8000-000000000002','aa030000-0000-4000-8000-000000000002','Task QA B',true,'aa010000-0000-4000-8000-000000000002',
 '{"elements":[{"id":"source-b","type":"image","customData":{"assetId":"aa050000-0000-4000-8000-000000000002"}}],"files":{},"appState":{}}');
INSERT INTO public.chat_sessions(id,canvas_id,title,created_by,thread_id) VALUES
('aa060000-0000-4000-8000-000000000001','aa040000-0000-4000-8000-000000000001','Task QA A','aa010000-0000-4000-8000-000000000001','task-qa-a'),
('aa060000-0000-4000-8000-000000000002','aa040000-0000-4000-8000-000000000002','Task QA B','aa010000-0000-4000-8000-000000000002','task-qa-b');
INSERT INTO public.agent_runs(id,session_id,thread_id,status,execution_mode,created_by) VALUES
('aa070000-0000-4000-8000-000000000001','aa060000-0000-4000-8000-000000000001','task-qa-a','running','fast','aa010000-0000-4000-8000-000000000001'),
('aa070000-0000-4000-8000-000000000002','aa060000-0000-4000-8000-000000000001','task-qa-a','running','fast','aa010000-0000-4000-8000-000000000001'),
('aa070000-0000-4000-8000-000000000003','aa060000-0000-4000-8000-000000000001','task-qa-a','running','fast','aa010000-0000-4000-8000-000000000001'),
('aa070000-0000-4000-8000-000000000004','aa060000-0000-4000-8000-000000000002','task-qa-b','running','fast','aa010000-0000-4000-8000-000000000002');
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT public.loomic_agent_task_begin(
  'aa010000-0000-4000-8000-000000000001','aa060000-0000-4000-8000-000000000001',
  'aa040000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000001','Keep the logo; soften the background',
  '{"kind":"canvas_image","elementId":"source-a","assetId":"aa050000-0000-4000-8000-000000000001"}',NULL);

SELECT pg_temp.qa_assert(public.loomic_agent_task_assert_current('aa070000-0000-4000-8000-000000000003') IS NULL,
  'unscoped ordinary chat has no intent and cannot invalidate it');
SELECT pg_temp.qa_assert(public.loomic_agent_task_current('aa010000-0000-4000-8000-000000000001','aa060000-0000-4000-8000-000000000001')->>'revision'='1',
  'current intent survives ordinary chat');
SELECT pg_temp.qa_error($q$ SELECT public.loomic_agent_task_current('aa010000-0000-4000-8000-000000000002','aa060000-0000-4000-8000-000000000001') $q$,
  'agent_task_session_forbidden');
SELECT pg_temp.qa_error($q$ SELECT public.loomic_agent_task_begin(
  'aa010000-0000-4000-8000-000000000001','aa060000-0000-4000-8000-000000000001',
  'aa040000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000003','Wrong source',
  '{"kind":"canvas_image","elementId":"source-b","assetId":"aa050000-0000-4000-8000-000000000002"}',NULL) $q$,
  'agent_task_target_forbidden');

-- Output is a NEW placeholder. Its source authority is distinct from placement.
INSERT INTO public.background_jobs(id,workspace_id,project_id,canvas_id,target_kind,session_id,queue_name,job_type,status,payload,result,created_by) VALUES
('aa080000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000001','aa030000-0000-4000-8000-000000000001',
 'aa040000-0000-4000-8000-000000000001','canvas','aa060000-0000-4000-8000-000000000001','image_generation_jobs','image_generation','succeeded',
 '{"origin_run_id":"aa070000-0000-4000-8000-000000000001","source_element_id":"source-a","source_asset_id":"aa050000-0000-4000-8000-000000000001","placeholder_element_id":"new-output","target":{"kind":"canvas","canvas_id":"aa040000-0000-4000-8000-000000000001","element_id":"new-output"}}',
 '{"asset_id":"aa050000-0000-4000-8000-000000000003","width":1024,"height":1024,"mime_type":"image/png"}','aa010000-0000-4000-8000-000000000001');

SELECT public.loomic_agent_task_update_brief('aa070000-0000-4000-8000-000000000001',
  '{"goal":"Soft background","preserve":["logo"],"changes":["background"],"acceptance":["Logo unchanged"]}');
SELECT public.loomic_agent_task_begin(
  'aa010000-0000-4000-8000-000000000001','aa060000-0000-4000-8000-000000000001',
  'aa040000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000002','Keep the footer too',NULL,
  'aa070000-0000-4000-8000-000000000001');
SELECT pg_temp.qa_assert(public.loomic_agent_task_current('aa010000-0000-4000-8000-000000000001','aa060000-0000-4000-8000-000000000001')
  @> '{"revision":2,"goal":"Keep the logo; soften the background","corrections":["Keep the footer too"],"target":{"elementId":"source-a"}}',
  'correction retains the original goal and source selection');
SELECT pg_temp.qa_error($q$ SELECT public.loomic_agent_task_assert_current('aa070000-0000-4000-8000-000000000001') $q$,'agent_task_superseded');
SELECT pg_temp.qa_error($q$ SELECT public.loomic_agent_task_update_brief('aa070000-0000-4000-8000-000000000001','{"goal":"old"}') $q$,'agent_task_superseded');

-- Actual stale canvas write must roll back, not merely fail a preflight read.
SELECT pg_temp.qa_error($q$ UPDATE public.canvases SET content=jsonb_set(content,'{elements}',content->'elements'||
  '[{"id":"late-output","type":"image","fileId":"late-file","customData":{"sourceJobId":"aa080000-0000-4000-8000-000000000001","assetId":"aa050000-0000-4000-8000-000000000003"}}]')
  WHERE id='aa040000-0000-4000-8000-000000000001' $q$,'agent_task_superseded');
SELECT pg_temp.qa_assert((SELECT jsonb_array_length(content->'elements')=1 FROM public.canvases WHERE id='aa040000-0000-4000-8000-000000000001'),
  'late output did not enter the canvas');
SELECT pg_temp.qa_assert((SELECT status='succeeded' AND result->>'asset_id'='aa050000-0000-4000-8000-000000000003'
  FROM public.background_jobs WHERE id='aa080000-0000-4000-8000-000000000001'),
  'successful generation and its asset remain retained');
SELECT pg_temp.qa_error($q$ UPDATE public.background_jobs SET image_enqueued_at=now()
  WHERE id='aa080000-0000-4000-8000-000000000001' $q$,'agent_task_superseded');
SELECT pg_temp.qa_error($q$ UPDATE public.background_jobs SET payload=payload-'origin_run_id'
  WHERE id='aa080000-0000-4000-8000-000000000001' $q$,'agent_task_job_immutable');
SELECT pg_temp.qa_error($q$ SELECT public.loomic_agent_task_begin(
  'aa010000-0000-4000-8000-000000000001','aa060000-0000-4000-8000-000000000001',
  'aa040000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000003','Stale correction',NULL,
  'aa070000-0000-4000-8000-000000000001') $q$,'agent_task_correction_conflict');
SELECT pg_temp.qa_assert(NOT has_function_privilege('authenticated','public.loomic_agent_task_begin(uuid,uuid,uuid,uuid,text,jsonb,uuid)','EXECUTE'),
  'intent cannot be rewritten directly by an authenticated database client');
\ir agent-task-design-assertions.qa.sql
ROLLBACK;
