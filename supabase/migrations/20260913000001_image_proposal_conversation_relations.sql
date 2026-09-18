-- Preserve a pending proposal across ordinary conversation without treating
-- prose classification as paid authorization. Only the server service role may
-- record semantic relations; confirmation keeps all existing actor/scope/input
-- checks and serializes against chat insertion on chat_sessions.

CREATE TABLE public.image_proposal_turn_relations (
  proposal_id uuid NOT NULL REFERENCES public.image_generation_proposals(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES public.chat_messages(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  canvas_id uuid NOT NULL REFERENCES public.canvases(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  classified_by_run_id uuid NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  relation text NOT NULL CHECK (relation IN ('preserve','invalidate')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id,message_id)
);

CREATE TABLE public.image_contextual_confirmation_bindings (
  proposal_id uuid NOT NULL REFERENCES public.image_generation_proposals(id) ON DELETE CASCADE,
  message_id uuid PRIMARY KEY REFERENCES public.chat_messages(id) ON DELETE CASCADE,
  run_id uuid NOT NULL UNIQUE REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  canvas_id uuid NOT NULL REFERENCES public.canvases(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX image_proposal_turn_relations_session_idx
  ON public.image_proposal_turn_relations(session_id,proposal_id);

ALTER TABLE public.image_proposal_turn_relations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.image_proposal_turn_relations FROM PUBLIC,anon,authenticated;
ALTER TABLE public.image_contextual_confirmation_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.image_contextual_confirmation_bindings FROM PUBLIC,anon,authenticated;

CREATE FUNCTION private.loomic_image_turn_preserves_proposal(
  p_proposal uuid,
  p_message public.chat_messages
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT private.loomic_is_image_decision_message(p_message.content)
    OR EXISTS (SELECT 1 FROM public.image_contextual_confirmation_bindings binding
      WHERE binding.proposal_id=p_proposal AND binding.message_id=p_message.id)
    OR EXISTS (
      SELECT 1 FROM public.image_proposal_turn_relations relation
      WHERE relation.proposal_id=p_proposal
        AND relation.message_id=p_message.id
        AND relation.session_id=p_message.session_id
        AND relation.relation='preserve'
    )
$$;

CREATE FUNCTION public.loomic_get_image_proposal_relation_context(
  p_user uuid,p_session uuid,p_canvas uuid,p_run uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' STABLE AS $$
DECLARE current_id uuid; current_sequence bigint; proposal public.image_generation_proposals;
  requirement_content text; turns jsonb; missing_count integer; total_missing integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.chat_sessions session
    JOIN public.canvases canvas ON canvas.id=session.canvas_id
    WHERE session.id=p_session AND session.canvas_id=p_canvas AND session.created_by=p_user
      AND EXISTS (SELECT 1 FROM public.workspace_members member
        WHERE member.workspace_id=canvas.workspace_id AND member.user_id=p_user)
  ) THEN RAISE EXCEPTION 'image_proposal_relation_forbidden'; END IF;

  SELECT message.id,message.session_sequence INTO current_id,current_sequence
  FROM public.agent_runs run
  JOIN public.chat_messages message ON message.id=run.request_message_id
  WHERE run.id=p_run AND run.session_id=p_session AND run.created_by=p_user
    AND message.session_id=p_session AND message.role='user'
    AND message.content=run.request_prompt;
  IF current_sequence IS NULL THEN RAISE EXCEPTION 'image_proposal_relation_run_invalid'; END IF;

  SELECT candidate.* INTO proposal
  FROM public.image_generation_proposals candidate
  JOIN public.chat_messages requirement ON requirement.id=candidate.requirement_message_id
  WHERE candidate.session_id=p_session AND candidate.canvas_id=p_canvas
    AND candidate.created_by=p_user AND candidate.status='pending' AND candidate.expires_at>now()
    AND requirement.session_id=p_session AND requirement.role='user'
    AND requirement.session_sequence<=current_sequence
    AND NOT EXISTS (
      SELECT 1 FROM public.image_proposal_turn_relations prior
      JOIN public.chat_messages prior_message ON prior_message.id=prior.message_id
      WHERE prior.proposal_id=candidate.id AND prior.relation='invalidate'
        AND prior_message.session_sequence<=current_sequence
    )
  ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 1;
  IF proposal.id IS NULL THEN RETURN NULL; END IF;

  SELECT content INTO requirement_content FROM public.chat_messages
    WHERE id=proposal.requirement_message_id;
  SELECT count(*) INTO total_missing FROM public.chat_messages message
  WHERE message.session_id=p_session AND message.role='user'
    AND message.session_sequence>(SELECT session_sequence FROM public.chat_messages WHERE id=proposal.requirement_message_id)
    AND message.session_sequence<=current_sequence
    AND NOT private.loomic_is_image_decision_message(message.content)
    AND (message.id<>current_id OR regexp_replace(lower(btrim(COALESCE(message.content,''))), '[，。！!,.[:space:]]', '', 'g')<>'确认')
    AND NOT EXISTS (SELECT 1 FROM public.image_proposal_turn_relations relation
      WHERE relation.proposal_id=proposal.id AND relation.message_id=message.id);
  WITH missing AS (
    SELECT message.* FROM public.chat_messages message
    WHERE message.session_id=p_session AND message.role='user'
      AND message.session_sequence>(SELECT session_sequence FROM public.chat_messages WHERE id=proposal.requirement_message_id)
      AND message.session_sequence<=current_sequence
      AND NOT private.loomic_is_image_decision_message(message.content)
      -- A bare confirmation is authorized separately from a trusted proposal
      -- CTA marker; it is never classified as conversational preservation.
      AND (message.id<>current_id OR regexp_replace(lower(btrim(COALESCE(message.content,''))), '[，。！!,.[:space:]]', '', 'g')<>'确认')
      AND NOT EXISTS (SELECT 1 FROM public.image_proposal_turn_relations relation
        WHERE relation.proposal_id=proposal.id AND relation.message_id=message.id)
    ORDER BY message.session_sequence LIMIT 16
  )
  SELECT count(*),COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'id',message.id,'content',message.content,'precedingAssistant',(
        SELECT assistant.content FROM public.chat_messages assistant
        WHERE assistant.session_id=p_session AND assistant.role='assistant'
          AND assistant.session_sequence<message.session_sequence
        ORDER BY assistant.session_sequence DESC LIMIT 1
      )))
      ORDER BY message.session_sequence),'[]'::jsonb)
    INTO missing_count,turns
  FROM missing message;
  RETURN jsonb_build_object(
    'proposalId',proposal.id,
    'proposalInput',proposal.input,
    'requirement',jsonb_build_object('id',proposal.requirement_message_id,'content',requirement_content),
    'turns',turns,
    'hasMore',total_missing>missing_count
  );
END $$;

CREATE FUNCTION public.loomic_bind_contextual_image_confirmation(
  p_user uuid,p_session uuid,p_canvas uuid,p_run uuid
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE current_message public.chat_messages; proposal public.image_generation_proposals;
  requirement_sequence bigint; assistant public.chat_messages;
BEGIN
  PERFORM 1 FROM public.chat_sessions session
  JOIN public.canvases canvas ON canvas.id=session.canvas_id
  WHERE session.id=p_session AND session.canvas_id=p_canvas AND session.created_by=p_user
    AND EXISTS (SELECT 1 FROM public.workspace_members member
      WHERE member.workspace_id=canvas.workspace_id AND member.user_id=p_user)
  FOR UPDATE OF session;
  IF NOT FOUND THEN RAISE EXCEPTION 'image_proposal_relation_forbidden'; END IF;
  SELECT message.* INTO current_message FROM public.agent_runs run
  JOIN public.chat_messages message ON message.id=run.request_message_id
  WHERE run.id=p_run AND run.session_id=p_session AND run.created_by=p_user
    AND message.session_id=p_session AND message.role='user' AND message.content=run.request_prompt;
  IF current_message.id IS NULL OR regexp_replace(lower(btrim(COALESCE(current_message.content,''))),
    '[，。！!,.[:space:]]','','g')<>'确认' THEN RETURN NULL; END IF;

  SELECT candidate.* INTO proposal FROM public.image_generation_proposals candidate
  JOIN public.chat_messages requirement ON requirement.id=candidate.requirement_message_id
  WHERE candidate.session_id=p_session AND candidate.canvas_id=p_canvas AND candidate.created_by=p_user
    AND candidate.status='pending' AND candidate.expires_at>now()
    AND requirement.session_id=p_session AND requirement.role='user'
    AND requirement.session_sequence<current_message.session_sequence
    AND NOT EXISTS (SELECT 1 FROM public.chat_messages intervening
      WHERE intervening.session_id=p_session AND intervening.role='user'
        AND intervening.session_sequence>requirement.session_sequence
        AND intervening.session_sequence<current_message.session_sequence
        AND NOT private.loomic_image_turn_preserves_proposal(candidate.id,intervening))
  ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 1 FOR UPDATE OF candidate;
  IF proposal.id IS NULL THEN RETURN NULL; END IF;
  SELECT session_sequence INTO requirement_sequence FROM public.chat_messages WHERE id=proposal.requirement_message_id;

  SELECT candidate.* INTO assistant FROM public.chat_messages candidate
    WHERE candidate.session_id=p_session AND candidate.session_sequence<current_message.session_sequence
    ORDER BY candidate.session_sequence DESC LIMIT 1;
  -- The immediately preceding assistant must actually invite confirmation.
  -- This text supplies conversational context only; the older matching tool
  -- ledger below is the authoritative proof that this proposal was saved.
  IF assistant.id IS NULL OR assistant.role<>'assistant'
    OR assistant.content !~ '(请|回复|点击)[^。！？\n]{0,24}确认[[:space:]]*生成'
    OR assistant.content ~ '(不要|无需|不用|不必)[^。！？\n]{0,12}确认[[:space:]]*生成'
  THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.chat_messages marker_message
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(marker_message.content_blocks,'[]'::jsonb)) block
    JOIN public.tool_executions execution ON execution.run_id=proposal.origin_run_id
      AND execution.requested_by=p_user AND execution.tool_name='generate_image'
      AND execution.status='completed' AND execution.tool_call_id=block->>'toolCallId'
    WHERE marker_message.session_id=p_session AND marker_message.role='assistant'
      AND marker_message.session_sequence>=requirement_sequence
      AND marker_message.session_sequence<current_message.session_sequence
      AND block->>'type'='tool' AND block->>'toolName'='generate_image'
      AND block->>'status'='completed'
      AND block->'output'->>'status'='awaiting_confirmation'
      AND block->'output'->'confirmation'->>'confirmationId'=proposal.id::text
      AND execution.output->>'status'='awaiting_confirmation'
      AND execution.output->'confirmation'->>'confirmationId'=proposal.id::text
  ) THEN RETURN NULL; END IF;
  INSERT INTO public.image_contextual_confirmation_bindings(
    proposal_id,message_id,run_id,session_id,canvas_id,created_by
  ) VALUES(proposal.id,current_message.id,p_run,p_session,p_canvas,p_user)
  ON CONFLICT (message_id) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM public.image_contextual_confirmation_bindings binding
    WHERE binding.message_id=current_message.id AND binding.proposal_id=proposal.id
      AND binding.run_id=p_run AND binding.created_by=p_user) THEN
    RAISE EXCEPTION 'image_proposal_relation_conflict';
  END IF;
  RETURN proposal.id;
