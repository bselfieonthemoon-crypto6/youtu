-- Existing immutable checkpoints need a separate invalidation generation.
-- Appending messages and ordinary task/brief updates keep their existing source
-- revisions, but do not require throwing away valid original conversation data.
ALTER TABLE public.chat_sessions ADD COLUMN agent_context_history_epoch bigint NOT NULL DEFAULT 0
  CHECK(agent_context_history_epoch>=0);

CREATE FUNCTION private.loomic_context_history_epoch_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  -- chat_sessions already permits scoped client updates. This new internal
  -- generation must not be client-writable or reset to revive an old graph.
  IF TG_OP='INSERT' THEN
    IF NEW.agent_context_history_epoch<>0 THEN RAISE EXCEPTION 'agent_context_history_epoch_immutable'; END IF;
  ELSIF NEW.agent_context_history_epoch IS DISTINCT FROM OLD.agent_context_history_epoch AND pg_trigger_depth()<=1 THEN
    RAISE EXCEPTION 'agent_context_history_epoch_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_context_history_epoch_guard BEFORE INSERT OR UPDATE ON public.chat_sessions
  FOR EACH ROW EXECUTE FUNCTION private.loomic_context_history_epoch_guard();

CREATE FUNCTION private.loomic_context_message_history_epoch()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE public.chat_sessions SET agent_context_history_epoch=agent_context_history_epoch+1 WHERE id=OLD.session_id;
    RETURN OLD;
  END IF;
  IF NEW.content IS DISTINCT FROM OLD.content OR NEW.content_blocks IS DISTINCT FROM OLD.content_blocks
    OR NEW.role IS DISTINCT FROM OLD.role OR NEW.session_id IS DISTINCT FROM OLD.session_id THEN
    UPDATE public.chat_sessions SET agent_context_history_epoch=agent_context_history_epoch+1
      WHERE id=OLD.session_id OR id=NEW.session_id;
  END IF;
  -- The existing message source trigger updates sourceWatermark and clears
  -- summaries atomically in this same transaction.
  RETURN NEW;
END $$;
CREATE TRIGGER agent_context_message_history_epoch AFTER UPDATE OR DELETE ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION private.loomic_context_message_history_epoch();

CREATE FUNCTION private.loomic_context_asset_history_epoch()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE affected_workspaces uuid[];
BEGIN
  IF TG_OP='DELETE' THEN
    affected_workspaces:=ARRAY[OLD.workspace_id];
  ELSIF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.bucket IS DISTINCT FROM OLD.bucket
    OR NEW.object_path IS DISTINCT FROM OLD.object_path OR NEW.deletion_pending_at IS DISTINCT FROM OLD.deletion_pending_at THEN
    affected_workspaces:=ARRAY[OLD.workspace_id,NEW.workspace_id];
  ELSE RETURN NEW;
  END IF;
  -- Scope conservatively to affected workspaces: old graph records may contain
  -- inline bytes or summaries whose asset IDs were not persisted separately.
  DELETE FROM public.agent_run_context_snapshots WHERE workspace_id=ANY(affected_workspaces);
  UPDATE public.chat_sessions s SET agent_context_history_epoch=agent_context_history_epoch+1,
    agent_context_revision=agent_context_revision+1,agent_context_source_revision=agent_context_source_revision+1
    FROM public.canvases c WHERE c.id=s.canvas_id AND c.workspace_id=ANY(affected_workspaces);
  -- Source revision also covers bucket-only changes, not handled by the older
  -- invalidation trigger. Multiple increments within one change are harmless.
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER agent_context_asset_history_epoch AFTER UPDATE OR DELETE ON public.asset_objects
  FOR EACH ROW EXECUTE FUNCTION private.loomic_context_asset_history_epoch();

CREATE OR REPLACE FUNCTION public.loomic_agent_context_capture(p_user uuid,p_workspace uuid,p_session uuid,p_run uuid,p_task uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE state jsonb; snap public.agent_run_context_snapshots; history_epoch bigint;
BEGIN
  -- Retain the existing live user/session/workspace/task authorization and
  -- session lock. The history epoch and selected snapshot are read under it.
  state:=private.loomic_context_state(p_user,p_workspace,p_session,p_run,p_task);
  SELECT agent_context_history_epoch INTO history_epoch FROM public.chat_sessions WHERE id=p_session;
  SELECT s.* INTO snap FROM public.agent_run_context_snapshots s
    WHERE s.session_id=p_session AND s.created_by=p_user AND s.workspace_id=p_workspace
      AND s.task_id IS NOT DISTINCT FROM p_task
      AND s.task_chain_id IS NOT DISTINCT FROM private.try_parse_uuid(state->>'taskChainId')
      AND s.task_hash IS NOT DISTINCT FROM state->>'taskHash'
      AND s.design_revision IS NOT DISTINCT FROM (state->>'designRevision')::bigint
    ORDER BY s.context_revision DESC LIMIT 1;
  RETURN (state-'taskHash')||jsonb_build_object('historyEpoch',history_epoch,
    'snapshot',CASE WHEN snap.id IS NULL THEN NULL ELSE private.loomic_context_snapshot_json(snap) END,
    'executionStatePolicy','reload_live_authority');
END $$;
REVOKE ALL ON FUNCTION private.loomic_context_message_history_epoch(),private.loomic_context_asset_history_epoch(),
  private.loomic_context_history_epoch_guard()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.loomic_agent_context_capture(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_agent_context_capture(uuid,uuid,uuid,uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
