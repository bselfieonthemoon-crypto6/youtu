-- Read-only design experts. The existing design task remains the only authority.
CREATE TABLE public.agent_delegations (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES public.agent_design_tasks(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_revision bigint NOT NULL CHECK (task_revision > 0),
  parent_tool_call_id text NOT NULL,
  request_key text NOT NULL CHECK (char_length(request_key) BETWEEN 1 AND 128),
  design_revision bigint CHECK (design_revision IS NULL OR design_revision >= 0),
  target jsonb NOT NULL,
  role text NOT NULL CHECK (role IN ('reference_analysis','design_planning','design_review')),
  model_ref text NOT NULL,
  instruction text NOT NULL CHECK (char_length(instruction) BETWEEN 1 AND 4000),
  skills jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(skills)='array'),
  status text NOT NULL CHECK (status IN ('running','completed','failed','superseded','canceled')),
  result text CHECK (result IS NULL OR char_length(result)<=24000),
  error_code text CHECK (error_code IS NULL OR char_length(error_code)<=100),
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL DEFAULT (now()+interval '90 seconds'),
  completed_at timestamptz,
  UNIQUE(run_id,request_key)
);
CREATE INDEX agent_delegations_task_revision_idx ON public.agent_delegations(task_id,task_revision);
ALTER TABLE public.agent_delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_delegations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_delegations FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.agent_delegations TO authenticated;
GRANT ALL ON public.agent_delegations TO service_role;
CREATE POLICY agent_delegations_read ON public.agent_delegations FOR SELECT TO authenticated USING (
  created_by=auth.uid() AND EXISTS (
    SELECT 1 FROM public.agent_runs r JOIN public.chat_sessions s ON s.id=r.session_id
    JOIN public.canvases c ON c.id=s.canvas_id JOIN public.workspace_members m ON m.workspace_id=c.workspace_id
    WHERE r.id=run_id AND m.user_id=auth.uid()
  )
);

CREATE FUNCTION private.loomic_agent_delegation_snapshot(p public.agent_delegations)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT jsonb_build_object('id',p.id,'runId',p.run_id,'taskId',p.task_id,'taskRevision',p.task_revision,
    'parentToolCallId',p.parent_tool_call_id,'requestKey',p.request_key,'designRevision',p.design_revision,
    'target',p.target,'role',p.role,'modelRef',p.model_ref,'instruction',p.instruction,'skills',p.skills,
    'status',p.status,'result',p.result,'errorCode',p.error_code,'createdAt',p.created_at,'completedAt',p.completed_at)
$$;

CREATE FUNCTION public.loomic_agent_delegation_begin(p_id uuid,p_run uuid,p_parent_tool text,
  p_request_key text,p_role text,p_instruction text,p_model_ref text,p_design_revision bigint,p_skills jsonb,
  p_max_parallel integer,p_max_tasks integer,p_timeout_ms integer DEFAULT 90000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task public.agent_design_tasks; record public.agent_delegations; hash_value text; revision_value bigint;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  task := private.loomic_agent_task_lock(p_run);
  IF task.id IS NULL THEN RAISE EXCEPTION 'agent_delegation_task_required'; END IF;
  IF p_parent_tool IS NULL OR p_parent_tool='' OR p_request_key IS NULL OR char_length(p_request_key) NOT BETWEEN 1 AND 128
    OR p_role NOT IN ('reference_analysis','design_planning','design_review') OR p_role IS NULL
    OR p_instruction IS NULL OR char_length(p_instruction) NOT BETWEEN 1 AND 4000
    OR p_model_ref IS NULL OR p_model_ref='' OR jsonb_typeof(p_skills) IS DISTINCT FROM 'array'
    OR p_max_parallel IS NULL OR p_max_parallel NOT BETWEEN 1 AND 3
    OR p_max_tasks IS NULL OR p_max_tasks NOT BETWEEN 1 AND 8
    OR p_timeout_ms IS NULL OR p_timeout_ms NOT BETWEEN 10000 AND 120000
  THEN RAISE EXCEPTION 'agent_delegation_invalid'; END IF;
  UPDATE public.agent_delegations SET status='failed',result=NULL,error_code='agent_delegation_interrupted',completed_at=now()
    WHERE run_id=p_run AND status='running' AND deadline_at<now()-interval '15 seconds';
  hash_value := md5(jsonb_build_object('role',p_role,'instruction',p_instruction,'model',p_model_ref,
    'skills',p_skills,'taskRevision',task.revision)::text);
  SELECT * INTO record FROM public.agent_delegations WHERE run_id=p_run AND request_key=p_request_key;
  IF record.id IS NOT NULL THEN
    IF record.request_hash<>hash_value THEN RAISE EXCEPTION 'agent_delegation_request_conflict'; END IF;
    -- A replay never starts another model request, including interrupted tasks.
    RETURN jsonb_build_object('record',private.loomic_agent_delegation_snapshot(record),'isNew',false);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.agent_runs WHERE id=p_run AND status IN ('accepted','running')) THEN
    RAISE EXCEPTION 'agent_delegation_run_stopped';
  END IF;
  IF (SELECT count(*) FROM public.agent_delegations WHERE run_id=p_run)>=p_max_tasks THEN
    RAISE EXCEPTION 'agent_delegation_budget_exhausted';
  END IF;
  IF (SELECT count(*) FROM public.agent_delegations WHERE run_id=p_run AND status='running')>=p_max_parallel THEN
    RAISE EXCEPTION 'agent_delegation_parallel_limit';
  END IF;
  IF task.target->>'kind'='design' THEN
    SELECT revision INTO revision_value FROM public.design_documents
      WHERE id=(task.target->>'designId')::uuid AND deleted_at IS NULL FOR SHARE;
    IF revision_value IS NULL OR revision_value IS DISTINCT FROM p_design_revision THEN
      RAISE EXCEPTION 'agent_delegation_design_changed';
    END IF;
  ELSIF p_design_revision IS NOT NULL THEN RAISE EXCEPTION 'agent_delegation_invalid'; END IF;
  INSERT INTO public.agent_delegations(id,run_id,task_id,created_by,task_revision,parent_tool_call_id,
    request_key,design_revision,target,role,model_ref,instruction,skills,status,request_hash,deadline_at)
  VALUES(p_id,p_run,task.id,task.created_by,task.revision,p_parent_tool,p_request_key,p_design_revision,
    task.target,p_role,p_model_ref,p_instruction,p_skills,'running',hash_value,
    now()+p_timeout_ms*interval '1 millisecond') RETURNING * INTO record;
  RETURN jsonb_build_object('record',private.loomic_agent_delegation_snapshot(record),'isNew',true);
