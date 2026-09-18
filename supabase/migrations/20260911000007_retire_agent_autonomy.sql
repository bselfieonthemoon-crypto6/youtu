-- Retire unattended execution without deleting chat, task, job, artwork, or
-- audit history. Abort if the expected autonomy schema is not the one being
-- migrated; the state updates below must never broaden silently.
DO $retirement_guard$
BEGIN
  IF to_regclass('public.agent_autonomy_preferences') IS NULL
    OR to_regclass('public.agent_task_autonomy') IS NULL
    OR to_regclass('public.agent_task_continuations') IS NULL
    OR to_regclass('public.agent_canvas_result_reviews') IS NULL THEN
    RAISE EXCEPTION 'Unexpected autonomy schema; review retirement migration before applying';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='agent_autonomy_preferences'
      AND column_name='enabled' AND data_type='boolean' AND is_nullable='NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='agent_task_autonomy'
      AND column_name='state' AND data_type='text' AND is_nullable='NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='agent_task_continuations'
      AND column_name='status' AND data_type='text' AND is_nullable='NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='agent_canvas_result_reviews'
      AND column_name='state' AND data_type='text' AND is_nullable='NO'
  ) THEN
    RAISE EXCEPTION 'Unexpected autonomy state columns; review retirement migration before applying';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='record_agent_task_continuation'
      AND tgrelid='public.background_jobs'::regclass
      AND tgfoid='private.loomic_record_agent_continuation()'::regprocedure
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='z_bind_delivered_canvas_review'
      AND tgrelid='public.background_jobs'::regclass
      AND tgfoid='private.loomic_bind_delivered_canvas_review()'::regprocedure
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Unexpected automatic continuation triggers; review retirement migration before applying';
  END IF;

  IF to_regprocedure('public.loomic_agent_autonomy(text,uuid,uuid,jsonb)') IS NULL
    OR to_regprocedure('public.loomic_claim_agent_continuation(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Unexpected autonomy entry points; review retirement migration before applying';
  END IF;
END
$retirement_guard$;

-- Stop creating post-generation work records. The trigger functions and all
-- existing rows remain available for audit and a reversible rollback.
ALTER TABLE public.background_jobs DISABLE TRIGGER record_agent_task_continuation;
ALTER TABLE public.background_jobs DISABLE TRIGGER z_bind_delivered_canvas_review;

-- Prevent an older API process from re-enabling or claiming unattended work.
-- Current server builds retain authenticated HTTP tombstones for stale clients.
REVOKE EXECUTE ON FUNCTION public.loomic_agent_autonomy(text,uuid,uuid,jsonb) FROM service_role;
REVOKE EXECUTE ON FUNCTION public.loomic_claim_agent_continuation(uuid,uuid) FROM service_role;

UPDATE public.agent_autonomy_preferences
SET enabled=false
WHERE enabled IS TRUE;

UPDATE public.agent_task_autonomy
SET enabled=false,
    state='stopped',
    claim_token=NULL,
    lease_until=NULL,
    internal_run_id=NULL,
    updated_at=now()
WHERE enabled IS DISTINCT FROM false
   OR state IN ('waiting','running')
   OR claim_token IS NOT NULL
   OR lease_until IS NOT NULL
   OR internal_run_id IS NOT NULL;

UPDATE public.agent_task_continuations
SET status='needs_attention',
    claim_token=NULL,
    completed_at=COALESCE(completed_at,now()),
    outcome=COALESCE(outcome,'{"reason":"autonomous_execution_retired"}'::jsonb)
WHERE status IN ('pending','running');

UPDATE public.agent_canvas_result_reviews
SET state='needs_attention',
    failure_code=COALESCE(failure_code,'autonomy_retired')
WHERE state='registered';

NOTIFY pgrst,'reload schema';