END $$;

CREATE FUNCTION public.loomic_record_image_proposal_turn_relations(
  p_user uuid,p_session uuid,p_canvas uuid,p_run uuid,p_proposal uuid,p_relations jsonb
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE proposal public.image_generation_proposals; current_sequence bigint;
  requirement_sequence bigint; entry jsonb; message public.chat_messages; relation_value text;
BEGIN
  PERFORM 1 FROM public.chat_sessions session
  JOIN public.canvases canvas ON canvas.id=session.canvas_id
  WHERE session.id=p_session AND session.canvas_id=p_canvas AND session.created_by=p_user
    AND EXISTS (SELECT 1 FROM public.workspace_members member
      WHERE member.workspace_id=canvas.workspace_id AND member.user_id=p_user)
  FOR UPDATE OF session;
  IF NOT FOUND THEN RAISE EXCEPTION 'image_proposal_relation_forbidden'; END IF;

  SELECT request_message.session_sequence INTO current_sequence
  FROM public.agent_runs run
  JOIN public.chat_messages request_message ON request_message.id=run.request_message_id
  WHERE run.id=p_run AND run.session_id=p_session AND run.created_by=p_user
    AND request_message.session_id=p_session AND request_message.role='user'
    AND request_message.content=run.request_prompt;
  IF current_sequence IS NULL THEN RAISE EXCEPTION 'image_proposal_relation_run_invalid'; END IF;

  SELECT candidate.* INTO proposal FROM public.image_generation_proposals candidate
  WHERE candidate.id=p_proposal AND candidate.session_id=p_session AND candidate.canvas_id=p_canvas
    AND candidate.created_by=p_user AND candidate.status='pending' AND candidate.expires_at>now()
  FOR UPDATE;
  IF proposal.id IS NULL OR EXISTS (
    SELECT 1 FROM public.image_generation_proposals newer
    WHERE newer.session_id=p_session AND newer.canvas_id=p_canvas AND newer.created_by=p_user
      AND newer.status='pending' AND (newer.created_at,newer.id)>(proposal.created_at,proposal.id)
  ) THEN RAISE EXCEPTION 'image_proposal_relation_proposal_changed'; END IF;
  SELECT session_sequence INTO requirement_sequence FROM public.chat_messages
    WHERE id=proposal.requirement_message_id AND session_id=p_session AND role='user';
  IF requirement_sequence IS NULL THEN RAISE EXCEPTION 'image_proposal_relation_proposal_invalid'; END IF;
  IF jsonb_typeof(p_relations)<>'array' OR jsonb_array_length(p_relations)>16 THEN
    RAISE EXCEPTION 'image_proposal_relation_invalid';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_relations)) <>
     (SELECT count(DISTINCT value->>'message_id') FROM jsonb_array_elements(p_relations)) THEN
    RAISE EXCEPTION 'image_proposal_relation_invalid';
  END IF;

  FOR entry IN SELECT value FROM jsonb_array_elements(p_relations) LOOP
    relation_value:=entry->>'relation';
    IF relation_value NOT IN ('preserve','invalidate') THEN RAISE EXCEPTION 'image_proposal_relation_invalid'; END IF;
    SELECT * INTO message FROM public.chat_messages candidate
      WHERE candidate.id=(entry->>'message_id')::uuid AND candidate.session_id=p_session
        AND candidate.role='user' AND candidate.session_sequence>requirement_sequence
        AND candidate.session_sequence<=current_sequence
        AND NOT private.loomic_is_image_decision_message(candidate.content);
    IF message.id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.agent_runs source_run
      WHERE source_run.request_message_id=message.id AND source_run.request_prompt=message.content
        AND source_run.session_id=p_session AND source_run.created_by=p_user
    ) THEN RAISE EXCEPTION 'image_proposal_relation_message_invalid'; END IF;
    IF EXISTS (SELECT 1 FROM public.image_proposal_turn_relations existing
      WHERE existing.proposal_id=p_proposal AND existing.message_id=message.id
        AND existing.relation<>relation_value) THEN
      RAISE EXCEPTION 'image_proposal_relation_conflict';
    END IF;
    INSERT INTO public.image_proposal_turn_relations(
      proposal_id,message_id,session_id,canvas_id,created_by,classified_by_run_id,relation
    ) VALUES(p_proposal,message.id,p_session,p_canvas,p_user,p_run,relation_value)
    ON CONFLICT (proposal_id,message_id) DO NOTHING;
  END LOOP;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.loomic_get_current_image_proposal(p_session uuid,p_canvas uuid,p_run uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' STABLE AS $$
DECLARE current_sequence bigint; proposal public.image_generation_proposals; BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.chat_sessions session JOIN public.canvases canvas ON canvas.id=session.canvas_id
    WHERE session.id=p_session AND session.canvas_id=p_canvas AND session.created_by=auth.uid()
      AND EXISTS (SELECT 1 FROM public.workspace_members member WHERE member.workspace_id=canvas.workspace_id AND member.user_id=auth.uid())
  ) THEN RAISE EXCEPTION 'image_session_forbidden'; END IF;
  SELECT message.session_sequence INTO current_sequence
  FROM public.agent_runs run JOIN public.chat_messages message ON message.id=run.request_message_id
  WHERE run.id=p_run AND run.session_id=p_session AND run.created_by=auth.uid()
    AND message.session_id=p_session AND message.role='user' AND message.content=run.request_prompt;
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
        AND NOT private.loomic_image_turn_preserves_proposal(candidate.id,intervening)
    )
  ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 1;
  RETURN CASE WHEN proposal.id IS NULL THEN NULL ELSE to_jsonb(proposal) END;
