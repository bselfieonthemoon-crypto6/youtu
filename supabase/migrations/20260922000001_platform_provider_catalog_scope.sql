-- Platform-scoped provider configuration and published models.
--
-- WHY THIS EXISTS
-- Provider configuration (workspace_provider_configs) and published models
-- (workspace_provider_models) were scoped per workspace, so a fresh signup got
-- its own empty workspace and could neither chat nor generate until somebody
-- configured that workspace. In the local replica only 4 of 38 workspaces had an
-- enabled, connection-tested model at all.
--
-- The product now has ONE platform-owned default channel set that every
-- workspace uses, while a workspace may still override it.
--
-- WHY THIS SHAPE IS THE SMALLEST HONEST CHANGE
-- `workspace_id` becomes nullable on the two existing tables and NULL means
-- "platform scope". Nothing is duplicated per workspace: one config row, one
-- Vault secret, one model row per upstream model, and one catalog key each.
-- Because platform models still hang off a real config row through the existing
-- foreign key, the whole established machinery keeps working unchanged:
-- catalog keys, provider_execution_snapshots, provider_execution_credentials,
-- agent_expert_model_snapshots, the credential release triggers, and the
-- workspace_provider_audit_events trail for workspace-owned configs.
--
-- WHY RESOLUTION FALLS BACK INSTEAD OF UNIONING
-- A workspace that already publishes its own usable configuration keeps exactly
-- that catalogue (the QA workspace 25eb32ef... is the regression case). The
-- platform default is visible only while the workspace has no enabled,
-- connection-tested configuration of its own. The rule lives in exactly one
-- function below so the four resolution paths cannot drift apart.
--
-- TENANT ISOLATION IS UNCHANGED
-- Only provider configuration moved scope. Projects, canvases, credits, assets,
-- skills enablement and every execution row (provider_execution_snapshots,
-- background_jobs, agent_runs) stay bound to the requesting workspace, and the
-- execution credential is still minted per execution by
-- loomic_provider_snapshot_create with the workspace recorded on the snapshot.
-- No client policy is added: both tables remain FORCE ROW LEVEL SECURITY with no
-- policies, i.e. service-role-mediated access only.

-- ---------------------------------------------------------------------------
-- Platform scope
-- ---------------------------------------------------------------------------
ALTER TABLE public.workspace_provider_configs ALTER COLUMN workspace_id DROP NOT NULL;

COMMENT ON COLUMN public.workspace_provider_configs.workspace_id IS
  'Owning workspace, or NULL for the platform-wide default channel. A workspace with its own enabled, connection-tested configuration resolves only its own rows; every other workspace resolves the NULL-scoped rows.';

-- The existing UNIQUE (workspace_id, display_name) does not constrain NULL
-- workspace_id (PostgreSQL treats NULLs as distinct), so the platform scope
-- needs its own uniqueness rule.
CREATE UNIQUE INDEX workspace_provider_configs_platform_display_name_key
  ON public.workspace_provider_configs (lower(btrim(display_name)))
  WHERE workspace_id IS NULL;

