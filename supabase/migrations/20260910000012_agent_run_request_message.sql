-- Older API clients do not send a userMessageId. Persist their exact request
-- and accepted run together rather than guessing an earlier matching prompt.
CREATE FUNCTION public.loomic_create_run_with_request(
  p_run uuid,p_session uuid,p_created_by uuid,p_thread text,
  p_model text,p_execution_mode text,p_prompt text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE message_id uuid; existing public.agent_runs; BEGIN
  PERFORM 1 FROM public.chat_sessions session
    JOIN public.canvases canvas ON canvas.id=session.canvas_id
    WHERE session.id=p_session AND session.created_by=p_created_by
      AND EXISTS (SELECT 1 FROM public.workspace_members member
        WHERE member.workspace_id=canvas.workspace_id AND member.user_id=p_created_by)
    FOR UPDATE OF session;
  IF NOT FOUND THEN RAISE EXCEPTION 'agent_run_request_session_forbidden'; END IF;
  IF p_prompt IS NULL OR length(btrim(p_prompt))=0 THEN
    RAISE EXCEPTION 'agent_run_request_prompt_required';
  END IF;
  SELECT * INTO existing FROM public.agent_runs WHERE id=p_run;
  IF FOUND THEN
    IF existing.session_id=p_session AND existing.created_by=p_created_by
      AND existing.request_prompt=p_prompt AND existing.thread_id=p_thread
      AND existing.model IS NOT DISTINCT FROM p_model
      AND existing.execution_mode=p_execution_mode AND existing.request_message_id IS NOT NULL THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'agent_run_request_conflict';
  END IF;
  INSERT INTO public.chat_messages(session_id,role,content,content_blocks)
    VALUES(p_session,'user',p_prompt,jsonb_build_array(jsonb_build_object('type','text','text',p_prompt)))
    RETURNING id INTO message_id;
  INSERT INTO public.agent_runs(id,session_id,created_by,thread_id,model,execution_mode,status,request_message_id,request_prompt)
    VALUES(p_run,p_session,p_created_by,p_thread,p_model,p_execution_mode,'accepted',message_id,p_prompt);
END $$;
REVOKE ALL ON FUNCTION public.loomic_create_run_with_request(uuid,uuid,uuid,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_create_run_with_request(uuid,uuid,uuid,text,text,text,text) TO service_role;
NOTIFY pgrst, 'reload schema';
