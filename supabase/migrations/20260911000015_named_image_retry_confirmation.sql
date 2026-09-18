-- A natural retry may preserve the exact confirmed proposal only when its
-- explicit name and ratio both match immutable proposal input. The syntax-only
-- classifier keeps the proposal chain visible; the proposal-aware predicate is
-- the paid boundary and fails closed for a changed or missing field.
-- Migration 14 rejected any named scope containing the character "改". That
-- also rejected immutable revision labels such as "暖橙改色版". Keep the
-- closed sentence grammar and title binding, but reject imperative edit forms
-- instead of a single character inside a legitimate title.
CREATE OR REPLACE FUNCTION private.loomic_named_image_confirmation_scope(p_content text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path='' AS $$
  WITH parsed AS (
    SELECT regexp_match(regexp_replace(lower(btrim(COALESCE(p_content,''))),
      '[，。！!,.[:space:]]','','g'),
      '^(?:确认生成|确认并生成|同意生成|开始生成)(?:这张|那张|这个|该)(.{2,60}?)(?:宣传海报|宣传图|海报|图片|标志|logo|方案)(?:吧)?$') AS named
  )
  SELECT CASE WHEN p_content !~ '[?？]'
    AND named[1] !~ '(如果|假如|除非|免费|不要|不生成|取消|暂停|暂不|稍后|但是|另外|同时|并且|还要|(?:改|换|调整|修改|替换)(?:成|为|到)|增加|新增|添加|删除|去掉|两张|多张|一组|批量)'
    THEN named[1] END FROM parsed
$$;

CREATE FUNCTION private.loomic_named_image_retry_confirmation_parts(p_content text)
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path='' AS $$
  WITH parsed AS (
    SELECT regexp_match(regexp_replace(lower(btrim(COALESCE(p_content,''))),
      '[，。！!,.[:space:]]','','g'),
      '^(?:重试|重新生成)(?:还是)?(?:刚才|上次)(?:已)?确认的(.{2,60}?)(?:宣传海报|宣传图|海报|图片|标志|logo|方案)(?:比例)?([1-9][0-9]{0,3}:[1-9][0-9]{0,3})其他不变(?:即可|就好)?$') AS parts
  )
  SELECT CASE WHEN p_content !~ '[?？]'
    AND parts[1] !~ '(如果|假如|除非|免费|不要|不生成|取消|暂停|暂不|稍后|但是|另外|同时|并且|还要|(?:改|换|调整|修改|替换)(?:成|为|到)|增加|新增|添加|删除|去掉|两张|多张|一组|批量)'
    THEN parts END FROM parsed
$$;

CREATE FUNCTION private.loomic_named_image_retry_confirmation_matches_proposal(p_content text,p_input jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path='' AS $$
  WITH parsed AS (
    SELECT private.loomic_named_image_retry_confirmation_parts(p_content) AS parts
  )
  SELECT COALESCE(parts IS NOT NULL
    AND position(regexp_replace(parts[1], '[[:space:]，。！!,.「」“”"'':：]', '', 'g')
      IN regexp_replace(lower(COALESCE(p_input->>'title','')), '[[:space:]，。！!,.「」“”"'':：]', '', 'g')) > 0
    AND regexp_replace(COALESCE(p_input->>'aspectRatio',''), '[[:space:]]', '', 'g')=parts[2], false)
  FROM parsed
$$;

DO $migration$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('private.loomic_classify_image_message(text)'::regprocedure) INTO definition;
  IF position('private.loomic_named_image_retry_confirmation_parts' IN definition)=0 THEN
    IF position('WHEN private.loomic_named_image_confirmation_scope(p_content) IS NOT NULL THEN ''confirm''' IN definition)=0 THEN
      RAISE EXCEPTION 'Unexpected image classifier definition';
    END IF;
    definition := replace(definition,
      'WHEN private.loomic_named_image_confirmation_scope(p_content) IS NOT NULL THEN ''confirm''',
      'WHEN private.loomic_named_image_retry_confirmation_parts(p_content) IS NOT NULL THEN ''confirm''
    WHEN private.loomic_named_image_confirmation_scope(p_content) IS NOT NULL THEN ''confirm''');
    EXECUTE definition;
  END IF;

  SELECT pg_get_functiondef('private.loomic_image_confirmation_matches_proposal(text,jsonb)'::regprocedure) INTO definition;
  IF position('private.loomic_named_image_retry_confirmation_matches_proposal' IN definition)=0 THEN
    IF position('AND (private.loomic_named_image_confirmation_scope(p_content) IS NULL OR' IN definition)=0 THEN
      RAISE EXCEPTION 'Unexpected proposal approval definition';
    END IF;
    definition := replace(definition,
      'AND (private.loomic_named_image_confirmation_scope(p_content) IS NULL OR',
      'AND (private.loomic_named_image_retry_confirmation_parts(p_content) IS NULL OR
        private.loomic_named_image_retry_confirmation_matches_proposal(p_content,p_input))
    AND (private.loomic_named_image_confirmation_scope(p_content) IS NULL OR');
    EXECUTE definition;
  END IF;
END
$migration$;

REVOKE ALL ON FUNCTION private.loomic_named_image_confirmation_scope(text),
  private.loomic_named_image_retry_confirmation_parts(text),
  private.loomic_named_image_retry_confirmation_matches_proposal(text,jsonb)
  FROM PUBLIC,anon,authenticated;
NOTIFY pgrst, 'reload schema';
