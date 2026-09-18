-- Durable, user-scoped result events. Never store a bearer token or grant a
-- background job authority to invent a new user request.
CREATE TABLE public.agent_task_continuations (
  job_id uuid PRIMARY KEY REFERENCES public.background_jobs(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES public.agent_design_tasks(id) ON DELETE CASCADE,
  task_revision bigint NOT NULL,
  origin_run_id uuid NOT NULL REFERENCES public.agent_runs(id),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  canvas_id uuid NOT NULL REFERENCES public.canvases(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','needs_attention','superseded')),
  claim_token uuid,
  -- Bound before the corresponding agent_runs INSERT. It intentionally has no
  -- FK: the binding is the lease that lets the BEFORE INSERT trigger
  -- distinguish this continuation from a genuinely new user run.
  continuation_run_id uuid,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  outcome jsonb,
  CHECK (outcome IS NULL OR octet_length(outcome::text) <= 30000)
);
CREATE INDEX agent_task_continuations_pending ON public.agent_task_continuations(session_id,created_at,job_id) WHERE status='pending';
CREATE UNIQUE INDEX agent_task_continuations_run_id ON public.agent_task_continuations(continuation_run_id) WHERE continuation_run_id IS NOT NULL;
ALTER TABLE public.agent_task_continuations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_task_continuations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_task_continuations FROM PUBLIC,anon,authenticated;

CREATE FUNCTION private.loomic_record_agent_continuation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task public.agent_design_tasks; mapped public.agent_design_task_runs;
BEGIN
  IF NEW.job_type <> 'image_generation' OR NEW.status NOT IN ('succeeded','failed','canceled','dead_letter') THEN RETURN NEW; END IF;
  -- A success is eligible only once its result has actually reached the canvas
  -- and/or a terminal design delivery message. Recovery writes the same marker.
  IF NEW.status='succeeded' AND NOT (NEW.result ? 'canvas_finalized_at' OR NEW.result ? 'chat_finalized_at') THEN RETURN NEW; END IF;
  SELECT r.* INTO mapped FROM public.agent_design_task_jobs b
    JOIN public.agent_design_task_runs r ON r.run_id=b.run_id WHERE b.job_id=NEW.id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO task FROM public.agent_design_tasks WHERE id=mapped.task_id;
  IF task.current_run_id IS DISTINCT FROM mapped.run_id OR task.revision IS DISTINCT FROM mapped.revision
    OR task.created_by IS DISTINCT FROM NEW.created_by OR task.session_id IS DISTINCT FROM NEW.session_id
    OR (NEW.target_kind='canvas' AND task.canvas_id IS DISTINCT FROM NEW.canvas_id)
    OR (NEW.target_kind='design' AND task.target->>'designId' IS DISTINCT FROM NEW.design_id::text)
    THEN RETURN NEW; END IF;
  INSERT INTO public.agent_task_continuations(job_id,task_id,task_revision,origin_run_id,created_by,workspace_id,session_id,canvas_id)
    VALUES(NEW.id,task.id,task.revision,mapped.run_id,task.created_by,NEW.workspace_id,task.session_id,task.canvas_id)
    ON CONFLICT(job_id) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER record_agent_task_continuation AFTER UPDATE OF status,result ON public.background_jobs
  FOR EACH ROW EXECUTE FUNCTION private.loomic_record_agent_continuation();

CREATE FUNCTION public.loomic_claim_agent_continuation(p_user uuid,p_session uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE event public.agent_task_continuations; task public.agent_design_tasks; token uuid;
BEGIN
  SELECT * INTO task FROM public.agent_design_tasks WHERE created_by=p_user AND session_id=p_session FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- Unknown model outcomes are not retried automatically after a process dies.
  UPDATE public.agent_task_continuations SET status='needs_attention',completed_at=now(),
    outcome='{"reason":"continuation_interrupted","message":"自动检查中断，未自动重发模型请求。"}'::jsonb
    WHERE session_id=p_session AND created_by=p_user AND status='running' AND claimed_at < now()-interval '3 minutes';
  UPDATE public.agent_task_continuations SET status='superseded',completed_at=now()
    WHERE session_id=p_session AND created_by=p_user AND status='pending'
      AND (task_id<>task.id OR task_revision<>task.revision OR origin_run_id<>task.current_run_id
        OR EXISTS(SELECT 1 FROM public.agent_runs r WHERE r.id=origin_run_id AND r.status IN ('canceled','failed')));
  IF EXISTS(SELECT 1 FROM public.agent_task_continuations WHERE session_id=p_session AND status='running')
    OR EXISTS(SELECT 1 FROM public.agent_runs WHERE session_id=p_session AND status IN ('accepted','running')) THEN RETURN NULL; END IF;
  SELECT * INTO event FROM public.agent_task_continuations WHERE session_id=p_session AND created_by=p_user AND status='pending'
    ORDER BY created_at,job_id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  token:=extensions.gen_random_uuid();
  UPDATE public.agent_task_continuations SET status='running',claim_token=token,claimed_at=now() WHERE job_id=event.job_id;
  RETURN to_jsonb(event)||jsonb_build_object('status','running','claim_token',token);
END $$;

CREATE FUNCTION public.loomic_finish_agent_continuation(p_user uuid,p_job uuid,p_token uuid,p_status text,p_outcome jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE event public.agent_task_continuations; task public.agent_design_tasks;
BEGIN
  IF p_status NOT IN ('completed','needs_attention','superseded') OR p_outcome IS NULL OR jsonb_typeof(p_outcome)<>'object'
    OR octet_length(p_outcome::text)>30000 THEN RAISE EXCEPTION 'invalid_continuation_outcome'; END IF;
  -- Same lock order as claim and task correction: task before event.
  SELECT t.* INTO task FROM public.agent_design_tasks t JOIN public.agent_task_continuations e ON e.task_id=t.id
    WHERE e.job_id=p_job AND e.created_by=p_user FOR UPDATE OF t;
  SELECT * INTO event FROM public.agent_task_continuations WHERE job_id=p_job AND created_by=p_user FOR UPDATE;
  IF NOT FOUND OR event.status<>'running' OR event.claim_token IS DISTINCT FROM p_token THEN RETURN false; END IF;
  IF task.current_run_id IS DISTINCT FROM event.origin_run_id OR task.revision IS DISTINCT FROM event.task_revision
    OR EXISTS(SELECT 1 FROM public.agent_runs WHERE id=event.origin_run_id AND status IN ('canceled','failed')) THEN
    p_status:='superseded'; p_outcome:='{"reason":"task_changed"}'::jsonb;
  END IF;
  UPDATE public.agent_task_continuations SET status=p_status,outcome=p_outcome,completed_at=now() WHERE job_id=p_job;
  IF p_status<>'superseded' AND p_outcome ? 'content' AND p_outcome ? 'runId' THEN
    INSERT INTO public.chat_messages(id,session_id,role,content)
      VALUES((p_outcome->>'runId')::uuid,event.session_id,'assistant',p_outcome->>'content')
      ON CONFLICT(id) DO NOTHING;
  END IF;
  RETURN p_status<>'superseded';
END $$;
REVOKE ALL ON FUNCTION private.loomic_record_agent_continuation(),
  public.loomic_claim_agent_continuation(uuid,uuid),public.loomic_finish_agent_continuation(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_claim_agent_continuation(uuid,uuid),
  public.loomic_finish_agent_continuation(uuid,uuid,uuid,text,jsonb) TO service_role;

CREATE FUNCTION public.loomic_agent_continuation_active(p_user uuid,p_job uuid,p_token uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT EXISTS(SELECT 1 FROM public.agent_task_continuations e
    JOIN public.agent_design_tasks t ON t.id=e.task_id
    JOIN public.agent_runs r ON r.id=e.origin_run_id
    WHERE e.job_id=p_job AND e.created_by=p_user AND e.claim_token=p_token AND e.status='running'
      AND t.current_run_id=e.origin_run_id AND t.revision=e.task_revision AND r.status NOT IN ('canceled','failed'));
$$;

-- Reserve the exact run id before agent_runs is inserted. The insert trigger
-- below will preserve only this continuation and supersede every other pending
-- or running continuation in the session.
CREATE FUNCTION public.loomic_bind_agent_continuation_run(p_user uuid,p_job uuid,p_token uuid,p_run uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE event public.agent_task_continuations; task public.agent_design_tasks;
BEGIN
  IF p_run IS NULL THEN RETURN false; END IF;
  SELECT t.* INTO task FROM public.agent_design_tasks t
    JOIN public.agent_task_continuations e ON e.task_id=t.id
    WHERE e.job_id=p_job AND e.created_by=p_user FOR UPDATE OF t;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO event FROM public.agent_task_continuations
    WHERE job_id=p_job AND created_by=p_user FOR UPDATE;
  IF NOT FOUND OR event.status<>'running' OR event.claim_token IS DISTINCT FROM p_token
    OR event.origin_run_id=p_run OR event.continuation_run_id IS NOT NULL
    OR task.current_run_id IS DISTINCT FROM event.origin_run_id
    OR task.revision IS DISTINCT FROM event.task_revision
    OR EXISTS(SELECT 1 FROM public.agent_runs WHERE id=p_run)
  THEN RETURN false; END IF;
  UPDATE public.agent_task_continuations SET continuation_run_id=p_run WHERE job_id=p_job;
  RETURN true;
END $$;

-- A newly accepted user run is a stronger, newer instruction. Serialize on the
-- same current task row as claim/bind, then fence older result continuations
-- before the new run becomes visible. The pre-bound continuation run excludes
-- itself and therefore cannot cancel its own lease.
CREATE FUNCTION private.loomic_supersede_continuations_on_new_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.created_by IS NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM public.agent_design_tasks
    WHERE session_id=NEW.session_id AND created_by=NEW.created_by FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  UPDATE public.agent_task_continuations SET status='superseded',completed_at=now(),
    outcome=jsonb_build_object('reason','new_user_run','runId',NEW.id)
    WHERE session_id=NEW.session_id AND created_by=NEW.created_by
      AND status IN ('pending','running')
      AND continuation_run_id IS DISTINCT FROM NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER supersede_continuations_on_new_run BEFORE INSERT ON public.agent_runs
  FOR EACH ROW EXECUTE FUNCTION private.loomic_supersede_continuations_on_new_run();

CREATE FUNCTION public.loomic_stop_agent_continuations(p_user uuid,p_session uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM 1 FROM public.agent_design_tasks WHERE created_by=p_user AND session_id=p_session FOR UPDATE;
  UPDATE public.agent_task_continuations SET status='needs_attention',completed_at=now(),
    outcome='{"reason":"review_stopped","message":"用户停止自动检查，未重试。"}'::jsonb
    WHERE created_by=p_user AND session_id=p_session AND status IN ('pending','running');
END $$;
REVOKE ALL ON FUNCTION public.loomic_agent_continuation_active(uuid,uuid,uuid),
  public.loomic_bind_agent_continuation_run(uuid,uuid,uuid,uuid),public.loomic_stop_agent_continuations(uuid,uuid),
  private.loomic_supersede_continuations_on_new_run() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_agent_continuation_active(uuid,uuid,uuid),
  public.loomic_bind_agent_continuation_run(uuid,uuid,uuid,uuid),public.loomic_stop_agent_continuations(uuid,uuid) TO service_role;
