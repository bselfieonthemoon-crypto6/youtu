-- Ordinary confirmed canvas generation has no source asset before delivery.
-- Capture its authenticated request before enqueue; bind a real image target
-- only after delivery. This registration grants no write or image authority.
CREATE TABLE public.agent_canvas_result_reviews (
  job_id uuid PRIMARY KEY REFERENCES public.background_jobs(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.agent_runs(id),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  session_id uuid NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  request_message_id uuid NOT NULL REFERENCES public.chat_messages(id),
  request_sequence bigint NOT NULL,
  goal text NOT NULL,
  base_task_id uuid,
  base_revision bigint,
  base_run_id uuid,
  state text NOT NULL DEFAULT 'registered' CHECK(state IN ('registered','bound','needs_attention')),
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.agent_canvas_result_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_canvas_result_reviews FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_canvas_result_reviews FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.loomic_register_canvas_result_review(p_user uuid,p_session uuid,p_run uuid,p_job uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE job public.background_jobs; request public.chat_messages; proposal public.image_generation_proposals;
  task public.agent_design_tasks; requirement public.chat_messages; goal_value text;
BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  -- Match finalization's job -> session order, and keep the row locked until
  -- registration commits. A recovery worker cannot deliver between the read
  -- and registration INSERT. This lock never authorizes enqueue or billing.
  SELECT * INTO job FROM public.background_jobs WHERE id=p_job AND created_by=p_user AND session_id=p_session FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM public.chat_sessions WHERE id=p_session AND created_by=p_user FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM public.agent_canvas_result_reviews WHERE job_id=p_job AND created_by=p_user AND session_id=p_session AND run_id=p_run)
    THEN RETURN true; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.agent_autonomy_preferences WHERE session_id=p_session AND created_by=p_user AND enabled)
    THEN RETURN false; END IF;
  IF job.job_type<>'image_generation' OR job.target_kind<>'canvas' OR job.status NOT IN ('queued','running','succeeded')
    OR job.design_id IS NOT NULL OR job.payload ? 'origin_run_id'
    OR EXISTS(SELECT 1 FROM public.agent_design_task_jobs WHERE job_id=p_job) THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.chat_sessions s JOIN public.canvases c ON c.id=s.canvas_id
    JOIN public.workspace_members m ON m.workspace_id=c.workspace_id AND m.user_id=p_user AND m.role IN ('owner','admin')
    WHERE s.id=p_session AND c.id=job.canvas_id AND c.workspace_id=job.workspace_id) THEN RETURN false; END IF;
  SELECT message.* INTO request FROM public.agent_runs run JOIN public.chat_messages message ON message.id=run.request_message_id
    WHERE run.id=p_run AND run.created_by=p_user AND run.session_id=p_session AND run.status IN ('accepted','running')
      AND message.session_id=p_session AND message.role='user' AND message.content=run.request_prompt;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM public.chat_messages WHERE session_id=p_session AND role='user'
    AND session_sequence>request.session_sequence) THEN RETURN false; END IF;
  SELECT * INTO proposal FROM public.image_generation_proposals WHERE id=p_job AND created_by=p_user
    AND session_id=p_session AND canvas_id=job.canvas_id AND status='confirmed';
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO requirement FROM public.chat_messages WHERE id=proposal.requirement_message_id AND session_id=p_session AND role='user';
  IF NOT FOUND OR requirement.session_sequence>request.session_sequence THEN RETURN false; END IF;
  IF request.id<>requirement.id AND (NOT private.loomic_is_image_confirmation_message(request.content)
    OR EXISTS(SELECT 1 FROM public.chat_messages WHERE session_id=p_session AND role='user'
      AND session_sequence>requirement.session_sequence AND session_sequence<request.session_sequence
      AND NOT private.loomic_is_image_confirmation_message(content))) THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM public.agent_design_task_runs WHERE run_id=p_run OR run_id=proposal.origin_run_id) THEN RETURN false; END IF;
  SELECT * INTO task FROM public.agent_design_tasks WHERE session_id=p_session FOR UPDATE;
  goal_value:=requirement.content;
  IF request.id<>requirement.id THEN goal_value:=goal_value||E'\n'||request.content; END IF;
  IF length(goal_value) NOT BETWEEN 1 AND 20000 THEN RETURN false; END IF;
  INSERT INTO public.agent_canvas_result_reviews(job_id,run_id,created_by,session_id,request_message_id,request_sequence,
    goal,base_task_id,base_revision,base_run_id)
    VALUES(p_job,p_run,p_user,p_session,request.id,request.session_sequence,goal_value,task.id,task.revision,task.current_run_id)
    ON CONFLICT(job_id) DO UPDATE SET run_id=excluded.run_id,request_message_id=excluded.request_message_id,
      request_sequence=excluded.request_sequence,goal=excluded.goal,base_task_id=excluded.base_task_id,
      base_revision=excluded.base_revision,base_run_id=excluded.base_run_id
      WHERE agent_canvas_result_reviews.created_by=p_user AND agent_canvas_result_reviews.session_id=p_session
        AND agent_canvas_result_reviews.state='registered'
        AND (job.status='queued' AND job.image_enqueued_at IS NULL);
  -- If recovery delivered before this request acquired the job lock, observe
  -- that exact already-paid result now. All terminal side effects are already
  -- idempotent; neither status, payload, billing nor queue fields change.
  IF job.status='succeeded' AND jsonb_typeof(job.result->'canvas_finalized_at')='string' THEN
    UPDATE public.background_jobs SET result=result WHERE id=p_job;
  END IF;
  RETURN true;
