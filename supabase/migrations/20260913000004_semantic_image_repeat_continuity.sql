-- Preserve semantic confirmation continuity after a same-turn revised proposal
-- was submitted directly. The proof is not assistant prose: it is the exact
-- prior semantic binding, matching completed tool ledgers, and the real scoped
-- background job. Confirmed proposals remain subject to bounded per-turn
-- relation review; intervening user messages are never ignored wholesale.

CREATE FUNCTION private.loomic_has_trusted_image_proposal_evidence(
  p_proposal public.image_generation_proposals,
  p_user uuid,
  p_before_sequence bigint
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.chat_messages marker_message
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(marker_message.content_blocks,'[]'::jsonb)) block
    JOIN public.tool_executions execution ON execution.run_id=p_proposal.origin_run_id
      AND execution.requested_by=p_user AND execution.tool_name='generate_image'
      AND execution.status='completed' AND execution.tool_call_id=block->>'toolCallId'
    WHERE marker_message.session_id=p_proposal.session_id AND marker_message.role='assistant'
      AND marker_message.session_sequence>=(SELECT requirement.session_sequence
        FROM public.chat_messages requirement WHERE requirement.id=p_proposal.requirement_message_id)
      AND marker_message.session_sequence<p_before_sequence
      AND block->>'type'='tool' AND block->>'toolName'='generate_image' AND block->>'status'='completed'
      AND block->'output'->>'status'='awaiting_confirmation'
      AND block->'output'->'confirmation'->>'confirmationId'=p_proposal.id::text
      AND execution.output->>'status'='awaiting_confirmation'
      AND execution.output->'confirmation'->>'confirmationId'=p_proposal.id::text
  ) OR EXISTS (
    SELECT 1 FROM public.image_contextual_confirmation_bindings binding
    JOIN public.chat_messages authorization_message ON authorization_message.id=binding.message_id
      AND authorization_message.session_id=binding.session_id AND authorization_message.role='user'
    JOIN public.background_jobs job ON job.id=p_proposal.id AND job.created_by=p_user
      AND job.session_id=p_proposal.session_id AND job.canvas_id=p_proposal.canvas_id
    JOIN public.chat_messages result_message ON result_message.session_id=p_proposal.session_id
      AND result_message.role='assistant'
      AND result_message.session_sequence>authorization_message.session_sequence
      AND result_message.session_sequence<p_before_sequence
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(result_message.content_blocks,'[]'::jsonb)) block
    JOIN public.tool_executions execution ON execution.run_id=binding.run_id
      AND execution.requested_by=p_user AND execution.tool_name='generate_image'
      AND execution.status='completed' AND execution.tool_call_id=block->>'toolCallId'
    WHERE binding.proposal_id=p_proposal.id AND binding.run_id=p_proposal.origin_run_id
      AND binding.session_id=p_proposal.session_id AND binding.canvas_id=p_proposal.canvas_id
      AND binding.created_by=p_user AND binding.semantic_decision='confirm_current_run'
      AND authorization_message.id=p_proposal.requirement_message_id
      AND authorization_message.session_sequence<p_before_sequence
      AND block->>'type'='tool' AND block->>'toolName'='generate_image' AND block->>'status'='completed'
      AND block->'output'->>'jobId'=p_proposal.id::text
      AND execution.output->>'jobId'=p_proposal.id::text
  )
$$;

