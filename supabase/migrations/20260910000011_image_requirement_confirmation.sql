-- Bind image proposals and agent runs to exact user messages. Confirmation and
-- chat insertion serialize on the chat_sessions row, making the requirement
-- check linearizable across API instances and direct database writers.

ALTER TABLE public.chat_messages
  ADD COLUMN session_sequence bigint;

WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY session_id ORDER BY created_at, id
  ) AS sequence_value
  FROM public.chat_messages
)
UPDATE public.chat_messages message
SET session_sequence = ranked.sequence_value
FROM ranked
WHERE ranked.id = message.id;

ALTER TABLE public.chat_messages
  ALTER COLUMN session_sequence SET NOT NULL;

CREATE UNIQUE INDEX chat_messages_session_sequence_idx
  ON public.chat_messages(session_id, session_sequence);

CREATE FUNCTION private.loomic_assign_chat_message_sequence()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM 1 FROM public.chat_sessions
    WHERE id=NEW.session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'chat_session_not_found'; END IF;
  SELECT COALESCE(max(message.session_sequence),0)+1
    INTO NEW.session_sequence
    FROM public.chat_messages message
    WHERE message.session_id=NEW.session_id;
  RETURN NEW;
END $$;

CREATE TRIGGER chat_messages_assign_session_sequence
  BEFORE INSERT ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION private.loomic_assign_chat_message_sequence();

CREATE FUNCTION private.loomic_preserve_chat_message_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM 1 FROM public.chat_sessions WHERE id=OLD.session_id FOR UPDATE;
    RETURN OLD;
  END IF;
  IF NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.session_sequence IS DISTINCT FROM OLD.session_sequence
    OR NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'chat_message_identity_immutable';
  END IF;
  IF OLD.role='user' AND (
    NEW.content IS DISTINCT FROM OLD.content
    OR NEW.content_blocks IS DISTINCT FROM OLD.content_blocks
    OR NEW.tool_activities IS DISTINCT FROM OLD.tool_activities
  ) THEN
    RAISE EXCEPTION 'user_message_content_immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER chat_messages_preserve_identity
  BEFORE UPDATE OR DELETE ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION private.loomic_preserve_chat_message_identity();

ALTER TABLE public.agent_runs
  ADD COLUMN request_message_id uuid REFERENCES public.chat_messages(id) ON DELETE SET NULL,
  ADD COLUMN request_prompt text;

CREATE INDEX agent_runs_request_message_idx
  ON public.agent_runs(request_message_id)
  WHERE request_message_id IS NOT NULL;

CREATE FUNCTION private.loomic_validate_agent_run_request_message()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  -- ON DELETE SET NULL must remain compatible with deleting a message or its
  -- parent session. Once the message is gone the prompt is no longer evidence.
  IF TG_OP='UPDATE' AND OLD.request_message_id IS NOT NULL
    AND NEW.request_message_id IS NULL THEN
    NEW.request_prompt := NULL;
    RETURN NEW;
  END IF;
  IF NEW.request_message_id IS NULL AND NEW.request_prompt IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.request_message_id IS NULL OR NEW.request_prompt IS NULL
    OR NEW.created_by IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.chat_messages message
      JOIN public.chat_sessions session ON session.id=message.session_id
      WHERE message.id=NEW.request_message_id
        AND message.session_id=NEW.session_id
        AND message.role='user'
        AND message.content=NEW.request_prompt
        AND session.created_by=NEW.created_by
    ) THEN
    RAISE EXCEPTION 'agent_run_request_message_invalid';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER agent_runs_validate_request_message
  BEFORE INSERT OR UPDATE OF request_message_id,request_prompt,session_id,created_by
  ON public.agent_runs
  FOR EACH ROW EXECUTE FUNCTION private.loomic_validate_agent_run_request_message();

ALTER TABLE public.image_generation_proposals
  ADD COLUMN requirement_message_id uuid REFERENCES public.chat_messages(id) ON DELETE SET NULL;

CREATE INDEX image_proposal_requirement_message_idx
  ON public.image_generation_proposals(requirement_message_id)
  WHERE requirement_message_id IS NOT NULL;

-- Historical runs were not bound to an exact message. Do not infer authority
-- from timestamp proximity: old proposals remain available to their exact UI
-- confirmation IDs, but free-text confirmation must rebuild them.

