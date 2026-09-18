-- Durable video submissions share one database transaction for credit debit,
-- PGMQ publication and the publication receipt. Both HTTP and Mastra callers
-- can safely replay their server-owned submission key after a lost response.

ALTER TABLE public.background_jobs
  ADD COLUMN video_enqueued_at timestamptz;

CREATE UNIQUE INDEX background_jobs_video_submission_key
  ON public.background_jobs(created_by, workspace_id, (payload->>'video_submission_key'))
  WHERE job_type='video_generation'
    AND jsonb_typeof(payload)='object'
    AND payload ? 'video_submission_key';

CREATE FUNCTION public.loomic_guard_durable_video_job()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  kind text;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.job_type::text<>'video_generation' OR NOT (NEW.payload ? 'video_submission_key') THEN
      RETURN NEW;
    END IF;
    IF auth.role()<>'service_role' THEN
      RAISE EXCEPTION 'video_submission_service_role_required';
    END IF;
    kind:=NEW.payload->>'video_submission_kind';
    IF NEW.queue_name<>'video_generation_jobs'
      OR NEW.payload->>'video_credits_cost' IS NULL
      OR NEW.payload->>'video_credits_cost' !~ '^[0-9]+$'
      OR NEW.payload->>'video_pricing_version' IS NULL
      OR (kind='http' AND (
        NEW.payload->>'video_submission_key' IS NULL
        OR NEW.payload->>'video_submission_key' !~ '^http:[0-9a-f]{64}$'
        OR NEW.payload ? 'video_origin_run_id' OR NEW.session_id IS NOT NULL
        OR NEW.canvas_id IS NOT NULL))
      OR (kind='mastra' AND (
        NEW.payload->>'video_origin_run_id' IS NULL
        OR NEW.payload->>'video_origin_run_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR NEW.payload->>'video_submission_key' IS NULL
        OR NEW.payload->>'video_submission_key' !~ ('^'||(NEW.payload->>'video_origin_run_id')||':[0-9a-f]{64}$')
        OR NEW.session_id IS NULL OR NEW.canvas_id IS NULL))
      OR kind IS NULL OR kind NOT IN ('http','mastra') THEN
      RAISE EXCEPTION 'video_submission_row_invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT (OLD.payload ? 'video_submission_key')
    AND NOT (NEW.payload ? 'video_submission_key') THEN
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.canvas_id IS DISTINCT FROM OLD.canvas_id
    OR NEW.design_id IS DISTINCT FROM OLD.design_id
    OR NEW.target_kind IS DISTINCT FROM OLD.target_kind
    OR NEW.job_type IS DISTINCT FROM OLD.job_type
    OR NEW.queue_name IS DISTINCT FROM OLD.queue_name THEN
    RAISE EXCEPTION 'durable_video_job_immutable';
  END IF;
  IF OLD.video_enqueued_at IS NOT NULL AND (
    NEW.video_enqueued_at IS DISTINCT FROM OLD.video_enqueued_at
    OR NEW.credits_cost IS DISTINCT FROM OLD.credits_cost
    OR NEW.credits_transaction_id IS DISTINCT FROM OLD.credits_transaction_id) THEN
    RAISE EXCEPTION 'durable_video_receipt_immutable';
  END IF;
  IF auth.role()<>'service_role' AND (
    NEW.video_enqueued_at IS DISTINCT FROM OLD.video_enqueued_at
    OR NEW.credits_cost IS DISTINCT FROM OLD.credits_cost
    OR NEW.credits_transaction_id IS DISTINCT FROM OLD.credits_transaction_id
    OR NEW.result IS DISTINCT FROM OLD.result
    OR NEW.error_code IS DISTINCT FROM OLD.error_code
    OR NEW.error_message IS DISTINCT FROM OLD.error_message
    OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count
    OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
    OR NEW.started_at IS DISTINCT FROM OLD.started_at
    OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
    OR NEW.failed_at IS DISTINCT FROM OLD.failed_at
    OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (
      NEW.status::text='canceled' AND OLD.status::text IN ('queued','running')
    ))) THEN
    RAISE EXCEPTION 'durable_video_server_fields_forbidden';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.loomic_guard_durable_video_job()
  FROM PUBLIC,anon,authenticated;
CREATE TRIGGER durable_video_job_guard
  BEFORE INSERT OR UPDATE ON public.background_jobs
  FOR EACH ROW EXECUTE FUNCTION public.loomic_guard_durable_video_job();

