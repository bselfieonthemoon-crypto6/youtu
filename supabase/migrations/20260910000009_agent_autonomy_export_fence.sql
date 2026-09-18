-- Export admission, exact revision, durable idempotency and PGMQ publication
-- share the stop/task locks and one transaction. Export payload stays compatible
-- with the strict frozen-revision worker contract; provenance lives in this ledger.
CREATE TABLE public.agent_autonomy_exports (
 task_id uuid NOT NULL REFERENCES public.agent_design_tasks(id) ON DELETE CASCADE,
 task_revision bigint NOT NULL, idempotency_key uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES auth.users(id), input jsonb NOT NULL,
 job_id uuid NOT NULL UNIQUE, message_id bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(task_id,task_revision,idempotency_key)
);
ALTER TABLE public.agent_autonomy_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_autonomy_exports FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_autonomy_exports FROM PUBLIC,anon,authenticated;

CREATE FUNCTION private.loomic_autonomy_export_result(p_job public.background_jobs,p_replayed boolean)
RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT jsonb_build_object('job_id',p_job.id,'design_id',p_job.design_id,'revision',p_job.payload->'revision',
   'status',p_job.status,'replayed',p_replayed,'result',CASE WHEN p_job.status='succeeded' THEN p_job.result ELSE NULL END)
$$;

