-- Close dormant unattended-only execution entrances as well as the retired
-- enable/claim entrances. Keep historical functions/data for audit, without
-- making them callable by old service-role processes. Ordinary conversational
-- image/design RPCs and their permissions are not changed.
DO $$
DECLARE
  signature text;
  target regprocedure;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.loomic_autonomy_start_tool(uuid,uuid,uuid,uuid,text,jsonb)',
    'public.loomic_autonomy_reserve_image(uuid,uuid,uuid,uuid)',
    'public.loomic_autonomy_arrange_design_boards(uuid,uuid,uuid,jsonb)',
    'public.loomic_autonomy_export_design(uuid,uuid,uuid,jsonb)',
    'public.loomic_autonomy_export_status(uuid,uuid,uuid)'
  ] LOOP
    target := to_regprocedure(signature);
    -- Some replicas never installed the optional legacy export functions.
    IF target IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', target);
    END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
