-- Shared task fixtures are provided by test-model-context-local.mjs.
CREATE TEMP TABLE context_profiles(label text PRIMARY KEY,value jsonb);
INSERT INTO context_profiles VALUES
('v1','{"contextWindowTokens":128000,"maxInputTokens":112000,"maxOutputTokens":16000,"profileSource":"QA verified endpoint record","verifiedAt":"2026-09-09T00:00:00Z","profileVersion":"v1","imageTokensPerImage":4096}'),
('v2','{"contextWindowTokens":256000,"maxInputTokens":224000,"maxOutputTokens":32000,"profileSource":"QA revised endpoint record","verifiedAt":"2026-09-09T01:00:00+08:00","profileVersion":"v2"}');
SELECT pg_temp.qa_assert(public.loomic_valid_context_profile(NULL),'SQL NULL means unknown');
SELECT pg_temp.qa_assert(public.loomic_valid_context_profile((SELECT value FROM context_profiles WHERE label='v1')),'verified v1 profile accepted');
SELECT pg_temp.qa_assert(public.loomic_valid_context_profile((SELECT value FROM context_profiles WHERE label='v2')),'ISO offset timestamp accepted');
DO $$ DECLARE base jsonb; invalid jsonb; BEGIN
  SELECT value INTO base FROM context_profiles WHERE label='v1';
  FOR invalid IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
    'null'::jsonb,'{}'::jsonb,'[]'::jsonb,'42'::jsonb,
    base-'verifiedAt',base||'{"contextWindowTokens":"128000"}',base||'{"maxInputTokens":null}',
    base||'{"maxOutputTokens":16000.5}',base||'{"contextWindowTokens":4096}',
    base||'{"maxInputTokens":200000}',base||'{"maxOutputTokens":128000}',
    base||'{"profileSource":123}',base||'{"profileSource":"   unverified  "}',base||'{"profileVersion":{}}',
    base||'{"verifiedAt":"now"}',base||'{"verifiedAt":"infinity"}',base||'{"verifiedAt":"2026-99-99T00:00:00Z"}',
    base||'{"verifiedAt":"2026-09-09"}',base||'{"imageTokensPerImage":"4096"}',base||'{"imageTokensPerImage":null}',
    base||'{"imageTokensPerImage":0}',base||'{"apiKey":"should-never-be-a-profile-field"}')) LOOP
    PERFORM pg_temp.qa_assert(public.loomic_valid_context_profile(invalid) IS FALSE,'malformed profile is exactly false');
  END LOOP;
END $$;

-- api_key_secret_id is a random synthetic identifier, not a real Vault row.
-- We never create, resolve, read or rotate a credential in this acceptance test.
INSERT INTO public.workspace_provider_configs(id,workspace_id,adapter,display_name,base_url,enabled,
 api_key_secret_id,api_key_last_four,revision,last_test_status,created_by,updated_by)
VALUES('aa090000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000001','openai_compatible','Context profile QA',
 'https://example.test/v1',true,'aa090000-0000-4000-8000-000000000099','fake',1,'succeeded',
 'aa010000-0000-4000-8000-000000000001','aa010000-0000-4000-8000-000000000001');
INSERT INTO public.workspace_provider_models(id,provider_config_id,upstream_model_id,display_name,modality,enabled,capabilities,catalog_key,context_profile) VALUES
('aa090000-0000-4000-8000-000000000002','aa090000-0000-4000-8000-000000000001','qa-known','QA known','text',true,'["text","vision_input"]',
 'aa090000-0000-4000-8000-000000000003',(SELECT value FROM context_profiles WHERE label='v1')),
('aa090000-0000-4000-8000-000000000004','aa090000-0000-4000-8000-000000000001','qa-unknown','QA unknown','text',true,'["text"]',
 'aa090000-0000-4000-8000-000000000005',NULL);
SELECT pg_temp.qa_error($q$ UPDATE public.workspace_provider_models SET context_profile='{}' WHERE id='aa090000-0000-4000-8000-000000000002' $q$,'check constraint');
SELECT pg_temp.qa_error($q$ UPDATE public.workspace_provider_models SET modality='image' WHERE id='aa090000-0000-4000-8000-000000000002' $q$,'check constraint');

-- Exercise the actual freeze triggers and safe profile reader using metadata
-- inserts; invoking credential snapshot resolvers is intentionally unnecessary.
INSERT INTO public.provider_execution_snapshots(id,workspace_id,provider_config_id,provider_revision,catalog_key,adapter,base_url,
 upstream_model_id,modality,capabilities,agent_run_id,context_profile) VALUES
('aa090000-0000-4000-8000-000000000006','aa020000-0000-4000-8000-000000000001','aa090000-0000-4000-8000-000000000001',1,
 'aa090000-0000-4000-8000-000000000003','openai_compatible','https://example.test/v1','qa-known','text','["text","vision_input"]',
 'aa070000-0000-4000-8000-000000000001',(SELECT value FROM context_profiles WHERE label='v2')),
