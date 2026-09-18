-- One immutable credential per explicitly quoted image stage, never a runtime
-- lookup of a newly edited workspace provider configuration.
ALTER TABLE public.provider_execution_snapshots
  ADD COLUMN execution_stage text NOT NULL DEFAULT 'generation'
  CHECK (execution_stage IN ('generation','foreground_matting'));
ALTER TABLE public.provider_execution_snapshots
  ADD CONSTRAINT provider_stage_target_check CHECK (execution_stage='generation' OR background_job_id IS NOT NULL);
DROP INDEX public.provider_execution_snapshots_background_job_key;
CREATE UNIQUE INDEX provider_execution_snapshots_background_job_key
  ON public.provider_execution_snapshots(background_job_id,execution_stage)
  WHERE background_job_id IS NOT NULL;

-- A process can stop after inserting the durable job but before its primary
-- provider snapshot is created. Make the primary snapshot RPC an idempotent
-- ensure operation under the job row lock. An existing snapshot is validated
-- and returned without consulting mutable catalog state; a missing snapshot
-- may only be created before billing, enqueue, or execution has begun.
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

  SELECT m.* INTO model_row
  FROM public.workspace_provider_models m
  JOIN public.workspace_provider_configs c ON c.id = m.provider_config_id
  WHERE m.catalog_key = p_catalog_key
    AND c.workspace_id = p_workspace_id
    AND c.enabled = true
    AND m.enabled = true
  FOR SHARE OF m;

  IF model_row.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'provider_snapshot_model_not_found';
  END IF;

  SELECT * INTO config_row
  FROM public.workspace_provider_configs
  WHERE id = model_row.provider_config_id
    AND workspace_id = p_workspace_id
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

