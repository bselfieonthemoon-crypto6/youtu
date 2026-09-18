\set ON_ERROR_STOP on

-- DDL smoke test only. Re-apply the migration inside a transaction and roll it
-- back, so the database returns to its exact pre-test function definition.
BEGIN;
\ir ../migrations/20260909000016_recoverable_canvas_image_jobs.sql

DO $$
DECLARE
  definition text;
  design_definition text;
BEGIN
  SELECT pg_get_functiondef('public.loomic_recoverable_canvas_image_jobs(integer)'::regprocedure)
    INTO definition;
  IF definition NOT LIKE '%SECURITY DEFINER%'
    OR definition NOT LIKE '%asset.deletion_pending_at IS NULL%'
    OR definition NOT LIKE '%LIMIT p_limit%' THEN
    RAISE EXCEPTION 'recoverable_canvas_image_jobs_definition_invalid';
  END IF;
  SELECT pg_get_functiondef('public.loomic_recoverable_design_image_chats(integer)'::regprocedure)
    INTO design_definition;
  IF design_definition NOT LIKE '%SECURITY DEFINER%'
    OR design_definition NOT LIKE '%finalization.status IN%'
    OR design_definition NOT LIKE '%LIMIT p_limit%' THEN
    RAISE EXCEPTION 'recoverable_design_image_chats_definition_invalid';
  END IF;
END;
$$;

ROLLBACK;
SELECT 'recoverable canvas image jobs migration DDL passed and was rolled back' AS result;
