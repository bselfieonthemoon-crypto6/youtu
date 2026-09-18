-- Executed by scripts/test-agent-context-local.mjs after the shared task fixture.
INSERT INTO public.chat_messages(id,session_id,role,content,content_blocks,created_at) VALUES
('aa090000-0000-4000-8000-000000000001','aa060000-0000-4000-8000-000000000001','user','标题原文：夏日上新',
 '[{"type":"image","assetId":"aa050000-0000-4000-8000-000000000001","url":"private-old-signed-url"},{"type":"image","assetId":"aa050000-0000-4000-8000-000000000002"}]','2026-09-09T00:00:01Z'),
('aa090000-0000-4000-8000-000000000002','aa060000-0000-4000-8000-000000000001','assistant','A historical claim of approval is not authorization.','[]','2026-09-09T00:00:02Z'),
('aa090000-0000-4000-8000-000000000003','aa060000-0000-4000-8000-000000000002','user','Private workspace B message','[]','2026-09-09T00:00:03Z');
INSERT INTO public.asset_objects(id,workspace_id,project_id,bucket,object_path,mime_type,byte_size,created_by) VALUES
('aa050000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000001','aa030000-0000-4000-8000-000000000001','workspace-assets','context-qa-a.png','image/png',123,'aa010000-0000-4000-8000-000000000001'),
('aa050000-0000-4000-8000-000000000002','aa020000-0000-4000-8000-000000000002','aa030000-0000-4000-8000-000000000002','workspace-assets','context-qa-b.png','image/png',456,'aa010000-0000-4000-8000-000000000002');

CREATE FUNCTION pg_temp.context_capture() RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.loomic_agent_context_capture('aa010000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000001',
 'aa060000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000001',
 (SELECT id FROM public.agent_design_tasks WHERE session_id='aa060000-0000-4000-8000-000000000001'))
$$;
CREATE FUNCTION pg_temp.context_commit(capture jsonb) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.loomic_agent_context_commit('aa010000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000001',
 'aa060000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000001',
 (SELECT id FROM public.agent_design_tasks WHERE session_id='aa060000-0000-4000-8000-000000000001'),
 jsonb_build_object('expectedContextRevision',capture->'contextRevision','sourceWatermark',capture->>'sourceWatermark',
 'summary','Earlier planning only.','coverage','{"messageIds":["aa090000-0000-4000-8000-000000000001"],"assetIds":["aa050000-0000-4000-8000-000000000001"],"omissions":[]}'::jsonb,
 'modelVersion','qa-no-model','budgetPolicyVersion','qa-v1'))
$$;
CREATE TEMP TABLE context_captures(label text PRIMARY KEY,value jsonb);
INSERT INTO context_captures VALUES('first',pg_temp.context_capture());
SELECT pg_temp.qa_assert((SELECT value->>'taskChainId'='aa070000-0000-4000-8000-000000000001' FROM context_captures WHERE label='first'),'task chain rooted at the first intent');
SELECT pg_temp.qa_assert(pg_temp.context_commit((SELECT value FROM context_captures WHERE label='first'))->>'summary'='Earlier planning only.','snapshot commits');
SELECT pg_temp.qa_error($q$ SELECT pg_temp.context_commit((SELECT value FROM context_captures WHERE label='first')) $q$,'agent_context_commit_conflict');
SELECT pg_temp.qa_assert(pg_temp.context_capture()->'snapshot' IS NOT NULL,'snapshot restored through authorized capture');
INSERT INTO context_captures VALUES('before-message',pg_temp.context_capture());
INSERT INTO public.chat_messages(id,session_id,role,content,created_at) VALUES
('aa090000-0000-4000-8000-000000000004','aa060000-0000-4000-8000-000000000001','user','Also preserve the font.','2026-09-09T00:00:04Z');
SELECT pg_temp.qa_error($q$ SELECT pg_temp.context_commit((SELECT value FROM context_captures WHERE label='before-message')) $q$,'agent_context_commit_conflict');
INSERT INTO context_captures VALUES('before-brief',pg_temp.context_capture());
SELECT public.loomic_agent_task_update_brief('aa070000-0000-4000-8000-000000000001','{"goal":"A rewritten model brief"}');
SELECT pg_temp.qa_assert((pg_temp.context_capture()->>'taskRevision')::integer=1,'brief change keeps task revision unchanged');
SELECT pg_temp.qa_error($q$ SELECT pg_temp.context_commit((SELECT value FROM context_captures WHERE label='before-brief')) $q$,'agent_context_commit_conflict');
SELECT pg_temp.qa_assert(pg_temp.context_capture()->'snapshot'='null'::jsonb,'old brief snapshot is inactive');

