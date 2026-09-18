import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

// No provider calls: even queue records and Vault fixtures are rolled back.
const database = 'loomic_replica_light_20260907';
const container = 'supabase_db_thtdhcvjppuvlvahfmga';
const query = sql => execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', database, '-Atq'],
  { input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
if (query('SELECT current_database();').trim() !== database) throw new Error('Refusing non-local database');
const root = new URL('../', import.meta.url);
const migrations = [
  ['20260909000014', '20260909000014_durable_node_image_submission'],
  ['20260914000001', '20260914000001_native_image_resolution'],
];
const pending = (await Promise.all(migrations.map(async ([version, name]) =>
  query(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='${version}';`).trim() === '0'
    ? await readFile(new URL(`supabase/migrations/${name}.sql`, root), 'utf8')
    : ''))).join('\n');
const source = await readFile(new URL('apps/server/src/features/agent-tasks/agent-task-local-db.qa.sql', root), 'utf8');
const fixture = source.slice(0, source.indexOf('INSERT INTO public.chat_sessions')).replace(/^BEGIN;\r?$/m, '');
const legacyInput = `'{"prompt":"  元旦，保持字体  ","model":"workspace:aa090000-0000-4000-8000-000000000002","aspect_ratio":"1:1","quality":"hd"}'::jsonb`;
const input = `(${legacyInput} || '{"resolution":"2k"}'::jsonb)`;
const call = (request = 'aa080000-0000-4000-8000-000000000001', element = 'node-1', cost = 7, user = 'aa010000-0000-4000-8000-000000000001', revision = 1, submissionInput = input) =>
  `public.loomic_submit_node_image('${user}','${request}','aa040000-0000-4000-8000-000000000001','${element}',${submissionInput},${cost},${revision},'gpt-image-2')`;
const sql = `BEGIN;
${pending}
${fixture}
INSERT INTO public.workspace_provider_configs(id,workspace_id,adapter,display_name,base_url,enabled,api_key_secret_id,api_key_last_four,revision,last_test_status,created_by,updated_by)
VALUES('aa090000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000001','openai_compatible','QA node model','https://api.apiyi.com/v1',true,vault.create_secret('synthetic-no-network-credential'),'tial',1,'succeeded','aa010000-0000-4000-8000-000000000001','aa010000-0000-4000-8000-000000000001');
INSERT INTO public.workspace_provider_models(provider_config_id,upstream_model_id,display_name,modality,enabled,capabilities,catalog_key)
VALUES('aa090000-0000-4000-8000-000000000001','gpt-image-2','QA image','image',true,'["image_generation"]','aa090000-0000-4000-8000-000000000002');
INSERT INTO public.credit_balances(workspace_id,balance) VALUES('aa020000-0000-4000-8000-000000000001',100)
ON CONFLICT(workspace_id) DO UPDATE SET balance=100;
CREATE FUNCTION pg_temp.qa_node(req text,node text,resolution text DEFAULT '2k') RETURNS jsonb LANGUAGE sql AS $f$
SELECT jsonb_build_object('id',node,'type','rectangle','x',550,'y',-300,'width',380,'height',380,'version',9,'isDeleted',false,
  'customData',jsonb_build_object('type','image-generator','status','generating','prompt','  元旦，保持字体  ',
    'nodeImageRequest',jsonb_build_object('requestId',req,'state','submitting','prompt','  元旦，保持字体  ',
      'model','workspace:aa090000-0000-4000-8000-000000000002','aspectRatio','1:1','quality','hd') ||
      CASE WHEN resolution IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('resolution',resolution) END));
$f$;
UPDATE public.canvases SET content=jsonb_build_object('elements',jsonb_build_array(
  pg_temp.qa_node('aa080000-0000-4000-8000-000000000001','node-1'),
  pg_temp.qa_node('aa080000-0000-4000-8000-000000000002','node-2'),
  pg_temp.qa_node('aa080000-0000-4000-8000-000000000003','node-3',NULL)),'files','{}'::jsonb,'appState','{}'::jsonb)
WHERE id='aa040000-0000-4000-8000-000000000001';
CREATE FUNCTION pg_temp.qa_fail_node_queue() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
  IF current_setting('loomic.qa_fail_node_queue',true)='on'
    AND NEW.message->>'workspace_id'='aa020000-0000-4000-8000-000000000001'
  THEN RAISE EXCEPTION 'qa_queue_unavailable'; END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER qa_node_queue_failure BEFORE INSERT ON pgmq.q_image_generation_jobs FOR EACH ROW EXECUTE FUNCTION pg_temp.qa_fail_node_queue();
SELECT pg_temp.qa_assert(NOT has_function_privilege('authenticated','public.loomic_submit_node_image(uuid,uuid,uuid,text,jsonb,integer,bigint,text)','EXECUTE'),'client cannot choose a price or impersonate submitter');
SELECT pg_temp.qa_error($q$ SELECT ${call(undefined, undefined, 7, 'aa010000-0000-4000-8000-000000000002')} $q$,'node_canvas_forbidden');
SELECT pg_temp.qa_error($q$ SELECT ${call(undefined, 'not-saved')} $q$,'node_not_saved');
SELECT pg_temp.qa_error($q$ SELECT ${call(undefined, undefined, 7, undefined, 2)} $q$,'node_model_changed');
SELECT pg_temp.qa_error($q$ SELECT public.loomic_submit_node_image('aa010000-0000-4000-8000-000000000001','aa080000-0000-4000-8000-000000000001','aa040000-0000-4000-8000-000000000001','node-1',jsonb_set(${input},'{quality}','null'),7,1,'gpt-image-2') $q$,'node_submission_invalid');
SELECT pg_temp.qa_error($q$ SELECT ${call(undefined, undefined, 7, undefined, 1, `jsonb_set(${input},'{resolution}','"8k"')`)} $q$,'node_submission_invalid');
SELECT pg_temp.qa_assert((SELECT count(*)=0 FROM public.background_jobs WHERE workspace_id='aa020000-0000-4000-8000-000000000001'),'failed snapshot precondition rolls back job');
SELECT pg_temp.qa_assert(${call()}->>'replayed'='false','native-resolution request created');
SELECT pg_temp.qa_assert((SELECT input->>'resolution'='2k' FROM public.node_image_submissions
  WHERE created_by='aa010000-0000-4000-8000-000000000001' AND request_id='aa080000-0000-4000-8000-000000000001'),'native resolution is part of immutable submission input');
SELECT pg_temp.qa_assert((SELECT payload->>'resolution'='2k' FROM public.background_jobs
  WHERE workspace_id='aa020000-0000-4000-8000-000000000001'),'native resolution reaches the worker payload');
SELECT pg_temp.qa_assert(${call()}->>'replayed'='true','same native-resolution request replays');
SELECT pg_temp.qa_error($q$ SELECT ${call(undefined, undefined, 7, undefined, 1, `jsonb_set(${input},'{resolution}','"4k"')`)} $q$,'node_submission_conflict');
SELECT pg_temp.qa_assert((SELECT input=${input} FROM public.node_image_submissions
  WHERE created_by='aa010000-0000-4000-8000-000000000001' AND request_id='aa080000-0000-4000-8000-000000000001'),'changed-resolution retry cannot rewrite immutable input');
SELECT pg_temp.qa_assert((SELECT count(*)=1 FROM public.background_jobs WHERE workspace_id='aa020000-0000-4000-8000-000000000001'),'one durable job');
SELECT pg_temp.qa_assert((SELECT count(*)=1 FROM public.provider_execution_snapshots WHERE workspace_id='aa020000-0000-4000-8000-000000000001'),'one frozen provider snapshot');
SELECT pg_temp.qa_assert((SELECT balance=93 FROM public.credit_balances WHERE workspace_id='aa020000-0000-4000-8000-000000000001'),'exactly one debit');
SELECT pg_temp.qa_assert((SELECT count(*)=1 FROM public.credit_transactions
  WHERE workspace_id='aa020000-0000-4000-8000-000000000001' AND transaction_type='generation_deduct'),'replay and changed-resolution conflict create no extra ledger entry');
SELECT pg_temp.qa_assert((SELECT count(*)=1 FROM pgmq.q_image_generation_jobs WHERE message->>'workspace_id'='aa020000-0000-4000-8000-000000000001'),'exactly one queue publication');
SELECT pg_temp.qa_assert((SELECT content#>>'{elements,0,y}'='-300' AND content#>>'{elements,0,customData,nodeImageRequest,state}'='accepted'
  AND content#>>'{elements,0,customData,nodeImageRequest,prompt}'='  元旦，保持字体  ' FROM public.canvases WHERE id='aa040000-0000-4000-8000-000000000001'),'position, exact prompt and accepted state persisted together');
SELECT pg_temp.qa_assert((SELECT (c.content#>>'{elements,0,customData,nodeImageRequest,submissionRevision}')::bigint = c.revision
  AND (j.payload->>'node_submission_revision')::bigint = c.revision
  FROM public.canvases c JOIN public.background_jobs j ON j.canvas_id=c.id
  WHERE c.id='aa040000-0000-4000-8000-000000000001'),'server submission generation is shared by node and job');
SAVEPOINT qa_legacy_request;
SELECT pg_temp.qa_assert(${call('aa080000-0000-4000-8000-000000000003', 'node-3', 0, undefined, 1, legacyInput)}->>'replayed'='false','legacy four-key request remains accepted');
SELECT pg_temp.qa_assert(${call('aa080000-0000-4000-8000-000000000003', 'node-3', 0, undefined, 1, legacyInput)}->>'replayed'='true','legacy four-key request remains replayable');
SELECT pg_temp.qa_assert((SELECT NOT (input ? 'resolution') FROM public.node_image_submissions
  WHERE created_by='aa010000-0000-4000-8000-000000000001' AND request_id='aa080000-0000-4000-8000-000000000003'),'legacy request is not rewritten with a resolution');
SELECT pg_temp.qa_assert((SELECT NOT (payload ? 'resolution') FROM public.background_jobs
  WHERE id=(SELECT job_id FROM public.node_image_submissions WHERE created_by='aa010000-0000-4000-8000-000000000001'
    AND request_id='aa080000-0000-4000-8000-000000000003')),'legacy worker payload remains compatible');
ROLLBACK TO SAVEPOINT qa_legacy_request;
RELEASE SAVEPOINT qa_legacy_request;
SELECT pg_temp.qa_error($q$ SELECT public.loomic_submit_node_image('aa010000-0000-4000-8000-000000000001','aa080000-0000-4000-8000-000000000001','aa040000-0000-4000-8000-000000000001','node-1',jsonb_set(${input},'{prompt}','"different"'),7,1,'gpt-image-2') $q$,'node_submission_conflict');
UPDATE public.canvases SET content=jsonb_set(content,'{elements,0,customData,nodeImageRequest,requestId}','"aa080000-0000-4000-8000-000000000004"') WHERE id='aa040000-0000-4000-8000-000000000001';
SELECT pg_temp.qa_error($q$ SELECT ${call('aa080000-0000-4000-8000-000000000004', undefined, 7, undefined, 1, `jsonb_set(${input},'{resolution}','"4k"')`)} $q$,'node_submission_conflict');
SELECT pg_temp.qa_error($q$ SELECT ${call('aa080000-0000-4000-8000-000000000004')} $q$,'node_generation_active');
SET LOCAL loomic.qa_fail_node_queue='on';
SELECT pg_temp.qa_error($q$ SELECT ${call('aa080000-0000-4000-8000-000000000002','node-2')} $q$,'qa_queue_unavailable');
SET LOCAL loomic.qa_fail_node_queue='off';
SELECT pg_temp.qa_assert((SELECT balance=93 FROM public.credit_balances WHERE workspace_id='aa020000-0000-4000-8000-000000000001'),'queue failure rolls back debit');
SELECT pg_temp.qa_assert((SELECT count(*)=1 FROM public.background_jobs WHERE workspace_id='aa020000-0000-4000-8000-000000000001'),'queue failure rolls back job');
SELECT pg_temp.qa_assert((SELECT count(*)=1 FROM public.provider_execution_snapshots WHERE workspace_id='aa020000-0000-4000-8000-000000000001'),'queue failure rolls back provider snapshot');
SELECT pg_temp.qa_assert((SELECT count(*)=1 FROM public.node_image_submissions WHERE created_by='aa010000-0000-4000-8000-000000000001'),'queue failure rolls back request identity');
SELECT pg_temp.qa_assert((SELECT content#>>'{elements,1,customData,nodeImageRequest,state}'='submitting' FROM public.canvases WHERE id='aa040000-0000-4000-8000-000000000001'),'queue failure rolls back placeholder transition');
SELECT pg_temp.qa_assert(${call('aa080000-0000-4000-8000-000000000002','node-2',0)}->>'replayed'='false','zero-credit mode remains supported');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"role":"authenticated","sub":"aa010000-0000-4000-8000-000000000001"}',true);
SELECT pg_temp.qa_assert((SELECT count(*)=2 FROM public.node_image_submissions WHERE canvas_id='aa040000-0000-4000-8000-000000000001'),'creator can read request recovery records');
SELECT set_config('request.jwt.claims','{"role":"authenticated","sub":"aa010000-0000-4000-8000-000000000002"}',true);
SELECT pg_temp.qa_assert((SELECT count(*)=0 FROM public.node_image_submissions),'cross-user lookup denied');
RESET ROLE;
UPDATE public.projects SET archived_at=now() WHERE id='aa030000-0000-4000-8000-000000000001';
SELECT pg_temp.qa_error($q$ SELECT ${call()} $q$,'node_canvas_forbidden');
ROLLBACK;
SELECT 'Node image database acceptance passed: native resolution, immutable replay, legacy compatibility, no extra ledger, atomic rollback, queue and tenant boundaries.';
`;
const prefix = randomBytes(2).toString('hex');
const output = query(sql.replace(/aa0([1-9])0000/g, (_, group) => `${prefix}000${group}`));
console.log(output.split('\n').find(line => line.startsWith('Node image database acceptance')));
