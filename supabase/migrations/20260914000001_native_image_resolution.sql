-- Extend direct node image submissions with an optional native resolution while
-- retaining the original function's single authorization, lock and write boundary.
CREATE OR REPLACE FUNCTION public.loomic_submit_node_image(
  p_user uuid, p_request uuid, p_canvas uuid, p_element text, p_input jsonb,
  p_cost integer, p_provider_revision bigint DEFAULT NULL, p_upstream_model text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  c public.canvases;
  previous public.node_image_submissions;
  element jsonb;
  frozen jsonb;
  job_id uuid := gen_random_uuid();
  ledger jsonb;
  next_elements jsonb;
  model_key uuid;
BEGIN
  IF p_user IS NULL OR p_request IS NULL OR p_canvas IS NULL OR p_element IS NULL
    OR length(p_element) NOT BETWEEN 1 AND 200 OR p_cost IS NULL OR p_cost < 0
    OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_input)) NOT IN (4,5)
    OR NOT (p_input ?& ARRAY['prompt','model','aspect_ratio','quality'])
    OR ((SELECT count(*) FROM jsonb_object_keys(p_input)) = 5 AND NOT (p_input ? 'resolution'))
    OR jsonb_typeof(p_input->'prompt') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'prompt')) = 0
    OR jsonb_typeof(p_input->'model') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_input->'aspect_ratio') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_input->'quality') IS DISTINCT FROM 'string'
    OR (p_input ? 'resolution' AND jsonb_typeof(p_input->'resolution') IS DISTINCT FROM 'string')
    OR length(p_input->>'prompt') > 32768 OR length(p_input->>'model') NOT BETWEEN 1 AND 200
    OR p_input->>'aspect_ratio' NOT IN ('1:1','16:9','9:16','4:3','3:4')
    OR p_input->>'quality' NOT IN ('standard','hd','ultra')
    OR (p_input ? 'resolution' AND p_input->>'resolution' NOT IN ('1k','2k','4k')) THEN
    RAISE EXCEPTION 'node_submission_invalid';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || p_request::text, 0));
  SELECT cv.* INTO c FROM public.canvases cv JOIN public.projects p ON p.id = cv.project_id
    JOIN public.workspaces w ON w.id = p.workspace_id
    WHERE cv.id = p_canvas AND cv.workspace_id = p.workspace_id AND p.archived_at IS NULL
      AND (w.owner_user_id = p_user OR EXISTS (
        SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = w.id
          AND m.user_id = p_user AND m.role IN ('owner','admin')))
    FOR UPDATE OF cv;
  IF c.id IS NULL THEN RAISE EXCEPTION 'node_canvas_forbidden'; END IF;
  SELECT * INTO previous FROM public.node_image_submissions
    WHERE created_by = p_user AND request_id = p_request;
  IF FOUND THEN
    IF previous.canvas_id <> p_canvas OR previous.element_id <> p_element OR previous.input <> p_input THEN
      RAISE EXCEPTION 'node_submission_conflict';
    END IF;
    IF previous.job_id IS NULL THEN RAISE EXCEPTION 'node_submission_expired'; END IF;
    RETURN jsonb_build_object('job_id', previous.job_id, 'replayed', true);
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(c.content->'elements') e WHERE e->>'id' = p_element) <> 1 THEN
    RAISE EXCEPTION 'node_not_saved';
  END IF;
  SELECT e INTO element FROM jsonb_array_elements(c.content->'elements') e WHERE e->>'id' = p_element;
  frozen := element#>'{customData,nodeImageRequest}';
  IF element->>'isDeleted' = 'true' OR element#>>'{customData,type}' IS DISTINCT FROM 'image-generator'
    OR frozen->>'requestId' IS DISTINCT FROM p_request::text
    OR frozen->>'prompt' IS DISTINCT FROM p_input->>'prompt'
    OR frozen->>'model' IS DISTINCT FROM p_input->>'model'
    OR frozen->>'aspectRatio' IS DISTINCT FROM p_input->>'aspect_ratio'
    OR frozen->>'quality' IS DISTINCT FROM p_input->>'quality'
    OR frozen->>'resolution' IS DISTINCT FROM p_input->>'resolution' THEN
    RAISE EXCEPTION 'node_submission_conflict';
  END IF;
  IF EXISTS (SELECT 1 FROM public.background_jobs j WHERE j.canvas_id = p_canvas
    AND j.payload#>>'{target,element_id}' = p_element
    AND (j.status::text IN ('queued','running','failed') OR
      (j.status::text = 'succeeded' AND j.result->>'canvas_finalized_at' IS NULL))) THEN
    RAISE EXCEPTION 'node_generation_active';
  END IF;
  INSERT INTO public.background_jobs(id,workspace_id,project_id,canvas_id,target_kind,queue_name,job_type,payload,created_by)
    VALUES(job_id,c.workspace_id,c.project_id,c.id,'canvas','image_generation_jobs','image_generation',
      p_input || jsonb_build_object('operation','generate','node_submission_revision',c.revision+1,'target',jsonb_build_object(
        'kind','canvas','canvas_id',c.id,'element_id',p_element)),p_user);
  IF p_input->>'model' LIKE 'workspace:%' THEN
    model_key := substring(p_input->>'model' FROM 11)::uuid;
    IF p_provider_revision IS NULL OR p_upstream_model IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.workspace_provider_models m JOIN public.workspace_provider_configs pc ON pc.id=m.provider_config_id
      WHERE m.catalog_key=model_key AND pc.workspace_id=c.workspace_id AND pc.revision=p_provider_revision
        AND m.upstream_model_id=p_upstream_model AND m.enabled AND pc.enabled
        AND m.modality='image' AND m.capabilities ? 'image_generation' AND pc.last_test_status='succeeded'
      FOR SHARE OF m,pc
    ) THEN RAISE EXCEPTION 'node_model_changed'; END IF;
    PERFORM public.loomic_provider_snapshot_create(c.workspace_id,model_key,NULL,job_id,p_cost,'credits-v1','image');
  END IF;
  IF p_cost > 0 THEN
    ledger := public.loomic_deduct_credits_idempotent(c.workspace_id,p_user,p_cost,job_id,'Direct node image generation');
    UPDATE public.background_jobs SET credits_cost=p_cost,credits_transaction_id=(ledger->>'transaction_id')::uuid WHERE id=job_id;
  END IF;
  INSERT INTO public.node_image_submissions(created_by,request_id,canvas_id,element_id,input,job_id)
    VALUES(p_user,p_request,p_canvas,p_element,p_input,job_id);
  element := element || jsonb_build_object('version',COALESCE((element->>'version')::bigint,1)+1,
    'updated',floor(extract(epoch FROM clock_timestamp())*1000),
    'versionNonce',floor(random()*2000000000),
    'customData',(element->'customData') || jsonb_build_object('jobId',job_id,'status','generating','errorMessage',NULL,
      'nodeImageRequest',frozen || jsonb_build_object('state','accepted','submissionRevision',c.revision+1)));
  SELECT jsonb_agg(CASE WHEN e.value->>'id'=p_element THEN element ELSE e.value END ORDER BY e.ordinality)
    INTO next_elements FROM jsonb_array_elements(c.content->'elements') WITH ORDINALITY e(value,ordinality);
  UPDATE public.canvases SET content=jsonb_set(c.content,'{elements}',next_elements),revision=revision+1 WHERE id=c.id;
  PERFORM pgmq.send('image_generation_jobs',jsonb_build_object('job_id',job_id,'job_type','image_generation',
    'workspace_id',c.workspace_id,'target_kind','canvas','canvas_id',c.id));
  UPDATE public.background_jobs SET image_enqueued_at=now() WHERE id=job_id;
  RETURN jsonb_build_object('job_id',job_id,'replayed',false);
END $$;

REVOKE ALL ON FUNCTION public.loomic_submit_node_image(uuid,uuid,uuid,text,jsonb,integer,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_submit_node_image(uuid,uuid,uuid,text,jsonb,integer,bigint,text) TO service_role;
NOTIFY pgrst, 'reload schema';