('aa090000-0000-4000-8000-000000000007','aa020000-0000-4000-8000-000000000001','aa090000-0000-4000-8000-000000000001',1,
 'aa090000-0000-4000-8000-000000000005','openai_compatible','https://example.test/v1','qa-unknown','text','["text"]',
 'aa070000-0000-4000-8000-000000000002',NULL);
SELECT public.loomic_agent_delegation_begin('aa090000-0000-4000-8000-000000000008','aa070000-0000-4000-8000-000000000001',
 'context-qa-tool','context-qa-expert','design_review','Review only','workspace:aa090000-0000-4000-8000-000000000003',NULL,'[]',2,6);
INSERT INTO public.agent_expert_model_snapshots(delegation_id,workspace_id,provider_config_id,provider_revision,catalog_key,base_url,
 upstream_model_id,capabilities,context_profile) VALUES
('aa090000-0000-4000-8000-000000000008','aa020000-0000-4000-8000-000000000001','aa090000-0000-4000-8000-000000000001',1,
 'aa090000-0000-4000-8000-000000000003','https://example.test/v1','qa-known','["text"]',NULL);
SELECT pg_temp.qa_assert(public.loomic_provider_context_profile('aa020000-0000-4000-8000-000000000001','aa090000-0000-4000-8000-000000000006',NULL)
 =(SELECT value FROM context_profiles WHERE label='v1'),'run profile comes from source, ignoring caller-supplied v2');
SELECT pg_temp.qa_assert(public.loomic_provider_context_profile('aa020000-0000-4000-8000-000000000001',NULL,'aa090000-0000-4000-8000-000000000008')
 =(SELECT value FROM context_profiles WHERE label='v1'),'expert freezes its source profile');
SELECT pg_temp.qa_assert(public.loomic_provider_context_profile('aa020000-0000-4000-8000-000000000001','aa090000-0000-4000-8000-000000000007',NULL) IS NULL,'unknown stays SQL NULL');

CREATE FUNCTION pg_temp.context_update_profile(models jsonb,actor uuid DEFAULT 'aa010000-0000-4000-8000-000000000001') RETURNS text LANGUAGE sql AS $$
 SELECT public.loomic_provider_config_update('aa020000-0000-4000-8000-000000000001','aa090000-0000-4000-8000-000000000001',
 (SELECT revision FROM public.workspace_provider_configs WHERE id='aa090000-0000-4000-8000-000000000001'),
 'Context profile QA','https://example.test/v1',true,NULL,NULL,models,actor)
$$;
CREATE FUNCTION pg_temp.context_model_payload(profile jsonb DEFAULT NULL,include_profile boolean DEFAULT true) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_array(jsonb_build_object('upstreamModelId','qa-known','displayName','QA renamed','modality','text','enabled',true,
 'capabilities','["text","vision_input"]'::jsonb)||CASE WHEN include_profile THEN jsonb_build_object('contextProfile',profile) ELSE '{}'::jsonb END)
$$;
SELECT pg_temp.qa_assert(pg_temp.context_update_profile(pg_temp.context_model_payload((SELECT value FROM context_profiles WHERE label='v2')))='updated','manager profile update succeeds');
SELECT pg_temp.qa_assert((SELECT catalog_key='aa090000-0000-4000-8000-000000000003' AND id='aa090000-0000-4000-8000-000000000002'
 AND context_profile=(SELECT value FROM context_profiles WHERE label='v2') FROM public.workspace_provider_models WHERE upstream_model_id='qa-known'
 AND provider_config_id='aa090000-0000-4000-8000-000000000001'),'updating model preserves catalog key and row identity');
SELECT pg_temp.qa_assert(public.loomic_provider_context_profile('aa020000-0000-4000-8000-000000000001','aa090000-0000-4000-8000-000000000006',NULL)
 =(SELECT value FROM context_profiles WHERE label='v1'),'run freezes v1 after live source changes to v2');
SELECT pg_temp.qa_assert(public.loomic_provider_context_profile('aa020000-0000-4000-8000-000000000001',NULL,'aa090000-0000-4000-8000-000000000008')
 =(SELECT value FROM context_profiles WHERE label='v1'),'expert freezes v1 after live source changes to v2');
SELECT pg_temp.qa_assert(public.loomic_provider_context_profile('aa020000-0000-4000-8000-000000000001','aa090000-0000-4000-8000-000000000007',NULL) IS NULL,'unknown snapshot remains unknown after source model removed');
SELECT pg_temp.qa_error($q$ UPDATE public.provider_execution_snapshots SET context_profile=NULL WHERE id='aa090000-0000-4000-8000-000000000006' $q$,'provider_snapshot_immutable');
SELECT pg_temp.qa_error($q$ UPDATE public.agent_expert_model_snapshots SET context_profile=NULL WHERE delegation_id='aa090000-0000-4000-8000-000000000008' $q$,'provider_snapshot_immutable');

