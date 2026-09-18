-- A full edit requirement may end with the exact sentence
-- "确认，按这次修改生成。". It remains a change everywhere else and can
-- authorize only the proposal created from this exact run/message. Historical
-- proposals cannot satisfy the origin_run_id + requirement_message_id fence.
CREATE FUNCTION private.loomic_is_combined_current_image_confirmation(p_content text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path='' AS $$
  WITH normalized AS (
    SELECT btrim(COALESCE(p_content,'')) AS raw
  ), parsed AS (
    SELECT raw, regexp_replace(raw,
      '[。！!.][[:space:]]*确认[[:space:]]*[，,][[:space:]]*按这次修改生成[。！!.[:space:]]*$', '') AS requirement
    FROM normalized
  )
  SELECT COALESCE(char_length(raw)<=4200
    AND raw !~ '[?？]'
    AND raw ~ '[。！!.][[:space:]]*确认[[:space:]]*[，,][[:space:]]*按这次修改生成[。！!.[:space:]]*$'
    AND requirement ~ '(改成|改为|换成|调整|修改|替换|增加|新增|添加|删除|去掉)'
    AND requirement !~ '(如果|假如|除非|只要|前提|免费|不要生成|不生成|取消生成|暂停生成|暂不生成|稍后生成)', false)
  FROM parsed
$$;

DO $migration$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('public.loomic_decide_current_image(uuid,uuid,uuid,uuid,text)'::regprocedure) INTO definition;
  IF position('private.loomic_is_combined_current_image_confirmation' IN definition)=0 THEN
    IF position('(p_decision=''confirm'' AND NOT private.loomic_is_image_confirmation_message(current_content))' IN definition)=0
      OR position('IF p_decision=''confirm'' AND NOT private.loomic_image_confirmation_matches_proposal(current_content,proposal.input) THEN RETURN NULL; END IF;' IN definition)=0
      OR position('OR NOT private.loomic_is_image_confirmation_message(current_content)) THEN' IN definition)=0 THEN
      RAISE EXCEPTION 'Unexpected decide-current-image definition';
    END IF;

    definition := replace(definition,
      '(p_decision=''confirm'' AND NOT private.loomic_is_image_confirmation_message(current_content))',
      '(p_decision=''confirm'' AND NOT private.loomic_is_image_confirmation_message(current_content)
        AND NOT private.loomic_is_combined_current_image_confirmation(current_content))');

    definition := replace(definition,
      'IF p_decision=''confirm'' AND NOT private.loomic_image_confirmation_matches_proposal(current_content,proposal.input) THEN RETURN NULL; END IF;',
      'IF p_decision=''confirm'' AND NOT (
    private.loomic_image_confirmation_matches_proposal(current_content,proposal.input)
    OR (private.loomic_is_combined_current_image_confirmation(current_content)
      AND proposal.origin_run_id=p_run
      AND proposal.requirement_message_id=current_id)
  ) THEN RETURN NULL; END IF;');

    definition := replace(definition,
      'OR NOT private.loomic_is_image_confirmation_message(current_content)) THEN',
      'OR NOT (private.loomic_is_image_confirmation_message(current_content)
        OR (private.loomic_is_combined_current_image_confirmation(current_content)
          AND proposal.requirement_message_id=current_id))) THEN');

    EXECUTE definition;
  END IF;
END
$migration$;

REVOKE ALL ON FUNCTION private.loomic_is_combined_current_image_confirmation(text)
  FROM PUBLIC,anon,authenticated;
NOTIFY pgrst, 'reload schema';
