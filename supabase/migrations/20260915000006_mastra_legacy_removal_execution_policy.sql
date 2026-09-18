-- Legacy background-removal execution is fixed Medium + 1K; reject mismatched paid tiers before INSERT.
CREATE OR REPLACE FUNCTION public.loomic_mastra_image_execution_guard()
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
  requested_max:=public.loomic_image_requested_output_count(request_text);
  IF requested_max IS NOT NULL AND (requested_max<1 OR requested_max>8) THEN RAISE EXCEPTION 'image_generation_requested_count_unsupported'; END IF;
  IF NEW.payload->>'quality'='hd' AND NOT public.loomic_image_tier_authorized(request_text,'((?<![A-Za-z0-9_])(medium|hd)(?![A-Za-z0-9_])|中(等|档)质量|中等画质)')
    OR NEW.payload->>'quality'='ultra' AND NOT public.loomic_image_tier_authorized(request_text,'((?<![A-Za-z0-9_])(high|ultra)(?![A-Za-z0-9_])|高(等|档)?质量|高画质)') THEN
    RAISE EXCEPTION 'image_quality_not_authorized'; END IF;
  IF NEW.payload->>'resolution'='2k' AND NOT public.loomic_image_tier_authorized(request_text,'((?<![A-Za-z0-9_])2[[:space:]]*k(?![A-Za-z0-9_]))')
    OR NEW.payload->>'resolution'='4k' AND NOT public.loomic_image_tier_authorized(request_text,'((?<![A-Za-z0-9_])4[[:space:]]*k(?![A-Za-z0-9_]))') THEN
    RAISE EXCEPTION 'image_resolution_not_authorized'; END IF;
  IF coalesce(NEW.payload->>'quality','standard') NOT IN ('standard','hd','ultra')
    OR coalesce(NEW.payload->>'resolution','1k') NOT IN ('1k','2k','4k') THEN RAISE EXCEPTION 'image_execution_tier_invalid'; END IF;
  IF NEW.payload->>'operation'='remove_background' AND (coalesce(NEW.payload->>'quality','standard')<>'hd'
    OR coalesce(NEW.payload->>'resolution','1k')<>'1k') THEN RAISE EXCEPTION 'image_legacy_background_removal_contract_required'; END IF;
  run_limit:=coalesce(requested_max,CASE WHEN NEW.payload->>'mastra_default_run_limit' ~ '^[1-4]$'
    THEN (NEW.payload->>'mastra_default_run_limit')::integer ELSE 4 END);
  SELECT count(*) INTO used FROM public.background_jobs job WHERE job.job_type::text='image_generation'
    AND job.created_by=NEW.created_by AND job.session_id=NEW.session_id AND job.payload->>'mastra_origin_run_id'=run.id::text;
  IF used>=run_limit THEN RAISE EXCEPTION 'image_generation_run_limit'; END IF;
  RETURN NEW;
END $$;


NOTIFY pgrst,'reload schema';
