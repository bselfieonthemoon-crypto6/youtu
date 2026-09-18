-- Session/task working context only. Original messages/assets retain ownership
-- and deletion semantics. These snapshots are never execution authorization.
ALTER TABLE public.chat_sessions
  ADD COLUMN agent_context_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN agent_context_source_revision bigint NOT NULL DEFAULT 0;

CREATE TABLE public.agent_run_context_snapshots (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  task_id uuid REFERENCES public.agent_design_tasks(id) ON DELETE CASCADE,
  task_chain_id uuid,
  task_revision bigint,
  task_hash text,
  design_revision bigint,
  context_revision bigint NOT NULL CHECK(context_revision>0),
  source_watermark text NOT NULL,
  content_hash text NOT NULL,
  summary text NOT NULL CHECK(octet_length(summary) BETWEEN 1 AND 192000),
  coverage jsonb NOT NULL CHECK(jsonb_typeof(coverage)='object'),
  model_version text NOT NULL,
  budget_policy_version text NOT NULL,
  public_plan jsonb,
  budget jsonb NOT NULL DEFAULT '{}',
  usage jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id,context_revision)
);
CREATE INDEX agent_context_scope_idx ON public.agent_run_context_snapshots(session_id,created_by,context_revision DESC);
ALTER TABLE public.agent_run_context_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_run_context_snapshots FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_run_context_snapshots FROM PUBLIC,anon,authenticated;

CREATE FUNCTION private.loomic_context_source_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE session uuid;
BEGIN
  session:=CASE WHEN TG_OP='DELETE' THEN OLD.session_id ELSE NEW.session_id END;
  UPDATE public.chat_sessions SET agent_context_revision=agent_context_revision+1,
    agent_context_source_revision=agent_context_source_revision+1 WHERE id=session;
  -- Edited/deleted source text must not survive as a copied summary. Inserts
  -- retain prior summaries for recovery, with an explicitly older watermark.
  IF TG_TABLE_NAME='chat_messages' AND TG_OP<>'INSERT' THEN
    DELETE FROM public.agent_run_context_snapshots WHERE session_id=session;
    IF TG_OP='UPDATE' AND OLD.session_id IS DISTINCT FROM NEW.session_id THEN
      UPDATE public.chat_sessions SET agent_context_revision=agent_context_revision+1,
        agent_context_source_revision=agent_context_source_revision+1 WHERE id=OLD.session_id;
      DELETE FROM public.agent_run_context_snapshots WHERE session_id=OLD.session_id;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER agent_context_message_revision AFTER INSERT OR UPDATE OR DELETE ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION private.loomic_context_source_changed();
CREATE TRIGGER agent_context_task_revision AFTER INSERT OR UPDATE OR DELETE ON public.agent_design_tasks
  FOR EACH ROW EXECUTE FUNCTION private.loomic_context_source_changed();

CREATE FUNCTION private.loomic_context_asset_invalidated()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.deletion_pending_at IS DISTINCT FROM OLD.deletion_pending_at
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.object_path IS DISTINCT FROM OLD.object_path THEN
    -- Conservative invalidation also covers summaries that referenced an image
    -- through a covered message instead of a separate assetIds list.
    DELETE FROM public.agent_run_context_snapshots WHERE workspace_id=OLD.workspace_id;
    UPDATE public.chat_sessions s SET agent_context_revision=agent_context_revision+1,
      agent_context_source_revision=agent_context_source_revision+1
      FROM public.canvases c WHERE c.id=s.canvas_id AND c.workspace_id=OLD.workspace_id;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER agent_context_asset_invalidation AFTER UPDATE OR DELETE ON public.asset_objects
  FOR EACH ROW EXECUTE FUNCTION private.loomic_context_asset_invalidated();