SELECT pg_temp.qa_assert(pg_temp.context_update_profile(pg_temp.context_model_payload(NULL,false))='updated','old client update without contextProfile accepted');
SELECT pg_temp.qa_assert((SELECT context_profile=(SELECT value FROM context_profiles WHERE label='v2') FROM public.workspace_provider_models
 WHERE id='aa090000-0000-4000-8000-000000000002'),'omission preserves existing profile');
SELECT pg_temp.qa_error($q$ SELECT pg_temp.context_update_profile(pg_temp.context_model_payload('{}')) $q$,'check constraint');
SELECT pg_temp.qa_assert((SELECT revision=3 FROM public.workspace_provider_configs WHERE id='aa090000-0000-4000-8000-000000000001'),'invalid profile rolls config revision back atomically');
SELECT pg_temp.qa_assert(pg_temp.context_update_profile(pg_temp.context_model_payload(NULL,true))='updated','explicit JSON null clears profile');
SELECT pg_temp.qa_assert((SELECT context_profile IS NULL FROM public.workspace_provider_models WHERE id='aa090000-0000-4000-8000-000000000002'),'explicit clear returns to unknown');
SELECT pg_temp.qa_assert(public.loomic_provider_context_profile('aa020000-0000-4000-8000-000000000001','aa090000-0000-4000-8000-000000000006',NULL)
 =(SELECT value FROM context_profiles WHERE label='v1'),'clearing source still cannot rewrite active run profile');

SELECT pg_temp.qa_error($q$ SELECT public.loomic_provider_context_profile('aa020000-0000-4000-8000-000000000002','aa090000-0000-4000-8000-000000000006',NULL) $q$,'context_profile_not_found');
SELECT pg_temp.qa_error($q$ SELECT public.loomic_provider_context_profile('aa020000-0000-4000-8000-000000000002',NULL,'aa090000-0000-4000-8000-000000000008') $q$,'context_profile_not_found');
SELECT pg_temp.qa_error($q$ SELECT public.loomic_provider_context_profile('aa020000-0000-4000-8000-000000000001',NULL,NULL) $q$,'context_profile_target_invalid');
SELECT pg_temp.qa_error($q$ SELECT public.loomic_provider_context_profile('aa020000-0000-4000-8000-000000000001','aa090000-0000-4000-8000-000000000006','aa090000-0000-4000-8000-000000000008') $q$,'context_profile_target_invalid');
SELECT pg_temp.qa_assert(NOT has_function_privilege('authenticated','public.loomic_provider_context_profile(uuid,uuid,uuid)','EXECUTE'),'safe reader remains private to authenticated server');
SELECT pg_temp.qa_assert(NOT has_function_privilege('authenticated','public.loomic_provider_config_update(uuid,uuid,bigint,text,text,boolean,text,text,jsonb,uuid)','EXECUTE'),'config RPC remains private');
SELECT pg_temp.qa_assert(public.loomic_provider_context_profile('aa020000-0000-4000-8000-000000000001','aa090000-0000-4000-8000-000000000006',NULL)
 -ARRAY['contextWindowTokens','maxInputTokens','maxOutputTokens','profileSource','verifiedAt','profileVersion','imageTokensPerImage']='{}','safe reader exposes only profile fields');
SELECT set_config('request.jwt.claims','{"role":"authenticated","sub":"aa010000-0000-4000-8000-000000000001"}',true);
SELECT pg_temp.qa_error($q$ SELECT public.loomic_provider_context_profile('aa020000-0000-4000-8000-000000000001','aa090000-0000-4000-8000-000000000006',NULL) $q$,'service_role_required');
SELECT pg_temp.qa_error($q$ SELECT pg_temp.context_update_profile(NULL) $q$,'service_role_required');
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
INSERT INTO public.workspace_members(workspace_id,user_id,role) VALUES('aa020000-0000-4000-8000-000000000001','aa010000-0000-4000-8000-000000000002','member');
SELECT pg_temp.qa_error($q$ SELECT pg_temp.context_update_profile(NULL,'aa010000-0000-4000-8000-000000000002') $q$,'provider_config_forbidden');
SELECT pg_temp.qa_error($q$ SELECT pg_temp.context_update_profile(NULL,NULL) $q$,'provider_config_forbidden');
UPDATE public.workspace_members SET role='member' WHERE workspace_id='aa020000-0000-4000-8000-000000000001' AND user_id='aa010000-0000-4000-8000-000000000001';
SELECT pg_temp.qa_error($q$ SELECT pg_temp.context_update_profile(NULL) $q$,'provider_config_forbidden');
