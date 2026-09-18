-- A pure confirmation of the current frozen task is not a new design intent.
-- Preserve an existing grant, never create/revive one or authorize billing here.
CREATE FUNCTION private.loomic_is_current_task_confirmation(p_run public.agent_runs)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT private.loomic_is_image_confirmation_message(p_run.request_prompt)
    AND EXISTS (
      SELECT 1 FROM public.agent_design_tasks t
      JOIN public.image_generation_proposals p ON p.origin_run_id=t.current_run_id
      JOIN public.chat_messages requirement ON requirement.id=p.requirement_message_id
      JOIN public.chat_messages request ON request.id=p_run.request_message_id
      WHERE t.session_id=p_run.session_id AND t.created_by=p_run.created_by
        AND p.created_by=p_run.created_by AND p.session_id=t.session_id AND p.canvas_id=t.canvas_id
        AND p.status IN ('pending','confirmed') AND p.expires_at>now()
        AND requirement.session_id=t.session_id AND requirement.role='user'
        AND request.session_id=t.session_id AND request.role='user' AND request.content=p_run.request_prompt
        AND request.session_sequence>requirement.session_sequence
        AND NOT EXISTS (SELECT 1 FROM public.chat_messages m WHERE m.session_id=t.session_id AND m.role='user'
          AND m.session_sequence>requirement.session_sequence AND m.id<>request.id
          AND (m.session_sequence>request.session_sequence OR NOT private.loomic_is_image_confirmation_message(m.content)))
    );
$$;
REVOKE ALL ON FUNCTION private.loomic_is_current_task_confirmation(public.agent_runs) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.loomic_supersede_continuations_on_new_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.created_by IS NULL THEN RETURN NEW; END IF;
 PERFORM 1 FROM public.chat_sessions WHERE id=NEW.session_id AND created_by=NEW.created_by FOR UPDATE;
 PERFORM 1 FROM public.agent_design_tasks WHERE session_id=NEW.session_id AND created_by=NEW.created_by FOR UPDATE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF private.loomic_is_current_task_confirmation(NEW) THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.agent_task_autonomy WHERE session_id=NEW.session_id AND created_by=NEW.created_by
   AND state='running' AND enabled AND internal_run_id=NEW.id AND lease_until>now()) THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.agent_task_continuations WHERE continuation_run_id=NEW.id AND status='running') THEN
   UPDATE public.agent_task_autonomy SET state='stopped',claim_token=NULL,updated_at=now() WHERE session_id=NEW.session_id AND created_by=NEW.created_by;
 END IF;
 UPDATE public.agent_task_continuations SET status='superseded',completed_at=now(),outcome=jsonb_build_object('reason','new_user_run','runId',NEW.id)
   WHERE session_id=NEW.session_id AND created_by=NEW.created_by AND status IN ('pending','running') AND continuation_run_id IS DISTINCT FROM NEW.id;
 RETURN NEW;
END $$;
NOTIFY pgrst,'reload schema';