CREATE FUNCTION private.loomic_context_state(p_user uuid,p_workspace uuid,p_session uuid,p_run uuid,p_task uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE session public.chat_sessions; task public.agent_design_tasks; chain uuid; task_hash text;
  design_revision bigint; source_count bigint; latest_id uuid; latest_time timestamptz; watermark text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  -- Session creator access matches the stricter task rule, even if the user
  -- happens to belong to the same workspace as another user's conversation.
  SELECT s.* INTO session FROM public.chat_sessions s
    JOIN public.canvases c ON c.id=s.canvas_id
    JOIN public.workspace_members m ON m.workspace_id=c.workspace_id AND m.user_id=p_user
    WHERE s.id=p_session AND s.created_by=p_user AND c.workspace_id=p_workspace FOR UPDATE OF s;
  IF session.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.agent_runs r
      WHERE r.id=p_run AND r.session_id=p_session AND r.created_by=p_user) THEN
    RAISE EXCEPTION 'agent_context_scope_forbidden';
  END IF;
  IF p_task IS NOT NULL THEN
    SELECT t.* INTO task FROM public.agent_design_tasks t
      JOIN public.agent_design_task_runs r ON r.task_id=t.id AND r.run_id=p_run
      WHERE t.id=p_task AND t.created_by=p_user AND t.session_id=p_session AND t.canvas_id=session.canvas_id;
    IF task.id IS NULL THEN RAISE EXCEPTION 'agent_context_task_forbidden'; END IF;
    IF task.current_run_id<>p_run THEN RAISE EXCEPTION 'agent_context_task_superseded'; END IF;
    -- taskId is reused for new goals: find the most recent root intent, not the
    -- first-ever task run. Each correction snapshot retains its root goal.
    SELECT r.run_id INTO chain FROM public.agent_design_task_runs r WHERE r.task_id=p_task
      AND r.revision<=task.revision AND COALESCE(jsonb_array_length(r.intent->'corrections'),0)=0
      ORDER BY r.revision DESC LIMIT 1;
    chain:=COALESCE(chain,p_run);
    task_hash:=encode(extensions.digest(jsonb_build_object('goal',task.goal,'corrections',task.corrections,'target',task.target,'brief',task.brief)::text,'sha256'),'hex');
    IF task.target->>'kind'='design' THEN
      SELECT d.revision INTO design_revision FROM public.design_documents d
        WHERE d.id=private.try_parse_uuid(task.target->>'designId') AND d.workspace_id=p_workspace AND d.deleted_at IS NULL
          AND EXISTS(SELECT 1 FROM public.design_nodes n WHERE n.design_id=d.id AND n.canvas_id=session.canvas_id AND n.deleted_at IS NULL);
      IF design_revision IS NULL THEN RAISE EXCEPTION 'agent_context_task_forbidden'; END IF;
    END IF;
  ELSIF EXISTS(SELECT 1 FROM public.agent_design_task_runs r WHERE r.run_id=p_run) THEN
    RAISE EXCEPTION 'agent_context_task_forbidden';
  END IF;
  SELECT count(*) INTO source_count FROM public.chat_messages WHERE session_id=p_session;
  SELECT m.id,m.created_at INTO latest_id,latest_time FROM public.chat_messages m WHERE m.session_id=p_session
    ORDER BY m.created_at DESC,m.id DESC LIMIT 1;
  watermark:=encode(extensions.digest(jsonb_build_object('sourceRevision',session.agent_context_source_revision,'count',source_count,
    'lastMessageId',latest_id,'lastMessageCreatedAt',latest_time,'taskChainId',chain,
    'taskRevision',task.revision,'taskHash',task_hash,'designRevision',design_revision)::text,'sha256'),'hex');
  RETURN jsonb_build_object('contextRevision',session.agent_context_revision,'sourceWatermark',watermark,
    'taskChainId',chain,'taskRevision',task.revision,'designRevision',design_revision,'taskHash',task_hash);
END $$;