-- One definition of "which provider rows does this workspace resolve?".
--   * a workspace-owned row is in scope only for its own workspace;
--   * a platform row is in scope only while the workspace has no enabled,
--     connection-tested configuration of its own.
-- "Usable" means exactly what the published catalogue already meant: enabled and
-- last_test_status = 'succeeded', so a workspace with only a broken or disabled
-- channel still gets a working platform default instead of an empty picker.
CREATE FUNCTION public.loomic_provider_config_in_scope(
  p_config_workspace_id uuid,
  p_workspace_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_config_workspace_id IS NOT NULL THEN p_config_workspace_id = p_workspace_id
    ELSE NOT EXISTS (
      SELECT 1
      FROM public.workspace_provider_configs own
      WHERE own.workspace_id = p_workspace_id
        AND own.enabled
        AND own.last_test_status = 'succeeded'
    )
  END
$$;

REVOKE ALL ON FUNCTION public.loomic_provider_config_in_scope(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_provider_config_in_scope(uuid, uuid)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Credential resolution: chat runs and background (image/video) jobs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.loomic_provider_snapshot_create(
  p_workspace_id uuid,
  p_catalog_key uuid,
  p_agent_run_id uuid DEFAULT NULL,
  p_background_job_id uuid DEFAULT NULL,
  p_billing_credits_cost integer DEFAULT NULL,
  p_billing_pricing_version text DEFAULT NULL,
  p_billing_unit text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  snapshot_id uuid := gen_random_uuid();
  copied_secret_id uuid;
  decrypted_key text;
  target_workspace_id uuid;
  target_job_type text;
  target_job_status text;
  target_job_enqueued_at timestamptz;
  target_job_credits_transaction_id uuid;
  target_job_credits_cost integer;
  target_job_payload jsonb;
  existing_snapshot public.provider_execution_snapshots%ROWTYPE;
  config_row public.workspace_provider_configs%ROWTYPE;
  model_row public.workspace_provider_models%ROWTYPE;
BEGIN
  IF (p_agent_run_id IS NULL) = (p_background_job_id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'provider_snapshot_invalid_target';
  END IF;

  IF p_agent_run_id IS NOT NULL THEN
    SELECT p.workspace_id INTO target_workspace_id
    FROM public.agent_runs ar
    JOIN public.chat_sessions cs ON cs.id = ar.session_id
    JOIN public.canvases c ON c.id = cs.canvas_id
    JOIN public.projects p ON p.id = c.project_id
    WHERE ar.id = p_agent_run_id;
  ELSE
    SELECT workspace_id,job_type::text,status::text,image_enqueued_at,
      credits_transaction_id,credits_cost,payload
    INTO target_workspace_id,target_job_type,target_job_status,target_job_enqueued_at,
      target_job_credits_transaction_id,target_job_credits_cost,target_job_payload
    FROM public.background_jobs
    WHERE id = p_background_job_id
    FOR UPDATE;
  END IF;

  IF target_workspace_id IS NULL OR target_workspace_id IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'provider_snapshot_target_not_found';
  END IF;

  IF p_background_job_id IS NOT NULL THEN
    SELECT * INTO existing_snapshot
    FROM public.provider_execution_snapshots
    WHERE background_job_id=p_background_job_id AND execution_stage='generation';
    IF existing_snapshot.id IS NOT NULL THEN
      IF existing_snapshot.workspace_id IS DISTINCT FROM p_workspace_id
        OR existing_snapshot.catalog_key IS DISTINCT FROM p_catalog_key
        OR existing_snapshot.billing_credits_cost IS DISTINCT FROM p_billing_credits_cost
        OR existing_snapshot.billing_pricing_version IS DISTINCT FROM p_billing_pricing_version
        OR existing_snapshot.billing_unit IS DISTINCT FROM p_billing_unit
        OR (target_job_type='image_generation' AND (
          existing_snapshot.modality IS DISTINCT FROM 'image'
          OR NOT (existing_snapshot.capabilities ? 'image_generation')))
        OR (target_job_type='video_generation' AND (
          existing_snapshot.modality IS DISTINCT FROM 'video'
          OR NOT (existing_snapshot.capabilities ? 'video_generation')))
        OR (target_job_type='image_generation'
          AND (target_job_payload->>'operation'='remove_background'
            OR target_job_payload#>>'{foreground_policy,mode}'='native_transparent')
          AND existing_snapshot.upstream_model_id IS DISTINCT FROM 'gpt-image-2')
      THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='provider_snapshot_existing_mismatch';
      END IF;
      RETURN existing_snapshot.id;
    END IF;
    IF target_job_status IS DISTINCT FROM 'queued'
      OR target_job_enqueued_at IS NOT NULL
      OR target_job_credits_transaction_id IS NOT NULL
      OR target_job_credits_cost IS NOT NULL
    THEN
      RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='provider_snapshot_target_not_chargeable';
    END IF;
    IF target_job_payload->>'model' IS DISTINCT FROM 'workspace:'||p_catalog_key::text THEN
      RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='provider_snapshot_model_mismatch';
    END IF;
  END IF;

  -- The public catalog key is opaque; the row is accepted from the workspace's
  -- own scope or, for a workspace without one, from the platform scope.
  SELECT m.* INTO model_row
  FROM public.workspace_provider_models m
  JOIN public.workspace_provider_configs c ON c.id = m.provider_config_id
  WHERE m.catalog_key = p_catalog_key
    AND public.loomic_provider_config_in_scope(c.workspace_id, p_workspace_id)
    AND c.enabled = true
    AND m.enabled = true
  FOR SHARE OF m;

  IF model_row.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'provider_snapshot_model_not_found';
  END IF;

  SELECT * INTO config_row
  FROM public.workspace_provider_configs
  WHERE id = model_row.provider_config_id
    AND public.loomic_provider_config_in_scope(workspace_id, p_workspace_id)
    AND enabled = true
  FOR SHARE;

  IF config_row.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'provider_snapshot_model_not_found';
  END IF;
  IF config_row.last_test_status <> 'succeeded' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_snapshot_config_not_verified';
  END IF;

  IF p_agent_run_id IS NOT NULL AND (
    model_row.modality <> 'text'
    OR NOT (model_row.capabilities ? 'text')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'provider_snapshot_modality_mismatch';
  END IF;
  IF p_background_job_id IS NOT NULL AND (
    target_job_type NOT IN ('image_generation', 'video_generation')
    OR (target_job_type = 'image_generation' AND (
      model_row.modality <> 'image'
      OR NOT (model_row.capabilities ? 'image_generation')))
    OR (target_job_type = 'video_generation' AND (
      model_row.modality <> 'video'
      OR NOT (model_row.capabilities ? 'video_generation')))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'provider_snapshot_modality_mismatch';
  END IF;
  IF p_background_job_id IS NOT NULL AND target_job_type='image_generation'
    AND (target_job_payload->>'operation'='remove_background'
      OR target_job_payload#>>'{foreground_policy,mode}'='native_transparent')
    AND model_row.upstream_model_id IS DISTINCT FROM 'gpt-image-2'
  THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='provider_snapshot_upstream_model_mismatch';
  END IF;

  SELECT decrypted_secret INTO decrypted_key
  FROM vault.decrypted_secrets
  WHERE id = config_row.api_key_secret_id;

  IF decrypted_key IS NULL OR decrypted_key = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'provider_snapshot_secret_unavailable';
  END IF;

  SELECT vault.create_secret(
    decrypted_key,
    'loomic-provider-snapshot-' || snapshot_id::text,
    'Ephemeral execution credential snapshot'
  ) INTO copied_secret_id;

  INSERT INTO public.provider_execution_snapshots (
    id,workspace_id,provider_config_id,provider_revision,catalog_key,
    adapter,base_url,upstream_model_id,modality,capabilities,
    billing_credits_cost,billing_pricing_version,billing_unit,
    agent_run_id,background_job_id,execution_stage
  ) VALUES (
    snapshot_id,p_workspace_id,config_row.id,config_row.revision,model_row.catalog_key,
    config_row.adapter,config_row.base_url,model_row.upstream_model_id,
    model_row.modality,model_row.capabilities,
    p_billing_credits_cost,p_billing_pricing_version,p_billing_unit,
    p_agent_run_id,p_background_job_id,'generation'
  );

  INSERT INTO public.provider_execution_credentials(snapshot_id,api_key_secret_id)
  VALUES(snapshot_id,copied_secret_id);
  RETURN snapshot_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Credential resolution: confirmed foreground (matting) stage
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.loomic_foreground_snapshot_create(p_workspace_id uuid,p_job_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  job public.background_jobs%ROWTYPE;
  model_row public.workspace_provider_models%ROWTYPE;
  config_row public.workspace_provider_configs%ROWTYPE;
  policy jsonb;
  existing uuid;
  snapshot_id uuid := gen_random_uuid();
  copied_secret_id uuid;
  decrypted_key text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  SELECT * INTO job FROM public.background_jobs WHERE id=p_job_id AND workspace_id=p_workspace_id FOR UPDATE;
  IF job.id IS NULL OR job.job_type::text IS DISTINCT FROM 'image_generation' OR job.target_kind IS DISTINCT FROM 'design'
    OR job.status::text IS DISTINCT FROM 'queued' OR COALESCE(job.payload->>'operation','generate') <> 'generate'
    OR job.payload#>>'{target,placement,role}' = 'background' THEN
    RAISE EXCEPTION 'foreground_snapshot_target_invalid';
  END IF;
  policy := job.payload->'foreground_policy';
  IF policy IS NULL OR policy->>'version' IS DISTINCT FROM '1' OR policy->>'mode' IS DISTINCT FROM 'api_matting'
    OR policy->>'generationModel' IS DISTINCT FROM job.payload->>'model'
    OR COALESCE(policy->>'mattingModel','') !~ '^workspace:[0-9a-f-]{36}$'
    OR COALESCE(policy->>'generationCredits','') !~ '^[0-9]+$'
    OR COALESCE(policy->>'mattingCredits','') !~ '^[0-9]+$'
    OR COALESCE(policy->>'totalCredits','') !~ '^[0-9]+$'
    OR policy->>'pricingVersion' IS DISTINCT FROM 'credits-v1' THEN
    RAISE EXCEPTION 'foreground_snapshot_policy_required';
  END IF;
  IF (policy->>'totalCredits')::integer <> (policy->>'generationCredits')::integer + (policy->>'mattingCredits')::integer THEN
    RAISE EXCEPTION 'foreground_snapshot_quote_invalid';
  END IF;
  SELECT id INTO existing FROM public.provider_execution_snapshots
    WHERE background_job_id=p_job_id AND workspace_id=p_workspace_id AND execution_stage='foreground_matting';
  IF existing IS NOT NULL THEN RETURN existing; END IF;
  SELECT m.* INTO model_row FROM public.workspace_provider_models m
    JOIN public.workspace_provider_configs c ON c.id=m.provider_config_id
    WHERE m.catalog_key=substring(policy->>'mattingModel' FROM 11)::uuid
      AND public.loomic_provider_config_in_scope(c.workspace_id,p_workspace_id) AND c.enabled AND m.enabled
      AND m.upstream_model_id='gpt-image-2' AND m.modality='image'
      AND m.capabilities ? 'image_generation'
    FOR SHARE OF m;
  IF model_row.id IS NULL THEN RAISE EXCEPTION 'foreground_snapshot_model_invalid'; END IF;
  SELECT * INTO config_row FROM public.workspace_provider_configs
    WHERE id=model_row.provider_config_id
      AND public.loomic_provider_config_in_scope(workspace_id,p_workspace_id) AND enabled
      AND last_test_status='succeeded' FOR SHARE;
  IF config_row.id IS NULL THEN RAISE EXCEPTION 'foreground_snapshot_provider_unavailable'; END IF;
  SELECT decrypted_secret INTO decrypted_key FROM vault.decrypted_secrets WHERE id=config_row.api_key_secret_id;
  IF decrypted_key IS NULL OR decrypted_key='' THEN RAISE EXCEPTION 'foreground_snapshot_secret_unavailable'; END IF;
  SELECT vault.create_secret(decrypted_key,'loomic-foreground-snapshot-'||snapshot_id::text,
    'Ephemeral confirmed foreground stage credential') INTO copied_secret_id;
  INSERT INTO public.provider_execution_snapshots (
    id,workspace_id,provider_config_id,provider_revision,catalog_key,adapter,base_url,
    upstream_model_id,modality,capabilities,billing_credits_cost,billing_pricing_version,
    billing_unit,background_job_id,execution_stage
  ) VALUES (snapshot_id,p_workspace_id,config_row.id,config_row.revision,model_row.catalog_key,
    config_row.adapter,config_row.base_url,model_row.upstream_model_id,model_row.modality,
    model_row.capabilities,(policy->>'mattingCredits')::integer,'credits-v1','image',p_job_id,'foreground_matting');
  INSERT INTO public.provider_execution_credentials(snapshot_id,api_key_secret_id) VALUES(snapshot_id,copied_secret_id);
  RETURN snapshot_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Credential resolution: frozen image fallback plan
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.loomic_image_provider_plan_create(
  p_workspace_id uuid,
  p_background_job_id uuid,
  p_requested_catalog_key uuid,
  p_billing_credits_cost integer,
  p_billing_pricing_version text,
  p_billing_unit text
) RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  job public.background_jobs%ROWTYPE;
  requested_model public.workspace_provider_models%ROWTYPE;
  candidate record;
  existing record;
  snapshot_id uuid;
  copied_secret_id uuid;
  decrypted_key text;
  result uuid[] := ARRAY[]::uuid[];
  ordinal integer := 0;
  proposal_cost integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='service_role_required';
  END IF;
  IF p_billing_credits_cost IS NULL OR p_billing_credits_cost < 0
    OR p_billing_pricing_version IS NULL OR btrim(p_billing_pricing_version)=''
    OR p_billing_unit IS DISTINCT FROM 'image'
  THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='image_provider_plan_billing_invalid';
  END IF;

  SELECT * INTO job FROM public.background_jobs
  WHERE id=p_background_job_id AND workspace_id=p_workspace_id
  FOR UPDATE;
  IF job.id IS NULL OR job.job_type::text IS DISTINCT FROM 'image_generation'
    OR job.payload->>'model' IS DISTINCT FROM 'workspace:'||p_requested_catalog_key::text
  THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='image_provider_plan_target_invalid';
  END IF;

  -- Idempotent replay never consults mutable provider state. Every existing
  -- row must agree with the original alias and frozen quote.
  IF EXISTS (
    SELECT 1 FROM public.provider_execution_snapshots
    WHERE background_job_id=job.id AND execution_stage='generation'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM public.provider_execution_snapshots s
      WHERE s.background_job_id=job.id AND s.execution_stage='generation'
        AND (s.workspace_id IS DISTINCT FROM p_workspace_id
          OR s.catalog_key IS DISTINCT FROM p_requested_catalog_key
          OR s.billing_credits_cost IS DISTINCT FROM p_billing_credits_cost
          OR s.billing_pricing_version IS DISTINCT FROM p_billing_pricing_version
          OR s.billing_unit IS DISTINCT FROM p_billing_unit
          OR s.modality IS DISTINCT FROM 'image'
          OR NOT (s.capabilities ? 'image_generation'))
    ) THEN
      RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='image_provider_plan_existing_mismatch';
    END IF;
    SELECT array_agg(s.id ORDER BY s.attempt_ordinal) INTO result
    FROM public.provider_execution_snapshots s
    WHERE s.background_job_id=job.id AND s.execution_stage='generation';
    RETURN result;
  END IF;

  IF job.status::text IS DISTINCT FROM 'queued' OR job.image_enqueued_at IS NOT NULL
    OR job.credits_transaction_id IS NOT NULL OR job.credits_cost IS NOT NULL
  THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='image_provider_plan_target_not_chargeable';
  END IF;

  SELECT approved_cost INTO proposal_cost
  FROM public.image_generation_proposals WHERE id=job.id;
  IF FOUND AND (proposal_cost IS NULL OR p_billing_credits_cost > proposal_cost) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='image_provider_plan_exceeds_approved_cost';
  END IF;

  -- The requested row may now be disabled; it is read only to recover the
  -- immutable upstream identity approved in the proposal. A deleted row is not
  -- enough evidence for cross-model substitution, so creation fails closed.
  SELECT m.* INTO requested_model
  FROM public.workspace_provider_models m
  JOIN public.workspace_provider_configs c ON c.id=m.provider_config_id
  WHERE m.catalog_key=p_requested_catalog_key
    AND public.loomic_provider_config_in_scope(c.workspace_id,p_workspace_id);
  IF requested_model.id IS NULL OR requested_model.modality IS DISTINCT FROM 'image'
    OR NOT (requested_model.capabilities ? 'image_generation')
  THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='image_provider_plan_requested_model_missing';
  END IF;

  -- Bounded to eight providers. Only exact-upstream alternatives are eligible:
  -- current catalog metadata does not prove cross-model reference/aspect/output
  -- compatibility. Requested connection wins when it is still usable.
  FOR candidate IN
    SELECT m.catalog_key AS provider_model_catalog_key,m.provider_config_id,
      c.revision,c.adapter,c.base_url,c.api_key_secret_id,m.upstream_model_id,
      m.modality,m.capabilities
    FROM public.workspace_provider_models m
    JOIN public.workspace_provider_configs c ON c.id=m.provider_config_id
    WHERE public.loomic_provider_config_in_scope(c.workspace_id,p_workspace_id) AND c.enabled AND m.enabled
      AND c.last_test_status='succeeded'
      AND m.modality='image' AND m.capabilities ? 'image_generation'
      AND m.upstream_model_id=requested_model.upstream_model_id
    ORDER BY (m.catalog_key=p_requested_catalog_key) DESC,c.created_at,m.created_at,m.catalog_key
    LIMIT 8
    FOR SHARE OF m,c
  LOOP
    SELECT decrypted_secret INTO decrypted_key
    FROM vault.decrypted_secrets WHERE id=candidate.api_key_secret_id;
    IF decrypted_key IS NULL OR decrypted_key='' THEN CONTINUE; END IF;
    snapshot_id := gen_random_uuid();
    SELECT vault.create_secret(
      decrypted_key,
      'loomic-image-fallback-'||snapshot_id::text,
      'Ephemeral image fallback credential snapshot'
    ) INTO copied_secret_id;
    INSERT INTO public.provider_execution_snapshots(
      id,workspace_id,provider_config_id,provider_revision,catalog_key,
      provider_model_catalog_key,adapter,base_url,upstream_model_id,modality,
      capabilities,billing_credits_cost,billing_pricing_version,billing_unit,
      background_job_id,execution_stage,attempt_ordinal
    ) VALUES (
      snapshot_id,p_workspace_id,candidate.provider_config_id,candidate.revision,
      p_requested_catalog_key,candidate.provider_model_catalog_key,candidate.adapter,
      candidate.base_url,candidate.upstream_model_id,candidate.modality,candidate.capabilities,
      p_billing_credits_cost,p_billing_pricing_version,p_billing_unit,
      job.id,'generation',ordinal
    );
    INSERT INTO public.provider_execution_credentials(snapshot_id,api_key_secret_id)
    VALUES(snapshot_id,copied_secret_id);
    result := array_append(result,snapshot_id);
    ordinal := ordinal+1;
  END LOOP;
  IF cardinality(result)=0 THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='image_provider_plan_unavailable';
  END IF;
  RETURN result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Credential resolution: direct canvas node image submission
-- ---------------------------------------------------------------------------
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
      WHERE m.catalog_key=model_key AND public.loomic_provider_config_in_scope(pc.workspace_id,c.workspace_id) AND pc.revision=p_provider_revision
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

-- ---------------------------------------------------------------------------
-- Frozen model metadata: context limits and collaboration role models
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.loomic_freeze_context_profile() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  SELECT m.context_profile INTO NEW.context_profile FROM public.workspace_provider_models m
    JOIN public.workspace_provider_configs c ON c.id=m.provider_config_id
    WHERE m.catalog_key=NEW.catalog_key
      AND public.loomic_provider_config_in_scope(c.workspace_id,NEW.workspace_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_validate_agent_role_models()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE ref text;
BEGIN
  IF NOT (NEW.agent_collaboration->>'enabled')::boolean THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.agent_collaboration IS NOT DISTINCT FROM OLD.agent_collaboration THEN RETURN NEW; END IF;
  FOR ref IN SELECT v FROM jsonb_each_text(NEW.agent_collaboration->'roleModels') AS entries(k,v) WHERE v IS NOT NULL LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.workspace_provider_models m JOIN public.workspace_provider_configs c ON c.id=m.provider_config_id
      WHERE m.catalog_key=substring(ref FROM 11)::uuid
        AND public.loomic_provider_config_in_scope(c.workspace_id,NEW.workspace_id)
        AND c.enabled AND c.last_test_status='succeeded' AND m.enabled AND m.modality='text' AND m.capabilities ? 'text'
    ) THEN RAISE EXCEPTION 'settings_model_not_accessible' USING ERRCODE = '22023'; END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_expert_model_snapshot_resolve(
  p_delegation uuid, p_run uuid, p_workspace uuid, p_role text, p_catalog_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  d public.agent_delegations; t public.agent_design_tasks;
  s public.agent_expert_model_snapshots;
  m public.workspace_provider_models; c public.workspace_provider_configs;
  key_value text; copied_secret uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  SELECT task.* INTO t FROM public.agent_design_tasks task
    JOIN public.agent_delegations delegation ON delegation.task_id=task.id
    WHERE delegation.id=p_delegation FOR UPDATE OF task;
  SELECT * INTO d FROM public.agent_delegations WHERE id=p_delegation FOR UPDATE;
  IF d.id IS NULL OR d.run_id IS DISTINCT FROM p_run OR d.role IS DISTINCT FROM p_role
    OR d.model_ref IS DISTINCT FROM 'workspace:'||p_catalog_key::text OR d.status <> 'running'
    OR t.current_run_id IS DISTINCT FROM p_run OR t.revision IS DISTINCT FROM d.task_revision
    OR NOT EXISTS (
      SELECT 1 FROM public.agent_runs r
      JOIN public.chat_sessions cs ON cs.id=r.session_id
      JOIN public.canvases canvas ON canvas.id=cs.canvas_id
      JOIN public.projects project ON project.id=canvas.project_id
      JOIN public.workspace_members member ON member.workspace_id=project.workspace_id AND member.user_id=d.created_by
      WHERE r.id=p_run AND r.status IN ('accepted','running') AND project.workspace_id=p_workspace
    ) THEN RAISE EXCEPTION 'expert_model_target_invalid'; END IF;

  SELECT * INTO s FROM public.agent_expert_model_snapshots WHERE delegation_id=p_delegation;
  IF s.delegation_id IS NOT NULL THEN
    IF s.workspace_id IS DISTINCT FROM p_workspace OR s.catalog_key IS DISTINCT FROM p_catalog_key THEN
      RAISE EXCEPTION 'expert_model_snapshot_conflict';
    END IF;
  ELSE
    SELECT model.* INTO m FROM public.workspace_provider_models model
      JOIN public.workspace_provider_configs config ON config.id=model.provider_config_id
      WHERE model.catalog_key=p_catalog_key
        AND public.loomic_provider_config_in_scope(config.workspace_id,p_workspace)
        AND model.enabled AND model.modality='text' AND model.capabilities ? 'text'
      FOR SHARE OF model;
    IF m.id IS NULL THEN RAISE EXCEPTION 'expert_model_not_accessible'; END IF;
    SELECT * INTO c FROM public.workspace_provider_configs WHERE id=m.provider_config_id
      AND public.loomic_provider_config_in_scope(workspace_id,p_workspace)
      AND enabled AND last_test_status='succeeded' FOR SHARE;
    IF c.id IS NULL THEN RAISE EXCEPTION 'expert_model_not_accessible'; END IF;
    SELECT decrypted_secret INTO key_value FROM vault.decrypted_secrets WHERE id=c.api_key_secret_id;
    IF key_value IS NULL OR key_value='' THEN RAISE EXCEPTION 'expert_model_secret_unavailable'; END IF;
    SELECT vault.create_secret(key_value,'loomic-expert-'||p_delegation::text,'Ephemeral read-only expert credential') INTO copied_secret;
    INSERT INTO public.agent_expert_model_snapshots(delegation_id,workspace_id,provider_config_id,provider_revision,catalog_key,base_url,upstream_model_id,capabilities)
      VALUES(p_delegation,p_workspace,c.id,c.revision,m.catalog_key,c.base_url,m.upstream_model_id,m.capabilities) RETURNING * INTO s;
    INSERT INTO public.agent_expert_model_credentials(delegation_id,api_key_secret_id) VALUES(p_delegation,copied_secret);
  END IF;
  SELECT secret.decrypted_secret INTO key_value FROM public.agent_expert_model_credentials credential
    JOIN vault.decrypted_secrets secret ON secret.id=credential.api_key_secret_id
    WHERE credential.delegation_id=p_delegation;
  IF key_value IS NULL OR key_value='' THEN RAISE EXCEPTION 'expert_model_snapshot_released'; END IF;
  RETURN jsonb_build_object('modelRef','workspace:'||s.catalog_key::text,'upstreamModelId',s.upstream_model_id,
    'baseUrl',s.base_url,'apiKey',key_value,'providerRevision',s.provider_revision,'capabilities',s.capabilities);
END;
$$;

-- ---------------------------------------------------------------------------
-- Platform-scope management
-- ---------------------------------------------------------------------------
-- The same CAS-protected RPCs now manage the platform scope when
-- p_workspace_id IS NULL. Authority is re-checked inside the transaction either
-- way: workspace owner/admin for a workspace row, an active platform admin for a
-- platform row. The audit row stays in the same transaction as the change, but
-- platform changes belong to the platform trail (admin_audit_events) because
-- workspace_provider_audit_events.workspace_id is NOT NULL and a platform
-- channel has no owning workspace.
CREATE OR REPLACE FUNCTION public.loomic_provider_config_update(
  p_workspace_id uuid,
  p_provider_config_id uuid,
  p_expected_revision bigint,
  p_display_name text,
  p_base_url text,
  p_enabled boolean,
  p_new_secret text DEFAULT NULL,
  p_new_secret_last_four text DEFAULT NULL,
  p_models jsonb DEFAULT NULL,
  p_actor_user_id uuid DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_row public.workspace_provider_configs%ROWTYPE;
  model_row jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF p_workspace_id IS NULL THEN
    IF NOT private.is_platform_admin(p_actor_user_id) THEN RAISE EXCEPTION 'provider_config_forbidden'; END IF;
  ELSE
    PERFORM 1 FROM public.workspace_members WHERE workspace_id=p_workspace_id
      AND user_id=p_actor_user_id AND role IN ('owner','admin') FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'provider_config_forbidden'; END IF;
  END IF;
  SELECT * INTO current_row FROM public.workspace_provider_configs
  WHERE id = p_provider_config_id
    AND workspace_id IS NOT DISTINCT FROM p_workspace_id
  FOR UPDATE;
  IF current_row.id IS NULL THEN RETURN 'not_found'; END IF;
  IF current_row.revision <> p_expected_revision THEN RETURN 'conflict'; END IF;

  IF p_new_secret IS NOT NULL THEN
    PERFORM vault.update_secret(current_row.api_key_secret_id, new_secret := p_new_secret);
  END IF;

  UPDATE public.workspace_provider_configs SET
    display_name = p_display_name,
    base_url = p_base_url,
    enabled = p_enabled,
    api_key_last_four = COALESCE(p_new_secret_last_four, api_key_last_four),
    revision = revision + 1,
    updated_by = p_actor_user_id,
    last_tested_at = CASE WHEN p_new_secret IS NOT NULL OR p_base_url IS DISTINCT FROM current_row.base_url THEN NULL ELSE last_tested_at END,
    last_test_status = CASE WHEN p_new_secret IS NOT NULL OR p_base_url IS DISTINCT FROM current_row.base_url THEN 'never' ELSE last_test_status END,
    last_test_error_code = CASE WHEN p_new_secret IS NOT NULL OR p_base_url IS DISTINCT FROM current_row.base_url THEN NULL ELSE last_test_error_code END
  WHERE id = p_provider_config_id;

  IF p_models IS NOT NULL THEN
    DELETE FROM public.workspace_provider_models existing
    WHERE existing.provider_config_id = p_provider_config_id
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_models) incoming
        WHERE incoming->>'upstreamModelId' = existing.upstream_model_id
          AND incoming->>'modality' = existing.modality
      );

    FOR model_row IN SELECT value FROM jsonb_array_elements(p_models)
    LOOP
      INSERT INTO public.workspace_provider_models (
        provider_config_id, upstream_model_id, display_name, modality, enabled, capabilities, context_profile
      ) VALUES (
        p_provider_config_id, model_row->>'upstreamModelId', model_row->>'displayName',
        model_row->>'modality', COALESCE((model_row->>'enabled')::boolean, false),
        COALESCE(model_row->'capabilities', '[]'::jsonb), NULLIF(model_row->'contextProfile', 'null'::jsonb)
      )
      ON CONFLICT (provider_config_id, upstream_model_id, modality) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        enabled = EXCLUDED.enabled,
        capabilities = EXCLUDED.capabilities,
        context_profile = CASE WHEN model_row ? 'contextProfile' THEN EXCLUDED.context_profile ELSE workspace_provider_models.context_profile END;
    END LOOP;
  END IF;

  IF p_workspace_id IS NULL THEN
    INSERT INTO public.admin_audit_events (
      actor_user_id, action, target_kind, target_id, before, after
    ) VALUES (
      p_actor_user_id, 'provider_config.updated', 'provider_config', p_provider_config_id::text,
      jsonb_build_object(
        'displayName', current_row.display_name, 'baseUrl', current_row.base_url,
        'enabled', current_row.enabled, 'revision', current_row.revision
      ),
      jsonb_build_object(
        'displayName', p_display_name, 'baseUrl', p_base_url,
        'enabled', p_enabled, 'revision', current_row.revision + 1,
        'baseUrlChanged', p_base_url IS DISTINCT FROM current_row.base_url,
        'modelsChanged', p_models IS NOT NULL
      )
    );
    IF p_new_secret IS NOT NULL THEN
      INSERT INTO public.admin_audit_events (
        actor_user_id, action, target_kind, target_id, after
      ) VALUES (
        p_actor_user_id, 'provider_config.key_rotated', 'provider_config',
        p_provider_config_id::text, jsonb_build_object('platform', true)
      );
    END IF;
  ELSE
    INSERT INTO public.workspace_provider_audit_events (
      workspace_id, provider_config_id, actor_user_id, action, safe_details
    ) VALUES (
      p_workspace_id, p_provider_config_id, p_actor_user_id, 'updated',
      jsonb_build_object(
        'baseUrlChanged', p_base_url IS DISTINCT FROM current_row.base_url,
        'enabled', p_enabled, 'modelsChanged', p_models IS NOT NULL
      )
    );
    IF p_new_secret IS NOT NULL THEN
      INSERT INTO public.workspace_provider_audit_events (
        workspace_id, provider_config_id, actor_user_id, action, safe_details
      ) VALUES (p_workspace_id, p_provider_config_id, p_actor_user_id, 'key_rotated', '{}'::jsonb);
    END IF;
  END IF;
  RETURN 'updated';
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_provider_config_delete(
  p_workspace_id uuid,
  p_provider_config_id uuid,
  p_actor_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  secret_id uuid;
  current_row public.workspace_provider_configs%ROWTYPE;
BEGIN
  IF p_workspace_id IS NULL THEN
    IF NOT private.is_platform_admin(p_actor_user_id) THEN RAISE EXCEPTION 'provider_config_forbidden'; END IF;
  ELSE
    PERFORM 1 FROM public.workspace_members WHERE workspace_id=p_workspace_id
      AND user_id=p_actor_user_id AND role IN ('owner','admin') FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'provider_config_forbidden'; END IF;
  END IF;

  SELECT * INTO current_row
  FROM public.workspace_provider_configs
  WHERE id = p_provider_config_id
    AND workspace_id IS NOT DISTINCT FROM p_workspace_id
  FOR UPDATE;
  IF current_row.id IS NULL THEN
    RETURN false;
  END IF;
  secret_id := current_row.api_key_secret_id;

  DELETE FROM vault.secrets WHERE id = secret_id;
  IF p_workspace_id IS NULL THEN
    INSERT INTO public.admin_audit_events (
      actor_user_id, action, target_kind, target_id, before
    ) VALUES (
      p_actor_user_id, 'provider_config.deleted', 'provider_config', p_provider_config_id::text,
      jsonb_build_object(
        'displayName', current_row.display_name, 'baseUrl', current_row.base_url,
        'enabled', current_row.enabled, 'revision', current_row.revision
      )
    );
  ELSE
    INSERT INTO public.workspace_provider_audit_events (
      workspace_id, provider_config_id, actor_user_id, action, safe_details
    ) VALUES (
      p_workspace_id, p_provider_config_id, p_actor_user_id, 'deleted', '{}'::jsonb
    );
  END IF;
  DELETE FROM public.workspace_provider_configs
  WHERE id = p_provider_config_id
    AND workspace_id IS NOT DISTINCT FROM p_workspace_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.loomic_provider_config_update(
  uuid, uuid, bigint, text, text, boolean, text, text, jsonb, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loomic_provider_config_delete(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_provider_config_update(
  uuid, uuid, bigint, text, text, boolean, text, text, jsonb, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.loomic_provider_config_delete(uuid, uuid, uuid)
  TO service_role;

NOTIFY pgrst, 'reload schema';
