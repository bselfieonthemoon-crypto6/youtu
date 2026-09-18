-- Extend the direct Mastra commit fence to native design targets. Provider
-- execution and design mutation remain owned by the existing worker/finalizer.

CREATE OR REPLACE FUNCTION public.loomic_commit_mastra_image_job(
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
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'mastra_image_submission_service_role_forbidden';
  END IF;
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
  JOIN public.canvases scope_canvas ON scope_canvas.id=session.canvas_id
    AND scope_canvas.workspace_id=job.workspace_id
  WHERE job.id=p_job AND job.created_by=p_user
    AND job.job_type::text='image_generation'
    AND job.payload->>'mastra_origin_run_id'=p_run::text
    AND job.payload->>'mastra_submission_key'=p_submission_key
    AND (job.payload->>'mastra_credits_cost')::integer=p_cost
    AND EXISTS (SELECT 1 FROM public.workspace_members member
      WHERE member.workspace_id=job.workspace_id AND member.user_id=p_user)
    AND (
      (job.target_kind::text='canvas' AND job.canvas_id=session.canvas_id
        AND job.design_id IS NULL
        AND job.payload#>>'{target,kind}'='canvas'
        AND job.payload#>>'{target,canvas_id}'=job.canvas_id::text)
      OR
      (job.target_kind::text='design' AND job.canvas_id IS NULL
        AND job.design_id IS NOT NULL
        AND job.payload#>>'{target,kind}'='design'
        AND job.payload#>>'{target,design_id}'=job.design_id::text
        AND EXISTS (
          SELECT 1 FROM public.design_documents document
          JOIN public.design_nodes node ON node.design_id=document.id
            AND node.canvas_id=session.canvas_id
            AND node.workspace_id=job.workspace_id
            AND node.deleted_at IS NULL
          WHERE document.id=job.design_id
            AND document.workspace_id=job.workspace_id
            AND document.project_id=job.project_id
            AND document.deleted_at IS NULL
            AND document.revision::text=job.payload#>>'{target,expected_revision}'
        ))
    )
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

NOTIFY pgrst, 'reload schema';