CREATE FUNCTION private.loomic_context_snapshot_json(s public.agent_run_context_snapshots)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
SELECT jsonb_build_object('id',s.id,'contextRevision',s.context_revision,'sourceWatermark',s.source_watermark,
  'taskChainId',s.task_chain_id,'taskRevision',s.task_revision,'designRevision',s.design_revision,
  'summary',s.summary,'coverage',s.coverage,'contentHash',s.content_hash,'modelVersion',s.model_version,
  'budgetPolicyVersion',s.budget_policy_version,'publicPlan',s.public_plan,'budget',s.budget,'usage',s.usage,'createdAt',s.created_at)
$$;

CREATE FUNCTION public.loomic_agent_context_capture(p_user uuid,p_workspace uuid,p_session uuid,p_run uuid,p_task uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE state jsonb; snap public.agent_run_context_snapshots;
BEGIN
  state:=private.loomic_context_state(p_user,p_workspace,p_session,p_run,p_task);
  SELECT s.* INTO snap FROM public.agent_run_context_snapshots s
    WHERE s.session_id=p_session AND s.created_by=p_user AND s.workspace_id=p_workspace
      AND s.task_id IS NOT DISTINCT FROM p_task
      AND s.task_chain_id IS NOT DISTINCT FROM private.try_parse_uuid(state->>'taskChainId')
      AND s.task_hash IS NOT DISTINCT FROM state->>'taskHash'
      AND s.design_revision IS NOT DISTINCT FROM (state->>'designRevision')::bigint
    ORDER BY s.context_revision DESC LIMIT 1;
  RETURN (state-'taskHash')||jsonb_build_object('snapshot',CASE WHEN snap.id IS NULL THEN NULL ELSE private.loomic_context_snapshot_json(snap) END,
    'executionStatePolicy','reload_live_authority');
END $$;

CREATE FUNCTION public.loomic_agent_context_commit(p_user uuid,p_workspace uuid,p_session uuid,p_run uuid,p_task uuid,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE state jsonb; snap public.agent_run_context_snapshots; next_revision bigint; source uuid;
BEGIN
  state:=private.loomic_context_state(p_user,p_workspace,p_session,p_run,p_task);
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR octet_length(p_payload::text)>262144
    OR jsonb_typeof(p_payload->'summary') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'modelVersion') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'budgetPolicyVersion') IS DISTINCT FROM 'string'
    OR COALESCE(char_length(p_payload->>'summary'),0) NOT BETWEEN 1 AND 64000
    OR COALESCE(char_length(p_payload->>'modelVersion'),0) NOT BETWEEN 1 AND 200
    OR COALESCE(char_length(p_payload->>'budgetPolicyVersion'),0) NOT BETWEEN 1 AND 200
    OR jsonb_typeof(p_payload->'coverage') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_payload#>'{coverage,messageIds}') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_payload#>'{coverage,assetIds}') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_payload#>'{coverage,omissions}') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_payload#>'{coverage,messageIds}')>2000 OR jsonb_array_length(p_payload#>'{coverage,assetIds}')>200
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN
      ('expectedContextRevision','sourceWatermark','summary','coverage','modelVersion','budgetPolicyVersion','publicPlan','budget','usage'))
    THEN RAISE EXCEPTION 'agent_context_payload_invalid'; END IF;
  IF p_payload->>'expectedContextRevision' IS DISTINCT FROM state->>'contextRevision'
    OR p_payload->>'sourceWatermark' IS DISTINCT FROM state->>'sourceWatermark' THEN
    RAISE EXCEPTION 'agent_context_commit_conflict';
  END IF;
  FOR source IN SELECT value::uuid FROM jsonb_array_elements_text(p_payload#>'{coverage,messageIds}') LOOP
    IF NOT EXISTS(SELECT 1 FROM public.chat_messages WHERE id=source AND session_id=p_session) THEN
      RAISE EXCEPTION 'agent_context_source_missing'; END IF;
  END LOOP;
  FOR source IN SELECT value::uuid FROM jsonb_array_elements_text(p_payload#>'{coverage,assetIds}') LOOP
    IF NOT EXISTS(SELECT 1 FROM public.asset_objects a WHERE a.id=source AND a.workspace_id=p_workspace AND a.deletion_pending_at IS NULL)
      OR NOT EXISTS(SELECT 1 FROM public.chat_messages m CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(m.content_blocks)='array' THEN m.content_blocks ELSE '[]' END) b
        WHERE m.session_id=p_session AND b->>'assetId'=source::text)
    THEN RAISE EXCEPTION 'agent_context_source_missing'; END IF;
  END LOOP;
  UPDATE public.chat_sessions SET agent_context_revision=agent_context_revision+1 WHERE id=p_session
    RETURNING agent_context_revision INTO next_revision;
  INSERT INTO public.agent_run_context_snapshots(workspace_id,created_by,session_id,run_id,task_id,task_chain_id,task_revision,
    task_hash,design_revision,context_revision,source_watermark,content_hash,summary,coverage,model_version,budget_policy_version,public_plan,budget,usage)
  VALUES(p_workspace,p_user,p_session,p_run,p_task,private.try_parse_uuid(state->>'taskChainId'),(state->>'taskRevision')::bigint,
    state->>'taskHash',(state->>'designRevision')::bigint,next_revision,state->>'sourceWatermark',encode(extensions.digest(p_payload::text,'sha256'),'hex'),
    p_payload->>'summary',p_payload->'coverage',p_payload->>'modelVersion',p_payload->>'budgetPolicyVersion',p_payload->'publicPlan',
    COALESCE(p_payload->'budget','{}'),COALESCE(p_payload->'usage','{}')) RETURNING * INTO snap;
  RETURN private.loomic_context_snapshot_json(snap);
END $$;

CREATE FUNCTION public.loomic_agent_context_evidence(p_user uuid,p_workspace uuid,p_session uuid,p_run uuid,p_task uuid,p_query jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE state jsonb; messages jsonb; attachments jsonb; missing_messages jsonb; missing_assets jsonb;
  requested_messages uuid[]; requested_assets uuid[]; attachment_ids uuid[]; page_size integer; cursor_time timestamptz; cursor_id uuid;
  next_cursor jsonb; selected_ids uuid[];
BEGIN
  state:=private.loomic_context_state(p_user,p_workspace,p_session,p_run,p_task);
  IF jsonb_typeof(p_query) IS DISTINCT FROM 'object'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_query) k WHERE k NOT IN('messageIds','assetIds','cursor','limit')) THEN
    RAISE EXCEPTION 'agent_context_query_invalid'; END IF;
  page_size:=COALESCE((p_query->>'limit')::integer,8);
  IF page_size NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'agent_context_query_invalid'; END IF;
  SELECT array_agg(value::uuid) INTO requested_messages FROM jsonb_array_elements_text(COALESCE(p_query->'messageIds','[]'));
  SELECT array_agg(value::uuid) INTO requested_assets FROM jsonb_array_elements_text(COALESCE(p_query->'assetIds','[]'));
  IF COALESCE(cardinality(requested_messages),0)>20 OR COALESCE(cardinality(requested_assets),0)>20
    OR (requested_messages IS NOT NULL AND p_query ? 'cursor') THEN RAISE EXCEPTION 'agent_context_query_invalid'; END IF;
  cursor_time:=(p_query#>>'{cursor,createdAt}')::timestamptz; cursor_id:=private.try_parse_uuid(p_query#>>'{cursor,id}');
  IF p_query ? 'cursor' AND (cursor_time IS NULL OR cursor_id IS NULL OR NOT EXISTS(
      SELECT 1 FROM public.chat_messages WHERE session_id=p_session AND id=cursor_id AND created_at=cursor_time)) THEN
    RAISE EXCEPTION 'agent_context_source_missing'; END IF;
  SELECT array_agg(q.id ORDER BY q.created_at,q.id) INTO selected_ids FROM (
    SELECT m.id,m.created_at FROM public.chat_messages m WHERE m.session_id=p_session
      AND (requested_messages IS NULL OR m.id=ANY(requested_messages))
      AND (cursor_time IS NULL OR (m.created_at,m.id)>(cursor_time,cursor_id))
      ORDER BY m.created_at,m.id LIMIT CASE WHEN requested_messages IS NULL THEN page_size ELSE 20 END) q;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',m.id,'role',m.role,
    'content',CASE WHEN octet_length(m.content)<=131072 THEN m.content ELSE NULL END,'createdAt',m.created_at,
    'contentHash',encode(extensions.digest(m.content,'sha256'),'hex'),'unavailableReason',CASE WHEN octet_length(m.content)>131072 THEN 'source_too_large' ELSE NULL END,
    'assetIds',COALESCE((SELECT jsonb_agg(DISTINCT a.id) FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(m.content_blocks)='array' THEN m.content_blocks ELSE '[]' END) b
      JOIN public.asset_objects a ON a.id=private.try_parse_uuid(b->>'assetId') AND a.workspace_id=p_workspace
      AND a.deletion_pending_at IS NULL),'[]')) ORDER BY m.created_at,m.id),'[]') INTO messages
    FROM public.chat_messages m WHERE m.session_id=p_session AND m.id=ANY(selected_ids);
  SELECT array_agg(DISTINCT private.try_parse_uuid(b->>'assetId')) FILTER(WHERE private.try_parse_uuid(b->>'assetId') IS NOT NULL)
    INTO attachment_ids FROM public.chat_messages m CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(m.content_blocks)='array' THEN m.content_blocks ELSE '[]' END) b
    WHERE m.session_id=p_session AND (m.id=ANY(selected_ids) OR private.try_parse_uuid(b->>'assetId')=ANY(requested_assets));
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',a.id,'mimeType',a.mime_type,'byteSize',a.byte_size,'createdAt',a.created_at)),'[]')
    INTO attachments FROM public.asset_objects a WHERE a.id=ANY(attachment_ids) AND a.workspace_id=p_workspace AND a.deletion_pending_at IS NULL;
  SELECT COALESCE(jsonb_agg(i),'[]') INTO missing_messages FROM unnest(requested_messages) i
    WHERE NOT EXISTS(SELECT 1 FROM public.chat_messages m WHERE m.id=i AND m.session_id=p_session);
  SELECT COALESCE(jsonb_agg(DISTINCT i),'[]') INTO missing_assets FROM unnest(COALESCE(requested_assets,'{}'::uuid[])||COALESCE(attachment_ids,'{}'::uuid[])) i
    WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(attachments) a WHERE a->>'id'=i::text);
  IF requested_messages IS NULL AND cardinality(selected_ids)=page_size THEN
    SELECT jsonb_build_object('createdAt',m.created_at,'id',m.id) INTO next_cursor FROM public.chat_messages m
      WHERE m.id=selected_ids[cardinality(selected_ids)] AND EXISTS(SELECT 1 FROM public.chat_messages later
        WHERE later.session_id=p_session AND (later.created_at,later.id)>(m.created_at,m.id));
  END IF;
  RETURN jsonb_build_object('messages',messages,'attachments',attachments,'missingMessageIds',missing_messages,
    'missingAssetIds',missing_assets,'nextCursor',next_cursor,'sourceWatermark',state->>'sourceWatermark',
    'contextRevision',(state->>'contextRevision')::bigint,'authority','historical_evidence_only');
END $$;

REVOKE ALL ON FUNCTION private.loomic_context_source_changed(),private.loomic_context_asset_invalidated(),
  private.loomic_context_state(uuid,uuid,uuid,uuid,uuid),private.loomic_context_snapshot_json(public.agent_run_context_snapshots)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.loomic_agent_context_capture(uuid,uuid,uuid,uuid,uuid),
  public.loomic_agent_context_commit(uuid,uuid,uuid,uuid,uuid,jsonb),
  public.loomic_agent_context_evidence(uuid,uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_agent_context_capture(uuid,uuid,uuid,uuid,uuid),
  public.loomic_agent_context_commit(uuid,uuid,uuid,uuid,uuid,jsonb),
  public.loomic_agent_context_evidence(uuid,uuid,uuid,uuid,uuid,jsonb) TO service_role;
