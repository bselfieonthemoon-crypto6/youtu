-- A new, explicit confirmation turn may create one new attempt from the exact
-- frozen plan only when the previous provider request was definitely rejected
-- before dispatch. Unknown provider outcomes remain permanently replay-only.

ALTER TABLE public.image_generation_proposals
  ADD COLUMN retry_of uuid REFERENCES public.image_generation_proposals(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX image_proposal_retry_request_idx
  ON public.image_generation_proposals(retry_of,requirement_message_id)
  WHERE retry_of IS NOT NULL AND requirement_message_id IS NOT NULL;

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
      regexp_replace(lower(btrim(COALESCE(p_content,''))), '[，。！!,.[:space:]]', '', 'g') AS text
  ), classified AS (
    SELECT raw, text, regexp_match(
      text,
      '^(确认执行|确认生成|确认并生成|同意执行|同意生成|开始执行|开始生成)(这个|该|此|上述)(.{1,80})(图片)?方案(其他|其余)(.{1,80})(暂不执行|先不执行|不执行|暂不生成|先不生成|不生成|暂不处理|先不处理|不处理)(即可|就好)?$'
    ) AS scoped
    FROM normalized
  )
  SELECT
    text ~ '^(确认生成|确认并生成|同意生成|可以生成|开始生成|继续生成|重试生成|重新生成|按原方案重试生成|沿用原方案重试生成|重试刚才失败的图片|重新生成刚才失败的图片|继续刚才的失败任务|就按这个生成|按这个生成|确认就按这个生成|确认请按上述方案继续执行并生成预览|confirmgeneration|startgeneration|generateit|proceedwithgeneration)$'
    OR (
      char_length(text) <= 240 AND raw !~ '[?？]' AND scoped IS NOT NULL
      AND concat(scoped[3],scoped[6]) !~ '(如果|假如|除非|只要|前提|免费|不要|不生成|先别|取消|尚未|未同意|不同意|拒绝|没有|暂停|暂不|等等|稍后|以后|但是|不过|而是|或者|另外|同时|并且|还要|再生成|多张|一组|多个|批量|改|换|调整|修改|替换|增加|新增|添加|删除|去掉)'
    )
    OR (
      char_length(text) <= 180 AND raw !~ '[?？]'
      AND text !~ '(如果|假如|除非|只要|前提|免费|不要|不生成|先别|取消|尚未|未同意|不同意|拒绝|没有|暂停|暂不|等等|稍后|以后|但是|不过|而是|或者|另外|同时|并且|还要|再生成|两张|2张|三张|3张|多张|一组|多个|批量|改|换|调整|修改|替换|增加|新增|添加|删除|去掉|尺寸|比例|颜色|背景|文案|文字)'
      AND text ~ '^(确认生成|确认并生成|同意生成|开始生成)刚才(保存|冻结)的?.{0,80}(图片)?方案(按(该|此|这个|上述)方案)?(继续)?(执行并)?(生成(一张|一张图片|图片|预览)?)?$'
    )
  FROM classified
$$;

CREATE FUNCTION public.loomic_retry_definite_image_failure(
  p_id uuid,
  p_session uuid,
  p_canvas uuid,
  p_run uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  source_proposal public.image_generation_proposals;
  source_job public.background_jobs;
  current_message_id uuid;
  current_content text;
  current_message_created_at timestamptz;
  current_proposal jsonb;
  retry_proposal public.image_generation_proposals;
BEGIN
  -- Serialize with chat writes and other retries across all API instances.
  PERFORM 1 FROM public.chat_sessions s JOIN public.canvases c ON c.id=s.canvas_id
    WHERE s.id=p_session AND s.canvas_id=p_canvas AND s.created_by=auth.uid()
      AND EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=c.workspace_id AND m.user_id=auth.uid())
    FOR UPDATE OF s;
  IF NOT FOUND THEN RAISE EXCEPTION 'image_session_forbidden'; END IF;

  SELECT message.id,message.content,message.created_at INTO current_message_id,current_content,current_message_created_at
  FROM public.agent_runs run
  JOIN public.chat_messages message ON message.id=run.request_message_id
  WHERE run.id=p_run AND run.session_id=p_session AND run.created_by=auth.uid()
    AND message.session_id=p_session AND message.role='user'
    AND message.content=run.request_prompt;
  IF current_message_id IS NULL OR NOT private.loomic_is_image_confirmation_message(current_content) THEN
    RAISE EXCEPTION 'image_retry_explicit_confirmation_required';
  END IF;

  -- A concurrent API instance may already have cloned this exact attempt.
  -- Resolve that receipt before the clone becomes the newest current proposal.
  SELECT * INTO retry_proposal FROM public.image_generation_proposals
    WHERE retry_of=p_id AND requirement_message_id=current_message_id
      AND session_id=p_session AND canvas_id=p_canvas AND created_by=auth.uid();
  IF retry_proposal.id IS NOT NULL THEN RETURN to_jsonb(retry_proposal); END IF;

  current_proposal:=public.loomic_get_current_image_proposal(p_session,p_canvas,p_run);
  IF current_proposal IS NULL OR current_proposal->>'id' IS DISTINCT FROM p_id::text THEN
    RAISE EXCEPTION 'image_retry_current_proposal_required';
  END IF;

  SELECT * INTO source_proposal FROM public.image_generation_proposals
    WHERE id=p_id AND session_id=p_session AND canvas_id=p_canvas
      AND created_by=auth.uid() AND status='confirmed' FOR UPDATE;
  SELECT * INTO source_job FROM public.background_jobs
    WHERE id=p_id AND session_id=p_session AND created_by=auth.uid() FOR UPDATE;
  IF source_proposal.id IS NULL OR source_job.id IS NULL OR source_job.status::text<>'dead_letter' THEN
    RAISE EXCEPTION 'image_retry_terminal_failure_required';
  END IF;
  -- A tool loop in the same user turn is not fresh authorization to spend.
  IF source_job.created_at >= current_message_created_at
    OR source_proposal.requirement_message_id=current_message_id THEN
    RAISE EXCEPTION 'image_retry_new_user_turn_required';
  END IF;
  IF source_proposal.approved_cost IS NULL THEN RAISE EXCEPTION 'image_retry_price_missing'; END IF;

  -- New rows use a structured code. The exact two-part legacy match repairs
  -- historical rows that wrapped this explicit pre-dispatch rejection as an
  -- unknown result; a generic 503 or unknown message is deliberately excluded.
  IF source_job.error_code IS DISTINCT FROM 'provider_rejected'
    AND NOT (
      source_job.error_code='image_generation_result_unknown'
      AND source_job.error_message ~* '503[[:space:]]*获取分组[[:space:]]+default[[:space:]]+下模型'
      AND source_job.error_message ~* '[（(]distributor[）)]'
      AND source_job.error_message ~* '\mno available channel\M'
    ) THEN
    RAISE EXCEPTION 'image_retry_result_not_definite';
  END IF;

  INSERT INTO public.image_generation_proposals(
    session_id,canvas_id,created_by,origin_run_id,requirement_message_id,
    input,details,approved_cost,status,expires_at,retry_of
  ) VALUES (
    p_session,p_canvas,auth.uid(),p_run,current_message_id,
    source_proposal.input,source_proposal.details,source_proposal.approved_cost,
    'confirmed',now()+interval '24 hours',p_id
  ) RETURNING * INTO retry_proposal;
  RETURN to_jsonb(retry_proposal);
END
$$;

REVOKE ALL ON FUNCTION public.loomic_retry_definite_image_failure(uuid,uuid,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.loomic_retry_definite_image_failure(uuid,uuid,uuid,uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