CREATE OR REPLACE FUNCTION public.loomic_get_image_proposal_relation_context(
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
  FROM public.agent_runs run JOIN public.chat_messages message ON message.id=run.request_message_id
  WHERE run.id=p_run AND run.session_id=p_session AND run.created_by=p_user
    AND message.session_id=p_session AND message.role='user' AND message.content=run.request_prompt;
  IF current_sequence IS NULL THEN RAISE EXCEPTION 'image_proposal_relation_run_invalid'; END IF;

  SELECT candidate.* INTO proposal FROM public.image_generation_proposals candidate
  JOIN public.chat_messages requirement ON requirement.id=candidate.requirement_message_id
  WHERE candidate.session_id=p_session AND candidate.canvas_id=p_canvas AND candidate.created_by=p_user
    AND candidate.status IN ('pending','confirmed')
    AND (candidate.status='pending' AND candidate.expires_at>now()
      OR candidate.status='confirmed' AND private.loomic_has_trusted_image_proposal_evidence(candidate,p_user,current_sequence+1))
    AND requirement.session_id=p_session AND requirement.role='user'
    AND requirement.session_sequence<=current_sequence
    AND NOT EXISTS (SELECT 1 FROM public.image_proposal_turn_relations prior
      JOIN public.chat_messages prior_message ON prior_message.id=prior.message_id
      WHERE prior.proposal_id=candidate.id AND prior.relation='invalidate'
        AND prior_message.session_sequence<=current_sequence)
  ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 1;
  IF proposal.id IS NULL THEN RETURN NULL; END IF;

  SELECT content INTO requirement_content FROM public.chat_messages WHERE id=proposal.requirement_message_id;
  SELECT count(*) INTO total_missing FROM public.chat_messages message
  WHERE message.session_id=p_session AND message.role='user'
    AND message.session_sequence>(SELECT session_sequence FROM public.chat_messages WHERE id=proposal.requirement_message_id)
    AND message.session_sequence<=current_sequence
    AND NOT private.loomic_is_image_decision_message(message.content)
    AND (message.id<>current_id OR regexp_replace(lower(btrim(COALESCE(message.content,''))),
      '[，。！!,.[:space:]]','','g')<>'确认')
    AND NOT EXISTS (SELECT 1 FROM public.image_proposal_turn_relations relation
      WHERE relation.proposal_id=proposal.id AND relation.message_id=message.id);
  WITH missing AS (
    SELECT message.* FROM public.chat_messages message
    WHERE message.session_id=p_session AND message.role='user'
      AND message.session_sequence>(SELECT session_sequence FROM public.chat_messages WHERE id=proposal.requirement_message_id)
      AND message.session_sequence<=current_sequence
      AND NOT private.loomic_is_image_decision_message(message.content)
      AND (message.id<>current_id OR regexp_replace(lower(btrim(COALESCE(message.content,''))),
        '[，。！!,.[:space:]]','','g')<>'确认')
      AND NOT EXISTS (SELECT 1 FROM public.image_proposal_turn_relations relation
        WHERE relation.proposal_id=proposal.id AND relation.message_id=message.id)
    ORDER BY message.session_sequence LIMIT 16
  )
  SELECT count(*),COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'id',message.id,'content',message.content,'precedingAssistant',(
        SELECT assistant.content FROM public.chat_messages assistant
        WHERE assistant.session_id=p_session AND assistant.role='assistant'
          AND assistant.session_sequence<message.session_sequence
        ORDER BY assistant.session_sequence DESC LIMIT 1)))
      ORDER BY message.session_sequence),'[]'::jsonb)
    INTO missing_count,turns FROM missing message;
  RETURN jsonb_build_object(
    'proposalId',proposal.id,'proposalInput',proposal.input,
    'requirement',jsonb_build_object('id',proposal.requirement_message_id,'content',requirement_content),
    'turns',turns,'hasMore',total_missing>missing_count);
END $$;

