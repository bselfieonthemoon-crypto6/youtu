-- Enforce paid tiers and per-turn output count at the durable INSERT boundary.
-- The request message associated with the owned run is the authorization source.
CREATE FUNCTION public.loomic_image_authorization_text(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(p_text,''),
    '```[^`]*```','','g'), '(^|\n)[[:space:]]*>[^\n]*','','g'),
    '[“「『][^”」』]*[”」』]','','g'), '"[^"\n]*"','','g');
$$;

CREATE FUNCTION public.loomic_image_tier_authorized(p_text text,p_tier text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE original text; clause text; tier_match text[]; prefix text; suffix text;
BEGIN
  FOR original IN SELECT regexp_split_to_table(public.loomic_image_authorization_text(p_text),'[。！？!?;；\n]') LOOP
    clause:=regexp_replace(original,'([124][[:space:]]*k|high|medium|hd|ultra)[[:space:]]*(参考图|原图|素材|reference|source)','','gi');
    IF clause ~* '(为什么|为何|检查|参数|讨论|解释|是否|吗|(?<![A-Za-z0-9_])why(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])check(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])explain(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])whether(?![A-Za-z0-9_]))'
      OR clause ~* '(不要|不需要|不使用|别用|禁止|勿|无需|不升级|不允许|do[[:space:]]+not|don[''’]t|without|never|no[[:space:]]+)' THEN CONTINUE; END IF;
    tier_match:=regexp_match(clause,p_tier,'i');
    IF tier_match IS NULL THEN CONTINUE; END IF;
    prefix:=substring(clause FROM 1 FOR strpos(lower(clause),lower(tier_match[1]))-1);
    suffix:=substring(clause FROM strpos(lower(clause),lower(tier_match[1]))+length(tier_match[1]));
    IF tier_match[1] ~* '(high|ultra|medium|hd|质量|画质)' THEN
      IF suffix ~* '^[[:space:]]*(contrast|[- ]?sized?|3d|风格|style)' THEN CONTINUE; END IF;
      IF prefix ~* '(quality|画质|质量)(档位)?[[:space:]]*[:：=]?[[:space:]]*$'
        OR prefix ~* '(使用|选用|选择|用|use|select|choose)[[:space:]]*$'
        OR prefix ~ '^[[:space:]]*$' AND suffix ~* '^[[:space:]]*(quality|画质|质量|档|[+＋,，/]|$)'
        OR suffix ~* '^[[:space:]]*(quality|画质|质量)' AND prefix ~* '(生成|制作|输出|做|generate|create|make|produce|output|render)[[:space:]]*[^,，]{0,24}$'
        THEN RETURN true; END IF;
      CONTINUE;
    END IF;
    IF prefix ~* '(quality|resolution|画质|质量|分辨率)(档位)?[[:space:]]*[:：=][[:space:]]*$'
      OR prefix ~* '(生成|制作|输出|做|给我|使用|选用|选择|用|generate|create|make|produce|use|output|render)[[:space:]]*[^,，]{0,24}$'
      OR prefix ~* '^[[:space:]]*((low|standard|high|medium|ultra|hd)[[:space:]]*[+＋,，/][[:space:]]*)?$'
      THEN RETURN true; END IF;
  END LOOP;
  RETURN false;
END $$;

CREATE FUNCTION public.loomic_image_requested_output_count(p_text text)
RETURNS integer LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE clause text; directive text[]; total_match text[]; output_match text[]; outputs text;
  before_text text; after_text text; number_text text; requested integer; total integer:=0; found boolean:=false;
BEGIN
  FOR clause IN SELECT regexp_split_to_table(public.loomic_image_authorization_text(p_text),'[。！？!?;；\n]') LOOP
    IF clause ~* '(不要|不需要|别|禁止|勿|无需|为什么|检查|讨论|解释|是否|吗|(?<![A-Za-z0-9_])why(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])check(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])explain(?![A-Za-z0-9_])|do[[:space:]]+not|don[''’]t)' THEN CONTINUE; END IF;
    directive:=regexp_match(clause,'(生成|制作|输出|给我|做|generate|create|make|produce)','i');
    IF directive IS NULL THEN CONTINUE; END IF;
    total_match:=regexp_match(clause,'(一共|总共|合计|共|总计|in[[:space:]]+total|total([[:space:]]+of)?)[[:space:]]*(生成|制作|输出|generate|create|make|produce)?[[:space:]]*(exactly[[:space:]]*)?([0-9]{1,3}|[一二两三四五六七八九十])[[:space:]]*(张|幅|images?(?![A-Za-z0-9_])|outputs?(?![A-Za-z0-9_])|pictures?(?![A-Za-z0-9_]))','i');
    IF total_match IS NOT NULL THEN number_text:=total_match[5]; ELSE number_text:=NULL; END IF;
    IF number_text IS NOT NULL THEN
      RETURN CASE number_text WHEN '一' THEN 1 WHEN '二' THEN 2 WHEN '两' THEN 2 WHEN '三' THEN 3 WHEN '四' THEN 4 WHEN '五' THEN 5
        WHEN '六' THEN 6 WHEN '七' THEN 7 WHEN '八' THEN 8 WHEN '九' THEN 9 WHEN '十' THEN 10 ELSE number_text::integer END;
    END IF;
    outputs:=substring(clause FROM strpos(lower(clause),lower(directive[1]))+length(directive[1]));
    LOOP
      output_match:=regexp_match(outputs,'^(.*?)([0-9]{1,3}|[一二两三四五六七八九十])[[:space:]]*(?:张|幅|个(?:图片|版本|方案)|images?(?![A-Za-z0-9_])|outputs?(?![A-Za-z0-9_])|pictures?(?![A-Za-z0-9_]))(.*)$','i');
      EXIT WHEN output_match IS NULL;
      before_text:=output_match[1];
      number_text:=output_match[2];
      after_text:=output_match[3];
      IF after_text !~* '^[[:space:]]*(参考|原图|素材|上传|输入|reference|source|input)'
        AND coalesce(before_text,'') !~* '(每张|包含|元素|参考|上传|input|reference|each)[^,，和及]{0,12}$' THEN

        requested:=CASE number_text WHEN '一' THEN 1 WHEN '二' THEN 2 WHEN '两' THEN 2 WHEN '三' THEN 3 WHEN '四' THEN 4 WHEN '五' THEN 5
          WHEN '六' THEN 6 WHEN '七' THEN 7 WHEN '八' THEN 8 WHEN '九' THEN 9 WHEN '十' THEN 10 ELSE number_text::integer END;
        total:=total+requested; found:=true;
      END IF;
      outputs:=after_text;
    END LOOP;
  END LOOP;
  RETURN CASE WHEN found THEN total ELSE NULL END;
END $$;

CREATE FUNCTION public.loomic_mastra_image_execution_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE run public.agent_runs; request_text text; text_match text[];
  requested integer; requested_max integer:=NULL; run_limit integer; used integer;
BEGIN
  IF NEW.job_type::text<>'image_generation' OR NOT (NEW.payload ? 'mastra_submission_key') THEN RETURN NEW; END IF;
  -- Serializes distinct submissions across processes, tools and reconstructed runtimes.
  SELECT r.* INTO run FROM public.agent_runs r
    WHERE r.id::text=NEW.payload->>'mastra_origin_run_id' AND r.created_by=NEW.created_by
      AND r.session_id=NEW.session_id AND r.status::text IN ('accepted','running') FOR UPDATE;
  IF run.id IS NULL THEN RAISE EXCEPTION 'mastra_image_submission_forbidden'; END IF;
  SELECT message.content INTO request_text FROM public.chat_messages message
    JOIN public.chat_sessions session ON session.id=message.session_id
    JOIN public.canvases canvas ON canvas.id=session.canvas_id
    WHERE message.id=run.request_message_id AND message.session_id=run.session_id AND message.role='user'
      AND canvas.id=NEW.canvas_id AND canvas.workspace_id=NEW.workspace_id
      AND EXISTS (SELECT 1 FROM public.workspace_members member WHERE member.workspace_id=NEW.workspace_id AND member.user_id=NEW.created_by);
  IF request_text IS NULL THEN RAISE EXCEPTION 'mastra_image_submission_forbidden'; END IF;
  IF NEW.payload->>'quality'='hd' AND NOT public.loomic_image_tier_authorized(request_text,'((?<![A-Za-z0-9_])(medium|hd)(?![A-Za-z0-9_])|中(等|档)质量|中等画质)')
    OR NEW.payload->>'quality'='ultra' AND NOT public.loomic_image_tier_authorized(request_text,'((?<![A-Za-z0-9_])(high|ultra)(?![A-Za-z0-9_])|高(等|档)?质量|高画质)') THEN
    RAISE EXCEPTION 'image_quality_not_authorized'; END IF;
  IF NEW.payload->>'resolution'='2k' AND NOT public.loomic_image_tier_authorized(request_text,'((?<![A-Za-z0-9_])2[[:space:]]*k(?![A-Za-z0-9_]))')
    OR NEW.payload->>'resolution'='4k' AND NOT public.loomic_image_tier_authorized(request_text,'((?<![A-Za-z0-9_])4[[:space:]]*k(?![A-Za-z0-9_]))') THEN
    RAISE EXCEPTION 'image_resolution_not_authorized'; END IF;
  requested_max:=public.loomic_image_requested_output_count(request_text);
  IF requested_max IS NOT NULL AND (requested_max<1 OR requested_max>8) THEN RAISE EXCEPTION 'image_generation_requested_count_unsupported'; END IF;
  run_limit:=coalesce(requested_max,CASE WHEN NEW.payload->>'mastra_default_run_limit' ~ '^[1-4]$'
    THEN (NEW.payload->>'mastra_default_run_limit')::integer ELSE 4 END);
  SELECT count(*) INTO used FROM public.background_jobs job WHERE job.job_type::text='image_generation'
    AND job.created_by=NEW.created_by AND job.session_id=NEW.session_id AND job.payload->>'mastra_origin_run_id'=run.id::text;
  IF used>=run_limit THEN RAISE EXCEPTION 'image_generation_run_limit'; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER background_jobs_mastra_image_execution_guard BEFORE INSERT ON public.background_jobs
  FOR EACH ROW EXECUTE FUNCTION public.loomic_mastra_image_execution_guard();
REVOKE ALL ON FUNCTION public.loomic_mastra_image_execution_guard() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.loomic_image_authorization_text(text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.loomic_image_tier_authorized(text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.loomic_image_requested_output_count(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_image_authorization_text(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.loomic_image_tier_authorized(text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.loomic_image_requested_output_count(text) TO service_role;
NOTIFY pgrst,'reload schema';