CREATE FUNCTION public.loomic_commit_video_job(
  p_job uuid,
  p_user uuid,
  p_submission_key text,
  p_cost integer,
  p_run uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  j public.background_jobs;
  submission_kind text;
  tx jsonb;
BEGIN
  IF p_job IS NULL OR p_user IS NULL OR p_submission_key IS NULL
    OR p_cost IS NULL OR p_cost < 0 THEN
    RAISE EXCEPTION 'video_submission_invalid';
  END IF;

  SELECT job.* INTO j
  FROM public.background_jobs job
  WHERE job.id=p_job
    AND job.created_by=p_user
    AND job.job_type::text='video_generation'
    AND job.queue_name='video_generation_jobs'
    AND job.payload->>'video_submission_key'=p_submission_key
    AND job.payload->>'video_credits_cost'=p_cost::text
    AND EXISTS (
      SELECT 1 FROM public.workspace_members member
      WHERE member.workspace_id=job.workspace_id AND member.user_id=p_user
    )
  FOR UPDATE OF job;

  IF j.id IS NULL THEN
    RAISE EXCEPTION 'video_submission_forbidden';
  END IF;
  IF j.video_enqueued_at IS NOT NULL OR j.status::text<>'queued' THEN
    RETURN;
  END IF;

  submission_kind := j.payload->>'video_submission_kind';
  IF submission_kind='mastra' THEN
    IF p_run IS NULL
      OR p_submission_key !~ ('^'||p_run::text||':[0-9a-f]{64}$')
      OR j.payload->>'video_origin_run_id' IS DISTINCT FROM p_run::text
      OR j.session_id IS NULL OR j.canvas_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM public.agent_runs run
        JOIN public.chat_sessions session ON session.id=run.session_id
        JOIN public.chat_messages request ON request.id=run.request_message_id
          AND request.session_id=session.id AND request.role='user'
        JOIN public.canvases canvas ON canvas.id=session.canvas_id
        WHERE run.id=p_run AND run.created_by=p_user
          AND run.session_id=j.session_id
          AND run.status::text IN ('accepted','running')
          AND canvas.id=j.canvas_id AND canvas.workspace_id=j.workspace_id
      ) THEN
      RAISE EXCEPTION 'video_submission_run_forbidden';
    END IF;
  ELSIF submission_kind='http' THEN
    IF p_run IS NOT NULL OR p_submission_key !~ '^http:[0-9a-f]{64}$'
      OR j.payload ? 'video_origin_run_id' OR j.session_id IS NOT NULL
      OR j.canvas_id IS NOT NULL THEN
      RAISE EXCEPTION 'video_submission_http_invalid';
    END IF;
  ELSE
    RAISE EXCEPTION 'video_submission_kind_invalid';
  END IF;

  IF j.payload->>'model' LIKE 'workspace:%' AND NOT EXISTS (
    SELECT 1 FROM public.provider_execution_snapshots snapshot
    WHERE snapshot.background_job_id=j.id
  ) THEN
    -- A concurrent replay can observe the job before snapshot creation finishes.
    -- Keep this retryable; the recovery publisher will try again.
    RAISE EXCEPTION 'video_provider_snapshot_missing';
  END IF;

  IF p_cost>0 THEN
    tx:=public.loomic_deduct_credits_idempotent(
      j.workspace_id,j.created_by,p_cost,j.id,'Video generation'
    );
    UPDATE public.background_jobs
    SET credits_cost=p_cost,
      credits_transaction_id=(tx->>'transaction_id')::uuid
    WHERE id=j.id;
  END IF;

  PERFORM pgmq.send(j.queue_name,jsonb_strip_nulls(jsonb_build_object(
    'job_id',j.id,'job_type',j.job_type,'workspace_id',j.workspace_id,
    'target_kind',j.target_kind,'canvas_id',j.canvas_id,
    'design_id',j.design_id,'session_id',j.session_id)));
  UPDATE public.background_jobs SET video_enqueued_at=now() WHERE id=j.id;
END
$$;

REVOKE ALL ON FUNCTION public.loomic_commit_video_job(uuid,uuid,text,integer,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_commit_video_job(uuid,uuid,text,integer,uuid)
  TO service_role;

CREATE FUNCTION public.loomic_recover_video_submissions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  item record;
  published integer:=0;
BEGIN
  FOR item IN
    SELECT j.id,j.created_by,j.payload->>'video_submission_key' AS submission_key,
      (j.payload->>'video_credits_cost')::integer AS credits_cost,
      CASE WHEN j.payload->>'video_submission_kind'='mastra'
        THEN (j.payload->>'video_origin_run_id')::uuid ELSE NULL END AS run_id
    FROM public.background_jobs j
    WHERE j.job_type::text='video_generation'
      AND j.status::text='queued'
      AND j.video_enqueued_at IS NULL
      AND j.payload->>'video_credits_cost' ~ '^[0-9]+$'
      AND (
        (j.payload->>'video_submission_kind'='http'
          AND j.payload->>'video_submission_key' ~ '^http:[0-9a-f]{64}$')
        OR
        (j.payload->>'video_submission_kind'='mastra'
          AND j.payload->>'video_origin_run_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND j.payload->>'video_submission_key' ~ ('^'||(j.payload->>'video_origin_run_id')||':[0-9a-f]{64}$'))
      )
      AND j.created_at<now()-interval '60 seconds'
    ORDER BY j.created_at
    LIMIT 50
  LOOP
    BEGIN
      PERFORM public.loomic_commit_video_job(
        item.id,item.created_by,item.submission_key,item.credits_cost,item.run_id
      );
      published:=published+1;
    EXCEPTION
      WHEN raise_exception THEN
        IF SQLERRM='video_provider_snapshot_missing' THEN
          -- The scan waits 60 seconds, so a snapshot that is still absent is
          -- no longer a normal concurrent-creation window.
          UPDATE public.background_jobs
          SET status='failed',error_code='submission_failed',
            error_message='Video provider snapshot was not committed',failed_at=now()
          WHERE id=item.id AND status::text='queued' AND video_enqueued_at IS NULL;
        ELSE
          UPDATE public.background_jobs
          SET status='failed',error_code='submission_failed',
            error_message='Video submission recovery rejected',failed_at=now()
          WHERE id=item.id AND status::text='queued' AND video_enqueued_at IS NULL;
        END IF;
      WHEN OTHERS THEN
        -- Infrastructure failures have an unknown commit outcome. Leave the
        -- record queued so a later scan can safely retry the same transaction.
        NULL;
    END;
  END LOOP;
  RETURN published;
END
$$;

REVOKE ALL ON FUNCTION public.loomic_recover_video_submissions()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_recover_video_submissions()
  TO service_role;

NOTIFY pgrst, 'reload schema';
