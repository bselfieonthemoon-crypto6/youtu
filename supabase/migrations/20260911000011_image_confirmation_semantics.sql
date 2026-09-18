-- Keep natural confirmation, cancellation, acknowledgement, questions and
-- changed requirements as distinct states. Only the exact `confirm` state is
-- accepted by the paid decision RPC. A deictic reference to a revision that
-- was already frozen (for example, "确认，按这次修改生成。") remains in the
-- current proposal chain without turning arbitrary edit text into approval.

CREATE FUNCTION private.loomic_classify_image_message(p_content text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path=''
AS $$
  WITH normalized AS (
    SELECT
      btrim(COALESCE(p_content,'')) AS raw,
      regexp_replace(lower(btrim(COALESCE(p_content,''))), '[，。！!,.[:space:]]', '', 'g') AS text
  ), classified AS (
    SELECT raw, text, regexp_match(
      text,
      '^(确认执行|确认生成|确认并生成|同意执行|同意生成|开始执行|开始生成)(这个|该|此|上述)(.{1,80})(图片)?方案(其他|其余)(.{1,80})(暂不执行|先不执行|不执行|暂不生成|先不生成|不生成|暂不处理|先不处理|不处理)(即可|就好)?$'
    ) AS scoped
    FROM normalized
  )
  SELECT CASE
    WHEN raw ~ '[?？]' OR text ~ '(吗|么)$' OR text ~ '(是否|能否|可否)' THEN 'question'
    WHEN raw ~ '^(取消|取消生成|不生成|不要生成|先不生成|算了|不要了)[。！![:space:]]*$' THEN 'cancel'
    WHEN text ~ '^(确认生成|确认并生成|同意生成|可以生成|开始生成|继续生成|重试生成|重新生成|按原方案重试生成|沿用原方案重试生成|重试刚才失败的图片|重新生成刚才失败的图片|继续刚才的失败任务|就按这个生成|按这个生成|确认就按这个生成|确认请按上述方案继续执行并生成预览|confirmgeneration|startgeneration|generateit|proceedwithgeneration)$' THEN 'confirm'
    WHEN text ~ '^((确认|同意|好的|好|可以)(就)?|就)?按(这个|该|此|上述)(图片)?方案(继续)?(执行并)?生成(吧|图片|预览)?$' THEN 'confirm'
    WHEN text ~ '^(确认|同意)(就)?按(这次|本次|刚才|上述)的?(修改|调整)(后|后的)?(图片)?(方案)?(继续)?(执行并)?生成(图片|预览)?$' THEN 'confirm'
    WHEN char_length(text) <= 240 AND scoped IS NOT NULL
      AND concat(scoped[3],scoped[6]) !~ '(如果|假如|除非|只要|前提|免费|不要|不生成|先别|取消|尚未|未同意|不同意|拒绝|没有|暂停|暂不|等等|稍后|以后|但是|不过|而是|或者|另外|同时|并且|还要|再生成|多张|一组|多个|批量|改|换|调整|修改|替换|增加|新增|添加|删除|去掉)'
      THEN 'confirm'
    WHEN char_length(text) <= 180
      AND text !~ '(如果|假如|除非|只要|前提|免费|不要|不生成|先别|取消|尚未|未同意|不同意|拒绝|没有|暂停|暂不|等等|稍后|以后|但是|不过|而是|或者|另外|同时|并且|还要|再生成|两张|2张|三张|3张|多张|一组|多个|批量|改|换|调整|修改|替换|增加|新增|添加|删除|去掉|尺寸|比例|颜色|背景|文案|文字)'
      AND text ~ '^(确认生成|确认并生成|同意生成|开始生成)刚才(保存|冻结)的?.{0,80}(图片)?方案(按(该|此|这个|上述)方案)?(继续)?(执行并)?(生成(一张|一张图片|图片|预览)?)?$'
      THEN 'confirm'
    WHEN text ~ '^(嗯可以|嗯|可以|好的|好|行|收到|知道了|明白了|ok|okay)$' THEN 'acknowledge'
    WHEN text ~ '(改|换|调整|修改|替换|增加|新增|添加|删除|去掉|再生成|两张|2张|三张|3张|多张|一组|多个|批量)' THEN 'change'
    ELSE 'other'
  END
  FROM classified
$$;

CREATE OR REPLACE FUNCTION private.loomic_is_image_confirmation_message(p_content text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=''
AS $$ SELECT private.loomic_classify_image_message(p_content)='confirm' $$;

CREATE OR REPLACE FUNCTION private.loomic_is_image_cancellation_message(p_content text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=''
AS $$ SELECT private.loomic_classify_image_message(p_content)='cancel' $$;

CREATE OR REPLACE FUNCTION private.loomic_is_image_acknowledgement(p_content text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=''
AS $$ SELECT private.loomic_classify_image_message(p_content)='acknowledge' $$;

CREATE OR REPLACE FUNCTION private.loomic_is_image_decision_message(p_content text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=''
AS $$ SELECT private.loomic_classify_image_message(p_content) IN ('confirm','cancel','acknowledge') $$;

REVOKE ALL ON FUNCTION private.loomic_classify_image_message(text) FROM PUBLIC,anon,authenticated;

NOTIFY pgrst, 'reload schema';
