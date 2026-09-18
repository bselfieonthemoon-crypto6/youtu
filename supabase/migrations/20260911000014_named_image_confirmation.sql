-- Named approval stays in the current proposal chain, but may only approve
-- the immutable proposal whose title contains the explicitly named subject.
CREATE OR REPLACE FUNCTION private.loomic_named_image_confirmation_scope(p_content text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path='' AS $$
  WITH parsed AS (
    SELECT regexp_match(regexp_replace(lower(btrim(COALESCE(p_content,''))),
      '[，。！!,.[:space:]]','','g'),
      '^(?:确认生成|确认并生成|同意生成|开始生成)(?:这张|那张|这个|该)(.{2,60}?)(?:宣传海报|宣传图|海报|图片|标志|logo|方案)(?:吧)?$') AS named
  )
  SELECT CASE WHEN p_content !~ '[?？]' AND named[1] !~ '(如果|假如|除非|免费|不要|不生成|取消|暂停|暂不|稍后|但是|另外|同时|并且|还要|改|换|调整|修改|替换|增加|新增|删除|去掉|两张|多张|一组|批量)' THEN named[1] END FROM parsed
$$;

DO $migration$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('private.loomic_classify_image_message(text)'::regprocedure) INTO definition;
  IF position('private.loomic_named_image_confirmation_scope' IN definition)=0 THEN
    IF position('WHEN text ~ ''^(嗯可以' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected image classifier definition'; END IF;
    definition := replace(definition, 'WHEN text ~ ''^(嗯可以',
      'WHEN private.loomic_named_image_confirmation_scope(p_content) IS NOT NULL THEN ''confirm''
    WHEN text ~ ''^(嗯可以');
    EXECUTE definition;
  END IF;
  SELECT pg_get_functiondef('private.loomic_image_confirmation_matches_proposal(text,jsonb)'::regprocedure) INTO definition;
  IF position('private.loomic_named_image_confirmation_scope' IN definition)=0 THEN
    IF position('AND CASE WHEN scoped IS NULL THEN true ELSE' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected proposal approval definition'; END IF;
    definition := replace(definition, 'AND CASE WHEN scoped IS NULL THEN true ELSE',
      'AND (private.loomic_named_image_confirmation_scope(p_content) IS NULL OR
        position(regexp_replace(private.loomic_named_image_confirmation_scope(p_content), ''[[:space:]，。！!,.「」“”"''''：:]'', '''', ''g'')
        IN regexp_replace(lower(COALESCE(p_input->>''title'','''')), ''[[:space:]，。！!,.「」“”"''''：:]'', '''', ''g'')) > 0)
    AND CASE WHEN scoped IS NULL THEN true ELSE');
    EXECUTE definition;
  END IF;
END
$migration$;
REVOKE ALL ON FUNCTION private.loomic_named_image_confirmation_scope(text) FROM PUBLIC,anon,authenticated;
NOTIFY pgrst, 'reload schema';
