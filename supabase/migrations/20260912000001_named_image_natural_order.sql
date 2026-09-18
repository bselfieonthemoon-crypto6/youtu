-- A named image approval may place the immutable proposal name before the
-- deictic: "确认生成北岸烘焙这张海报". Keep this as a named approval so
-- the existing proposal-aware predicate must still bind the extracted scope to
-- the locked proposal input. This does not add a generic confirmation form.
CREATE OR REPLACE FUNCTION private.loomic_named_image_confirmation_scope(p_content text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path='' AS $$
  WITH parsed AS (
    SELECT regexp_match(regexp_replace(lower(btrim(COALESCE(p_content,''))),
      '[，。！!,.[:space:]]','','g'),
      '^(?:确认生成|确认并生成|同意生成|开始生成)(?:(?:这张|那张|这个|该)(.{2,60}?)(?:宣传海报|宣传图|海报|图片|标志|logo|方案)|(.{2,60}?)(?:这张|那张|这个|该)(?:宣传海报|宣传图|海报|图片|标志|logo|方案))(?:吧)?$') AS named
  ), scoped AS (
    SELECT COALESCE(named[1],named[2]) AS scope FROM parsed
  )
  SELECT CASE WHEN p_content !~ '[?？]'
    AND scope !~ '(如果|假如|除非|免费|不要|不生成|取消|暂停|暂不|稍后|但是|另外|同时|并且|还要|(?:改|换|调整|修改|替换)(?:成|为|到)|增加|新增|添加|删除|去掉|两张|多张|一组|批量)'
    THEN scope END FROM scoped
$$;

REVOKE ALL ON FUNCTION private.loomic_named_image_confirmation_scope(text)
  FROM PUBLIC,anon,authenticated;
NOTIFY pgrst, 'reload schema';
