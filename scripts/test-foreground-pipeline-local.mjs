import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const database = 'loomic_replica_light_20260907';
const container = 'supabase_db_thtdhcvjppuvlvahfmga';
const query = sql => execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', database, '-Atq'], { input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
if (query('SELECT current_database();').trim() !== database) throw new Error('Refusing non-local database');
const name = '20260909000015_image_foreground_stage';
const migrationSource = await readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
const functionDefinition = functionName => {
  const start = migrationSource.indexOf(`CREATE OR REPLACE FUNCTION public.${functionName}`);
  const end = migrationSource.indexOf('$$;', start);
  if (start < 0 || end < 0) throw new Error(`Missing ${functionName} definition in ${name}`);
  return migrationSource.slice(start, end + 3);
};
// An already-migrated disposable replica may contain an earlier working-tree
// revision. Refresh replaceable functions inside this test transaction so the
// assertions always exercise the checked-out migration; ROLLBACK restores DB state.
const migration = query("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='20260909000015';").trim() === '0'
  ? migrationSource
  : ['loomic_provider_snapshot_create(', 'deduct_credits(', 'loomic_guard_frozen_image_job()', 'loomic_commit_image_job(']
      .map(functionDefinition).join('\n');
const source = await readFile(new URL('../apps/server/src/features/agent-tasks/agent-task-local-db.qa.sql', import.meta.url), 'utf8');
const fixture = source.slice(0, source.indexOf('INSERT INTO public.chat_sessions')).replace(/^BEGIN;\r?$/m, '');
const sql = `BEGIN;
${migration}
${fixture}
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
INSERT INTO public.design_documents(id,workspace_id,project_id,name,scene,width,height,created_by)
VALUES('aa080000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000001','aa030000-0000-4000-8000-000000000001','QA foreground',
 '{"schemaVersion":1,"engine":"fabric","canvas":{"width":640,"height":360,"background":"#ffffff"},"objects":[]}',640,360,'aa010000-0000-4000-8000-000000000001');
INSERT INTO public.workspace_provider_configs(id,workspace_id,adapter,display_name,base_url,enabled,api_key_secret_id,api_key_last_four,revision,last_test_status,created_by,updated_by)
VALUES('aa090000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000001','openai_compatible','QA foreground','https://api.apiyi.com/v1',true,vault.create_secret('synthetic-no-network'),'work',1,'succeeded','aa010000-0000-4000-8000-000000000001','aa010000-0000-4000-8000-000000000001');
INSERT INTO public.workspace_provider_models(provider_config_id,upstream_model_id,display_name,modality,enabled,capabilities,catalog_key) VALUES
('aa090000-0000-4000-8000-000000000001','gpt-image-2-all','QA primary','image',true,'["image_generation"]','aa090000-0000-4000-8000-000000000002'),
('aa090000-0000-4000-8000-000000000001','gpt-image-2','QA matting','image',true,'["image_generation"]','aa090000-0000-4000-8000-000000000003');
INSERT INTO public.chat_sessions(id,canvas_id,title,created_by,thread_id)
VALUES('aa060000-0000-4000-8000-000000000001','aa040000-0000-4000-8000-000000000001','Foreground pipeline QA','aa010000-0000-4000-8000-000000000001','foreground-pipeline-qa');
UPDATE public.credit_balances SET balance=100
WHERE workspace_id='aa020000-0000-4000-8000-000000000001';

CREATE FUNCTION pg_temp.qa_frozen_job_rejects(p_input jsonb,p_payload jsonb,p_cost integer,p_label text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE test_id uuid:=gen_random_uuid(); BEGIN
  INSERT INTO public.image_generation_proposals(
    id,session_id,canvas_id,created_by,origin_run_id,input,details,status,approved_cost
  ) VALUES(test_id,'aa060000-0000-4000-8000-000000000001','aa040000-0000-4000-8000-000000000001',
    'aa010000-0000-4000-8000-000000000001',gen_random_uuid(),p_input,'{}','confirmed',p_cost);
  BEGIN
    INSERT INTO public.background_jobs(
      id,workspace_id,project_id,design_id,target_kind,session_id,queue_name,job_type,status,payload,created_by
    ) VALUES(test_id,'aa020000-0000-4000-8000-000000000001','aa030000-0000-4000-8000-000000000001',
      'aa080000-0000-4000-8000-000000000001','design','aa060000-0000-4000-8000-000000000001',
      'image_generation_jobs','image_generation','queued',p_payload,'aa010000-0000-4000-8000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    IF position('frozen_image_job_mismatch' IN SQLERRM)=0 THEN
      RAISE EXCEPTION 'Expected frozen_image_job_mismatch for %, got %',p_label,SQLERRM;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'Expected frozen_image_job_mismatch for %, but insert succeeded',p_label;
END $$;

CREATE FUNCTION pg_temp.qa_credit_rejects(p_input jsonb,p_payload jsonb,p_cost integer,p_primary_cost integer,p_label text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE test_id uuid:=gen_random_uuid(); balance_before integer; BEGIN
  p_input:=jsonb_set(p_input,'{target,idempotency_key}',to_jsonb(test_id::text));
  p_payload:=jsonb_set(p_payload,'{target,idempotency_key}',to_jsonb(test_id::text));
  SELECT balance INTO balance_before FROM public.credit_balances
    WHERE workspace_id='aa020000-0000-4000-8000-000000000001';
  INSERT INTO public.image_generation_proposals(
    id,session_id,canvas_id,created_by,origin_run_id,input,details,status,approved_cost
  ) VALUES(test_id,'aa060000-0000-4000-8000-000000000001','aa040000-0000-4000-8000-000000000001',
    'aa010000-0000-4000-8000-000000000001',gen_random_uuid(),p_input,'{}','confirmed',p_cost);
  INSERT INTO public.background_jobs(
    id,workspace_id,project_id,design_id,target_kind,session_id,queue_name,job_type,status,payload,created_by
  ) VALUES(test_id,'aa020000-0000-4000-8000-000000000001','aa030000-0000-4000-8000-000000000001',
    'aa080000-0000-4000-8000-000000000001','design','aa060000-0000-4000-8000-000000000001',
    'image_generation_jobs','image_generation','queued',p_payload,'aa010000-0000-4000-8000-000000000001');
  PERFORM public.loomic_provider_snapshot_create(
    'aa020000-0000-4000-8000-000000000001','aa090000-0000-4000-8000-000000000002',NULL,
    test_id,p_primary_cost,'credits-v1','image');
  BEGIN
    PERFORM public.deduct_credits('aa020000-0000-4000-8000-000000000001',
      'aa010000-0000-4000-8000-000000000001',p_cost,test_id,'QA invalid quote');
  EXCEPTION WHEN OTHERS THEN
    IF position('credit_price_mismatch' IN SQLERRM)=0 THEN
      RAISE EXCEPTION 'Expected credit_price_mismatch for %, got %',p_label,SQLERRM;
    END IF;
    IF (SELECT balance FROM public.credit_balances WHERE workspace_id='aa020000-0000-4000-8000-000000000001') IS DISTINCT FROM balance_before
      OR EXISTS(SELECT 1 FROM public.credit_transactions WHERE job_id=test_id)
      OR EXISTS(SELECT 1 FROM public.background_jobs WHERE id=test_id AND credits_transaction_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Rejected credit quote changed billing state for %',p_label;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'Expected credit_price_mismatch for %, but debit succeeded',p_label;
END $$;

-- Canonical explicit generate and remove_background operations both pass the
-- insert guard. These rows also prove camelCase proposals map to snake_case jobs.
INSERT INTO public.image_generation_proposals(
  id,session_id,canvas_id,created_by,origin_run_id,input,details,status,approved_cost
) VALUES(
  'aa070000-0000-4000-8000-000000000002','aa060000-0000-4000-8000-000000000001','aa040000-0000-4000-8000-000000000001',
  'aa010000-0000-4000-8000-000000000001',gen_random_uuid(),
  '{"prompt":"logo","model":"workspace:aa090000-0000-4000-8000-000000000002","aspectRatio":"1:1","quality":"hd","operation":"generate","outputFormat":"png","target":{"kind":"design","design_id":"aa080000-0000-4000-8000-000000000001","expected_revision":0,"idempotency_key":"aa070000-0000-4000-8000-000000000092","placement":{"x":0,"y":0,"role":"logo"}},"foregroundPolicy":{"version":1,"mode":"api_matting","generationModel":"workspace:aa090000-0000-4000-8000-000000000002","mattingModel":"workspace:aa090000-0000-4000-8000-000000000003","generationCredits":7,"mattingCredits":20,"totalCredits":27,"pricingVersion":"credits-v1"}}',
  '{}','confirmed',27
);
INSERT INTO public.background_jobs(
  id,workspace_id,project_id,design_id,target_kind,session_id,queue_name,job_type,status,payload,created_by
) VALUES(
  'aa070000-0000-4000-8000-000000000002','aa020000-0000-4000-8000-000000000001','aa030000-0000-4000-8000-000000000001',
  'aa080000-0000-4000-8000-000000000001','design','aa060000-0000-4000-8000-000000000001','image_generation_jobs','image_generation','queued',
  '{"prompt":"logo","model":"workspace:aa090000-0000-4000-8000-000000000002","aspect_ratio":"1:1","quality":"hd","operation":"generate","output_format":"png","target":{"kind":"design","design_id":"aa080000-0000-4000-8000-000000000001","expected_revision":0,"idempotency_key":"aa070000-0000-4000-8000-000000000092","placement":{"x":0,"y":0,"role":"logo"}},"foreground_policy":{"version":1,"mode":"api_matting","generationModel":"workspace:aa090000-0000-4000-8000-000000000002","mattingModel":"workspace:aa090000-0000-4000-8000-000000000003","generationCredits":7,"mattingCredits":20,"totalCredits":27,"pricingVersion":"credits-v1"}}',
  'aa010000-0000-4000-8000-000000000001'
);
INSERT INTO public.image_generation_proposals(
  id,session_id,canvas_id,created_by,origin_run_id,input,details,status,approved_cost
) VALUES(
  'aa070000-0000-4000-8000-000000000003','aa060000-0000-4000-8000-000000000001','aa040000-0000-4000-8000-000000000001',
  'aa010000-0000-4000-8000-000000000001',gen_random_uuid(),
  '{"prompt":"remove background","model":"gpt-image-2","aspectRatio":"1:1","operation":"remove_background","outputFormat":"png","inputImages":["data:image/png;base64,AA=="],"target":{"kind":"canvas","canvas_id":"aa040000-0000-4000-8000-000000000001"}}',
  '{}','confirmed',20
);
INSERT INTO public.background_jobs(
  id,workspace_id,project_id,canvas_id,target_kind,session_id,queue_name,job_type,status,payload,created_by
) VALUES(
  'aa070000-0000-4000-8000-000000000003','aa020000-0000-4000-8000-000000000001','aa030000-0000-4000-8000-000000000001',
  'aa040000-0000-4000-8000-000000000001','canvas','aa060000-0000-4000-8000-000000000001','image_generation_jobs','image_generation','queued',
  '{"prompt":"remove background","model":"gpt-image-2","aspect_ratio":"1:1","operation":"remove_background","output_format":"png","input_images":["data:image/png;base64,AA=="],"target":{"kind":"canvas","canvas_id":"aa040000-0000-4000-8000-000000000001"}}',
  'aa010000-0000-4000-8000-000000000001'
);
SELECT pg_temp.qa_assert((SELECT count(*)=2 FROM public.background_jobs WHERE id IN (
  'aa070000-0000-4000-8000-000000000002','aa070000-0000-4000-8000-000000000003')),
  'explicit generate and remove_background operations pass the frozen guard');

DO $$ DECLARE
  field text;
  proposal_input jsonb := '{"prompt":"logo","model":"workspace:aa090000-0000-4000-8000-000000000002","aspectRatio":"1:1","quality":"hd","operation":"generate","outputFormat":"png","target":{"kind":"design","design_id":"aa080000-0000-4000-8000-000000000001","expected_revision":0,"idempotency_key":"aa070000-0000-4000-8000-000000000093","placement":{"x":0,"y":0,"role":"logo"}},"foregroundPolicy":{"version":1,"mode":"api_matting","generationModel":"workspace:aa090000-0000-4000-8000-000000000002","mattingModel":"workspace:aa090000-0000-4000-8000-000000000003","generationCredits":7,"mattingCredits":20,"totalCredits":27,"pricingVersion":"credits-v1"}}';
  job_payload jsonb := '{"prompt":"logo","model":"workspace:aa090000-0000-4000-8000-000000000002","aspect_ratio":"1:1","quality":"hd","operation":"generate","output_format":"png","target":{"kind":"design","design_id":"aa080000-0000-4000-8000-000000000001","expected_revision":0,"idempotency_key":"aa070000-0000-4000-8000-000000000093","placement":{"x":0,"y":0,"role":"logo"}},"foreground_policy":{"version":1,"mode":"api_matting","generationModel":"workspace:aa090000-0000-4000-8000-000000000002","mattingModel":"workspace:aa090000-0000-4000-8000-000000000003","generationCredits":7,"mattingCredits":20,"totalCredits":27,"pricingVersion":"credits-v1"}}';
BEGIN
  FOREACH field IN ARRAY ARRAY['version','mode','generationModel','mattingModel','generationCredits','mattingCredits','totalCredits','pricingVersion'] LOOP
    PERFORM pg_temp.qa_frozen_job_rejects(proposal_input,
      jsonb_set(job_payload,ARRAY['foreground_policy',field],'null'::jsonb),27,'foregroundPolicy.'||field);
  END LOOP;
  PERFORM pg_temp.qa_frozen_job_rejects(proposal_input,
    jsonb_set(job_payload,'{foreground_policy,unapprovedField}','true'::jsonb),27,'foregroundPolicy extra field');
  PERFORM pg_temp.qa_frozen_job_rejects(proposal_input,job_payload,26,'approved_cost differs from totalCredits');
  PERFORM pg_temp.qa_frozen_job_rejects(proposal_input,
    jsonb_set(job_payload,'{output_format}','"jpeg"'::jsonb),27,'output_format changed');
  PERFORM pg_temp.qa_frozen_job_rejects(proposal_input,job_payload-'output_format',27,'output_format omitted');
  PERFORM pg_temp.qa_frozen_job_rejects(proposal_input,
    jsonb_set(job_payload,'{operation}','"remove_background"'::jsonb),27,'operation changed');
  PERFORM pg_temp.qa_credit_rejects(
    jsonb_set(proposal_input,'{foregroundPolicy,totalCredits}','28'::jsonb),
    jsonb_set(job_payload,'{foreground_policy,totalCredits}','28'::jsonb),28,7,
    'foreground total differs from generation plus matting');
  PERFORM pg_temp.qa_credit_rejects(proposal_input,job_payload,27,8,
    'generation snapshot stage cost differs from frozen generationCredits');
END $$;
INSERT INTO public.background_jobs(id,workspace_id,project_id,canvas_id,target_kind,design_id,queue_name,job_type,status,payload,created_by)
VALUES('aa070000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000001','aa030000-0000-4000-8000-000000000001',NULL,'design','aa080000-0000-4000-8000-000000000001','image_generation_jobs','image_generation','queued',
 '{"prompt":"logo","model":"workspace:aa090000-0000-4000-8000-000000000002","target":{"kind":"design","design_id":"aa080000-0000-4000-8000-000000000001","expected_revision":0,"idempotency_key":"aa070000-0000-4000-8000-000000000099","placement":{"x":0,"y":0,"role":"logo"}},"foreground_policy":{"version":1,"mode":"api_matting","generationModel":"workspace:aa090000-0000-4000-8000-000000000002","mattingModel":"workspace:aa090000-0000-4000-8000-000000000003","generationCredits":7,"mattingCredits":20,"totalCredits":27,"pricingVersion":"credits-v1"}}', 'aa010000-0000-4000-8000-000000000001');
SELECT public.loomic_provider_snapshot_create('aa020000-0000-4000-8000-000000000001','aa090000-0000-4000-8000-000000000002',NULL,'aa070000-0000-4000-8000-000000000001',27,'credits-v1','image');
SELECT pg_temp.qa_assert(NOT has_function_privilege('authenticated','public.loomic_foreground_snapshot_create(uuid,uuid)','EXECUTE'),'authenticated cannot add paid stages');
SELECT pg_temp.qa_assert(NOT has_function_privilege('authenticated','public.loomic_foreground_snapshot_resolve(uuid,uuid)','EXECUTE'),'authenticated cannot read provider secrets');
SELECT pg_temp.qa_error($q$ SELECT public.loomic_foreground_snapshot_create('aa020000-0000-4000-8000-000000000002','aa070000-0000-4000-8000-000000000001') $q$,'foreground_snapshot_target_invalid');
SELECT pg_temp.qa_assert(public.loomic_foreground_snapshot_create('aa020000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000001') = public.loomic_foreground_snapshot_create('aa020000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000001'),'helper snapshot is idempotent');
SELECT pg_temp.qa_assert((SELECT count(*)=2 FROM public.provider_execution_snapshots WHERE background_job_id='aa070000-0000-4000-8000-000000000001'),'two distinct frozen stages');
SELECT pg_temp.qa_assert((SELECT upstream_model_id='gpt-image-2-all' FROM public.loomic_provider_job_snapshot_resolve('aa020000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000001')),'primary does not switch to helper');
SELECT pg_temp.qa_assert((SELECT upstream_model_id='gpt-image-2' AND billing_credits_cost=20 FROM public.loomic_foreground_snapshot_resolve('aa020000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000001')),'helper uses exact model and confirmed quote');
SELECT pg_temp.qa_assert((SELECT count(*)=0 FROM public.loomic_foreground_snapshot_resolve('aa020000-0000-4000-8000-000000000002','aa070000-0000-4000-8000-000000000001')),'cross-tenant secret resolution denied');

-- Commit must fail before debit and queue publication until both frozen stages
-- exist. The error identifies which stage is missing.
SELECT pg_temp.qa_error($q$ SELECT public.loomic_commit_image_job('aa070000-0000-4000-8000-000000000002') $q$,'image_provider_snapshot_missing');
SELECT pg_temp.qa_assert((SELECT balance=100 FROM public.credit_balances WHERE workspace_id='aa020000-0000-4000-8000-000000000001'),'missing primary snapshot does not deduct credits');
SELECT pg_temp.qa_assert((SELECT credits_transaction_id IS NULL AND image_enqueued_at IS NULL FROM public.background_jobs WHERE id='aa070000-0000-4000-8000-000000000002'),'missing primary snapshot does not mark the job charged or enqueued');
SELECT pg_temp.qa_assert((SELECT count(*)=0 FROM pgmq.q_image_generation_jobs WHERE message->>'job_id'='aa070000-0000-4000-8000-000000000002'),'missing primary snapshot does not publish a queue message');
SELECT public.loomic_provider_snapshot_create('aa020000-0000-4000-8000-000000000001','aa090000-0000-4000-8000-000000000002',NULL,'aa070000-0000-4000-8000-000000000002',7,'credits-v1','image');
SELECT pg_temp.qa_assert(public.loomic_provider_snapshot_create(
  'aa020000-0000-4000-8000-000000000001','aa090000-0000-4000-8000-000000000002',NULL,
  'aa070000-0000-4000-8000-000000000002',7,'credits-v1','image') =
  (SELECT id FROM public.provider_execution_snapshots WHERE background_job_id='aa070000-0000-4000-8000-000000000002' AND execution_stage='generation'),
  'primary crash recovery reuses the exact frozen snapshot');
SELECT pg_temp.qa_assert((SELECT count(*)=1 FROM public.provider_execution_snapshots
  WHERE background_job_id='aa070000-0000-4000-8000-000000000002' AND execution_stage='generation'),
  'primary crash recovery creates no second credential snapshot');
SELECT pg_temp.qa_error($q$ SELECT public.loomic_provider_snapshot_create(
  'aa020000-0000-4000-8000-000000000001','aa090000-0000-4000-8000-000000000003',NULL,
  'aa070000-0000-4000-8000-000000000002',7,'credits-v1','image') $q$,'provider_snapshot_existing_mismatch');
SELECT pg_temp.qa_error($q$ SELECT public.loomic_provider_snapshot_create(
  'aa020000-0000-4000-8000-000000000001','aa090000-0000-4000-8000-000000000002',NULL,
  'aa070000-0000-4000-8000-000000000002',8,'credits-v1','image') $q$,'provider_snapshot_existing_mismatch');
SELECT pg_temp.qa_error($q$ SELECT public.loomic_commit_image_job('aa070000-0000-4000-8000-000000000002') $q$,'image_foreground_snapshot_missing');
SELECT pg_temp.qa_assert((SELECT balance=100 FROM public.credit_balances WHERE workspace_id='aa020000-0000-4000-8000-000000000001'),'missing helper snapshot does not deduct credits');
SELECT pg_temp.qa_assert((SELECT count(*)=0 FROM public.credit_transactions WHERE job_id='aa070000-0000-4000-8000-000000000002'),'missing helper snapshot creates no credit transaction');
SELECT pg_temp.qa_assert((SELECT credits_transaction_id IS NULL AND image_enqueued_at IS NULL FROM public.background_jobs WHERE id='aa070000-0000-4000-8000-000000000002'),'missing helper snapshot does not mark the job charged or enqueued');
SELECT pg_temp.qa_assert((SELECT count(*)=0 FROM pgmq.q_image_generation_jobs WHERE message->>'job_id'='aa070000-0000-4000-8000-000000000002'),'missing helper snapshot does not publish a queue message');
SELECT public.loomic_foreground_snapshot_create('aa020000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000002');
SELECT public.loomic_commit_image_job('aa070000-0000-4000-8000-000000000002');
SELECT pg_temp.qa_assert((SELECT balance=73 FROM public.credit_balances WHERE workspace_id='aa020000-0000-4000-8000-000000000001'),'complete primary and helper snapshots deduct the confirmed total exactly once');
SELECT pg_temp.qa_assert((SELECT credits_cost=27 AND credits_transaction_id IS NOT NULL AND image_enqueued_at IS NOT NULL FROM public.background_jobs WHERE id='aa070000-0000-4000-8000-000000000002'),'complete snapshots mark the exact total and enqueue acknowledgement');
SELECT pg_temp.qa_assert((SELECT count(*)=1 FROM public.credit_transactions WHERE job_id='aa070000-0000-4000-8000-000000000002' AND transaction_type='generation_deduct' AND amount=-27),'complete snapshots create one exact-total debit');
SELECT pg_temp.qa_assert((SELECT count(*)=1 FROM pgmq.q_image_generation_jobs WHERE message->>'job_id'='aa070000-0000-4000-8000-000000000002'),'complete snapshots publish exactly one queue message');
UPDATE public.workspace_provider_models SET upstream_model_id='mutated-primary'
  WHERE catalog_key='aa090000-0000-4000-8000-000000000002';
SELECT pg_temp.qa_assert(public.loomic_provider_snapshot_create(
  'aa020000-0000-4000-8000-000000000001','aa090000-0000-4000-8000-000000000002',NULL,
  'aa070000-0000-4000-8000-000000000002',7,'credits-v1','image') =
  (SELECT id FROM public.provider_execution_snapshots WHERE background_job_id='aa070000-0000-4000-8000-000000000002' AND execution_stage='generation'),
  'current catalog edits do not replace an existing primary snapshot');
SELECT pg_temp.qa_assert((SELECT upstream_model_id='gpt-image-2-all' FROM public.loomic_provider_job_snapshot_resolve(
  'aa020000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000002')),
  'primary crash recovery retains the original frozen upstream provider');

-- A workspace alias remapped to all/vip cannot satisfy an operation whose
-- frozen semantics require the exact gpt-image-2 upstream model.
INSERT INTO public.image_generation_proposals(
  id,session_id,canvas_id,created_by,origin_run_id,input,details,status,approved_cost
) VALUES(
  'aa070000-0000-4000-8000-000000000006','aa060000-0000-4000-8000-000000000001','aa040000-0000-4000-8000-000000000001',
  'aa010000-0000-4000-8000-000000000001',gen_random_uuid(),
  '{"prompt":"remove background","model":"workspace:aa090000-0000-4000-8000-000000000002","aspectRatio":"1:1","operation":"remove_background","outputFormat":"png","inputImages":["data:image/png;base64,AA=="],"target":{"kind":"canvas","canvas_id":"aa040000-0000-4000-8000-000000000001"}}',
  '{}','confirmed',7
);
INSERT INTO public.background_jobs(
  id,workspace_id,project_id,canvas_id,target_kind,session_id,queue_name,job_type,status,payload,created_by
) VALUES(
  'aa070000-0000-4000-8000-000000000006','aa020000-0000-4000-8000-000000000001','aa030000-0000-4000-8000-000000000001',
  'aa040000-0000-4000-8000-000000000001','canvas','aa060000-0000-4000-8000-000000000001',
  'image_generation_jobs','image_generation','queued',
  '{"prompt":"remove background","model":"workspace:aa090000-0000-4000-8000-000000000002","aspect_ratio":"1:1","operation":"remove_background","output_format":"png","input_images":["data:image/png;base64,AA=="],"target":{"kind":"canvas","canvas_id":"aa040000-0000-4000-8000-000000000001"}}',
  'aa010000-0000-4000-8000-000000000001'
);
SELECT pg_temp.qa_error($q$ SELECT public.loomic_provider_snapshot_create(
  'aa020000-0000-4000-8000-000000000001','aa090000-0000-4000-8000-000000000002',NULL,
  'aa070000-0000-4000-8000-000000000006',7,'credits-v1','image') $q$,
  'provider_snapshot_upstream_model_mismatch');
SELECT pg_temp.qa_assert((SELECT count(*)=0 FROM public.provider_execution_snapshots
  WHERE background_job_id='aa070000-0000-4000-8000-000000000006'),
  'exact-model mismatch creates no provider credential snapshot');

-- Commit locks and verifies the canonical canvas placeholder immediately
-- before charging/enqueueing. Missing, deleted, or rebound nodes fail closed.
INSERT INTO public.image_generation_proposals(
  id,session_id,canvas_id,created_by,origin_run_id,input,details,status,approved_cost
) VALUES(
  'aa070000-0000-4000-8000-000000000005','aa060000-0000-4000-8000-000000000001','aa040000-0000-4000-8000-000000000001',
  'aa010000-0000-4000-8000-000000000001',gen_random_uuid(),
  '{"prompt":"canvas art","model":"gpt-image-2","aspectRatio":"1:1","operation":"generate","outputFormat":"png","target":{"kind":"canvas","canvas_id":"aa040000-0000-4000-8000-000000000001","element_id":"qa-placeholder","placement":{"x":10,"y":20,"width":256,"height":256}}}',
  '{}','confirmed',0
);
INSERT INTO public.background_jobs(
  id,workspace_id,project_id,canvas_id,target_kind,session_id,queue_name,job_type,status,payload,created_by
) VALUES(
  'aa070000-0000-4000-8000-000000000005','aa020000-0000-4000-8000-000000000001','aa030000-0000-4000-8000-000000000001',
  'aa040000-0000-4000-8000-000000000001','canvas','aa060000-0000-4000-8000-000000000001',
  'image_generation_jobs','image_generation','queued',
  '{"prompt":"canvas art","model":"gpt-image-2","aspect_ratio":"1:1","operation":"generate","output_format":"png","target":{"kind":"canvas","canvas_id":"aa040000-0000-4000-8000-000000000001","element_id":"qa-placeholder","placement":{"x":10,"y":20,"width":256,"height":256}}}',
  'aa010000-0000-4000-8000-000000000001'
);
SELECT pg_temp.qa_error($q$ SELECT public.loomic_commit_image_job('aa070000-0000-4000-8000-000000000005') $q$,
  'image_generation_placeholder_invalid');
-- A malformed canonical payload must not bypass the same guard by omitting
-- element_id entirely. This confirmed Agent endpoint always needs a node.
INSERT INTO public.image_generation_proposals(id,session_id,canvas_id,created_by,origin_run_id,input,details,status,approved_cost)
SELECT 'aa070000-0000-4000-8000-000000009996',session_id,canvas_id,created_by,gen_random_uuid(),
  input #- '{target,element_id}',details,'confirmed',3
FROM public.image_generation_proposals WHERE id='aa070000-0000-4000-8000-000000000005';
INSERT INTO public.background_jobs(id,workspace_id,project_id,canvas_id,target_kind,session_id,queue_name,job_type,status,payload,created_by)
SELECT 'aa070000-0000-4000-8000-000000009996',workspace_id,project_id,canvas_id,target_kind,session_id,
  queue_name,job_type,'queued',payload #- '{target,element_id}',created_by
FROM public.background_jobs WHERE id='aa070000-0000-4000-8000-000000000005';
SELECT pg_temp.qa_error($q$ SELECT public.loomic_commit_image_job('aa070000-0000-4000-8000-000000009996') $q$,
  'image_generation_placeholder_invalid');
SELECT pg_temp.qa_assert((SELECT image_enqueued_at IS NULL AND credits_transaction_id IS NULL FROM public.background_jobs
  WHERE id='aa070000-0000-4000-8000-000000009996'),'missing element id cannot enqueue or debit');
UPDATE public.canvases SET content=jsonb_set(content,'{elements}',content->'elements'||
  '[{"id":"qa-placeholder","type":"rectangle","isDeleted":true,"customData":{"type":"image-generator","jobId":"aa070000-0000-4000-8000-000000000005"}}]'::jsonb)
  WHERE id='aa040000-0000-4000-8000-000000000001';
SELECT pg_temp.qa_error($q$ SELECT public.loomic_commit_image_job('aa070000-0000-4000-8000-000000000005') $q$,
  'image_generation_placeholder_invalid');
UPDATE public.canvases SET content=jsonb_set(content,'{elements}',(
  SELECT jsonb_agg(CASE WHEN e->>'id'='qa-placeholder'
    THEN jsonb_set(jsonb_set(e,'{isDeleted}','false'::jsonb),'{customData,jobId}',to_jsonb(gen_random_uuid()::text))
    ELSE e END) FROM jsonb_array_elements(content->'elements') e))
  WHERE id='aa040000-0000-4000-8000-000000000001';
SELECT pg_temp.qa_error($q$ SELECT public.loomic_commit_image_job('aa070000-0000-4000-8000-000000000005') $q$,
  'image_generation_placeholder_invalid');
UPDATE public.canvases SET content=jsonb_set(content,'{elements}',(
  SELECT jsonb_agg(CASE WHEN e->>'id'='qa-placeholder'
    THEN jsonb_set(e,'{customData,sourceJobId}',to_jsonb('aa070000-0000-4000-8000-000000000005'::text))
    ELSE e END) FROM jsonb_array_elements(content->'elements') e))
  WHERE id='aa040000-0000-4000-8000-000000000001';
SELECT public.loomic_commit_image_job('aa070000-0000-4000-8000-000000000005');
SELECT pg_temp.qa_assert((SELECT image_enqueued_at IS NOT NULL FROM public.background_jobs
  WHERE id='aa070000-0000-4000-8000-000000000005'),
  'valid canonical placeholder permits the first enqueue');
SELECT pg_temp.qa_assert((SELECT count(*)=1 FROM pgmq.q_image_generation_jobs
  WHERE message->>'job_id'='aa070000-0000-4000-8000-000000000005'),
  'valid canonical placeholder publishes exactly one queue message');
UPDATE public.canvases SET content=jsonb_set(content,'{elements}',(
  SELECT jsonb_agg(e) FILTER (WHERE e->>'id'<>'qa-placeholder') FROM jsonb_array_elements(content->'elements') e))
  WHERE id='aa040000-0000-4000-8000-000000000001';
SELECT public.loomic_commit_image_job('aa070000-0000-4000-8000-000000000005');
SELECT pg_temp.qa_assert((SELECT count(*)=1 FROM pgmq.q_image_generation_jobs
  WHERE message->>'job_id'='aa070000-0000-4000-8000-000000000005'),
  'repeated commit after enqueue is a no-op even if the placeholder later changes');

INSERT INTO public.background_jobs(id,workspace_id,project_id,queue_name,job_type,status,payload,created_by)
VALUES('aa070000-0000-4000-8000-000000000004','aa020000-0000-4000-8000-000000000001','aa030000-0000-4000-8000-000000000001',
  'image_generation_jobs','image_generation','running',
  '{"prompt":"too late","model":"workspace:aa090000-0000-4000-8000-000000000002"}',
  'aa010000-0000-4000-8000-000000000001');
SELECT pg_temp.qa_error($q$ SELECT public.loomic_provider_snapshot_create(
  'aa020000-0000-4000-8000-000000000001','aa090000-0000-4000-8000-000000000002',NULL,
  'aa070000-0000-4000-8000-000000000004',7,'credits-v1','image') $q$,'provider_snapshot_target_not_chargeable');
SELECT pg_temp.qa_assert((SELECT count(*)=0 FROM public.provider_execution_snapshots
  WHERE background_job_id='aa070000-0000-4000-8000-000000000004'),
  'a started job cannot acquire a new provider snapshot');
UPDATE public.workspace_provider_models SET upstream_model_id='gpt-image-2-vip' WHERE catalog_key='aa090000-0000-4000-8000-000000000003';
SELECT pg_temp.qa_assert((SELECT upstream_model_id='gpt-image-2' FROM public.loomic_foreground_snapshot_resolve('aa020000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000001')),'provider edits do not change frozen stage');
UPDATE public.background_jobs SET status='canceled' WHERE id='aa070000-0000-4000-8000-000000000001';
SELECT pg_temp.qa_assert((SELECT count(*)=0 FROM public.provider_execution_credentials ec JOIN public.provider_execution_snapshots s ON s.id=ec.snapshot_id WHERE s.background_job_id='aa070000-0000-4000-8000-000000000001'),'terminal job releases both stage credentials');
ROLLBACK;
SELECT 'Foreground database acceptance passed: frozen fields, operations, exact total, stage completeness, isolation, idempotence, tenant boundary, cleanup; all fixtures rolled back.';
`;
const prefix = randomBytes(2).toString('hex');
const output = query(sql.replace(/aa0([1-9])0000/g, (_, group) => `${prefix}000${group}`));
console.log(output.split('\n').find(line => line.startsWith('Foreground database acceptance')));