END $$;

CREATE OR REPLACE FUNCTION public.loomic_decide_current_image(p_id uuid,p_session uuid,p_canvas uuid,p_run uuid,p_decision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE proposal public.image_generation_proposals; current_id uuid; current_content text;
  current_sequence bigint; latest_id uuid; requirement_sequence bigint; BEGIN
  PERFORM 1 FROM public.chat_sessions session JOIN public.canvases canvas ON canvas.id=session.canvas_id
    WHERE session.id=p_session AND session.canvas_id=p_canvas AND session.created_by=auth.uid()
      AND EXISTS (SELECT 1 FROM public.workspace_members member WHERE member.workspace_id=canvas.workspace_id AND member.user_id=auth.uid())
    FOR UPDATE OF session;
  IF NOT FOUND THEN RAISE EXCEPTION 'image_session_forbidden'; END IF;
  IF p_decision NOT IN ('confirm','cancel') THEN RAISE EXCEPTION 'invalid_decision'; END IF;
  SELECT message.id,message.content,message.session_sequence INTO current_id,current_content,current_sequence
  FROM public.agent_runs run JOIN public.chat_messages message ON message.id=run.request_message_id
  WHERE run.id=p_run AND run.session_id=p_session AND run.created_by=auth.uid()
    AND message.session_id=p_session AND message.role='user' AND message.content=run.request_prompt;
  IF current_id IS NULL THEN RETURN NULL; END IF;
  IF ((p_decision='confirm' AND NOT private.loomic_is_image_confirmation_message(current_content)
      AND NOT private.loomic_is_combined_current_image_confirmation(current_content))
      AND NOT EXISTS (SELECT 1 FROM public.image_contextual_confirmation_bindings binding
        WHERE binding.proposal_id=p_id AND binding.message_id=current_id AND binding.run_id=p_run
          AND binding.session_id=p_session AND binding.canvas_id=p_canvas AND binding.created_by=auth.uid()))
    OR (p_decision='cancel' AND NOT private.loomic_is_image_cancellation_message(current_content)) THEN RETURN NULL; END IF;
  SELECT candidate.* INTO proposal FROM public.image_generation_proposals candidate
  JOIN public.chat_messages requirement ON requirement.id=candidate.requirement_message_id
  WHERE candidate.id=p_id AND candidate.session_id=p_session AND candidate.canvas_id=p_canvas
    AND candidate.created_by=auth.uid() AND requirement.session_id=p_session AND requirement.role='user'
  FOR UPDATE OF candidate;
  IF proposal.id IS NOT NULL THEN SELECT session_sequence INTO requirement_sequence
    FROM public.chat_messages WHERE id=proposal.requirement_message_id; END IF;
  IF proposal.id IS NULL OR requirement_sequence>current_sequence THEN RETURN NULL; END IF;
  IF p_decision='confirm' AND NOT (
    private.loomic_image_confirmation_matches_proposal(current_content,proposal.input)
    OR (private.loomic_is_combined_current_image_confirmation(current_content)
      AND proposal.origin_run_id=p_run AND proposal.requirement_message_id=current_id)
    OR EXISTS (SELECT 1 FROM public.image_contextual_confirmation_bindings binding
      WHERE binding.proposal_id=proposal.id AND binding.message_id=current_id AND binding.run_id=p_run
        AND binding.session_id=p_session AND binding.canvas_id=p_canvas AND binding.created_by=auth.uid())
  ) THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.chat_messages intervening
    WHERE intervening.session_id=p_session AND intervening.role='user'
      AND intervening.session_sequence>requirement_sequence
      AND NOT private.loomic_image_turn_preserves_proposal(proposal.id,intervening)) THEN RETURN NULL; END IF;
  SELECT candidate.id INTO latest_id FROM public.image_generation_proposals candidate
  JOIN public.chat_messages candidate_requirement ON candidate_requirement.id=candidate.requirement_message_id
  WHERE candidate.session_id=p_session AND candidate.canvas_id=p_canvas
    AND candidate.created_by=auth.uid() AND candidate.status IN ('pending','confirmed')
    AND candidate_requirement.session_id=p_session AND candidate_requirement.role='user'
    AND candidate_requirement.session_sequence<=current_sequence
    AND NOT EXISTS (SELECT 1 FROM public.chat_messages intervening
      WHERE intervening.session_id=p_session AND intervening.role='user'
        AND intervening.session_sequence>candidate_requirement.session_sequence
        AND NOT private.loomic_image_turn_preserves_proposal(candidate.id,intervening))
  ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 1;
  IF latest_id IS DISTINCT FROM proposal.id THEN RETURN NULL; END IF;
  IF proposal.status='confirmed' AND p_decision='confirm' THEN RETURN to_jsonb(proposal); END IF;
  IF proposal.status<>'pending' OR proposal.expires_at<=now() THEN RETURN NULL; END IF;
  IF p_decision='confirm' AND proposal.origin_run_id=p_run
    AND (proposal.requirement_message_id IS DISTINCT FROM current_id
      OR NOT (private.loomic_is_image_confirmation_message(current_content)
        OR (private.loomic_is_combined_current_image_confirmation(current_content)
          AND proposal.requirement_message_id=current_id))) THEN
    RAISE EXCEPTION 'confirmation_requires_new_turn';
  END IF;
  UPDATE public.image_generation_proposals SET status=CASE WHEN p_decision='confirm' THEN 'confirmed' ELSE 'canceled' END
    WHERE id=p_id RETURNING * INTO proposal;
  RETURN to_jsonb(proposal);
END $$;

REVOKE ALL ON FUNCTION private.loomic_image_turn_preserves_proposal(uuid,public.chat_messages),
  public.loomic_get_image_proposal_relation_context(uuid,uuid,uuid,uuid),
  public.loomic_record_image_proposal_turn_relations(uuid,uuid,uuid,uuid,uuid,jsonb),
  public.loomic_bind_contextual_image_confirmation(uuid,uuid,uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_get_image_proposal_relation_context(uuid,uuid,uuid,uuid),
  public.loomic_record_image_proposal_turn_relations(uuid,uuid,uuid,uuid,uuid,jsonb),
  public.loomic_bind_contextual_image_confirmation(uuid,uuid,uuid,uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.loomic_get_current_image_proposal(uuid,uuid,uuid),
  public.loomic_decide_current_image(uuid,uuid,uuid,uuid,text) TO authenticated;

NOTIFY pgrst, 'reload schema';
