-- Acknowledgements keep a frozen proposal in conversational scope, but never
-- satisfy the separate explicit confirmation predicate or authorize billing.
CREATE OR REPLACE FUNCTION private.loomic_is_image_acknowledgement(p_content text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=''
AS $$
  SELECT regexp_replace(lower(btrim(COALESCE(p_content,''))), '[，。！!,.[:space:]]', '', 'g')
    ~ '^(嗯可以|嗯|可以|好的|好|行|收到|知道了|明白了|ok|okay)$'
$$;

CREATE OR REPLACE FUNCTION private.loomic_is_image_decision_message(p_content text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=''
AS $$
  SELECT private.loomic_is_image_confirmation_message(p_content)
    OR private.loomic_is_image_cancellation_message(p_content)
    OR private.loomic_is_image_acknowledgement(p_content)
$$;

NOTIFY pgrst, 'reload schema';
