-- Contextual, typo-tolerant image-generation intent is classified by the
-- server's bounded workspace model. SQL remains the sole authority for actor,
-- message, proposal, current-run, immutable-input and race checks.

ALTER TABLE public.image_contextual_confirmation_bindings
  ADD COLUMN semantic_decision text
    CHECK (semantic_decision IN ('confirm_existing','confirm_current_run'));

CREATE OR REPLACE FUNCTION private.loomic_image_turn_preserves_proposal(
  p_proposal uuid,
  p_message public.chat_messages
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT private.loomic_is_image_decision_message(p_message.content)
    OR regexp_replace(lower(btrim(COALESCE(p_message.content,''))), '[，。！!,.[:space:]]', '', 'g')='确认'
    OR EXISTS (SELECT 1 FROM public.image_contextual_confirmation_bindings binding
      WHERE binding.proposal_id=p_proposal AND binding.message_id=p_message.id
        AND (binding.assistant_message_id IS NOT NULL OR binding.semantic_decision IS NOT NULL))
    OR EXISTS (
      SELECT 1 FROM public.image_proposal_turn_relations relation
      WHERE relation.proposal_id=p_proposal
        AND relation.message_id=p_message.id
        AND relation.session_id=p_message.session_id
        AND relation.relation='preserve'
    )
$$;

CREATE FUNCTION public.loomic_get_semantic_image_confirmation_review(
  p_user uuid,p_session uuid,p_canvas uuid,p_run uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' STABLE AS $$
DECLARE current_message public.chat_messages; proposal public.image_generation_proposals;
  requirement_sequence bigint; recent_messages jsonb; trusted_invitation boolean;
  current_job_status text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.chat_sessions session
    JOIN public.canvases canvas ON canvas.id=session.canvas_id
    WHERE session.id=p_session AND session.canvas_id=p_canvas AND session.created_by=p_user
      AND EXISTS (SELECT 1 FROM public.workspace_members member
        WHERE member.workspace_id=canvas.workspace_id AND member.user_id=p_user)
  ) THEN RAISE EXCEPTION 'image_semantic_intent_forbidden'; END IF;

  SELECT message.* INTO current_message FROM public.agent_runs run
  JOIN public.chat_messages message ON message.id=run.request_message_id
  WHERE run.id=p_run AND run.session_id=p_session AND run.created_by=p_user
    AND message.session_id=p_session AND message.role='user' AND message.content=run.request_prompt;
  IF current_message.id IS NULL THEN RAISE EXCEPTION 'image_semantic_intent_run_invalid'; END IF;

  -- Load the actual latest proposal preceding this message. The current turn
  -- is intentionally not used to select it: it may be a revision that should
  -- authorize only a newly frozen proposal from this exact run.
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

  SELECT EXISTS (
    SELECT 1 FROM public.chat_messages marker_message
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(marker_message.content_blocks,'[]'::jsonb)) block
    JOIN public.tool_executions execution ON execution.run_id=proposal.origin_run_id
      AND execution.requested_by=p_user AND execution.tool_name='generate_image'
      AND execution.status='completed' AND execution.tool_call_id=block->>'toolCallId'
    WHERE marker_message.session_id=p_session AND marker_message.role='assistant'
      AND marker_message.session_sequence>=requirement_sequence
      AND marker_message.session_sequence<current_message.session_sequence
      AND block->>'type'='tool' AND block->>'toolName'='generate_image' AND block->>'status'='completed'
      AND block->'output'->>'status'='awaiting_confirmation'
      AND block->'output'->'confirmation'->>'confirmationId'=proposal.id::text
      AND execution.output->>'status'='awaiting_confirmation'
      AND execution.output->'confirmation'->>'confirmationId'=proposal.id::text
  ) INTO trusted_invitation;
  IF NOT trusted_invitation THEN RETURN NULL; END IF;

  SELECT job.status INTO current_job_status FROM public.background_jobs job
    WHERE job.id=proposal.id AND job.created_by=p_user;
  WITH recent AS (
    SELECT message.role,message.content,message.session_sequence
    FROM public.chat_messages message
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
      'jobStatus',current_job_status,'hasTrustedInvitation',trusted_invitation)),
    'recentDialogue',recent_messages
  );
END $$;

