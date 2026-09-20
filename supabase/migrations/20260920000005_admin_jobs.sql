-- B5a: platform-admin job inspection and disposition.
--
-- Until now the console could only count jobs and list the last twenty failures.
-- An operator diagnosing "why did this die at 3am" needs the opposite: filter, open
-- one job, see its attempts, its provider error, its ledger rows and its audit
-- history, then cancel a queued job or mark a dead letter as reviewed.
--
-- Writes follow the B1-B4 rules (platform admin, reason required, audit row in the
-- same transaction). Two deliberate boundaries:
--   * cancelling only flips `status`/`canceled_at`, exactly like the user-facing
--     cancel path: the existing refund reconciliation and the worker's terminal
--     settlement then do their normal work. This function invents no billing.
--   * there is NO replay. Re-running a dead letter calls a paid upstream, so it stays
--     a separate decision.
--
-- "Acknowledged" is derived from this table's own audit trail rather than a new
-- column: the newest `job.failure.acknowledge` row for the job IS the state, so the
-- list and the history can never disagree.

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_job_directory(
  p_actor_user_id uuid,
  p_status text DEFAULT NULL,
  p_job_type text DEFAULT NULL,
  p_workspace_id uuid DEFAULT NULL,
  p_error_code text DEFAULT NULL,
  p_since timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 25,
  p_offset integer DEFAULT 0,
  p_stuck_running_minutes integer DEFAULT 15,
  p_stuck_queued_minutes integer DEFAULT 30
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_running_seconds integer := GREATEST(COALESCE(p_stuck_running_minutes, 15), 1) * 60;
  v_queued_seconds integer := GREATEST(COALESCE(p_stuck_queued_minutes, 30), 1) * 60;
  v_total integer;
  v_jobs jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;

  SELECT count(*) INTO v_total
  FROM public.background_jobs bj
  WHERE (p_status IS NULL OR bj.status::text = p_status)
    AND (p_job_type IS NULL OR bj.job_type::text = p_job_type)
    AND (p_workspace_id IS NULL OR bj.workspace_id = p_workspace_id)
    AND (p_error_code IS NULL OR bj.error_code = p_error_code)
    AND (p_since IS NULL OR bj.created_at >= p_since);

  SELECT coalesce(jsonb_agg(page.row_data ORDER BY page.created_at DESC, page.id), '[]'::jsonb)
  INTO v_jobs
  FROM (
    SELECT
      jsonb_build_object(
        'id', bj.id,
        'status', bj.status::text,
        'jobType', bj.job_type::text,
        'queueName', bj.queue_name,
        'workspaceId', bj.workspace_id,
        'workspaceName', w.name,
        'createdBy', bj.created_by,
        'createdByEmail', p.email,
        'title', bj.payload ->> 'title',
        'model', bj.payload ->> 'model',
        'createdAt', bj.created_at,
        'startedAt', bj.started_at,
        'completedAt', bj.completed_at,
        'attemptCount', bj.attempt_count,
        'maxAttempts', bj.max_attempts,
        'errorCode', bj.error_code,
        'errorMessage', left(bj.error_message, 300),
        'creditsCost', bj.credits_cost,
        'stuck', (
          (bj.status = 'running' AND now() - coalesce(bj.started_at, bj.created_at) > make_interval(secs => v_running_seconds))
          OR (bj.status = 'queued' AND now() - bj.created_at > make_interval(secs => v_queued_seconds))
        ),
        'ageSeconds', floor(extract(epoch FROM now() - bj.created_at))::integer,
        'acknowledgedAt', ack.created_at,
        'acknowledgedByEmail', ack.actor_email,
        'acknowledgeReason', ack.reason
      ) AS row_data,
      bj.created_at,
      bj.id
    FROM public.background_jobs bj
    LEFT JOIN public.workspaces w ON w.id = bj.workspace_id
    LEFT JOIN public.profiles p ON p.id = bj.created_by
    LEFT JOIN LATERAL (
      SELECT ae.created_at, ap.email AS actor_email, ae.reason
      FROM public.admin_audit_events ae
      LEFT JOIN public.profiles ap ON ap.id = ae.actor_user_id
      WHERE ae.target_kind = 'job' AND ae.target_id = bj.id::text
        AND ae.action = 'job.failure.acknowledge'
      ORDER BY ae.created_at DESC
      LIMIT 1
    ) ack ON true
    WHERE (p_status IS NULL OR bj.status::text = p_status)
      AND (p_job_type IS NULL OR bj.job_type::text = p_job_type)
      AND (p_workspace_id IS NULL OR bj.workspace_id = p_workspace_id)
      AND (p_error_code IS NULL OR bj.error_code = p_error_code)
      AND (p_since IS NULL OR bj.created_at >= p_since)
    ORDER BY bj.created_at DESC, bj.id
    LIMIT v_limit OFFSET v_offset
  ) page;

  RETURN jsonb_build_object('total', v_total, 'jobs', v_jobs);
END;
$$;

COMMENT ON FUNCTION public.admin_job_directory(uuid, text, text, uuid, text, timestamptz, integer, integer, integer, integer) IS
  'Platform-admin job list: filter by status/type/workspace/error code/since, with stuck detection and the latest acknowledgement. Read-only; payload text is never returned here.';

CREATE OR REPLACE FUNCTION public.admin_job_detail(
  p_actor_user_id uuid,
  p_job_id uuid,
  p_payload_preview_chars integer DEFAULT 2000
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_preview integer := LEAST(GREATEST(COALESCE(p_payload_preview_chars, 2000), 200), 8000);
  v_job jsonb;
  v_transactions jsonb;
  v_audit jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;

  SELECT jsonb_build_object(
           'id', bj.id,
           'status', bj.status::text,
           'jobType', bj.job_type::text,
           'queueName', bj.queue_name,
           'workspaceId', bj.workspace_id,
           'workspaceName', w.name,
           'sessionId', bj.session_id,
           'sessionTitle', cs.title,
           'canvasId', bj.canvas_id,
           'createdBy', bj.created_by,
           'createdByEmail', p.email,
           'createdAt', bj.created_at,
           'startedAt', bj.started_at,
           'completedAt', bj.completed_at,
           'failedAt', bj.failed_at,
           'canceledAt', bj.canceled_at,
           'attemptCount', bj.attempt_count,
           'maxAttempts', bj.max_attempts,
           'errorCode', bj.error_code,
           'errorMessage', bj.error_message,
           'creditsCost', bj.credits_cost,
           'creditsTransactionId', bj.credits_transaction_id,
           'acknowledgedAt', ack.created_at,
           'acknowledgedByEmail', ack.actor_email,
           'acknowledgeReason', ack.reason,
           'payloadPreview', left(bj.payload::text, v_preview),
           'resultPreview', left(bj.result::text, v_preview)
         )
    INTO v_job
    FROM public.background_jobs bj
    LEFT JOIN public.workspaces w ON w.id = bj.workspace_id
    LEFT JOIN public.chat_sessions cs ON cs.id = bj.session_id
    LEFT JOIN public.profiles p ON p.id = bj.created_by
    -- Same derived acknowledgement as the directory: the newest review of this
    -- job's failure IS the state, so the detail and the list cannot disagree.
    LEFT JOIN LATERAL (
      SELECT ae.created_at, ap.email AS actor_email, ae.reason
      FROM public.admin_audit_events ae
      LEFT JOIN public.profiles ap ON ap.id = ae.actor_user_id
      WHERE ae.target_kind = 'job' AND ae.target_id = bj.id::text
        AND ae.action = 'job.failure.acknowledge'
      ORDER BY ae.created_at DESC
      LIMIT 1
    ) ack ON true
   WHERE bj.id = p_job_id;
  IF v_job IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_JOB: no such job';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', ct.id, 'transactionType', ct.transaction_type, 'amount', ct.amount,
           'balanceAfter', ct.balance_after, 'description', ct.description, 'createdAt', ct.created_at
         ) ORDER BY ct.created_at DESC), '[]'::jsonb)
    INTO v_transactions
    FROM public.credit_transactions ct
   WHERE ct.job_id = p_job_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'action', ae.action, 'reason', ae.reason, 'actorEmail', ap.email,
           'actorUserId', ae.actor_user_id, 'createdAt', ae.created_at
         ) ORDER BY ae.created_at DESC), '[]'::jsonb)
    INTO v_audit
    FROM public.admin_audit_events ae
    LEFT JOIN public.profiles ap ON ap.id = ae.actor_user_id
   WHERE ae.target_kind = 'job' AND ae.target_id = p_job_id::text;

  RETURN jsonb_build_object('job', v_job, 'transactions', v_transactions, 'audit', v_audit);