CREATE FUNCTION private.loomic_is_image_confirmation_message(p_content text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path='' AS $$
  SELECT regexp_replace(lower(btrim(COALESCE(p_content,''))), '[，。！!,.[:space:]]', '', 'g')
    ~ '^(确认生成|确认并生成|同意生成|可以生成|开始生成|继续生成|就按这个生成|按这个生成|确认就按这个生成|确认请按上述方案继续执行并生成预览|confirmgeneration|startgeneration|generateit|proceedwithgeneration)$'
$$;

CREATE FUNCTION private.loomic_is_image_cancellation_message(p_content text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path='' AS $$
  SELECT btrim(COALESCE(p_content,'')) ~ '^(取消|取消生成|不生成|不要生成|先不生成|算了|不要了)[。！![:space:]]*$'
$$;

CREATE FUNCTION private.loomic_is_image_decision_message(p_content text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path='' AS $$
  SELECT private.loomic_is_image_confirmation_message(p_content)
    OR private.loomic_is_image_cancellation_message(p_content)
$$;

CREATE OR REPLACE FUNCTION public.loomic_propose_image(p_session uuid,p_canvas uuid,p_run uuid,p_input jsonb,p_details jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE proposal public.image_generation_proposals; requirement_id uuid; BEGIN
  PERFORM 1 FROM public.chat_sessions s JOIN public.canvases c ON c.id=s.canvas_id
    WHERE s.id=p_session AND s.canvas_id=p_canvas AND s.created_by=auth.uid()
      AND EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=c.workspace_id AND m.user_id=auth.uid())
    FOR UPDATE OF s;
  IF NOT FOUND THEN RAISE EXCEPTION 'image_session_forbidden'; END IF;
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR length(p_input->>'prompt')<1
    OR p_input ? 'proposalId' THEN RAISE EXCEPTION 'image_proposal_invalid'; END IF;
  SELECT run.request_message_id INTO requirement_id
  FROM public.agent_runs run
  JOIN public.chat_messages message ON message.id=run.request_message_id
  WHERE run.id=p_run AND run.session_id=p_session AND run.created_by=auth.uid()
    AND message.session_id=p_session AND message.role='user'
    AND message.content=run.request_prompt;
  IF requirement_id IS NULL THEN RAISE EXCEPTION 'image_requirement_message_missing'; END IF;
  UPDATE public.image_generation_proposals SET status='superseded'
    WHERE session_id=p_session AND created_by=auth.uid() AND status='pending';
  INSERT INTO public.image_generation_proposals(session_id,canvas_id,created_by,origin_run_id,requirement_message_id,input,details)
    VALUES(p_session,p_canvas,auth.uid(),p_run,requirement_id,p_input,p_details) RETURNING * INTO proposal;
  RETURN to_jsonb(proposal);
END $$;

CREATE FUNCTION public.loomic_get_current_image_proposal(p_session uuid,p_canvas uuid,p_run uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' STABLE AS $$
DECLARE current_sequence bigint; proposal public.image_generation_proposals; BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.chat_sessions s JOIN public.canvases c ON c.id=s.canvas_id
    WHERE s.id=p_session AND s.canvas_id=p_canvas AND s.created_by=auth.uid()
      AND EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=c.workspace_id AND m.user_id=auth.uid())
  ) THEN RAISE EXCEPTION 'image_session_forbidden'; END IF;
  SELECT message.session_sequence INTO current_sequence
  FROM public.agent_runs run
  JOIN public.chat_messages message ON message.id=run.request_message_id
  WHERE run.id=p_run AND run.session_id=p_session AND run.created_by=auth.uid()
    AND message.session_id=p_session AND message.role='user'
    AND message.content=run.request_prompt;
  IF current_sequence IS NULL THEN RETURN NULL; END IF;
  SELECT candidate.* INTO proposal
  FROM public.image_generation_proposals candidate
  JOIN public.chat_messages requirement ON requirement.id=candidate.requirement_message_id
  WHERE candidate.session_id=p_session AND candidate.canvas_id=p_canvas
    AND candidate.created_by=auth.uid() AND candidate.status IN ('pending','confirmed')
    AND requirement.session_id=p_session AND requirement.role='user'
    AND requirement.session_sequence<=current_sequence
    AND NOT EXISTS (
      SELECT 1 FROM public.chat_messages intervening
      WHERE intervening.session_id=p_session AND intervening.role='user'
        AND intervening.session_sequence>requirement.session_sequence
        AND intervening.session_sequence<=current_sequence
        AND NOT private.loomic_is_image_decision_message(intervening.content)
    )
  ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 1;
  RETURN CASE WHEN proposal.id IS NULL THEN NULL ELSE to_jsonb(proposal) END;
END $$;

CREATE FUNCTION public.loomic_decide_current_image(p_id uuid,p_session uuid,p_canvas uuid,p_run uuid,p_decision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE proposal public.image_generation_proposals; current_id uuid; current_content text; current_sequence bigint; latest_id uuid; requirement_sequence bigint; BEGIN
  PERFORM 1 FROM public.chat_sessions s JOIN public.canvases c ON c.id=s.canvas_id
    WHERE s.id=p_session AND s.canvas_id=p_canvas AND s.created_by=auth.uid()
      AND EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=c.workspace_id AND m.user_id=auth.uid())
    FOR UPDATE OF s;
  IF NOT FOUND THEN RAISE EXCEPTION 'image_session_forbidden'; END IF;
  IF p_decision NOT IN ('confirm','cancel') THEN RAISE EXCEPTION 'invalid_decision'; END IF;
  SELECT message.id,message.content,message.session_sequence INTO current_id,current_content,current_sequence
  FROM public.agent_runs run
  JOIN public.chat_messages message ON message.id=run.request_message_id
  WHERE run.id=p_run AND run.session_id=p_session AND run.created_by=auth.uid()
    AND message.session_id=p_session AND message.role='user'
    AND message.content=run.request_prompt;
  IF current_id IS NULL THEN RETURN NULL; END IF;
  IF (p_decision='confirm' AND NOT private.loomic_is_image_confirmation_message(current_content))
    OR (p_decision='cancel' AND NOT private.loomic_is_image_cancellation_message(current_content)) THEN
    RETURN NULL;
  END IF;
  SELECT candidate.* INTO proposal
  FROM public.image_generation_proposals candidate
  JOIN public.chat_messages requirement ON requirement.id=candidate.requirement_message_id
  WHERE candidate.id=p_id AND candidate.session_id=p_session AND candidate.canvas_id=p_canvas
    AND candidate.created_by=auth.uid() AND requirement.session_id=p_session
    AND requirement.role='user' FOR UPDATE OF candidate;
  IF proposal.id IS NOT NULL THEN
    SELECT requirement.session_sequence INTO requirement_sequence
    FROM public.chat_messages requirement
    WHERE requirement.id=proposal.requirement_message_id;
  END IF;
  IF proposal.id IS NULL OR requirement_sequence>current_sequence THEN RETURN NULL; END IF;
  IF EXISTS (
      SELECT 1 FROM public.chat_messages intervening
      WHERE intervening.session_id=p_session AND intervening.role='user'
        AND intervening.session_sequence>requirement_sequence
        AND NOT CASE WHEN p_decision='confirm'
          THEN private.loomic_is_image_confirmation_message(intervening.content)
          ELSE private.loomic_is_image_decision_message(intervening.content) END
  ) THEN RETURN NULL; END IF;
  SELECT candidate.id INTO latest_id
  FROM public.image_generation_proposals candidate
  JOIN public.chat_messages candidate_requirement ON candidate_requirement.id=candidate.requirement_message_id
  WHERE candidate.session_id=p_session AND candidate.canvas_id=p_canvas
    AND candidate.created_by=auth.uid() AND candidate.status IN ('pending','confirmed')
    AND candidate_requirement.session_id=p_session AND candidate_requirement.role='user'
    AND candidate_requirement.session_sequence<=current_sequence
    AND NOT EXISTS (
      SELECT 1 FROM public.chat_messages intervening
      WHERE intervening.session_id=p_session AND intervening.role='user'
        AND intervening.session_sequence>candidate_requirement.session_sequence
        AND NOT CASE WHEN p_decision='confirm'
          THEN private.loomic_is_image_confirmation_message(intervening.content)
          ELSE private.loomic_is_image_decision_message(intervening.content) END
    )
  ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 1;
  IF latest_id IS DISTINCT FROM proposal.id THEN RETURN NULL; END IF;
  IF proposal.status='confirmed' AND p_decision='confirm' THEN RETURN to_jsonb(proposal); END IF;
  IF proposal.status<>'pending' OR proposal.expires_at<=now() THEN RETURN NULL; END IF;
  IF p_decision='confirm' AND proposal.origin_run_id=p_run
    AND (proposal.requirement_message_id IS DISTINCT FROM current_id
      OR NOT private.loomic_is_image_confirmation_message(current_content)) THEN
    RAISE EXCEPTION 'confirmation_requires_new_turn';
  END IF;
  UPDATE public.image_generation_proposals SET status=CASE WHEN p_decision='confirm' THEN 'confirmed' ELSE 'canceled' END
    WHERE id=p_id RETURNING * INTO proposal;
  RETURN to_jsonb(proposal);
END $$;

REVOKE ALL ON FUNCTION public.loomic_get_current_image_proposal(uuid,uuid,uuid),public.loomic_decide_current_image(uuid,uuid,uuid,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.loomic_get_current_image_proposal(uuid,uuid,uuid),public.loomic_decide_current_image(uuid,uuid,uuid,uuid,text) TO authenticated;

NOTIFY pgrst, 'reload schema';