END $$;

CREATE FUNCTION private.loomic_bind_delivered_canvas_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE registration public.agent_canvas_result_reviews; task public.agent_design_tasks; canvas public.canvases;
  target_value jsonb; brief_value jsonb; element jsonb;
BEGIN
  IF NEW.job_type<>'image_generation' OR NEW.target_kind<>'canvas' OR NEW.status<>'succeeded'
    OR jsonb_typeof(NEW.result->'canvas_finalized_at') IS DISTINCT FROM 'string'
    OR NEW.result->>'asset_id' IS NULL OR NEW.result->>'canvas_element_id' IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO registration FROM public.agent_canvas_result_reviews WHERE job_id=NEW.id;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM public.agent_design_task_jobs WHERE job_id=NEW.id) THEN RETURN NEW; END IF;
  PERFORM 1 FROM public.chat_sessions WHERE id=registration.session_id AND created_by=registration.created_by
    AND canvas_id=NEW.canvas_id FOR UPDATE;
  IF NOT FOUND OR registration.created_by IS DISTINCT FROM NEW.created_by OR registration.session_id IS DISTINCT FROM NEW.session_id
    OR NOT EXISTS(SELECT 1 FROM public.agent_autonomy_preferences WHERE session_id=registration.session_id
      AND created_by=registration.created_by AND enabled)
    OR NOT EXISTS(SELECT 1 FROM public.agent_runs WHERE id=registration.run_id AND created_by=registration.created_by
      AND session_id=registration.session_id AND status NOT IN ('canceled','failed'))
    OR EXISTS(SELECT 1 FROM public.chat_messages WHERE session_id=registration.session_id AND role='user'
      AND session_sequence>registration.request_sequence) THEN RETURN NEW; END IF;
  SELECT * INTO task FROM public.agent_design_tasks WHERE session_id=registration.session_id FOR UPDATE;
  IF task.id IS DISTINCT FROM registration.base_task_id OR task.revision IS DISTINCT FROM registration.base_revision
    OR task.current_run_id IS DISTINCT FROM registration.base_run_id THEN RETURN NEW; END IF;
  SELECT * INTO canvas FROM public.canvases WHERE id=NEW.canvas_id AND workspace_id=NEW.workspace_id;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=NEW.workspace_id
    AND user_id=registration.created_by AND role IN ('owner','admin')) THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.asset_objects WHERE id::text=NEW.result->>'asset_id'
    AND workspace_id=NEW.workspace_id AND deletion_pending_at IS NULL) THEN RETURN NEW; END IF;
  SELECT item INTO element FROM jsonb_array_elements(COALESCE(canvas.content->'elements','[]'::jsonb)) item
    WHERE item->>'id'=NEW.result->>'canvas_element_id' AND item->>'type'='image'
      AND COALESCE((item->>'isDeleted')::boolean,false)=false
      AND COALESCE(canvas.content->'files'->(item->>'fileId')->>'assetId',item#>>'{customData,assetId}')=NEW.result->>'asset_id';
  IF element IS NULL THEN RETURN NEW; END IF;
  target_value:=jsonb_build_object('kind','canvas_image','elementId',element->>'id','assetId',NEW.result->>'asset_id');
  brief_value:=jsonb_build_object('imageResult',jsonb_build_object('jobId',NEW.id),
    'canvasResultReview',jsonb_build_object('mode','read_only','jobId',NEW.id));
  IF task.id IS NULL THEN
    INSERT INTO public.agent_design_tasks(created_by,session_id,canvas_id,revision,current_run_id,goal,target,brief)
      VALUES(registration.created_by,registration.session_id,NEW.canvas_id,1,registration.run_id,registration.goal,target_value,brief_value)
      RETURNING * INTO task;
  ELSE
    UPDATE public.agent_design_tasks SET revision=revision+1,current_run_id=registration.run_id,canvas_id=NEW.canvas_id,
      goal=registration.goal,corrections='[]',target=target_value,brief=brief_value,updated_at=now()
      WHERE id=task.id RETURNING * INTO task;
  END IF;
  INSERT INTO public.agent_design_task_runs(run_id,task_id,revision,request_hash,intent)
    VALUES(registration.run_id,task.id,task.revision,md5(registration.goal||NEW.id::text),private.loomic_agent_task_snapshot(task));
  INSERT INTO public.agent_design_task_jobs(job_id,run_id) VALUES(NEW.id,registration.run_id);
  INSERT INTO public.agent_task_continuations(job_id,task_id,task_revision,origin_run_id,created_by,workspace_id,session_id,canvas_id)
    VALUES(NEW.id,task.id,task.revision,registration.run_id,registration.created_by,NEW.workspace_id,registration.session_id,NEW.canvas_id)
    ON CONFLICT(job_id) DO NOTHING;
  PERFORM public.loomic_agent_autonomy('grant',registration.created_by,registration.session_id,
    jsonb_build_object('taskId',task.id,'revision',task.revision,'originRunId',registration.run_id,'defaultEnabled',false));
  UPDATE public.agent_canvas_result_reviews SET state='bound' WHERE job_id=NEW.id;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- This block is a subtransaction: roll back enrollment, not the delivered
  -- image. Persist an observable failure instead of claiming a review exists.
  UPDATE public.agent_canvas_result_reviews SET state='needs_attention',failure_code=SQLSTATE WHERE job_id=NEW.id;
  RAISE WARNING 'plain_canvas_result_review_binding_failed job=% sqlstate=%',NEW.id,SQLSTATE;
  RETURN NEW;
END $$;
CREATE TRIGGER z_bind_delivered_canvas_review AFTER UPDATE OF status,result ON public.background_jobs
  FOR EACH ROW EXECUTE FUNCTION private.loomic_bind_delivered_canvas_review();

-- Serializes user-run insertion with first-task delivery enrollment as well as
-- existing task correction. New chat messages already take this session lock.
CREATE OR REPLACE FUNCTION private.loomic_supersede_continuations_on_new_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.created_by IS NULL THEN RETURN NEW; END IF;
 PERFORM 1 FROM public.chat_sessions WHERE id=NEW.session_id AND created_by=NEW.created_by FOR UPDATE;
 PERFORM 1 FROM public.agent_design_tasks WHERE session_id=NEW.session_id AND created_by=NEW.created_by FOR UPDATE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.agent_task_autonomy WHERE session_id=NEW.session_id AND created_by=NEW.created_by
   AND state='running' AND enabled AND internal_run_id=NEW.id AND lease_until>now()) THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.agent_task_continuations WHERE continuation_run_id=NEW.id AND status='running') THEN
   UPDATE public.agent_task_autonomy SET state='stopped',claim_token=NULL,updated_at=now() WHERE session_id=NEW.session_id AND created_by=NEW.created_by;
 END IF;
 UPDATE public.agent_task_continuations SET status='superseded',completed_at=now(),outcome=jsonb_build_object('reason','new_user_run','runId',NEW.id)
   WHERE session_id=NEW.session_id AND created_by=NEW.created_by AND status IN ('pending','running') AND continuation_run_id IS DISTINCT FROM NEW.id;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.loomic_register_canvas_result_review(uuid,uuid,uuid,uuid),
  private.loomic_bind_delivered_canvas_review() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_register_canvas_result_review(uuid,uuid,uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
