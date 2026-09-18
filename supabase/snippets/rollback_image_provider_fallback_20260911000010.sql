-- Run only after stopping image submission/worker traffic. This intentionally
-- refuses to discard a durable fallback plan that may record paid attempts.
BEGIN;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM public.provider_execution_snapshots
    WHERE execution_stage='generation' AND attempt_ordinal>0
  ) THEN
    RAISE EXCEPTION 'image_provider_fallback_rollback_has_durable_attempts';
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.loomic_image_provider_plan_resolve(uuid,uuid);
DROP FUNCTION IF EXISTS public.loomic_image_provider_plan_create(uuid,uuid,uuid,integer,text,text);
DROP INDEX IF EXISTS public.provider_execution_snapshots_background_job_key;
CREATE UNIQUE INDEX provider_execution_snapshots_background_job_key
  ON public.provider_execution_snapshots(background_job_id,execution_stage)
  WHERE background_job_id IS NOT NULL;
ALTER TABLE public.provider_execution_snapshots
  DROP COLUMN provider_model_catalog_key,
  DROP COLUMN attempt_ordinal;
COMMIT;