CREATE OR REPLACE FUNCTION public.loomic_record_image_proposal_turn_relations(
  p_user uuid,p_session uuid,p_canvas uuid,p_run uuid,p_proposal uuid,p_relations jsonb
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE proposal public.image_generation_proposals; current_sequence bigint;
  requirement_sequence bigint; entry jsonb; message public.chat_messages; relation_value text;
BEGIN
  PERFORM 1 FROM public.chat_sessions session JOIN public.canvases canvas ON canvas.id=session.canvas_id
  WHERE session.id=p_session AND session.canvas_id=p_canvas AND session.created_by=p_user
    AND EXISTS (SELECT 1 FROM public.workspace_members member
      WHERE member.workspace_id=canvas.workspace_id AND member.user_id=p_user)
  FOR UPDATE OF session;
  IF NOT FOUND THEN RAISE EXCEPTION 'image_proposal_relation_forbidden'; END IF;
  SELECT request_message.session_sequence INTO current_sequence
  FROM public.agent_runs run JOIN public.chat_messages request_message ON request_message.id=run.request_message_id
  WHERE run.id=p_run AND run.session_id=p_session AND run.created_by=p_user
    AND request_message.session_id=p_session AND request_message.role='user'
    AND request_message.content=run.request_prompt;
  IF current_sequence IS NULL THEN RAISE EXCEPTION 'image_proposal_relation_run_invalid'; END IF;

  SELECT candidate.* INTO proposal FROM public.image_generation_proposals candidate
  WHERE candidate.id=p_proposal AND candidate.session_id=p_session AND candidate.canvas_id=p_canvas
    AND candidate.created_by=p_user AND candidate.status IN ('pending','confirmed')
    AND (candidate.status='pending' AND candidate.expires_at>now()
      OR candidate.status='confirmed' AND private.loomic_has_trusted_image_proposal_evidence(candidate,p_user,current_sequence+1))
  FOR UPDATE;
  IF proposal.id IS NULL OR EXISTS (
    SELECT 1 FROM public.image_generation_proposals newer
    WHERE newer.session_id=p_session AND newer.canvas_id=p_canvas AND newer.created_by=p_user
      AND newer.status IN ('pending','confirmed')
      AND (newer.created_at,newer.id)>(proposal.created_at,proposal.id)
  ) THEN RAISE EXCEPTION 'image_proposal_relation_proposal_changed'; END IF;
  SELECT session_sequence INTO requirement_sequence FROM public.chat_messages
    WHERE id=proposal.requirement_message_id AND session_id=p_session AND role='user';
  IF requirement_sequence IS NULL THEN RAISE EXCEPTION 'image_proposal_relation_proposal_invalid'; END IF;
  IF jsonb_typeof(p_relations)<>'array' OR jsonb_array_length(p_relations)>16 THEN
    RAISE EXCEPTION 'image_proposal_relation_invalid'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_relations)) <>
     (SELECT count(DISTINCT value->>'message_id') FROM jsonb_array_elements(p_relations)) THEN
    RAISE EXCEPTION 'image_proposal_relation_invalid'; END IF;

  FOR entry IN SELECT value FROM jsonb_array_elements(p_relations) LOOP
    relation_value:=entry->>'relation';
    IF relation_value NOT IN ('preserve','invalidate') THEN RAISE EXCEPTION 'image_proposal_relation_invalid'; END IF;
    SELECT * INTO message FROM public.chat_messages candidate
    WHERE candidate.id=(entry->>'message_id')::uuid AND candidate.session_id=p_session
      AND candidate.role='user' AND candidate.session_sequence>requirement_sequence
      AND candidate.session_sequence<=current_sequence
      AND NOT private.loomic_is_image_decision_message(candidate.content);
    IF message.id IS NULL OR NOT EXISTS (SELECT 1 FROM public.agent_runs source_run
      WHERE source_run.request_message_id=message.id AND source_run.request_prompt=message.content
        AND source_run.session_id=p_session AND source_run.created_by=p_user)
    THEN RAISE EXCEPTION 'image_proposal_relation_message_invalid'; END IF;
    IF EXISTS (SELECT 1 FROM public.image_proposal_turn_relations existing
      WHERE existing.proposal_id=p_proposal AND existing.message_id=message.id
        AND existing.relation<>relation_value) THEN RAISE EXCEPTION 'image_proposal_relation_conflict'; END IF;
    INSERT INTO public.image_proposal_turn_relations(
      proposal_id,message_id,session_id,canvas_id,created_by,classified_by_run_id,relation
    ) VALUES(p_proposal,message.id,p_session,p_canvas,p_user,p_run,relation_value)
    ON CONFLICT (proposal_id,message_id) DO NOTHING;
  END LOOP;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.loomic_get_semantic_image_confirmation_review(
  p_user uuid,p_session uuid,p_canvas uuid,p_run uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' STABLE AS $$
DECLARE current_message public.chat_messages; proposal public.image_generation_proposals;
  requirement_sequence bigint; recent_messages jsonb; current_job_status text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.chat_sessions session
    JOIN public.canvases canvas ON canvas.id=session.canvas_id
    WHERE session.id=p_session AND session.canvas_id=p_canvas AND session.created_by=p_user
      AND EXISTS (SELECT 1 FROM public.workspace_members member
        WHERE member.workspace_id=canvas.workspace_id AND member.user_id=p_user))
  THEN RAISE EXCEPTION 'image_semantic_intent_forbidden'; END IF;
  SELECT message.* INTO current_message FROM public.agent_runs run
  JOIN public.chat_messages message ON message.id=run.request_message_id
  WHERE run.id=p_run AND run.session_id=p_session AND run.created_by=p_user
    AND message.session_id=p_session AND message.role='user' AND message.content=run.request_prompt;
  IF current_message.id IS NULL THEN RAISE EXCEPTION 'image_semantic_intent_run_invalid'; END IF;

  SELECT candidate.* INTO proposal FROM public.image_generation_proposals candidate
  JOIN public.chat_messages requirement ON requirement.id=candidate.requirement_message_id
  WHERE candidate.session_id=p_session AND candidate.canvas_id=p_canvas AND candidate.created_by=p_user
    AND candidate.status IN ('pending','confirmed')
    AND (candidate.status='confirmed' OR candidate.expires_at>now())
    AND requirement.session_id=p_session AND requirement.role='user'
    AND requirement.session_sequence<current_message.session_sequence
    AND NOT EXISTS (SELECT 1 FROM public.chat_messages intervening
      WHERE intervening.session_id=p_session AND intervening.role='user'
        AND intervening.session_sequence>requirement.session_sequence
        AND intervening.session_sequence<current_message.session_sequence
        AND NOT private.loomic_image_turn_preserves_proposal(candidate.id,intervening))
  ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 1;
  IF proposal.id IS NULL THEN RETURN NULL; END IF;
  SELECT session_sequence INTO requirement_sequence FROM public.chat_messages
    WHERE id=proposal.requirement_message_id AND session_id=p_session AND role='user';
  IF NOT private.loomic_has_trusted_image_proposal_evidence(proposal,p_user,current_message.session_sequence)
  THEN RETURN NULL; END IF;

  SELECT job.status INTO current_job_status FROM public.background_jobs job
    WHERE job.id=proposal.id AND job.created_by=p_user
      AND job.session_id=p_session AND job.canvas_id=p_canvas;
  WITH recent AS (
    SELECT message.role,message.content,message.session_sequence FROM public.chat_messages message
    WHERE message.session_id=p_session AND message.role IN ('user','assistant')
      AND message.session_sequence>=requirement_sequence
      AND message.session_sequence<current_message.session_sequence
    ORDER BY message.session_sequence DESC LIMIT 16
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('role',recent.role,
      'content',left(COALESCE(recent.content,''),4001)) ORDER BY recent.session_sequence),'[]'::jsonb)
    INTO recent_messages FROM recent;
  RETURN jsonb_build_object(
    'currentMessage',jsonb_build_object('id',current_message.id,'content',current_message.content),
    'proposal',jsonb_strip_nulls(jsonb_build_object(
      'id',proposal.id,'status',proposal.status,'title',left(COALESCE(proposal.input->>'title',''),500),
      'prompt',left(COALESCE(proposal.input->>'prompt',''),2000),
      'aspectRatio',proposal.input->>'aspectRatio','operation',proposal.input->>'operation',
      'outputFormat',proposal.input->>'outputFormat',
      'inputImageCount',CASE WHEN jsonb_typeof(proposal.input->'inputImages')='array'
        THEN jsonb_array_length(proposal.input->'inputImages') ELSE 0 END,
      'jobStatus',current_job_status,'hasTrustedInvitation',true)),
    'recentDialogue',recent_messages);