CREATE OR REPLACE FUNCTION public.loomic_provider_job_snapshot_resolve(
  p_workspace_id uuid, p_background_job_id uuid
) RETURNS TABLE (
  snapshot_id uuid, provider_config_id uuid, provider_revision bigint,
  catalog_key uuid, adapter text, base_url text, upstream_model_id text,
  modality text, capabilities jsonb, billing_credits_cost integer,
  billing_pricing_version text, billing_unit text, api_key text
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT s.id,s.provider_config_id,s.provider_revision,s.catalog_key,s.adapter,
    s.base_url,s.upstream_model_id,s.modality,s.capabilities,s.billing_credits_cost,
    s.billing_pricing_version,s.billing_unit,d.decrypted_secret
  FROM public.provider_execution_snapshots s
  JOIN public.provider_execution_credentials ec ON ec.snapshot_id=s.id
  JOIN vault.decrypted_secrets d ON d.id=ec.api_key_secret_id
  WHERE s.workspace_id=p_workspace_id AND s.background_job_id=p_background_job_id
    AND s.execution_stage='generation'
$$;

CREATE FUNCTION public.loomic_foreground_snapshot_create(p_workspace_id uuid,p_job_id uuid)
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
      AND c.workspace_id=p_workspace_id AND c.enabled AND m.enabled
      AND m.upstream_model_id='gpt-image-2' AND m.modality='image'
      AND m.capabilities ? 'image_generation'
    FOR SHARE OF m;
  IF model_row.id IS NULL THEN RAISE EXCEPTION 'foreground_snapshot_model_invalid'; END IF;
  SELECT * INTO config_row FROM public.workspace_provider_configs
    WHERE id=model_row.provider_config_id AND workspace_id=p_workspace_id AND enabled
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

CREATE FUNCTION public.loomic_foreground_snapshot_resolve(p_workspace_id uuid,p_background_job_id uuid)
RETURNS TABLE (
  snapshot_id uuid,provider_config_id uuid,provider_revision bigint,catalog_key uuid,
  adapter text,base_url text,upstream_model_id text,modality text,capabilities jsonb,
  billing_credits_cost integer,billing_pricing_version text,billing_unit text,api_key text
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT s.id,s.provider_config_id,s.provider_revision,s.catalog_key,s.adapter,
    s.base_url,s.upstream_model_id,s.modality,s.capabilities,s.billing_credits_cost,
    s.billing_pricing_version,s.billing_unit,d.decrypted_secret
  FROM public.provider_execution_snapshots s
  JOIN public.provider_execution_credentials ec ON ec.snapshot_id=s.id
  JOIN vault.decrypted_secrets d ON d.id=ec.api_key_secret_id
  WHERE s.workspace_id=p_workspace_id AND s.background_job_id=p_background_job_id
    AND s.execution_stage='foreground_matting' AND s.upstream_model_id='gpt-image-2'
$$;
REVOKE ALL ON FUNCTION public.loomic_foreground_snapshot_create(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.loomic_foreground_snapshot_resolve(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_foreground_snapshot_create(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.loomic_foreground_snapshot_resolve(uuid,uuid) TO service_role;

-- Each snapshot holds its stage price; the job has one idempotent total debit.
CREATE OR REPLACE FUNCTION public.deduct_credits(
  p_workspace_id uuid,
  p_user_id uuid,
  p_amount integer,
  p_job_id uuid DEFAULT NULL,
  p_description text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  job_row public.background_jobs%ROWTYPE;
  v_balance integer;
  v_new_balance integer;
  v_version integer;
  v_tx_id uuid;
  v_snapshot_cost integer;
  v_snapshot_found boolean := false;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'credit_invalid_amount';
  END IF;
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'credit_job_required';
  END IF;

  SELECT * INTO job_row
  FROM public.background_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF job_row.id IS NULL
    OR job_row.workspace_id IS DISTINCT FROM p_workspace_id
    OR job_row.created_by IS DISTINCT FROM p_user_id
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'credit_job_not_found';
  END IF;
  IF job_row.status::text <> 'queued' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'credit_job_not_chargeable';
  END IF;
  IF job_row.credits_transaction_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM public.credit_transactions
    WHERE job_id = p_job_id AND transaction_type = 'generation_deduct'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'credit_job_already_charged';
  END IF;

  IF job_row.payload ? 'foreground_policy' THEN
    v_snapshot_found := true;
    v_snapshot_cost := (job_row.payload#>>'{foreground_policy,totalCredits}')::integer;
    IF v_snapshot_cost IS NULL OR v_snapshot_cost IS DISTINCT FROM
      (job_row.payload#>>'{foreground_policy,generationCredits}')::integer + (job_row.payload#>>'{foreground_policy,mattingCredits}')::integer
      OR EXISTS (
        SELECT 1 FROM public.provider_execution_snapshots s WHERE s.background_job_id=p_job_id AND (
          (s.execution_stage='generation' AND s.billing_credits_cost IS DISTINCT FROM (job_row.payload#>>'{foreground_policy,generationCredits}')::integer)
          OR (s.execution_stage='foreground_matting' AND s.billing_credits_cost IS DISTINCT FROM (job_row.payload#>>'{foreground_policy,mattingCredits}')::integer)
        )
      ) THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='credit_price_mismatch'; END IF;
  ELSE
    SELECT billing_credits_cost, true INTO v_snapshot_cost, v_snapshot_found
    FROM public.provider_execution_snapshots
    WHERE background_job_id = p_job_id AND execution_stage='generation';
  END IF;

  IF v_snapshot_found
    AND v_snapshot_cost IS NOT NULL
    AND v_snapshot_cost IS DISTINCT FROM p_amount
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'credit_price_mismatch';
  END IF;

  SELECT balance, version INTO v_balance, v_version
  FROM public.credit_balances
  WHERE workspace_id = p_workspace_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'credit_balance_not_found';
  END IF;
  IF v_balance < p_amount THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INSUFFICIENT_CREDITS';
  END IF;

  v_new_balance := v_balance - p_amount;
  UPDATE public.credit_balances
  SET balance = v_new_balance,
      version = v_version + 1,
      updated_at = now()
  WHERE workspace_id = p_workspace_id AND version = v_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'credit_concurrent_modification';
  END IF;

  INSERT INTO public.credit_transactions
    (workspace_id, user_id, transaction_type, amount, balance_after, job_id, description)
  VALUES
    (p_workspace_id, p_user_id, 'generation_deduct', -p_amount, v_new_balance, p_job_id, p_description)
  RETURNING id INTO v_tx_id;

  UPDATE public.background_jobs
  SET credits_cost = p_amount, credits_transaction_id = v_tx_id
  WHERE id = p_job_id;

  RETURN v_tx_id;
END;
$$;

-- Freeze the canonical operation and processing policy as well as the primary request.
CREATE OR REPLACE FUNCTION public.loomic_guard_frozen_image_job()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.image_generation_proposals; BEGIN
  IF TG_OP='UPDATE' THEN SELECT * INTO p FROM public.image_generation_proposals WHERE id=OLD.id OR id=NEW.id LIMIT 1;
  ELSE SELECT * INTO p FROM public.image_generation_proposals WHERE id=NEW.id; END IF;
  IF p.id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.payload IS DISTINCT FROM OLD.payload
      OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.session_id IS DISTINCT FROM OLD.session_id
      OR NEW.canvas_id IS DISTINCT FROM OLD.canvas_id OR NEW.design_id IS DISTINCT FROM OLD.design_id
      OR NEW.target_kind IS DISTINCT FROM OLD.target_kind OR NEW.job_type IS DISTINCT FROM OLD.job_type
    THEN RAISE EXCEPTION 'frozen_image_job_immutable'; END IF;
    RETURN NEW;
  END IF;
  IF p.status<>'confirmed' OR p.approved_cost IS NULL OR NEW.created_by IS DISTINCT FROM p.created_by
    OR NEW.session_id IS DISTINCT FROM p.session_id OR NEW.job_type::text<>'image_generation'
    OR NEW.payload->>'model' IS DISTINCT FROM p.input->>'model'
    OR NEW.payload->>'prompt' IS DISTINCT FROM p.input->>'prompt'
    OR NEW.payload->>'aspect_ratio' IS DISTINCT FROM COALESCE(p.input->>'aspectRatio','1:1')
    OR COALESCE(NEW.payload->'input_images','[]'::jsonb) IS DISTINCT FROM COALESCE(p.input->'inputImages','[]'::jsonb)
    OR (p.input ? 'quality' AND NEW.payload->>'quality' IS DISTINCT FROM p.input->>'quality')
    OR COALESCE(NEW.payload->>'operation','generate') IS DISTINCT FROM COALESCE(p.input->>'operation','generate')
    OR COALESCE(NEW.payload->>'operation','generate') NOT IN ('generate','remove_background')
    OR NEW.payload->'foreground_policy' IS DISTINCT FROM p.input->'foregroundPolicy'
    OR (p.input ? 'foregroundPolicy' AND p.approved_cost IS DISTINCT FROM (p.input#>>'{foregroundPolicy,totalCredits}')::integer)
    OR (p.input ? 'outputFormat' AND NEW.payload->>'output_format' IS DISTINCT FROM p.input->>'outputFormat')
    OR NOT EXISTS (SELECT 1 FROM public.canvases c WHERE c.id=p.canvas_id AND c.workspace_id=NEW.workspace_id)
  THEN RAISE EXCEPTION 'frozen_image_job_mismatch'; END IF;
  IF p.input#>>'{target,kind}'='design' THEN
    IF NEW.target_kind IS DISTINCT FROM 'design' OR NEW.design_id::text IS DISTINCT FROM p.input#>>'{target,design_id}'
      OR NEW.payload->'target' IS DISTINCT FROM p.input->'target' THEN RAISE EXCEPTION 'frozen_image_target_mismatch'; END IF;
  ELSE
    IF NEW.target_kind IS DISTINCT FROM 'canvas' OR NEW.canvas_id IS DISTINCT FROM p.canvas_id
      OR NEW.payload#>>'{target,canvas_id}' IS DISTINCT FROM p.canvas_id::text THEN RAISE EXCEPTION 'frozen_image_target_mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.loomic_commit_image_job(p_job uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  j public.background_jobs;
  cost integer;
  tx jsonb;
  canvas_content jsonb;
  placeholder jsonb;
  placeholder_count integer;
  placeholder_id text;
BEGIN
  SELECT * INTO j FROM public.background_jobs WHERE id=p_job FOR UPDATE;
  IF j.id IS NULL OR j.job_type::text<>'image_generation' OR NOT EXISTS (
    SELECT 1 FROM public.image_generation_proposals p WHERE p.id=j.id AND p.status='confirmed'
      AND p.created_by=j.created_by AND p.session_id=j.session_id
  ) THEN RAISE EXCEPTION 'image_job_not_confirmed'; END IF;
  IF j.image_enqueued_at IS NOT NULL OR j.status::text<>'queued' THEN RETURN; END IF;
  placeholder_id:=j.payload#>>'{target,element_id}';
  IF j.target_kind='canvas' THEN
    IF placeholder_id IS NULL OR btrim(placeholder_id)=''
      OR j.payload#>>'{target,kind}' IS DISTINCT FROM 'canvas'
      OR j.payload#>>'{target,canvas_id}' IS DISTINCT FROM j.canvas_id::text
    THEN RAISE EXCEPTION 'image_generation_placeholder_invalid'; END IF;
    SELECT c.content INTO canvas_content FROM public.canvases c
      WHERE c.id=j.canvas_id AND c.workspace_id=j.workspace_id FOR UPDATE;
    IF NOT FOUND OR jsonb_typeof(canvas_content->'elements') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'image_generation_placeholder_invalid';
    END IF;
    SELECT count(*) INTO placeholder_count FROM jsonb_array_elements(canvas_content->'elements') e
      WHERE e->>'id'=placeholder_id;
    IF placeholder_count<>1 THEN RAISE EXCEPTION 'image_generation_placeholder_invalid'; END IF;
    SELECT e INTO placeholder FROM jsonb_array_elements(canvas_content->'elements') e
      WHERE e->>'id'=placeholder_id LIMIT 1;
    IF placeholder->>'isDeleted'='true'
      OR placeholder#>>'{customData,type}' IS DISTINCT FROM 'image-generator'
      OR (placeholder#>>'{customData,jobId}' IS DISTINCT FROM j.id::text
        AND placeholder#>>'{customData,sourceJobId}' IS DISTINCT FROM j.id::text)
    THEN RAISE EXCEPTION 'image_generation_placeholder_invalid'; END IF;
  END IF;
  IF j.payload->>'model' LIKE 'workspace:%' AND NOT EXISTS (
    SELECT 1 FROM public.provider_execution_snapshots s JOIN public.provider_execution_credentials ec ON ec.snapshot_id=s.id
    WHERE s.background_job_id=j.id AND s.workspace_id=j.workspace_id AND s.execution_stage='generation'
      AND 'workspace:'||s.catalog_key::text=j.payload->>'model'
      AND ((j.payload->>'operation' IS DISTINCT FROM 'remove_background'
        AND j.payload#>>'{foreground_policy,mode}' IS DISTINCT FROM 'native_transparent')
        OR s.upstream_model_id='gpt-image-2')
  ) THEN RAISE EXCEPTION 'image_provider_snapshot_missing'; END IF;
  IF j.payload#>>'{foreground_policy,mode}'='api_matting' AND j.payload#>>'{foreground_policy,mattingModel}' LIKE 'workspace:%' AND NOT EXISTS (
    SELECT 1 FROM public.provider_execution_snapshots s JOIN public.provider_execution_credentials ec ON ec.snapshot_id=s.id
    WHERE s.background_job_id=j.id AND s.workspace_id=j.workspace_id AND s.execution_stage='foreground_matting'
      AND 'workspace:'||s.catalog_key::text=j.payload#>>'{foreground_policy,mattingModel}' AND s.upstream_model_id='gpt-image-2'
  ) THEN RAISE EXCEPTION 'image_foreground_snapshot_missing'; END IF;
  SELECT approved_cost INTO cost FROM public.image_generation_proposals WHERE id=j.id;
  IF cost IS NULL OR cost<0 THEN RAISE EXCEPTION 'image_price_missing'; END IF;
  IF cost>0 THEN
    tx:=public.loomic_deduct_credits_idempotent(j.workspace_id,j.created_by,cost,j.id,'Confirmed image generation');
    UPDATE public.background_jobs SET credits_cost=cost,credits_transaction_id=(tx->>'transaction_id')::uuid WHERE id=j.id;
  END IF;
  PERFORM pgmq.send(j.queue_name,jsonb_strip_nulls(jsonb_build_object(
    'job_id',j.id,'job_type',j.job_type,'workspace_id',j.workspace_id,
    'target_kind',j.target_kind,'canvas_id',j.canvas_id,'design_id',j.design_id,'session_id',j.session_id)));
  UPDATE public.background_jobs SET image_enqueued_at=now() WHERE id=j.id;
END $$;