END $$;

CREATE FUNCTION public.loomic_agent_delegation_finish(p_id uuid,p_status text,p_result text DEFAULT NULL,p_error_code text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE record public.agent_delegations; task public.agent_design_tasks; final_status text; revision_value bigint;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF p_status IS NULL OR p_status NOT IN ('completed','failed','canceled','superseded')
    OR char_length(p_result)>24000 OR char_length(p_error_code)>100 THEN RAISE EXCEPTION 'agent_delegation_invalid'; END IF;
  SELECT * INTO record FROM public.agent_delegations WHERE id=p_id;
  IF record.id IS NULL THEN RAISE EXCEPTION 'agent_delegation_not_found'; END IF;
  -- Same lock order as correction: task, then delegation, then design.
  SELECT * INTO task FROM public.agent_design_tasks WHERE id=record.task_id FOR UPDATE;
  SELECT * INTO record FROM public.agent_delegations WHERE id=p_id FOR UPDATE;
  IF record.status NOT IN ('running','completed') THEN RETURN private.loomic_agent_delegation_snapshot(record); END IF;
  final_status := CASE WHEN record.status='completed' THEN 'completed' ELSE p_status END;
  IF task.current_run_id IS DISTINCT FROM record.run_id OR task.revision IS DISTINCT FROM record.task_revision
    OR task.target IS DISTINCT FROM record.target THEN final_status := 'superseded';
  ELSIF record.status='running' AND NOT EXISTS(SELECT 1 FROM public.agent_runs WHERE id=record.run_id AND status IN ('accepted','running')) THEN
    final_status := 'canceled';
  ELSIF record.design_revision IS NOT NULL THEN
    SELECT revision INTO revision_value FROM public.design_documents
      WHERE id=(record.target->>'designId')::uuid AND deleted_at IS NULL FOR SHARE;
    IF revision_value IS DISTINCT FROM record.design_revision THEN final_status := 'superseded'; END IF;
  END IF;
  IF record.status='completed' AND final_status='completed' THEN RETURN private.loomic_agent_delegation_snapshot(record); END IF;
  UPDATE public.agent_delegations SET status=final_status,
    result=CASE WHEN final_status='completed' THEN p_result ELSE NULL END,
    error_code=CASE WHEN final_status='superseded' THEN 'agent_delegation_superseded' ELSE p_error_code END,
    completed_at=now() WHERE id=p_id RETURNING * INTO record;
  RETURN private.loomic_agent_delegation_snapshot(record);
END $$;

CREATE FUNCTION public.loomic_agent_delegations_stop(p_run uuid,p_status text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF p_status IS NULL OR p_status NOT IN ('failed','canceled') THEN RAISE EXCEPTION 'agent_delegation_invalid'; END IF;
  UPDATE public.agent_delegations SET status=p_status,result=NULL,completed_at=now(),error_code='agent_delegation_run_stopped'
    WHERE run_id=p_run AND status='running';
END $$;

CREATE FUNCTION private.loomic_agent_delegations_supersede()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.revision IS DISTINCT FROM OLD.revision OR NEW.current_run_id IS DISTINCT FROM OLD.current_run_id THEN
    UPDATE public.agent_delegations SET status='superseded',result=NULL,error_code='agent_delegation_superseded',completed_at=now()
      WHERE task_id=NEW.id AND task_revision<NEW.revision AND status IN ('running','completed');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_delegations_supersede_on_correction AFTER UPDATE OF revision,current_run_id
  ON public.agent_design_tasks FOR EACH ROW EXECUTE FUNCTION private.loomic_agent_delegations_supersede();

CREATE FUNCTION private.loomic_agent_delegations_finish_with_run()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.status IN ('failed','canceled','completed') AND NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE public.agent_delegations SET status=CASE WHEN NEW.status='canceled' THEN 'canceled' ELSE 'failed' END,
      result=NULL,error_code='agent_delegation_run_stopped',completed_at=now()
      WHERE run_id=NEW.id AND status='running';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_delegations_finish_with_run AFTER UPDATE OF status ON public.agent_runs
  FOR EACH ROW EXECUTE FUNCTION private.loomic_agent_delegations_finish_with_run();

REVOKE ALL ON FUNCTION private.loomic_agent_delegation_snapshot(public.agent_delegations),
  private.loomic_agent_delegations_supersede(),private.loomic_agent_delegations_finish_with_run() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.loomic_agent_delegation_begin(uuid,uuid,text,text,text,text,text,bigint,jsonb,integer,integer,integer),
  public.loomic_agent_delegation_finish(uuid,text,text,text),public.loomic_agent_delegations_stop(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_agent_delegation_begin(uuid,uuid,text,text,text,text,text,bigint,jsonb,integer,integer,integer),
  public.loomic_agent_delegation_finish(uuid,text,text,text),public.loomic_agent_delegations_stop(uuid,text) TO service_role;
