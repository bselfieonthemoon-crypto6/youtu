-- Accept an explicit natural-language confirmation that names the immediately
-- preceding frozen proposal. Revised, conditional, questioning, negative, and
-- ambiguous messages remain new requirements and cannot authorize billing.

CREATE OR REPLACE FUNCTION private.loomic_is_image_confirmation_message(p_content text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path=''
AS $$
  WITH normalized AS (
    SELECT
      btrim(COALESCE(p_content,'')) AS raw,
      regexp_replace(
        lower(btrim(COALESCE(p_content,''))),
        '[，。！!,.[:space:]]',
        '',
        'g'
      ) AS text
  )
  SELECT
    text ~ '^(确认生成|确认并生成|同意生成|可以生成|开始生成|继续生成|就按这个生成|按这个生成|确认就按这个生成|确认请按上述方案继续执行并生成预览|confirmgeneration|startgeneration|generateit|proceedwithgeneration)$'
    OR (
      char_length(text) <= 180
      AND raw !~ '[?？]'
      AND text !~ '(如果|假如|除非|只要|前提|免费|不要|不生成|先别|取消|尚未|未同意|不同意|拒绝|没有|暂停|暂不|等等|稍后|以后|但是|不过|而是|或者|另外|同时|并且|还要|再生成|两张|2张|三张|3张|多张|一组|多个|批量|改|换|调整|修改|替换|增加|新增|添加|删除|去掉|尺寸|比例|颜色|背景|文案|文字)'
      AND text ~ '^(确认生成|确认并生成|同意生成|开始生成)刚才(保存|冻结)的?.{0,80}(图片)?方案(按(该|此|这个|上述)方案)?(继续)?(执行并)?(生成(一张|一张图片|图片|预览)?)?$'
    )
  FROM normalized
$$;

NOTIFY pgrst, 'reload schema';