CREATE FUNCTION public.loomic_autonomy_export_design(p_user uuid,p_session uuid,p_token uuid,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 grant_row public.agent_task_autonomy; task_row public.agent_design_tasks; design_row public.design_documents;
 canvas_row public.canvases; node_row public.design_nodes; job_row public.background_jobs;
 previous public.agent_autonomy_exports; operation_id uuid; payload_value jsonb; message_id_value bigint;
 multiplier_value integer; width_value bigint; height_value bigint;
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
 PERFORM private.loomic_assert_autonomy_commit(p_user,p_session,p_token);
 SELECT * INTO STRICT grant_row FROM public.agent_task_autonomy WHERE session_id=p_session;
 SELECT * INTO STRICT task_row FROM public.agent_design_tasks WHERE id=grant_row.task_id;
 IF p_input IS NULL OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
   OR NOT (p_input ?& ARRAY['design_id','expected_revision','idempotency_key','format','multiplier','transparent'])
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) key WHERE key NOT IN ('design_id','expected_revision','idempotency_key','format','multiplier','transparent'))
   OR COALESCE(p_input->>'design_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR COALESCE(p_input->>'idempotency_key','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR jsonb_typeof(p_input->'expected_revision') IS DISTINCT FROM 'number'
   OR jsonb_typeof(p_input->'multiplier') IS DISTINCT FROM 'number'
   OR p_input->>'multiplier' NOT IN ('1','2') OR COALESCE(p_input->>'format','') NOT IN ('png','jpeg')
   OR jsonb_typeof(p_input->'transparent') IS DISTINCT FROM 'boolean'
   OR (p_input->>'format'='jpeg' AND p_input->>'transparent'='true')
   OR octet_length(p_input::text)>5000 THEN RAISE EXCEPTION 'autonomy_export_invalid'; END IF;
 IF (p_input->>'expected_revision')::numeric NOT BETWEEN 0 AND 9007199254740991
   OR trunc((p_input->>'expected_revision')::numeric)<>(p_input->>'expected_revision')::numeric
 THEN RAISE EXCEPTION 'autonomy_export_invalid'; END IF;
 IF NOT private.loomic_agent_task_target_authorized(task_row,jsonb_build_object('kind','design','designId',p_input->>'design_id'))
 THEN RAISE EXCEPTION 'autonomy_export_target_mismatch'; END IF;
 PERFORM 1 FROM public.workspace_members WHERE workspace_id=grant_row.workspace_id AND user_id=p_user
   AND role IN ('owner','admin') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'autonomy_export_forbidden'; END IF;
 operation_id:=(p_input->>'idempotency_key')::uuid;
 SELECT * INTO previous FROM public.agent_autonomy_exports
   WHERE task_id=task_row.id AND task_revision=task_row.revision AND idempotency_key=operation_id;
 IF FOUND THEN
   IF previous.created_by IS DISTINCT FROM p_user OR previous.input IS DISTINCT FROM p_input
   THEN RAISE EXCEPTION 'autonomy_export_idempotency_conflict'; END IF;
   SELECT * INTO job_row FROM public.background_jobs WHERE id=previous.job_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'autonomy_export_result_unavailable'; END IF;
   RETURN private.loomic_autonomy_export_result(job_row,true);
 END IF;
 IF (SELECT count(*) FROM public.agent_autonomy_exports WHERE task_id=task_row.id AND task_revision=task_row.revision)>=24
 THEN RAISE EXCEPTION 'autonomy_export_budget_exhausted'; END IF;
 -- Held through queue commit; simultaneous native edits cannot race admission.
 SELECT * INTO design_row FROM public.design_documents WHERE id=(p_input->>'design_id')::uuid FOR SHARE;
 SELECT * INTO node_row FROM public.design_nodes WHERE design_id=design_row.id AND deleted_at IS NULL FOR SHARE;
 SELECT * INTO canvas_row FROM public.canvases WHERE id=grant_row.canvas_id;
 IF design_row.id IS NULL OR design_row.deleted_at IS NOT NULL OR node_row.design_id IS NULL
   OR design_row.workspace_id IS DISTINCT FROM grant_row.workspace_id OR design_row.project_id IS DISTINCT FROM canvas_row.project_id
   OR NOT EXISTS(SELECT 1 FROM public.canvases c WHERE c.id=node_row.canvas_id AND c.workspace_id=grant_row.workspace_id AND c.project_id=canvas_row.project_id)
 THEN RAISE EXCEPTION 'autonomy_export_target_mismatch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM (
   SELECT task_row.target AS target UNION ALL SELECT scope.target FROM public.agent_task_target_scopes scope
   WHERE scope.task_id=task_row.id AND scope.task_revision=task_row.revision AND scope.created_by=p_user AND scope.session_id=p_session
 ) allowed WHERE private.loomic_agent_target_subset(jsonb_build_object('kind','design','designId',design_row.id),allowed.target)
   AND (NOT (allowed.target ? 'elementId') OR allowed.target->>'elementId'=node_row.element_id))
 THEN RAISE EXCEPTION 'autonomy_export_target_mismatch'; END IF;
 IF design_row.revision IS DISTINCT FROM (p_input->>'expected_revision')::bigint
 THEN RAISE EXCEPTION 'autonomy_export_revision_conflict'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.design_document_versions WHERE design_id=design_row.id AND revision=design_row.revision)
 THEN RAISE EXCEPTION 'autonomy_export_revision_unavailable'; END IF;
 multiplier_value:=(p_input->>'multiplier')::integer;
 width_value:=design_row.width::bigint*multiplier_value; height_value:=design_row.height::bigint*multiplier_value;
 IF width_value>32768 OR height_value>32768 OR width_value*height_value>64000000
 THEN RAISE EXCEPTION 'autonomy_export_render_budget_exceeded'; END IF;
 payload_value:=(p_input-'expected_revision')||jsonb_build_object('revision',design_row.revision,'requested_by',p_user);
 -- No adoption of an unrelated foreground request or a different task's key.
 IF EXISTS(SELECT 1 FROM public.background_jobs WHERE job_type='design_export' AND design_id=design_row.id
   AND created_by=p_user AND payload->>'idempotency_key'=operation_id::text)
 THEN RAISE EXCEPTION 'autonomy_export_idempotency_conflict'; END IF;
 PERFORM private.loomic_assert_autonomy_commit(p_user,p_session,p_token);
 INSERT INTO public.background_jobs(workspace_id,project_id,canvas_id,target_kind,design_id,session_id,queue_name,job_type,payload,created_by)
 VALUES(grant_row.workspace_id,design_row.project_id,NULL,'design',design_row.id,p_session,'design_export_jobs','design_export',payload_value,p_user)
 RETURNING * INTO job_row;
 PERFORM private.loomic_assert_autonomy_commit(p_user,p_session,p_token);
 SELECT pgmq.send('design_export_jobs',jsonb_build_object('job_id',job_row.id,'job_type','design_export',
   'workspace_id',grant_row.workspace_id,'target_kind','design','design_id',design_row.id,'session_id',p_session)) INTO message_id_value;
 INSERT INTO public.agent_autonomy_exports(task_id,task_revision,idempotency_key,created_by,input,job_id,message_id)
 VALUES(task_row.id,task_row.revision,operation_id,p_user,p_input,job_row.id,message_id_value);
 RETURN private.loomic_autonomy_export_result(job_row,false);
