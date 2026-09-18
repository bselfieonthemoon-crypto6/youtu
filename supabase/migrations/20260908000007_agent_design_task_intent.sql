-- Explicit design tasks only: ordinary chat never advances this durable revision.
CREATE TABLE public.agent_design_tasks (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL UNIQUE REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  canvas_id uuid NOT NULL REFERENCES public.canvases(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision > 0),
  current_run_id uuid NOT NULL REFERENCES public.agent_runs(id) DEFERRABLE INITIALLY DEFERRED,
  goal text NOT NULL CHECK (char_length(goal) BETWEEN 1 AND 20000),
  corrections jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(corrections)='array'),
  target jsonb NOT NULL CHECK (jsonb_typeof(target)='object'),
  brief jsonb CHECK (brief IS NULL OR jsonb_typeof(brief)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.agent_design_task_runs (
  run_id uuid PRIMARY KEY REFERENCES public.agent_runs(id) DEFERRABLE INITIALLY DEFERRED,
  task_id uuid NOT NULL REFERENCES public.agent_design_tasks(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision > 0),
  request_hash text NOT NULL,
  intent jsonb NOT NULL,
  UNIQUE(task_id, revision)
);
CREATE TABLE public.agent_design_task_jobs (
  job_id uuid PRIMARY KEY REFERENCES public.background_jobs(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.agent_design_task_runs(run_id) ON DELETE CASCADE
);
ALTER TABLE public.agent_design_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_design_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_design_task_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_design_task_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_design_task_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_design_task_jobs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_design_tasks,public.agent_design_task_runs,public.agent_design_task_jobs FROM PUBLIC,anon,authenticated;

CREATE FUNCTION private.loomic_agent_task_snapshot(p_task public.agent_design_tasks)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT jsonb_build_object('id',p_task.id,'revision',p_task.revision,
    'runId',p_task.current_run_id,'sessionId',p_task.session_id,'canvasId',p_task.canvas_id,
    'goal',p_task.goal,'corrections',p_task.corrections,'target',p_task.target,'brief',p_task.brief)
$$;

-- This lock is retained until the enclosing mutation transaction commits. begin
-- takes the same row lock, so a correction and an attachment have a total order.
CREATE FUNCTION private.loomic_agent_task_lock(p_run uuid)
RETURNS public.agent_design_tasks LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task public.agent_design_tasks; mapped public.agent_design_task_runs; BEGIN
  SELECT * INTO mapped FROM public.agent_design_task_runs WHERE run_id=p_run;
  IF mapped.run_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO task FROM public.agent_design_tasks WHERE id=mapped.task_id FOR UPDATE;
  IF task.current_run_id IS DISTINCT FROM p_run OR task.revision IS DISTINCT FROM mapped.revision THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='agent_task_superseded';
  END IF;
  RETURN task;
END $$;

CREATE FUNCTION public.loomic_agent_task_begin(p_user uuid,p_session uuid,p_canvas uuid,p_run uuid,
  p_prompt text,p_target jsonb DEFAULT NULL,p_correction_of uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task public.agent_design_tasks; mapped public.agent_design_task_runs; canvas public.canvases;
  target_value jsonb; design public.design_documents; element jsonb; object_id text; hash_value text;
BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF p_prompt IS NULL OR char_length(btrim(p_prompt)) NOT BETWEEN 1 AND 20000 THEN
    RAISE EXCEPTION 'agent_task_prompt_invalid';
  END IF;
  -- Session locking also serializes the first concurrent task creation.
  PERFORM 1 FROM public.chat_sessions s WHERE s.id=p_session AND s.created_by=p_user AND s.canvas_id=p_canvas FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'agent_task_session_forbidden'; END IF;
  SELECT * INTO canvas FROM public.canvases WHERE id=p_canvas;
  IF canvas.id IS NULL OR NOT EXISTS (SELECT 1 FROM public.workspace_members m
      WHERE m.workspace_id=canvas.workspace_id AND m.user_id=p_user AND m.role IN ('owner','admin'))
    OR NOT EXISTS (SELECT 1 FROM public.agent_runs r WHERE r.id=p_run AND r.created_by=p_user
      AND r.session_id=p_session AND r.status IN ('accepted','running'))
  THEN RAISE EXCEPTION 'agent_task_run_forbidden'; END IF;
  SELECT * INTO task FROM public.agent_design_tasks WHERE session_id=p_session FOR UPDATE;
  hash_value := md5(jsonb_build_object('prompt',p_prompt,'target',p_target,'correction',p_correction_of)::text);
  SELECT * INTO mapped FROM public.agent_design_task_runs WHERE run_id=p_run;
  IF mapped.run_id IS NOT NULL THEN
    IF mapped.request_hash<>hash_value OR task.id IS DISTINCT FROM mapped.task_id THEN
      RAISE EXCEPTION 'agent_task_run_conflict';
    END IF;
    task := private.loomic_agent_task_lock(p_run);
    RETURN private.loomic_agent_task_snapshot(task);
  END IF;
  IF p_correction_of IS NOT NULL AND (task.id IS NULL OR task.created_by<>p_user
      OR task.canvas_id<>p_canvas OR task.current_run_id<>p_correction_of) THEN
    RAISE EXCEPTION 'agent_task_correction_conflict';
  END IF;
  target_value := CASE WHEN p_correction_of IS NOT NULL AND p_target IS NULL THEN task.target ELSE p_target END;
  IF target_value IS NULL THEN RAISE EXCEPTION 'agent_task_target_invalid'; END IF;
  IF target_value IS NOT NULL THEN
    IF jsonb_typeof(target_value)<>'object' OR COALESCE(target_value->>'kind','') NOT IN ('design','canvas_image')
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(target_value) k WHERE k NOT IN ('kind','designId','objectIds','elementId','assetId'))
    THEN RAISE EXCEPTION 'agent_task_target_invalid'; END IF;
    IF target_value->>'kind'='design' THEN
      IF target_value ? 'assetId' THEN RAISE EXCEPTION 'agent_task_target_invalid'; END IF;
      SELECT * INTO design FROM public.design_documents d WHERE d.id=(target_value->>'designId')::uuid
        AND d.workspace_id=canvas.workspace_id AND d.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM public.design_nodes n WHERE n.design_id=d.id AND n.canvas_id=p_canvas AND n.deleted_at IS NULL);
      IF design.id IS NULL THEN RAISE EXCEPTION 'agent_task_target_forbidden'; END IF;
      IF target_value ? 'objectIds' THEN
        IF jsonb_typeof(target_value->'objectIds')<>'array' OR jsonb_array_length(target_value->'objectIds') NOT BETWEEN 1 AND 100 THEN
          RAISE EXCEPTION 'agent_task_target_invalid';
        END IF;
        FOR object_id IN SELECT jsonb_array_elements_text(target_value->'objectIds') LOOP
          IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(design.scene->'objects') o WHERE o->>'objectId'=object_id) THEN
            RAISE EXCEPTION 'agent_task_target_forbidden';
          END IF;
        END LOOP;
      END IF;
    ELSE
      IF target_value ? 'designId' OR target_value ? 'objectIds' THEN RAISE EXCEPTION 'agent_task_target_invalid'; END IF;
      IF NOT (target_value ? 'elementId') OR NOT (target_value ? 'assetId') THEN RAISE EXCEPTION 'agent_task_target_invalid'; END IF;
      IF target_value ? 'elementId' THEN
        SELECT e INTO element FROM jsonb_array_elements(COALESCE(canvas.content->'elements','[]'::jsonb)) e
          WHERE e->>'id'=target_value->>'elementId' AND e->>'type'='image' AND COALESCE((e->>'isDeleted')::boolean,false)=false;
        IF element IS NULL THEN RAISE EXCEPTION 'agent_task_target_forbidden'; END IF;
        IF target_value ? 'assetId' AND COALESCE(canvas.content->'files'->(element->>'fileId')->>'assetId',element#>>'{customData,assetId}')
          IS DISTINCT FROM target_value->>'assetId' THEN RAISE EXCEPTION 'agent_task_target_forbidden'; END IF;
      ELSIF target_value ? 'assetId' THEN RAISE EXCEPTION 'agent_task_target_invalid'; END IF;
    END IF;
  END IF;
  IF task.id IS NULL THEN
    INSERT INTO public.agent_design_tasks(created_by,session_id,canvas_id,revision,current_run_id,goal,target)
      VALUES(p_user,p_session,p_canvas,1,p_run,p_prompt,target_value) RETURNING * INTO task;
  ELSE
    UPDATE public.agent_design_tasks SET revision=revision+1,current_run_id=p_run,target=target_value,
      goal=CASE WHEN p_correction_of IS NULL THEN p_prompt ELSE goal END,
      corrections=CASE WHEN p_correction_of IS NULL THEN '[]'::jsonb ELSE corrections||jsonb_build_array(p_prompt) END,
      brief=NULL,updated_at=now() WHERE id=task.id RETURNING * INTO task;
  END IF;
  INSERT INTO public.agent_design_task_runs(run_id,task_id,revision,request_hash,intent)
    VALUES(p_run,task.id,task.revision,hash_value,private.loomic_agent_task_snapshot(task));
  UPDATE public.image_generation_proposals p SET status='superseded'
    WHERE p.session_id=p_session AND p.created_by=p_user AND p.origin_run_id<>p_run
      AND p.status IN ('pending','confirmed')
      AND EXISTS (SELECT 1 FROM public.agent_design_task_runs r WHERE r.run_id=p.origin_run_id AND r.task_id=task.id)
      AND NOT EXISTS (SELECT 1 FROM public.background_jobs j WHERE j.id=p.id AND j.image_enqueued_at IS NOT NULL);
  RETURN private.loomic_agent_task_snapshot(task);
END $$;

CREATE FUNCTION public.loomic_agent_task_current(p_user uuid,p_session uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task public.agent_design_tasks; BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chat_sessions s JOIN public.canvases c ON c.id=s.canvas_id
    JOIN public.workspace_members m ON m.workspace_id=c.workspace_id AND m.user_id=p_user
    WHERE s.id=p_session AND s.created_by=p_user) THEN RAISE EXCEPTION 'agent_task_session_forbidden'; END IF;
  SELECT * INTO task FROM public.agent_design_tasks WHERE session_id=p_session AND created_by=p_user;
  IF task.id IS NULL THEN RETURN NULL; END IF;
  RETURN private.loomic_agent_task_snapshot(task);
END $$;
CREATE FUNCTION public.loomic_agent_task_assert_current(p_run uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task public.agent_design_tasks; BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  task := private.loomic_agent_task_lock(p_run);
  IF task.id IS NULL THEN RETURN NULL; END IF;
  RETURN private.loomic_agent_task_snapshot(task);
END $$;
CREATE FUNCTION public.loomic_agent_task_update_brief(p_run uuid,p_brief jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task public.agent_design_tasks; BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  task := private.loomic_agent_task_lock(p_run);
  IF task.id IS NULL THEN RAISE EXCEPTION 'agent_task_run_invalid'; END IF;
  IF p_brief IS NULL OR jsonb_typeof(p_brief)<>'object' OR octet_length(p_brief::text)>80000 THEN
    RAISE EXCEPTION 'agent_task_brief_invalid'; END IF;
  UPDATE public.agent_design_tasks SET brief=p_brief,updated_at=now() WHERE id=task.id RETURNING * INTO task;
  RETURN private.loomic_agent_task_snapshot(task);
END $$;

-- Freeze attribution independently of caller-editable job payloads. Frozen
-- proposal identity wins over the run that later confirms that proposal.
CREATE FUNCTION private.loomic_agent_task_bind_job()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE origin uuid; task public.agent_design_tasks; BEGIN
  IF TG_OP='UPDATE' THEN
    IF EXISTS (SELECT 1 FROM public.agent_design_task_jobs WHERE job_id=OLD.id)
      AND (NEW.payload IS DISTINCT FROM OLD.payload OR NEW.created_by IS DISTINCT FROM OLD.created_by
        OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.canvas_id IS DISTINCT FROM OLD.canvas_id
        OR NEW.design_id IS DISTINCT FROM OLD.design_id OR NEW.target_kind IS DISTINCT FROM OLD.target_kind) THEN
      RAISE EXCEPTION 'agent_task_job_immutable';
    END IF;
    IF NEW.credits_cost IS DISTINCT FROM OLD.credits_cost OR NEW.image_enqueued_at IS DISTINCT FROM OLD.image_enqueued_at THEN
      SELECT run_id INTO origin FROM public.agent_design_task_jobs WHERE job_id=OLD.id;
      PERFORM private.loomic_agent_task_lock(origin);
    END IF;
    RETURN NEW;
  END IF;
  SELECT origin_run_id INTO origin FROM public.image_generation_proposals WHERE id=NEW.id;
  IF origin IS NULL AND NEW.payload->>'origin_run_id' IS NOT NULL THEN origin:=(NEW.payload->>'origin_run_id')::uuid; END IF;
  task := private.loomic_agent_task_lock(origin);
  IF task.id IS NULL THEN RETURN NEW; END IF;
  IF NEW.created_by IS DISTINCT FROM task.created_by OR NEW.session_id IS DISTINCT FROM task.session_id
    OR (NEW.target_kind='canvas' AND NEW.canvas_id IS DISTINCT FROM task.canvas_id)
    OR (task.target->>'kind'='design' AND NEW.design_id::text IS DISTINCT FROM task.target->>'designId')
    OR (NEW.target_kind='design' AND NOT EXISTS (SELECT 1 FROM public.design_nodes n
      WHERE n.design_id=NEW.design_id AND n.canvas_id=task.canvas_id AND n.deleted_at IS NULL))
    OR (task.target ? 'objectIds' AND NOT (task.target->'objectIds' ? COALESCE(
      NEW.payload#>>'{target,placement,replace_object_id}',NEW.payload#>>'{target,source_object_id}','')))
    OR (task.target->>'kind'='canvas_image' AND NEW.target_kind IS DISTINCT FROM 'canvas')
    OR (task.target->>'kind'='canvas_image' AND (NEW.payload->>'source_element_id' IS DISTINCT FROM task.target->>'elementId'
      OR NEW.payload->>'source_asset_id' IS DISTINCT FROM task.target->>'assetId'))
  THEN RAISE EXCEPTION 'agent_task_target_mismatch'; END IF;
  INSERT INTO public.agent_design_task_jobs(job_id,run_id) VALUES(NEW.id,origin);
  RETURN NEW;
END $$;
CREATE TRIGGER agent_task_job_binding AFTER INSERT OR UPDATE ON public.background_jobs
  FOR EACH ROW EXECUTE FUNCTION private.loomic_agent_task_bind_job();

CREATE FUNCTION private.loomic_agent_task_guard_design_version()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE origin uuid; task public.agent_design_tasks; BEGIN
  IF NEW.actor_kind='agent' THEN origin:=NEW.agent_run_id;
  ELSIF NEW.actor_kind='job' THEN
    SELECT binding.run_id INTO origin FROM public.job_target_finalizations f
      JOIN public.agent_design_task_jobs binding ON binding.job_id=f.job_id
      WHERE f.command_id=NEW.idempotency_key AND f.target_id=NEW.design_id;
  ELSE RETURN NEW; END IF;
  task := private.loomic_agent_task_lock(origin);
  IF task.id IS NULL THEN RETURN NEW; END IF;
  IF task.target->>'kind'='canvas_image'
    OR (task.target->>'kind'='design' AND task.target->>'designId' IS DISTINCT FROM NEW.design_id::text)
    OR NOT EXISTS (SELECT 1 FROM public.design_nodes n WHERE n.design_id=NEW.design_id
      AND n.canvas_id=task.canvas_id AND n.deleted_at IS NULL)
  THEN RAISE EXCEPTION 'agent_task_target_mismatch'; END IF;
  IF task.target ? 'objectIds' AND (
    EXISTS (SELECT 1 FROM unnest(NEW.changed_object_ids) id WHERE NOT (task.target->'objectIds' ? id::text))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.command_batch) cmd WHERE cmd->>'action' IN ('scene.replace','canvas.update'))
  ) THEN RAISE EXCEPTION 'agent_task_target_mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_task_design_version_guard BEFORE INSERT ON public.design_document_versions
  FOR EACH ROW EXECUTE FUNCTION private.loomic_agent_task_guard_design_version();

-- Detect new/replaced generated image content, including split-layer source IDs.
-- Ordinary user moves/deletes of historical images are not generation commits.
CREATE FUNCTION private.loomic_agent_task_guard_canvas_content()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE element jsonb; previous jsonb; source_id text; origin uuid; task public.agent_design_tasks; BEGIN
  FOR element IN SELECT e FROM jsonb_array_elements(COALESCE(NEW.content->'elements','[]'::jsonb)) e LOOP
    IF COALESCE((element->>'isDeleted')::boolean,false) THEN CONTINUE; END IF;
    source_id := split_part(COALESCE(element#>>'{customData,sourceJobId}',element#>>'{customData,jobId}',''),':',1);
    IF source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN CONTINUE; END IF;
    SELECT e INTO previous FROM jsonb_array_elements(COALESCE(OLD.content->'elements','[]'::jsonb)) e WHERE e->>'id'=element->>'id';
    IF previous IS NOT NULL AND previous->>'type' IS NOT DISTINCT FROM element->>'type'
      AND previous->>'fileId' IS NOT DISTINCT FROM element->>'fileId'
      AND previous#>>'{customData,assetId}' IS NOT DISTINCT FROM element#>>'{customData,assetId}'
      AND previous#>>'{customData,sourceJobId}' IS NOT DISTINCT FROM element#>>'{customData,sourceJobId}'
      AND previous#>>'{customData,jobId}' IS NOT DISTINCT FROM element#>>'{customData,jobId}'
    THEN CONTINUE; END IF;
    SELECT run_id INTO origin FROM public.agent_design_task_jobs WHERE job_id=source_id::uuid;
    task := private.loomic_agent_task_lock(origin);
    IF task.id IS NULL THEN CONTINUE; END IF;
    IF task.canvas_id IS DISTINCT FROM NEW.id OR task.target->>'kind'='design' THEN
      RAISE EXCEPTION 'agent_task_target_mismatch'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_task_canvas_content_guard BEFORE UPDATE OF content ON public.canvases
  FOR EACH ROW EXECUTE FUNCTION private.loomic_agent_task_guard_canvas_content();

REVOKE ALL ON FUNCTION private.loomic_agent_task_snapshot(public.agent_design_tasks),
  private.loomic_agent_task_lock(uuid),private.loomic_agent_task_bind_job(),
  private.loomic_agent_task_guard_design_version(),private.loomic_agent_task_guard_canvas_content()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.loomic_agent_task_begin(uuid,uuid,uuid,uuid,text,jsonb,uuid),
  public.loomic_agent_task_current(uuid,uuid),public.loomic_agent_task_assert_current(uuid),
  public.loomic_agent_task_update_brief(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_agent_task_begin(uuid,uuid,uuid,uuid,text,jsonb,uuid),
  public.loomic_agent_task_current(uuid,uuid),public.loomic_agent_task_assert_current(uuid),
  public.loomic_agent_task_update_brief(uuid,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
