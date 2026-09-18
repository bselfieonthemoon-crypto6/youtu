-- A user may explicitly approve the current frozen proposal while declining
-- other offered image scopes in the same sentence. This remains only a message
-- predicate: loomic_get_current_image_proposal and loomic_decide_current_image
-- still bind the decision to the authenticated session/canvas/run, exact
-- current requirement and proposal id. The latter also gets an additional
-- fail-closed check against the immutable proposal input.

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
  ), classified AS (
    SELECT raw, text, regexp_match(
      text,
      '^(确认执行|确认生成|确认并生成|同意执行|同意生成|开始执行|开始生成)(这个|该|此|上述)(.{1,80})(图片)?方案(其他|其余)(.{1,80})(暂不执行|先不执行|不执行|暂不生成|先不生成|不生成|暂不处理|先不处理|不处理)(即可|就好)?$'
    ) AS scoped
    FROM normalized
  )
  SELECT
    text ~ '^(确认生成|确认并生成|同意生成|可以生成|开始生成|继续生成|就按这个生成|按这个生成|确认就按这个生成|确认请按上述方案继续执行并生成预览|confirmgeneration|startgeneration|generateit|proceedwithgeneration)$'
    OR (
      char_length(text) <= 240
      AND raw !~ '[?？]'
      AND scoped IS NOT NULL
      AND concat(scoped[3],scoped[6]) !~ '(如果|假如|除非|只要|前提|免费|不要|不生成|先别|取消|尚未|未同意|不同意|拒绝|没有|暂停|暂不|等等|稍后|以后|但是|不过|而是|或者|另外|同时|并且|还要|再生成|多张|一组|多个|批量|改|换|调整|修改|替换|增加|新增|添加|删除|去掉)'
    )
    OR (
      char_length(text) <= 180
      AND raw !~ '[?？]'
      AND text !~ '(如果|假如|除非|只要|前提|免费|不要|不生成|先别|取消|尚未|未同意|不同意|拒绝|没有|暂停|暂不|等等|稍后|以后|但是|不过|而是|或者|另外|同时|并且|还要|再生成|两张|2张|三张|3张|多张|一组|多个|批量|改|换|调整|修改|替换|增加|新增|添加|删除|去掉|尺寸|比例|颜色|背景|文案|文字)'
      AND text ~ '^(确认生成|确认并生成|同意生成|开始生成)刚才(保存|冻结)的?.{0,80}(图片)?方案(按(该|此|这个|上述)方案)?(继续)?(执行并)?(生成(一张|一张图片|图片|预览)?)?$'
    )
  FROM classified
$$;

CREATE FUNCTION private.loomic_image_confirmation_matches_proposal(p_content text,p_input jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path=''
AS $$
  WITH normalized AS (
    SELECT regexp_replace(
      lower(btrim(COALESCE(p_content,''))),
      '[，。！!,.[:space:]]',
      '',
      'g'
    ) AS text
  ), parsed AS (
    SELECT text, regexp_match(
      text,
      '^(确认执行|确认生成|确认并生成|同意执行|同意生成|开始执行|开始生成)(这个|该|此|上述)(.{1,80})(图片)?方案(其他|其余)(.{1,80})(暂不执行|先不执行|不执行|暂不生成|先不生成|不生成|暂不处理|先不处理|不处理)(即可|就好)?$'
    ) AS scoped
    FROM normalized
  ), requirements AS (
    SELECT text, scoped, COALESCE(scoped[3],'') AS approved_scope
    FROM parsed
  )
  SELECT COALESCE(
    private.loomic_is_image_confirmation_message(p_content)
    AND CASE WHEN scoped IS NULL THEN true ELSE
      approved_scope ~ '(png|jpg|jpeg|webp|透明|去背景|移除背景|删除背景|抠图)'
      AND NOT (approved_scope ~ '(png|透明)' AND approved_scope ~ '(jpg|jpeg|webp)')
      AND NOT (approved_scope ~ '(jpg|jpeg)' AND approved_scope ~ 'webp')
      AND (approved_scope !~ '(png|透明)' OR p_input->>'outputFormat'='png')
      AND (approved_scope !~ '(jpg|jpeg)' OR p_input->>'outputFormat'='jpg')
      AND (approved_scope !~ 'webp' OR p_input->>'outputFormat'='webp')
      AND (approved_scope !~ '(透明|去背景|移除背景|删除背景|抠图)'
        OR p_input->>'operation'='remove_background'
        OR jsonb_typeof(p_input->'foregroundPolicy')='object')
    END,
    false
  )
  FROM requirements
$$;

-- Add the proposal-input match immediately after the existing locked proposal
-- and requirement-sequence check. Abort instead of silently replacing a
-- definition whose ownership, freshness, expiry, or idempotency fences differ.
DO $scoped_confirmation_guard$
DECLARE
  definition text;
  old_clause text := 'IF proposal.id IS NULL OR requirement_sequence>current_sequence THEN RETURN NULL; END IF;';
  new_clause text := 'IF proposal.id IS NULL OR requirement_sequence>current_sequence THEN RETURN NULL; END IF;
  IF p_decision=''confirm'' AND NOT private.loomic_image_confirmation_matches_proposal(current_content,proposal.input) THEN RETURN NULL; END IF;';
BEGIN
  SELECT pg_get_functiondef('public.loomic_decide_current_image(uuid,uuid,uuid,uuid,text)'::regprocedure) INTO definition;
  IF array_length(string_to_array(definition, old_clause), 1) - 1 <> 1 THEN
    RAISE EXCEPTION 'Unexpected decide-current-image definition; review migration before applying';
  END IF;
  EXECUTE replace(definition, old_clause, new_clause);
END
$scoped_confirmation_guard$;

NOTIFY pgrst, 'reload schema';
