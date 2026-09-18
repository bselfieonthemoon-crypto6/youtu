-- The exact-proposal service RPC intentionally preserves proposal-id semantics,
-- but the supplied confirmation run must still be a real current-user turn in
-- the same session. This prevents an internal caller from using a random UUID
-- to satisfy only `origin_run_id <> p_run`.
CREATE OR REPLACE FUNCTION public.loomic_decide_image_service(
  p_id uuid,
  p_user uuid,
  p_session uuid,
  p_canvas uuid,
  p_run uuid,
  p_decision text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE proposal public.image_generation_proposals; BEGIN
  PERFORM 1 FROM public.chat_sessions s JOIN public.canvases c ON c.id=s.canvas_id
    WHERE s.id=p_session AND s.canvas_id=p_canvas AND s.created_by=p_user
      AND EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=c.workspace_id AND m.user_id=p_user)
    FOR UPDATE OF s;
  IF NOT FOUND THEN RAISE EXCEPTION 'image_session_forbidden'; END IF;

  PERFORM 1
  FROM public.agent_runs run
  JOIN public.chat_messages message ON message.id=run.request_message_id
    AND message.session_id=run.session_id AND message.role='user'
  WHERE run.id=p_run AND run.created_by=p_user AND run.session_id=p_session;
  IF NOT FOUND THEN RAISE EXCEPTION 'image_confirmation_run_forbidden'; END IF;

  SELECT * INTO proposal FROM public.image_generation_proposals
    WHERE id=p_id AND session_id=p_session AND canvas_id=p_canvas AND created_by=p_user FOR UPDATE;
  IF proposal.id IS NULL THEN RAISE EXCEPTION 'image_proposal_not_found'; END IF;
  IF p_decision NOT IN ('confirm','cancel') THEN RAISE EXCEPTION 'invalid_decision'; END IF;
  IF proposal.status='confirmed' AND p_decision='confirm' THEN RETURN to_jsonb(proposal); END IF;
  IF proposal.status<>'pending' OR proposal.expires_at<=now() THEN RAISE EXCEPTION 'image_proposal_unavailable'; END IF;
  IF p_decision='confirm' AND proposal.origin_run_id=p_run THEN RAISE EXCEPTION 'confirmation_requires_new_turn'; END IF;
  UPDATE public.image_generation_proposals SET status=CASE WHEN p_decision='confirm' THEN 'confirmed' ELSE 'canceled' END
    WHERE id=p_id RETURNING * INTO proposal;
  RETURN to_jsonb(proposal);
END $$;

REVOKE ALL ON FUNCTION public.loomic_decide_image_service(uuid,uuid,uuid,uuid,uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_decide_image_service(uuid,uuid,uuid,uuid,uuid,text)
  TO service_role;

NOTIFY pgrst,'reload schema';