-- Bind an existing proposal only after the reviewer has returned the enum.
-- The model never supplied p_proposal: it came from the context above and is
-- revalidated under the same session lock.
CREATE FUNCTION public.loomic_bind_reviewed_semantic_image_confirmation(
  p_user uuid,p_session uuid,p_canvas uuid,p_run uuid,p_proposal uuid
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE current_message public.chat_messages; proposal public.image_generation_proposals;
  requirement_sequence bigint; latest_id uuid;
BEGIN
  PERFORM 1 FROM public.chat_sessions session
  JOIN public.canvases canvas ON canvas.id=session.canvas_id
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
  IF proposal.id IS NULL THEN RETURN NULL; END IF;
  SELECT session_sequence INTO requirement_sequence FROM public.chat_messages
    WHERE id=proposal.requirement_message_id AND session_id=p_session AND role='user';
  IF NOT EXISTS (
    SELECT 1 FROM public.chat_messages marker_message
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(marker_message.content_blocks,'[]'::jsonb)) block
    JOIN public.tool_executions execution ON execution.run_id=proposal.origin_run_id
      AND execution.requested_by=p_user AND execution.tool_name='generate_image'
      AND execution.status='completed' AND execution.tool_call_id=block->>'toolCallId'
    WHERE marker_message.session_id=p_session AND marker_message.role='assistant'
      AND marker_message.session_sequence>=requirement_sequence
      AND marker_message.session_sequence<current_message.session_sequence
      AND block->>'type'='tool' AND block->>'toolName'='generate_image' AND block->>'status'='completed'
      AND block->'output'->>'status'='awaiting_confirmation'
      AND block->'output'->'confirmation'->>'confirmationId'=proposal.id::text
      AND execution.output->>'status'='awaiting_confirmation'
      AND execution.output->'confirmation'->>'confirmationId'=proposal.id::text
  ) THEN RETURN NULL; END IF;
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

