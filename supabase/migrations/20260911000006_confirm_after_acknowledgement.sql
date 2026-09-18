-- Keep the CURRENT message's explicit paid-confirmation check unchanged.
-- Only prior acknowledgement turns are allowed between frozen requirement
-- and explicit confirmation. Prior cancellation/edits still invalidate it.
DO $$
DECLARE definition text;
  old_clause text := 'THEN private.loomic_is_image_confirmation_message(intervening.content)';
  new_clause text := 'THEN (private.loomic_is_image_confirmation_message(intervening.content) OR private.loomic_is_image_acknowledgement(intervening.content))';
BEGIN
  SELECT pg_get_functiondef('public.loomic_decide_current_image(uuid,uuid,uuid,uuid,text)'::regprocedure) INTO definition;
  IF array_length(string_to_array(definition, old_clause), 1) - 1 <> 2 THEN
    RAISE EXCEPTION 'Unexpected decide-current-image definition; review migration before applying';
  END IF;
  EXECUTE replace(definition, old_clause, new_clause);
END $$;
NOTIFY pgrst, 'reload schema';