END $$;

CREATE OR REPLACE FUNCTION public.loomic_bind_reviewed_semantic_image_confirmation(
  p_user uuid,p_session uuid,p_canvas uuid,p_run uuid,p_proposal uuid
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE current_message public.chat_messages; proposal public.image_generation_proposals; latest_id uuid;
BEGIN
  PERFORM 1 FROM public.chat_sessions session JOIN public.canvases canvas ON canvas.id=session.canvas_id
  WHERE session.id=p_session AND session.canvas_id=p_canvas AND session.created_by=p_user
    AND EXISTS (SELECT 1 FROM public.workspace_members member
      WHERE member.workspace_id=canvas.workspace_id AND member.user_id=p_user)
  FOR UPDATE OF session;
  IF NOT FOUND THEN RAISE EXCEPTION 'image_semantic_intent_forbidden'; END IF;
  SELECT message.* INTO current_message FROM public.agent_runs run
  JOIN public.chat_messages message ON message.id=run.request_message_id
  WHERE run.id=p_run AND run.session_id=p_session AND run.created_by=p_user
    AND message.session_id=p_session AND message.role='user' AND message.content=run.request_prompt;
  IF current_message.id IS NULL THEN RAISE EXCEPTION 'image_semantic_intent_run_invalid'; END IF;

  SELECT candidate.* INTO proposal FROM public.image_generation_proposals candidate
  JOIN public.chat_messages requirement ON requirement.id=candidate.requirement_message_id
  WHERE candidate.id=p_proposal AND candidate.session_id=p_session AND candidate.canvas_id=p_canvas
    AND candidate.created_by=p_user AND candidate.status IN ('pending','confirmed')
    AND (candidate.status='confirmed' OR candidate.expires_at>now())
    AND requirement.session_id=p_session AND requirement.role='user'
    AND requirement.session_sequence<current_message.session_sequence
    AND NOT EXISTS (SELECT 1 FROM public.chat_messages intervening
      WHERE intervening.session_id=p_session AND intervening.role='user'
        AND intervening.session_sequence>requirement.session_sequence
        AND intervening.session_sequence<current_message.session_sequence
        AND NOT private.loomic_image_turn_preserves_proposal(candidate.id,intervening))
  FOR UPDATE OF candidate;
  IF proposal.id IS NULL OR NOT private.loomic_has_trusted_image_proposal_evidence(
    proposal,p_user,current_message.session_sequence) THEN RETURN NULL; END IF;
  SELECT candidate.id INTO latest_id FROM public.image_generation_proposals candidate
  JOIN public.chat_messages requirement ON requirement.id=candidate.requirement_message_id
  WHERE candidate.session_id=p_session AND candidate.canvas_id=p_canvas AND candidate.created_by=p_user
    AND candidate.status IN ('pending','confirmed') AND (candidate.status='confirmed' OR candidate.expires_at>now())
    AND requirement.session_id=p_session AND requirement.role='user'
    AND requirement.session_sequence<current_message.session_sequence
    AND NOT EXISTS (SELECT 1 FROM public.chat_messages intervening
      WHERE intervening.session_id=p_session AND intervening.role='user'
        AND intervening.session_sequence>requirement.session_sequence
        AND intervening.session_sequence<current_message.session_sequence
        AND NOT private.loomic_image_turn_preserves_proposal(candidate.id,intervening))
  ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 1;
  IF latest_id IS DISTINCT FROM proposal.id THEN RETURN NULL; END IF;
  INSERT INTO public.image_contextual_confirmation_bindings(
    proposal_id,message_id,run_id,session_id,canvas_id,created_by,semantic_decision
  ) VALUES(proposal.id,current_message.id,p_run,p_session,p_canvas,p_user,'confirm_existing')
  ON CONFLICT (message_id) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM public.image_contextual_confirmation_bindings binding
    WHERE binding.message_id=current_message.id AND binding.proposal_id=proposal.id AND binding.run_id=p_run
      AND binding.session_id=p_session AND binding.canvas_id=p_canvas AND binding.created_by=p_user
      AND binding.semantic_decision='confirm_existing')
  THEN RAISE EXCEPTION 'image_semantic_intent_conflict'; END IF;
  RETURN proposal.id;
END $$;

REVOKE ALL ON FUNCTION private.loomic_has_trusted_image_proposal_evidence(
    public.image_generation_proposals,uuid,bigint),
  public.loomic_get_image_proposal_relation_context(uuid,uuid,uuid,uuid),
  public.loomic_record_image_proposal_turn_relations(uuid,uuid,uuid,uuid,uuid,jsonb),
  public.loomic_get_semantic_image_confirmation_review(uuid,uuid,uuid,uuid),
  public.loomic_bind_reviewed_semantic_image_confirmation(uuid,uuid,uuid,uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_get_image_proposal_relation_context(uuid,uuid,uuid,uuid),
  public.loomic_record_image_proposal_turn_relations(uuid,uuid,uuid,uuid,uuid,jsonb),
  public.loomic_get_semantic_image_confirmation_review(uuid,uuid,uuid,uuid),
  public.loomic_bind_reviewed_semantic_image_confirmation(uuid,uuid,uuid,uuid,uuid)
  TO service_role;

NOTIFY pgrst, 'reload schema';