END $$;

CREATE FUNCTION public.loomic_autonomy_export_status(p_user uuid,p_session uuid,p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE grant_row public.agent_task_autonomy; result_value jsonb;
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
 PERFORM private.loomic_assert_autonomy_commit(p_user,p_session,p_token);
 SELECT * INTO STRICT grant_row FROM public.agent_task_autonomy WHERE session_id=p_session;
 IF EXISTS(SELECT 1 FROM public.agent_autonomy_exports e LEFT JOIN public.background_jobs j ON j.id=e.job_id
   WHERE e.task_id=grant_row.task_id AND e.task_revision=grant_row.task_revision AND e.created_by=p_user AND j.id IS NULL)
 THEN RAISE EXCEPTION 'autonomy_export_result_unavailable'; END IF;
 SELECT COALESCE(jsonb_agg(private.loomic_autonomy_export_result(j,true) ORDER BY e.created_at),'[]') INTO result_value
 FROM public.agent_autonomy_exports e JOIN public.background_jobs j ON j.id=e.job_id
 WHERE e.task_id=grant_row.task_id AND e.task_revision=grant_row.task_revision AND e.created_by=p_user;
 RETURN result_value;
END $$;

CREATE FUNCTION private.loomic_guard_autonomy_export_job()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_OP='INSERT' THEN
   IF EXISTS(SELECT 1 FROM public.agent_autonomy_exports WHERE job_id=NEW.id)
   THEN RAISE EXCEPTION 'autonomy_export_job_immutable'; END IF;
   RETURN NEW;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.agent_autonomy_exports WHERE job_id=OLD.id) THEN
   IF TG_OP='DELETE' THEN RETURN OLD; END IF;
   RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN
   IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'autonomy_export_worker_required'; END IF;
   RETURN OLD;
 END IF;
 IF NEW.payload IS DISTINCT FROM OLD.payload OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.design_id IS DISTINCT FROM OLD.design_id
     OR NEW.target_kind IS DISTINCT FROM OLD.target_kind OR NEW.job_type IS DISTINCT FROM OLD.job_type
     OR NEW.queue_name IS DISTINCT FROM OLD.queue_name
 THEN RAISE EXCEPTION 'autonomy_export_job_immutable'; END IF;
 -- A browser can cancel its own queued/running job, but cannot manufacture
 -- trusted worker success/result evidence through the ordinary owner RLS policy.
 IF auth.role() IS DISTINCT FROM 'service_role'
   AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.result IS DISTINCT FROM OLD.result) AND NOT (
   NEW.status='canceled' AND OLD.status IN ('queued','running') AND NEW.result IS NOT DISTINCT FROM OLD.result
 ) THEN RAISE EXCEPTION 'autonomy_export_worker_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_autonomy_export_job_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.background_jobs
 FOR EACH ROW EXECUTE FUNCTION private.loomic_guard_autonomy_export_job();
REVOKE ALL ON FUNCTION private.loomic_autonomy_export_result(public.background_jobs,boolean),private.loomic_guard_autonomy_export_job(),
 public.loomic_autonomy_export_design(uuid,uuid,uuid,jsonb),public.loomic_autonomy_export_status(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_autonomy_export_design(uuid,uuid,uuid,jsonb),public.loomic_autonomy_export_status(uuid,uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
