-- Direct Mastra image submissions use a server-derived run/input identity.
-- They do not reuse the legacy natural-language proposal confirmation path.

CREATE UNIQUE INDEX background_jobs_mastra_image_submission_key
  ON public.background_jobs(created_by,session_id,(payload->>'mastra_submission_key'))
  WHERE job_type='image_generation'
    AND jsonb_typeof(payload)='object'
    AND payload ? 'mastra_submission_key';

CREATE FUNCTION public.loomic_commit_mastra_image_job(
  p_job uuid,
  p_user uuid,
  p_run uuid,
  p_submission_key text,
  p_cost integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE j public.background_jobs; tx jsonb;
BEGIN
  IF p_cost IS NULL OR p_cost<0 OR p_submission_key IS NULL
    OR p_submission_key !~ ('^'||p_run::text||':[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'mastra_image_submission_invalid';
  END IF;

  SELECT job.* INTO j
  FROM public.background_jobs job
  JOIN public.agent_runs run ON run.id=p_run AND run.session_id=job.session_id
    AND run.created_by=p_user AND run.status::text IN ('accepted','running')
  JOIN public.chat_sessions session ON session.id=job.session_id
  JOIN public.chat_messages request ON request.id=run.request_message_id
    AND request.session_id=session.id AND request.role='user'
  JOIN public.canvases canvas ON canvas.id=session.canvas_id
    AND canvas.id=job.canvas_id AND canvas.workspace_id=job.workspace_id
  WHERE job.id=p_job AND job.created_by=p_user
    AND job.job_type::text='image_generation'
    AND job.payload->>'mastra_origin_run_id'=p_run::text
    AND job.payload->>'mastra_submission_key'=p_submission_key
    AND (job.payload->>'mastra_credits_cost')::integer=p_cost
    AND EXISTS (SELECT 1 FROM public.workspace_members member
      WHERE member.workspace_id=job.workspace_id AND member.user_id=p_user)
  FOR UPDATE OF job;
  IF j.id IS NULL THEN RAISE EXCEPTION 'mastra_image_submission_forbidden'; END IF;
  IF j.image_enqueued_at IS NOT NULL OR j.status::text<>'queued' THEN RETURN; END IF;
  IF j.payload->>'model' LIKE 'workspace:%' AND NOT EXISTS (
    SELECT 1 FROM public.provider_execution_snapshots snapshot
    WHERE snapshot.background_job_id=j.id
  ) THEN RAISE EXCEPTION 'image_provider_snapshot_missing'; END IF;

  IF p_cost>0 THEN
    tx:=public.loomic_deduct_credits_idempotent(
      j.workspace_id,j.created_by,p_cost,j.id,'Mastra image generation'
    );
    UPDATE public.background_jobs SET credits_cost=p_cost,
      credits_transaction_id=(tx->>'transaction_id')::uuid WHERE id=j.id;
  END IF;
  PERFORM pgmq.send(j.queue_name,jsonb_strip_nulls(jsonb_build_object(
    'job_id',j.id,'job_type',j.job_type,'workspace_id',j.workspace_id,
    'target_kind',j.target_kind,'canvas_id',j.canvas_id,
    'design_id',j.design_id,'session_id',j.session_id)));
  UPDATE public.background_jobs SET image_enqueued_at=now() WHERE id=j.id;
END
$$;

REVOKE ALL ON FUNCTION public.loomic_commit_mastra_image_job(uuid,uuid,uuid,text,integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_commit_mastra_image_job(uuid,uuid,uuid,text,integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.loomic_recover_image_submissions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE item record; published integer:=0;
BEGIN
  FOR item IN SELECT j.id FROM public.background_jobs j
    JOIN public.image_generation_proposals p ON p.id=j.id
    WHERE j.status::text='queued' AND j.image_enqueued_at IS NULL
      AND p.status='confirmed' AND j.created_at<now()-interval '60 seconds'
    ORDER BY j.created_at LIMIT 50
  LOOP
    BEGIN
      PERFORM public.loomic_commit_image_job(item.id);
      published:=published+1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.background_jobs SET status='failed',error_code='submission_failed',
        error_message='Submission recovery: '||SQLERRM,failed_at=now()
        WHERE id=item.id AND status::text='queued' AND image_enqueued_at IS NULL;
    END;
  END LOOP;

  FOR item IN SELECT j.id,j.created_by,(j.payload->>'mastra_origin_run_id')::uuid AS run_id,
      j.payload->>'mastra_submission_key' AS submission_key,
      (j.payload->>'mastra_credits_cost')::integer AS credits_cost
    FROM public.background_jobs j
    WHERE j.job_type::text='image_generation' AND j.status::text='queued'
      AND j.image_enqueued_at IS NULL AND j.payload ? 'mastra_submission_key'
      AND j.payload->>'mastra_origin_run_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND j.payload->>'mastra_credits_cost' ~ '^[0-9]+$'
      AND j.created_at<now()-interval '60 seconds'
    ORDER BY j.created_at LIMIT 50
  LOOP
    BEGIN
      PERFORM public.loomic_commit_mastra_image_job(
        item.id,item.created_by,item.run_id,item.submission_key,item.credits_cost
      );
      published:=published+1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.background_jobs SET status='failed',error_code='submission_failed',
        error_message='Submission recovery: '||SQLERRM,failed_at=now()
        WHERE id=item.id AND status::text='queued' AND image_enqueued_at IS NULL;
    END;
  END LOOP;
  RETURN published;
END
$$;

REVOKE ALL ON FUNCTION public.loomic_recover_image_submissions()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_recover_image_submissions()
  TO service_role;

NOTIFY pgrst, 'reload schema';