-- After generate_image freezes the revised input, load that exact immutable
-- current-run proposal for a second bounded review. This prevents the earlier
-- proposal from standing in for the actual modified input.
CREATE FUNCTION public.loomic_get_semantic_current_run_image_confirmation_review(
  p_user uuid,p_session uuid,p_canvas uuid,p_run uuid,p_proposal uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' STABLE AS $$
DECLARE current_message public.chat_messages; proposal public.image_generation_proposals;
  recent_messages jsonb; current_job_status text;
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
  IF current_message.id IS NULL THEN RETURN NULL; END IF;
  SELECT candidate.* INTO proposal FROM public.image_generation_proposals candidate
  WHERE candidate.id=p_proposal AND candidate.session_id=p_session AND candidate.canvas_id=p_canvas
    AND candidate.created_by=p_user AND candidate.origin_run_id=p_run
    AND candidate.requirement_message_id=current_message.id AND candidate.status='pending'
    AND candidate.expires_at>now()
    AND NOT EXISTS (SELECT 1 FROM public.image_generation_proposals newer
      WHERE newer.session_id=p_session AND newer.canvas_id=p_canvas AND newer.created_by=p_user
        AND (newer.created_at,newer.id)>(candidate.created_at,candidate.id));
  IF proposal.id IS NULL THEN RETURN NULL; END IF;
  SELECT job.status INTO current_job_status FROM public.background_jobs job
    WHERE job.id=proposal.id AND job.created_by=p_user;
  WITH recent AS (
    SELECT message.role,message.content,message.session_sequence
    FROM public.chat_messages message
    WHERE message.session_id=p_session AND message.role IN ('user','assistant')
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
    'recentDialogue',recent_messages
  );
END $$;

CREATE FUNCTION public.loomic_bind_reviewed_semantic_current_run_image_confirmation(
  p_user uuid,p_session uuid,p_canvas uuid,p_run uuid,p_proposal uuid
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE current_message public.chat_messages; proposal public.image_generation_proposals;
BEGIN
  PERFORM 1 FROM public.chat_sessions session
  JOIN public.canvases canvas ON canvas.id=session.canvas_id
  WHERE session.id=p_session AND session.canvas_id=p_canvas AND session.created_by=p_user
    AND EXISTS (SELECT 1 FROM public.workspace_members member
      WHERE member.workspace_id=canvas.workspace_id AND member.user_id=p_user)
  FOR UPDATE OF session;
  IF NOT FOUND THEN RAISE EXCEPTION 'image_semantic_intent_forbidden'; END IF;
  SELECT message.* INTO current_message FROM public.agent_runs run
  JOIN public.chat_messages message ON message.id=run.request_message_id
  WHERE run.id=p_run AND run.session_id=p_session AND run.created_by=p_user
    AND message.session_id=p_session AND message.role='user' AND message.content=run.request_prompt;
  IF current_message.id IS NULL THEN RETURN NULL; END IF;
  SELECT candidate.* INTO proposal FROM public.image_generation_proposals candidate
  WHERE candidate.id=p_proposal AND candidate.session_id=p_session AND candidate.canvas_id=p_canvas
    AND candidate.created_by=p_user AND candidate.origin_run_id=p_run
    AND candidate.requirement_message_id=current_message.id AND candidate.status='pending'
    AND candidate.expires_at>now()
    AND NOT EXISTS (SELECT 1 FROM public.image_generation_proposals newer
      WHERE newer.session_id=p_session AND newer.canvas_id=p_canvas AND newer.created_by=p_user
        AND (newer.created_at,newer.id)>(candidate.created_at,candidate.id))
  FOR UPDATE OF candidate;
  IF proposal.id IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.image_contextual_confirmation_bindings(
    proposal_id,message_id,run_id,session_id,canvas_id,created_by,semantic_decision
  ) VALUES(proposal.id,current_message.id,p_run,p_session,p_canvas,p_user,'confirm_current_run')
  ON CONFLICT (message_id) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM public.image_contextual_confirmation_bindings binding
    WHERE binding.message_id=current_message.id AND binding.proposal_id=proposal.id AND binding.run_id=p_run
      AND binding.session_id=p_session AND binding.canvas_id=p_canvas AND binding.created_by=p_user
      AND binding.semantic_decision='confirm_current_run')
  THEN RAISE EXCEPTION 'image_semantic_intent_conflict'; END IF;
  RETURN proposal.id;
END $$;

CREATE OR REPLACE FUNCTION public.loomic_decide_current_image(p_id uuid,p_session uuid,p_canvas uuid,p_run uuid,p_decision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE proposal public.image_generation_proposals; current_id uuid; current_content text;
  current_sequence bigint; latest_id uuid; requirement_sequence bigint; semantic_scope text; BEGIN
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
  SELECT binding.semantic_decision INTO semantic_scope FROM public.image_contextual_confirmation_bindings binding
    WHERE binding.proposal_id=p_id AND binding.message_id=current_id AND binding.run_id=p_run
      AND binding.session_id=p_session AND binding.canvas_id=p_canvas AND binding.created_by=auth.uid();
  IF (p_decision='confirm' AND NOT private.loomic_is_image_confirmation_message(current_content)
      AND NOT private.loomic_is_combined_current_image_confirmation(current_content) AND semantic_scope IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.image_contextual_confirmation_bindings binding
        WHERE binding.proposal_id=p_id AND binding.message_id=current_id AND binding.run_id=p_run
          AND binding.session_id=p_session AND binding.canvas_id=p_canvas AND binding.created_by=auth.uid()
          AND binding.assistant_message_id IS NOT NULL))
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
    OR semantic_scope IN ('confirm_existing','confirm_current_run')
    OR EXISTS (SELECT 1 FROM public.image_contextual_confirmation_bindings binding
      WHERE binding.proposal_id=proposal.id AND binding.message_id=current_id AND binding.run_id=p_run
        AND binding.session_id=p_session AND binding.canvas_id=p_canvas AND binding.created_by=auth.uid()
        AND binding.assistant_message_id IS NOT NULL)
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
          AND proposal.requirement_message_id=current_id)
        OR semantic_scope='confirm_current_run')) THEN
    RAISE EXCEPTION 'confirmation_requires_new_turn';
  END IF;
  IF semantic_scope='confirm_existing' AND proposal.requirement_message_id=current_id THEN RETURN NULL; END IF;
  IF semantic_scope='confirm_current_run' AND
    (proposal.origin_run_id<>p_run OR proposal.requirement_message_id<>current_id) THEN RETURN NULL; END IF;
  UPDATE public.image_generation_proposals SET status=CASE WHEN p_decision='confirm' THEN 'confirmed' ELSE 'canceled' END
    WHERE id=p_id RETURNING * INTO proposal;
  RETURN to_jsonb(proposal);
END $$;

REVOKE ALL ON FUNCTION public.loomic_get_semantic_image_confirmation_review(uuid,uuid,uuid,uuid),
  public.loomic_bind_reviewed_semantic_image_confirmation(uuid,uuid,uuid,uuid,uuid),
  public.loomic_get_semantic_current_run_image_confirmation_review(uuid,uuid,uuid,uuid,uuid),
  public.loomic_bind_reviewed_semantic_current_run_image_confirmation(uuid,uuid,uuid,uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_get_semantic_image_confirmation_review(uuid,uuid,uuid,uuid),
  public.loomic_bind_reviewed_semantic_image_confirmation(uuid,uuid,uuid,uuid,uuid),
  public.loomic_get_semantic_current_run_image_confirmation_review(uuid,uuid,uuid,uuid,uuid),
  public.loomic_bind_reviewed_semantic_current_run_image_confirmation(uuid,uuid,uuid,uuid,uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.loomic_decide_current_image(uuid,uuid,uuid,uuid,text) TO authenticated;

NOTIFY pgrst, 'reload schema';