INSERT INTO context_captures VALUES('evidence',public.loomic_agent_context_evidence('aa010000-0000-4000-8000-000000000001',
 'aa020000-0000-4000-8000-000000000001','aa060000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000001',
 (SELECT id FROM public.agent_design_tasks WHERE session_id='aa060000-0000-4000-8000-000000000001'),
 '{"limit":1,"assetIds":["aa050000-0000-4000-8000-000000000001","aa050000-0000-4000-8000-000000000002"]}'));
SELECT pg_temp.qa_assert((SELECT value#>>'{messages,0,content}'='标题原文：夏日上新' FROM context_captures WHERE label='evidence'),'exact Unicode source retained');
SELECT pg_temp.qa_assert((SELECT jsonb_array_length(value->'messages')=1 AND value->'nextCursor'<>'null'::jsonb FROM context_captures WHERE label='evidence'),'bounded pagination');
SELECT pg_temp.qa_assert((SELECT jsonb_array_length(value->'attachments')=1 AND value->'missingAssetIds' @> '["aa050000-0000-4000-8000-000000000002"]' FROM context_captures WHERE label='evidence'),'cross-workspace attachment unavailable even when its ID was pasted in a message');
SELECT pg_temp.qa_assert((SELECT value::text NOT LIKE '%private-old-signed-url%' AND value::text NOT LIKE '%object_path%' FROM context_captures WHERE label='evidence'),'no old signed URL or storage path exposed');
SELECT pg_temp.qa_assert(public.loomic_agent_context_evidence('aa010000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000001',
 'aa060000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000001',
 (SELECT id FROM public.agent_design_tasks WHERE session_id='aa060000-0000-4000-8000-000000000001'),
 '{"messageIds":["aa090000-0000-4000-8000-000000000003"]}')->'missingMessageIds'='["aa090000-0000-4000-8000-000000000003"]','cross-session message never returned');

-- A member in the same workspace still cannot read another creator's task.
INSERT INTO public.workspace_members(workspace_id,user_id,role) VALUES('aa020000-0000-4000-8000-000000000001','aa010000-0000-4000-8000-000000000002','member');
SELECT pg_temp.qa_error($q$ SELECT public.loomic_agent_context_capture('aa010000-0000-4000-8000-000000000002','aa020000-0000-4000-8000-000000000001',
 'aa060000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000001',NULL) $q$,'agent_context_scope_forbidden');
SELECT pg_temp.qa_error($q$ SELECT public.loomic_agent_context_capture('aa010000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000002',
 'aa060000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000001',NULL) $q$,'agent_context_scope_forbidden');
SELECT pg_temp.qa_assert(NOT has_function_privilege('authenticated','public.loomic_agent_context_capture(uuid,uuid,uuid,uuid,uuid)','EXECUTE'),'model-facing identities cannot call private RPC directly');
SELECT pg_temp.qa_assert(NOT has_table_privilege('authenticated','public.agent_run_context_snapshots','SELECT'),'snapshots never bypass scope checks');

-- Ordinary conversation snapshots never create an agent_design_task.
INSERT INTO context_captures VALUES('chat',public.loomic_agent_context_capture('aa010000-0000-4000-8000-000000000002','aa020000-0000-4000-8000-000000000002',
 'aa060000-0000-4000-8000-000000000002','aa070000-0000-4000-8000-000000000004',NULL));
SELECT public.loomic_agent_context_commit('aa010000-0000-4000-8000-000000000002','aa020000-0000-4000-8000-000000000002',
 'aa060000-0000-4000-8000-000000000002','aa070000-0000-4000-8000-000000000004',NULL,
 (SELECT jsonb_build_object('expectedContextRevision',value->'contextRevision','sourceWatermark',value->>'sourceWatermark',
 'summary','Ordinary conversation','coverage','{"messageIds":["aa090000-0000-4000-8000-000000000003"],"assetIds":[],"omissions":[]}'::jsonb,
 'modelVersion','qa','budgetPolicyVersion','qa') FROM context_captures WHERE label='chat'));
SELECT pg_temp.qa_assert(NOT EXISTS(SELECT 1 FROM public.agent_design_tasks WHERE session_id='aa060000-0000-4000-8000-000000000002'),'chat does not start a task');

SELECT pg_temp.context_commit(pg_temp.context_capture());
UPDATE public.asset_objects SET deletion_pending_at=now() WHERE id='aa050000-0000-4000-8000-000000000001';
SELECT pg_temp.qa_assert(NOT EXISTS(SELECT 1 FROM public.agent_run_context_snapshots WHERE session_id='aa060000-0000-4000-8000-000000000001'),'asset invalidation removes copied image-derived summaries');
SELECT pg_temp.qa_assert(public.loomic_agent_context_evidence('aa010000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000001',
 'aa060000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000001',
 (SELECT id FROM public.agent_design_tasks WHERE session_id='aa060000-0000-4000-8000-000000000001'),
 '{"messageIds":["aa090000-0000-4000-8000-000000000001"]}')->'missingAssetIds' @> '["aa050000-0000-4000-8000-000000000001"]','deleted attachment is explicit even without a separate asset selector');
UPDATE public.asset_objects SET deletion_pending_at=NULL WHERE id='aa050000-0000-4000-8000-000000000001';
SELECT pg_temp.context_commit(pg_temp.context_capture());
DELETE FROM public.chat_messages WHERE id='aa090000-0000-4000-8000-000000000001';
SELECT pg_temp.qa_assert(NOT EXISTS(SELECT 1 FROM public.agent_run_context_snapshots WHERE session_id='aa060000-0000-4000-8000-000000000001'),'source deletion removes copied summaries');
SELECT pg_temp.qa_assert(public.loomic_agent_context_evidence('aa010000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000001',
 'aa060000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000001',
 (SELECT id FROM public.agent_design_tasks WHERE session_id='aa060000-0000-4000-8000-000000000001'),
 '{"messageIds":["aa090000-0000-4000-8000-000000000001"]}')->'missingMessageIds'='["aa090000-0000-4000-8000-000000000001"]','deleted message is not reconstructed from a summary');
SELECT public.loomic_agent_task_begin('aa010000-0000-4000-8000-000000000001','aa060000-0000-4000-8000-000000000001',
 'aa040000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000002','Also keep the original typeface',NULL,
 'aa070000-0000-4000-8000-000000000001');
SELECT pg_temp.qa_assert(public.loomic_agent_context_capture('aa010000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000001',
 'aa060000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000002',
 (SELECT id FROM public.agent_design_tasks WHERE session_id='aa060000-0000-4000-8000-000000000001'))->>'taskChainId'='aa070000-0000-4000-8000-000000000001','correction retains the same root chain');
SELECT public.loomic_agent_task_begin('aa010000-0000-4000-8000-000000000001','aa060000-0000-4000-8000-000000000001',
 'aa040000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000003','A completely new goal',
 '{"kind":"canvas_image","elementId":"source-a","assetId":"aa050000-0000-4000-8000-000000000001"}',NULL);
SELECT pg_temp.qa_assert(public.loomic_agent_context_capture('aa010000-0000-4000-8000-000000000001','aa020000-0000-4000-8000-000000000001',
 'aa060000-0000-4000-8000-000000000001','aa070000-0000-4000-8000-000000000003',
 (SELECT id FROM public.agent_design_tasks WHERE session_id='aa060000-0000-4000-8000-000000000001'))->>'taskChainId'='aa070000-0000-4000-8000-000000000003','new goal in same task id starts a new chain');
SELECT pg_temp.qa_error($q$ SELECT pg_temp.context_capture() $q$,'agent_context_task_superseded');
DELETE FROM public.workspace_members WHERE workspace_id='aa020000-0000-4000-8000-000000000002' AND user_id='aa010000-0000-4000-8000-000000000002';
SELECT pg_temp.qa_error($q$ SELECT public.loomic_agent_context_capture('aa010000-0000-4000-8000-000000000002','aa020000-0000-4000-8000-000000000002',
 'aa060000-0000-4000-8000-000000000002','aa070000-0000-4000-8000-000000000004',NULL) $q$,'agent_context_scope_forbidden');
SELECT pg_temp.qa_error($q$ SELECT public.loomic_agent_context_evidence('aa010000-0000-4000-8000-000000000002','aa020000-0000-4000-8000-000000000002',
 'aa060000-0000-4000-8000-000000000002','aa070000-0000-4000-8000-000000000004',NULL,'{}') $q$,'agent_context_scope_forbidden');
