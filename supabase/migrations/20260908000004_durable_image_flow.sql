-- Durable, session-scoped image proposals. No API keys or access tokens are stored.
CREATE TABLE public.image_generation_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  canvas_id uuid NOT NULL REFERENCES public.canvases(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  origin_run_id uuid NOT NULL,
  input jsonb NOT NULL,
  details jsonb NOT NULL,
  approved_cost integer CHECK (approved_cost>=0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','canceled','superseded')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX image_proposal_session_idx ON public.image_generation_proposals(session_id,created_at DESC);
ALTER TABLE public.image_generation_proposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.image_generation_proposals FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.image_generation_proposals TO authenticated;
GRANT ALL ON public.image_generation_proposals TO service_role;
CREATE POLICY image_proposal_read ON public.image_generation_proposals FOR SELECT TO authenticated
USING (created_by=auth.uid() AND EXISTS (SELECT 1 FROM public.canvases c WHERE c.id=canvas_id));

CREATE FUNCTION public.loomic_propose_image(p_session uuid,p_canvas uuid,p_run uuid,p_input jsonb,p_details jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE proposal public.image_generation_proposals; BEGIN
  -- Lock the session to serialize revisions and confirmation on all instances.
  PERFORM 1 FROM public.chat_sessions s JOIN public.canvases c ON c.id=s.canvas_id
    WHERE s.id=p_session AND s.canvas_id=p_canvas AND s.created_by=auth.uid()
      AND EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=c.workspace_id AND m.user_id=auth.uid())
    FOR UPDATE OF s;
  IF NOT FOUND THEN RAISE EXCEPTION 'image_session_forbidden'; END IF;
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR length(p_input->>'prompt')<1
    OR p_input ? 'proposalId' THEN RAISE EXCEPTION 'image_proposal_invalid'; END IF;
  UPDATE public.image_generation_proposals SET status='superseded'
    WHERE session_id=p_session AND created_by=auth.uid() AND status='pending';
  INSERT INTO public.image_generation_proposals(session_id,canvas_id,created_by,origin_run_id,input,details)
    VALUES(p_session,p_canvas,auth.uid(),p_run,p_input,p_details) RETURNING * INTO proposal;
  RETURN to_jsonb(proposal);
END $$;

CREATE FUNCTION public.loomic_decide_image(p_id uuid,p_session uuid,p_canvas uuid,p_run uuid,p_decision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE proposal public.image_generation_proposals; BEGIN
  PERFORM 1 FROM public.chat_sessions s JOIN public.canvases c ON c.id=s.canvas_id
    WHERE s.id=p_session AND s.canvas_id=p_canvas AND s.created_by=auth.uid()
      AND EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=c.workspace_id AND m.user_id=auth.uid())
    FOR UPDATE OF s;
  IF NOT FOUND THEN RAISE EXCEPTION 'image_session_forbidden'; END IF;
  SELECT * INTO proposal FROM public.image_generation_proposals
    WHERE id=p_id AND session_id=p_session AND canvas_id=p_canvas AND created_by=auth.uid() FOR UPDATE;
  IF proposal.id IS NULL THEN RAISE EXCEPTION 'image_proposal_not_found'; END IF;
  IF p_decision NOT IN ('confirm','cancel') THEN RAISE EXCEPTION 'invalid_decision'; END IF;
  IF proposal.status='confirmed' AND p_decision='confirm' THEN RETURN to_jsonb(proposal); END IF;
  IF proposal.status<>'pending' OR proposal.expires_at<=now() THEN RAISE EXCEPTION 'image_proposal_unavailable'; END IF;
  IF p_decision='confirm' AND proposal.origin_run_id=p_run THEN RAISE EXCEPTION 'confirmation_requires_new_turn'; END IF;
  UPDATE public.image_generation_proposals SET status=CASE WHEN p_decision='confirm' THEN 'confirmed' ELSE 'canceled' END
    WHERE id=p_id RETURNING * INTO proposal;
  RETURN to_jsonb(proposal);
END $$;
REVOKE ALL ON FUNCTION public.loomic_propose_image(uuid,uuid,uuid,jsonb,jsonb),public.loomic_decide_image(uuid,uuid,uuid,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.loomic_propose_image(uuid,uuid,uuid,jsonb,jsonb),public.loomic_decide_image(uuid,uuid,uuid,uuid,text) TO authenticated;

-- The proposal UUID is also the task UUID. A retry cannot create another task.
ALTER TABLE public.background_jobs ADD COLUMN image_enqueued_at timestamptz;
CREATE FUNCTION public.loomic_prepare_image_submission(p_id uuid,p_user uuid,p_session uuid,p_cost integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF p_cost IS NULL OR p_cost<0 THEN RAISE EXCEPTION 'image_price_invalid'; END IF;
  UPDATE public.image_generation_proposals SET approved_cost=COALESCE(approved_cost,p_cost)
    WHERE id=p_id AND created_by=p_user AND session_id=p_session AND status='confirmed';
  IF NOT FOUND THEN RAISE EXCEPTION 'image_proposal_not_confirmed'; END IF;
END $$;
CREATE FUNCTION public.loomic_commit_image_job(p_job uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j public.background_jobs; cost integer; tx jsonb; BEGIN
  SELECT * INTO j FROM public.background_jobs WHERE id=p_job FOR UPDATE;
  IF j.id IS NULL OR j.job_type::text<>'image_generation' OR NOT EXISTS (
    SELECT 1 FROM public.image_generation_proposals p WHERE p.id=j.id AND p.status='confirmed'
      AND p.created_by=j.created_by AND p.session_id=j.session_id
  ) THEN RAISE EXCEPTION 'image_job_not_confirmed'; END IF;
  IF j.image_enqueued_at IS NOT NULL OR j.status::text<>'queued' THEN RETURN; END IF;
  -- Only jobs with a complete provider snapshot (or a built-in provider) are ready.
  IF j.payload->>'model' LIKE 'workspace:%' AND NOT EXISTS (
    SELECT 1 FROM public.provider_execution_snapshots s WHERE s.background_job_id=j.id
  ) THEN RAISE EXCEPTION 'image_provider_snapshot_missing'; END IF;
  SELECT approved_cost INTO cost FROM public.image_generation_proposals WHERE id=j.id;
  IF cost IS NULL OR cost<0 THEN RAISE EXCEPTION 'image_price_missing'; END IF;
  IF cost>0 THEN
    tx := public.loomic_deduct_credits_idempotent(j.workspace_id,j.created_by,cost,j.id,'Confirmed image generation');
    UPDATE public.background_jobs SET credits_cost=cost,credits_transaction_id=(tx->>'transaction_id')::uuid WHERE id=j.id;
  END IF;
  PERFORM pgmq.send(j.queue_name,jsonb_strip_nulls(jsonb_build_object(
    'job_id',j.id,'job_type',j.job_type,'workspace_id',j.workspace_id,
    'target_kind',j.target_kind,'canvas_id',j.canvas_id,'design_id',j.design_id,'session_id',j.session_id)));
  UPDATE public.background_jobs SET image_enqueued_at=now() WHERE id=j.id;
END $$;

CREATE FUNCTION public.loomic_recover_image_submissions()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item record; published integer:=0; BEGIN
  FOR item IN SELECT j.id FROM public.background_jobs j JOIN public.image_generation_proposals p ON p.id=j.id
    WHERE j.status::text='queued' AND j.image_enqueued_at IS NULL AND p.status='confirmed'
      AND j.created_at<now()-interval '60 seconds' ORDER BY j.created_at LIMIT 50
  LOOP
    BEGIN
      PERFORM public.loomic_commit_image_job(item.id);
      published:=published+1;
    EXCEPTION WHEN OTHERS THEN
      -- No debit can survive a failed commit transaction. Leave a durable, visible failure.
      UPDATE public.background_jobs SET status='failed',error_code='submission_failed',error_message='Submission recovery: '||SQLERRM,failed_at=now()
        WHERE id=item.id AND status::text='queued' AND image_enqueued_at IS NULL;
    END;
  END LOOP;
  RETURN published;
END $$;
REVOKE ALL ON FUNCTION public.loomic_commit_image_job(uuid),public.loomic_recover_image_submissions() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_commit_image_job(uuid),public.loomic_recover_image_submissions() TO service_role;
REVOKE ALL ON FUNCTION public.loomic_prepare_image_submission(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_prepare_image_submission(uuid,uuid,uuid,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
