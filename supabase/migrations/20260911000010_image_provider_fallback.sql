-- Freeze a bounded, ordered set of same-upstream image providers before a job
-- is charged or published. The proposal/job keeps its original public model
-- alias; provider_model_catalog_key records the concrete compatible connection.
ALTER TABLE public.provider_execution_snapshots
  ADD COLUMN attempt_ordinal integer NOT NULL DEFAULT 0
  CHECK (attempt_ordinal BETWEEN 0 AND 7),
  ADD COLUMN provider_model_catalog_key uuid;

DROP INDEX public.provider_execution_snapshots_background_job_key;
CREATE UNIQUE INDEX provider_execution_snapshots_background_job_key
  ON public.provider_execution_snapshots(background_job_id,execution_stage,attempt_ordinal)
  WHERE background_job_id IS NOT NULL;

CREATE FUNCTION public.loomic_image_provider_plan_create(
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
  WHERE m.catalog_key=p_requested_catalog_key AND c.workspace_id=p_workspace_id;
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
    WHERE c.workspace_id=p_workspace_id AND c.enabled AND m.enabled
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

CREATE FUNCTION public.loomic_image_provider_plan_resolve(
  p_workspace_id uuid,p_background_job_id uuid
) RETURNS TABLE(
  snapshot_id uuid,provider_config_id uuid,provider_revision bigint,
  catalog_key uuid,provider_model_catalog_key uuid,adapter text,base_url text,
  upstream_model_id text,modality text,capabilities jsonb,
  billing_credits_cost integer,billing_pricing_version text,billing_unit text,
  attempt_ordinal integer,api_key text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
  SELECT s.id,s.provider_config_id,s.provider_revision,s.catalog_key,
    s.provider_model_catalog_key,s.adapter,s.base_url,s.upstream_model_id,
    s.modality,s.capabilities,s.billing_credits_cost,s.billing_pricing_version,
    s.billing_unit,s.attempt_ordinal,d.decrypted_secret
  FROM public.provider_execution_snapshots s
  JOIN public.provider_execution_credentials ec ON ec.snapshot_id=s.id
  JOIN vault.decrypted_secrets d ON d.id=ec.api_key_secret_id
  WHERE s.workspace_id=p_workspace_id AND s.background_job_id=p_background_job_id
    AND s.execution_stage='generation' AND s.modality='image'
  ORDER BY s.attempt_ordinal
$$;

REVOKE ALL ON FUNCTION public.loomic_image_provider_plan_create(uuid,uuid,uuid,integer,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.loomic_image_provider_plan_resolve(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_image_provider_plan_create(uuid,uuid,uuid,integer,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.loomic_image_provider_plan_resolve(uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