END;
$$;

COMMENT ON FUNCTION public.admin_job_detail(uuid, uuid, integer) IS
  'Platform-admin job detail: the row plus its ledger rows and every admin action taken on it. Payload/result are returned as bounded text previews.';

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_cancel_job(
  p_actor_user_id uuid,
  p_job_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status public.background_job_status;
  v_workspace_id uuid;
  v_after jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 2 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a reason is required to cancel a job';
  END IF;

  SELECT status, workspace_id INTO v_status, v_workspace_id
    FROM public.background_jobs WHERE id = p_job_id FOR UPDATE;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_JOB: no such job';
  END IF;
  IF v_status IN ('succeeded', 'failed', 'dead_letter', 'canceled') THEN
    RAISE EXCEPTION 'ALREADY_TERMINAL: the job already ended';
  END IF;

  UPDATE public.background_jobs
     SET status = 'canceled', canceled_at = now(), error_code = 'admin_canceled'
   WHERE id = p_job_id;

  v_after := jsonb_build_object('status', 'canceled', 'statusBefore', v_status::text);
  INSERT INTO public.admin_audit_events
    (actor_user_id, action, target_kind, target_id, workspace_id, reason, before, after)
  VALUES
    (p_actor_user_id, 'job.cancel', 'job', p_job_id::text, v_workspace_id, btrim(p_reason),
     jsonb_build_object('status', v_status::text), v_after);

  RETURN v_after;
END;
$$;

COMMENT ON FUNCTION public.admin_cancel_job(uuid, uuid, text) IS
  'Platform-admin: cancel a queued/running job (status only, so the existing refund reconciliation still applies) and audit it atomically.';

CREATE OR REPLACE FUNCTION public.admin_acknowledge_job(
  p_actor_user_id uuid,
  p_job_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status public.background_job_status;
  v_workspace_id uuid;
  v_after jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 2 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a reason is required to acknowledge a failure';
  END IF;

  SELECT status, workspace_id INTO v_status, v_workspace_id
    FROM public.background_jobs WHERE id = p_job_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_JOB: no such job';
  END IF;
  -- Acknowledging means "a human has looked at this terminal failure"; an
  -- in-flight job is not a failure yet.
  IF v_status NOT IN ('failed', 'dead_letter', 'canceled') THEN
    RAISE EXCEPTION 'NOT_TERMINAL: only an ended job can be acknowledged';
  END IF;

  v_after := jsonb_build_object('acknowledged', true, 'status', v_status::text);
  INSERT INTO public.admin_audit_events
    (actor_user_id, action, target_kind, target_id, workspace_id, reason, before, after)
  VALUES
    (p_actor_user_id, 'job.failure.acknowledge', 'job', p_job_id::text, v_workspace_id, btrim(p_reason),
     NULL, v_after);

  RETURN v_after;
END;
$$;

COMMENT ON FUNCTION public.admin_acknowledge_job(uuid, uuid, text) IS
  'Platform-admin: record that a terminal failure has been reviewed (derived state, read back from this audit trail) and audit it atomically.';

REVOKE ALL ON FUNCTION public.admin_job_directory(uuid, text, text, uuid, text, timestamptz, integer, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_job_detail(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_cancel_job(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_acknowledge_job(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_job_directory(uuid, text, text, uuid, text, timestamptz, integer, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_job_detail(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_cancel_job(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_acknowledge_job(uuid, uuid, text) TO service_role;
