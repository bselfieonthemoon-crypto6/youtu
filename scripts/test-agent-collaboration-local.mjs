import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const database = 'loomic_replica_light_20260907';
const container = 'supabase_db_thtdhcvjppuvlvahfmga';
const root = new URL('../', import.meta.url);
const migrations = ['20260909000005_agent_collaboration_settings', '20260909000006_agent_delegations', '20260909000007_expert_model_snapshots', '20260909000008_collaboration_read_and_disable'];
const query = sql => execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', database, '-Atq'], { input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
if (query('SELECT current_database();').trim() !== database) throw new Error('Not the local replica');
const pending = [];
for (const name of migrations) {
  if (query(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='${name.split('_')[0]}';`).trim() === '0') pending.push(await readFile(new URL(`supabase/migrations/${name}.sql`, root), 'utf8'));
}
const source = await readFile(new URL('apps/server/src/features/agent-tasks/agent-task-local-db.qa.sql', root), 'utf8');
const fixture = source.slice(0, source.indexOf('SELECT pg_temp.qa_assert(public.loomic_agent_task_assert_current'))
  .replace(/^BEGIN;\r?$/m, '');
const prefix = randomBytes(2).toString('hex');
const sql = `BEGIN;\n${pending.join('\n')}\n${fixture}
SELECT pg_temp.qa_assert(public.loomic_valid_agent_collaboration('{"enabled":true,"maxParallel":2,"maxTasksPerRun":6,"timeoutMs":90000,"roleModels":{"reference_analysis":null,"design_planning":null,"design_review":null}}'), 'bounded collaboration defaults');
SELECT pg_temp.qa_assert(NOT public.loomic_valid_agent_collaboration('{"enabled":true,"maxParallel":999}'), 'malformed config rejected');
INSERT INTO public.workspace_settings(workspace_id) VALUES('aa020000-0000-4000-8000-000000000001');
SELECT pg_temp.qa_error($q$ UPDATE public.workspace_settings SET agent_collaboration=jsonb_set(agent_collaboration,'{maxParallel}','4') WHERE workspace_id='aa020000-0000-4000-8000-000000000001' $q$, 'check constraint');
SELECT pg_temp.qa_error($q$ UPDATE public.workspace_settings SET agent_collaboration=jsonb_set(agent_collaboration,'{roleModels,design_review}','"workspace:00000000-0000-4000-8000-000000000099"') WHERE workspace_id='aa020000-0000-4000-8000-000000000001' $q$, 'settings_model_not_accessible');

INSERT INTO public.workspace_provider_configs(id,workspace_id,adapter,display_name,base_url,enabled,api_key_secret_id,api_key_last_four,revision,last_test_status,created_by,updated_by)
VALUES('aa090000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000001','openai_compatible','QA expert model','https://api.apiyi.com/v1',true,vault.create_secret('qa-no-real-api-key'),'-key',1,'succeeded','aa010000-0000-4000-8000-000000000001','aa010000-0000-4000-8000-000000000001');
INSERT INTO public.workspace_provider_models(provider_config_id,upstream_model_id,display_name,modality,enabled,capabilities,catalog_key)
VALUES('aa090000-0000-4000-8000-000000000001','qa-expert-model','QA expert','text',true,'["text"]','aa090000-0000-4000-8000-000000000002');
UPDATE public.workspace_settings SET agent_collaboration=jsonb_set(agent_collaboration,'{roleModels,design_review}','"workspace:aa090000-0000-4000-8000-000000000002"') WHERE workspace_id='aa020000-0000-4000-8000-000000000001';
SELECT pg_temp.qa_assert(public.loomic_agent_delegation_begin('aa090000-0000-4000-8000-000000000003','aa070000-0000-4000-8000-000000000001','qa-tool','qa-review','design_review','Check contrast only','workspace:aa090000-0000-4000-8000-000000000002',NULL,'[]',2,6)->>'isNew'='true','new delegation recorded');
SELECT pg_temp.qa_assert(public.loomic_agent_delegation_begin('aa090000-0000-4000-8000-000000000004','aa070000-0000-4000-8000-000000000001','qa-tool','qa-review','design_review','Check contrast only','workspace:aa090000-0000-4000-8000-000000000002',NULL,'[]',2,6)->>'isNew'='false','replay reuses record');
SELECT pg_temp.qa_error($q$ SELECT public.loomic_agent_delegation_begin('aa090000-0000-4000-8000-000000000004','aa070000-0000-4000-8000-000000000001','qa-tool','qa-review','design_review','Different work','workspace:aa090000-0000-4000-8000-000000000002',NULL,'[]',2,6) $q$, 'request_conflict');
SELECT pg_temp.qa_assert((public.loomic_expert_model_snapshot_resolve('aa090000-0000-4000-8000-000000000003','aa070000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000001','design_review','aa090000-0000-4000-8000-000000000002')->>'providerRevision')::integer=1, 'independent frozen model');
SELECT pg_temp.qa_error($q$ SELECT public.loomic_expert_model_snapshot_resolve('aa090000-0000-4000-8000-000000000003','aa070000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000002','design_review','aa090000-0000-4000-8000-000000000002') $q$, 'target_invalid');
SELECT pg_temp.qa_error($q$ SELECT public.loomic_expert_model_snapshot_resolve('aa090000-0000-4000-8000-000000000003','aa070000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000001','design_planning','aa090000-0000-4000-8000-000000000002') $q$, 'target_invalid');
UPDATE public.workspace_provider_configs SET revision=2,enabled=false WHERE id='aa090000-0000-4000-8000-000000000001';
UPDATE public.workspace_settings SET agent_collaboration=jsonb_set(agent_collaboration,'{enabled}','false') WHERE workspace_id='aa020000-0000-4000-8000-000000000001';
SELECT pg_temp.qa_assert((SELECT agent_collaboration->'roleModels'->>'design_review'='workspace:aa090000-0000-4000-8000-000000000002' FROM public.workspace_settings WHERE workspace_id='aa020000-0000-4000-8000-000000000001'),'disabling retains unpublished model selection');
SELECT pg_temp.qa_error($q$ UPDATE public.workspace_settings SET agent_collaboration=jsonb_set(agent_collaboration,'{enabled}','true') WHERE workspace_id='aa020000-0000-4000-8000-000000000001' $q$, 'settings_model_not_accessible');
SELECT pg_temp.qa_assert((public.loomic_expert_model_snapshot_resolve('aa090000-0000-4000-8000-000000000003','aa070000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000001','design_review','aa090000-0000-4000-8000-000000000002')->>'providerRevision')::integer=1, 'inflight configuration frozen');
SELECT pg_temp.qa_assert(public.loomic_agent_delegation_finish('aa090000-0000-4000-8000-000000000003','completed','Public review conclusion',NULL)->>'status'='completed','read-only task completed');
SELECT pg_temp.qa_assert(NOT EXISTS(SELECT 1 FROM public.agent_expert_model_credentials WHERE delegation_id='aa090000-0000-4000-8000-000000000003'), 'ephemeral credential released');
SELECT pg_temp.qa_assert(NOT has_table_privilege('authenticated','public.agent_expert_model_snapshots','SELECT'), 'private model snapshot hidden');
SELECT pg_temp.qa_assert(NOT has_function_privilege('authenticated','public.loomic_expert_model_snapshot_resolve(uuid,uuid,uuid,text,uuid)','EXECUTE'), 'private model resolver inaccessible');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"role":"authenticated","sub":"aa010000-0000-4000-8000-000000000001"}',true);
SELECT pg_temp.qa_assert((SELECT count(*)=1 FROM public.agent_delegations WHERE run_id='aa070000-0000-4000-8000-000000000001'),'creator can read own task result through private-ledger policy');
SELECT set_config('request.jwt.claims','{"role":"authenticated","sub":"aa010000-0000-4000-8000-000000000002"}',true);
SELECT pg_temp.qa_assert((SELECT count(*)=0 FROM public.agent_delegations),'cross-user task result denied');
SELECT pg_temp.qa_assert((SELECT count(*)=0 FROM public.workspace_settings WHERE workspace_id='aa020000-0000-4000-8000-000000000001'),'cross-workspace settings denied');
RESET ROLE;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT public.loomic_agent_task_begin('aa010000-0000-4000-8000-000000000001','aa060000-0000-4000-8000-000000000001','aa040000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000002','Only adjust the title',NULL,'aa070000-0000-4000-8000-000000000001');
SELECT pg_temp.qa_assert((SELECT status='superseded' AND result IS NULL FROM public.agent_delegations WHERE id='aa090000-0000-4000-8000-000000000003'),'correction invalidates previous conclusions');
SELECT pg_temp.qa_assert((SELECT jsonb_array_length(content->'elements')=1 FROM public.canvases WHERE id='aa040000-0000-4000-8000-000000000001'),'experts never modify canvas');
ROLLBACK;
SELECT 'Agent collaboration database acceptance passed (own-access, tenant isolation, snapshots, corrections, replay, and disable; all fixture data and pending DDL rolled back)';
`.replace(/aa0([1-9])0000/g, (_, group) => `${prefix}000${group}`);
const output = query(sql);
console.log(output.split('\n').find(line => line.startsWith('Agent collaboration database acceptance')));
