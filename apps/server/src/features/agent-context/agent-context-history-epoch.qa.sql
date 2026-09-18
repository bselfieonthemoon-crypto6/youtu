-- Runs after the shared task fixture, before the regular context assertions.
CREATE FUNCTION pg_temp.history_epoch_a() RETURNS bigint LANGUAGE sql AS $$
 SELECT (public.loomic_agent_context_capture('aa010000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000001',
 'aa060000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000001',
 (SELECT id FROM public.agent_design_tasks WHERE session_id='aa060000-0000-4000-8000-000000000001'))->>'historyEpoch')::bigint
$$;
CREATE FUNCTION pg_temp.history_epoch_b() RETURNS bigint LANGUAGE sql AS $$
 SELECT (public.loomic_agent_context_capture('aa010000-0000-4000-8000-000000000002','aa020000-0000-4000-8000-000000000002',
 'aa060000-0000-4000-8000-000000000002','aa070000-0000-4000-8000-000000000004',NULL)->>'historyEpoch')::bigint
$$;
SELECT pg_temp.qa_assert(pg_temp.history_epoch_a()=0 AND pg_temp.history_epoch_b()=0,'new sessions start at epoch zero; task creation does not invalidate history');
CREATE TEMP TABLE history_epoch_watermark AS SELECT public.loomic_agent_context_capture(
 'aa010000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000001',
 'aa060000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000001',
 (SELECT id FROM public.agent_design_tasks WHERE session_id='aa060000-0000-4000-8000-000000000001'))->>'sourceWatermark' AS value;
INSERT INTO public.chat_messages(id,session_id,role,content,content_blocks) VALUES
('aa090000-0000-4000-8000-000000000101','aa060000-0000-4000-8000-000000000001','user','Original source','[]');
SELECT pg_temp.qa_assert(pg_temp.history_epoch_a()=0,'new user message preserves existing valid history');
UPDATE public.chat_messages SET tool_activities='[{"type":"safe-metadata"}]' WHERE id='aa090000-0000-4000-8000-000000000101';
UPDATE public.chat_messages SET content=content,content_blocks=content_blocks,role=role WHERE id='aa090000-0000-4000-8000-000000000101';
SELECT pg_temp.qa_assert(pg_temp.history_epoch_a()=0,'metadata-only and no-op message updates preserve epoch');
UPDATE public.chat_messages SET content='Edited source' WHERE id='aa090000-0000-4000-8000-000000000101';
SELECT pg_temp.qa_assert(pg_temp.history_epoch_a()=1,'source text edit increments history epoch');
UPDATE public.chat_messages SET content_blocks='[{"type":"text","text":"Edited block"}]' WHERE id='aa090000-0000-4000-8000-000000000101';
SELECT pg_temp.qa_assert(pg_temp.history_epoch_a()=2,'source block edit increments history epoch');
UPDATE public.chat_messages SET role='assistant' WHERE id='aa090000-0000-4000-8000-000000000101';
SELECT pg_temp.qa_assert(pg_temp.history_epoch_a()=3,'source role edit increments history epoch');
UPDATE public.chat_messages SET session_id='aa060000-0000-4000-8000-000000000002' WHERE id='aa090000-0000-4000-8000-000000000101';
SELECT pg_temp.qa_assert(pg_temp.history_epoch_a()=4 AND pg_temp.history_epoch_b()=1,'moving a source invalidates both sessions');
DELETE FROM public.chat_messages WHERE id='aa090000-0000-4000-8000-000000000101';
SELECT pg_temp.qa_assert(pg_temp.history_epoch_a()=4 AND pg_temp.history_epoch_b()=2,'source deletion invalidates its session');
SELECT public.loomic_agent_task_update_brief('aa070000-0000-4000-8000-000000000001','{"goal":"Epoch test brief"}');
SELECT pg_temp.qa_assert(pg_temp.history_epoch_a()=4,'task brief update keeps original conversation history');
SELECT pg_temp.qa_assert(public.loomic_agent_context_capture('aa010000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000001',
 'aa060000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000001',
 (SELECT id FROM public.agent_design_tasks WHERE session_id='aa060000-0000-4000-8000-000000000001'))->>'sourceWatermark'
 <>(SELECT value FROM history_epoch_watermark),'source watermark also changes, preserving commit CAS');

INSERT INTO public.asset_objects(id,workspace_id,project_id,bucket,object_path,mime_type,byte_size,created_by) VALUES
('aa090000-0000-4000-8000-000000000105','aa020000-0000-4000-8000-000000000001','aa030000-0000-4000-8000-000000000001',
 'workspace-assets','context-epoch-fixture.png','image/png',123,'aa010000-0000-4000-8000-000000000001');
UPDATE public.asset_objects SET byte_size=124 WHERE id='aa090000-0000-4000-8000-000000000105';
SELECT pg_temp.qa_assert(pg_temp.history_epoch_a()=4,'new asset and metadata edit do not discard conversation');
UPDATE public.asset_objects SET object_path='context-epoch-replaced.png' WHERE id='aa090000-0000-4000-8000-000000000105';
SELECT pg_temp.qa_assert(pg_temp.history_epoch_a()=5,'replaced asset path invalidates old inline bytes');
UPDATE public.asset_objects SET bucket='project-assets' WHERE id='aa090000-0000-4000-8000-000000000105';
SELECT pg_temp.qa_assert(pg_temp.history_epoch_a()=6,'bucket move invalidates old inline bytes');
UPDATE public.asset_objects SET deletion_pending_at=now() WHERE id='aa090000-0000-4000-8000-000000000105';
SELECT pg_temp.qa_assert(pg_temp.history_epoch_a()=7,'soft deletion invalidates before physical cleanup');
UPDATE public.asset_objects SET deletion_pending_at=NULL WHERE id='aa090000-0000-4000-8000-000000000105';
SELECT pg_temp.qa_assert(pg_temp.history_epoch_a()=8,'restoring asset does not revive an old checkpoint generation');
UPDATE public.asset_objects SET workspace_id='aa020000-0000-4000-8000-000000000002',project_id='aa030000-0000-4000-8000-000000000002'
 WHERE id='aa090000-0000-4000-8000-000000000105';
SELECT pg_temp.qa_assert(pg_temp.history_epoch_a()=9 AND pg_temp.history_epoch_b()=3,'workspace move invalidates both workspace histories');
DELETE FROM public.asset_objects WHERE id='aa090000-0000-4000-8000-000000000105';
SELECT pg_temp.qa_assert(pg_temp.history_epoch_a()=9 AND pg_temp.history_epoch_b()=4,'asset deletion increments affected history only');
SELECT pg_temp.qa_error($q$ UPDATE public.chat_sessions SET agent_context_history_epoch=0
 WHERE id='aa060000-0000-4000-8000-000000000001' $q$,'agent_context_history_epoch_immutable');
SELECT pg_temp.qa_assert(pg_temp.history_epoch_a()=9,'direct writes cannot roll back the invalidation generation');
SELECT pg_temp.qa_assert(NOT has_function_privilege('authenticated','private.loomic_context_message_history_epoch()','EXECUTE'),
 'history invalidation cannot be invoked by a client');
