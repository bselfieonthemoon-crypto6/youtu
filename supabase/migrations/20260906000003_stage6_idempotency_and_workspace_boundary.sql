-- Stage 6 incremental hardening for already-applied catalog/audit migrations.

CREATE UNIQUE INDEX IF NOT EXISTS background_jobs_design_image_idempotency_key
  ON public.background_jobs(
    design_id,
    created_by,
    ((payload->'target'->>'idempotency_key'))
  )
  WHERE job_type = 'image_generation'
    AND target_kind = 'design'
    AND design_id IS NOT NULL
    AND payload->'target' ? 'idempotency_key';

CREATE TABLE IF NOT EXISTS public.design_agent_mutation_requests (
  design_id uuid NOT NULL REFERENCES public.design_documents(id) ON DELETE CASCADE,
  idempotency_key uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{32}$'),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (design_id, idempotency_key),
  CHECK (result IS NULL OR jsonb_typeof(result) = 'object')
);
ALTER TABLE public.design_agent_mutation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_agent_mutation_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.design_agent_mutation_requests FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.loomic_agent_design_mutate_v2(
  p_operation text,
  p_design_id uuid,
  p_expected_revision bigint,
  p_idempotency_key uuid,
  p_commands jsonb,
  p_next_scene jsonb,
  p_actor_user_id uuid,
  p_agent_run_id uuid,
  p_tool_execution_id uuid,
  p_template_id uuid DEFAULT NULL,
  p_expected_template_revision bigint DEFAULT NULL,
  p_confirmation_id uuid DEFAULT NULL,
  p_destructive_confirmed boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  request_row public.design_agent_mutation_requests%ROWTYPE;
  input_hash_value text;
  result_value jsonb;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='service_role_required';
  END IF;
  input_hash_value := md5(jsonb_build_object(
    'operation', p_operation,
    'design_id', p_design_id,
    'expected_revision', p_expected_revision,
    'commands', p_commands,
    'template_id', p_template_id,
    'expected_template_revision', p_expected_template_revision
  )::text);

  INSERT INTO public.design_agent_mutation_requests(
    design_id, idempotency_key, actor_user_id, input_hash
  ) VALUES (
    p_design_id, p_idempotency_key, p_actor_user_id, input_hash_value
  ) ON CONFLICT (design_id, idempotency_key) DO NOTHING;

  SELECT * INTO request_row
  FROM public.design_agent_mutation_requests request
  WHERE request.design_id=p_design_id
    AND request.idempotency_key=p_idempotency_key
  FOR UPDATE;

  IF request_row.actor_user_id IS DISTINCT FROM p_actor_user_id
    OR request_row.input_hash IS DISTINCT FROM input_hash_value
  THEN
    RAISE EXCEPTION USING
      ERRCODE='23505', MESSAGE='agent_design_idempotency_conflict';
  END IF;
  IF request_row.result IS NOT NULL THEN
    RETURN jsonb_set(request_row.result, '{replayed}', 'true'::jsonb, true);
  END IF;

  result_value := public.loomic_agent_design_mutate(
    p_operation, p_design_id, p_expected_revision, p_idempotency_key,
    p_commands, p_next_scene, p_actor_user_id, p_agent_run_id,
    p_tool_execution_id, p_template_id, p_expected_template_revision,
    p_confirmation_id, p_destructive_confirmed
  );
  UPDATE public.design_agent_mutation_requests
  SET result=result_value, completed_at=now()
  WHERE design_id=p_design_id AND idempotency_key=p_idempotency_key;
  RETURN result_value;
END;
$$;
REVOKE ALL ON FUNCTION public.loomic_agent_design_mutate_v2(
  text,uuid,bigint,uuid,jsonb,jsonb,uuid,uuid,uuid,uuid,bigint,uuid,boolean
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.loomic_agent_design_mutate_v2(
  text,uuid,bigint,uuid,jsonb,jsonb,uuid,uuid,uuid,uuid,bigint,uuid,boolean
) TO service_role;

CREATE OR REPLACE FUNCTION public.loomic_design_resources_list_scoped(
  p_scope text, p_kind text, p_status text, p_query text,
  p_category_id uuid, p_tag_id uuid, p_format text, p_aspect_ratio text,
  p_cursor_updated_at timestamptz, p_cursor_id uuid, p_limit integer,
  p_active_workspace_id uuid
)
RETURNS TABLE(item jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
AS $$
  SELECT to_jsonb(r) || jsonb_build_object(
    'tag_ids', COALESCE((SELECT jsonb_agg(rtl.tag_id ORDER BY rtl.tag_id)
      FROM public.resource_tag_links rtl WHERE rtl.resource_id=r.id),'[]'::jsonb),
    'mime_type', ao.mime_type)
  FROM public.design_resources r
  JOIN public.asset_objects ao ON ao.id=r.asset_object_id
  LEFT JOIN public.resource_categories rc ON rc.id=r.category_id
  WHERE r.deleted_at IS NULL
    AND (r.scope='platform' OR r.workspace_id=p_active_workspace_id)
    AND (p_scope IS NULL OR r.scope=p_scope)
    AND (p_kind IS NULL OR r.kind=p_kind)
    AND (p_status IS NULL OR r.status=p_status)
    AND (p_category_id IS NULL OR r.category_id=p_category_id)
    AND (p_tag_id IS NULL OR EXISTS(SELECT 1 FROM public.resource_tag_links rtl
      WHERE rtl.resource_id=r.id AND rtl.tag_id=p_tag_id))
    AND (p_query IS NULL OR btrim(p_query)='' OR r.name ILIKE '%'||p_query||'%'
      OR COALESCE(r.description,'') ILIKE '%'||p_query||'%'
      OR COALESCE(rc.name,'') ILIKE '%'||p_query||'%'
      OR EXISTS(SELECT 1 FROM public.resource_tag_links rtl
        JOIN public.resource_tags rt ON rt.id=rtl.tag_id
        WHERE rtl.resource_id=r.id AND rt.name ILIKE '%'||p_query||'%'))
    AND (p_format IS NULL OR CASE p_format
      WHEN 'png' THEN ao.mime_type='image/png'
      WHEN 'jpeg' THEN ao.mime_type IN ('image/jpeg','image/jpg')
      WHEN 'webp' THEN ao.mime_type='image/webp'
      WHEN 'gif' THEN ao.mime_type='image/gif'
      WHEN 'svg' THEN ao.mime_type='image/svg+xml' ELSE false END)
    AND (p_aspect_ratio IS NULL OR CASE p_aspect_ratio
      WHEN 'square' THEN r.width IS NOT NULL AND abs(r.width-r.height)<=greatest(r.width,r.height)*0.05
      WHEN 'portrait' THEN r.width IS NOT NULL AND r.height>r.width
      WHEN 'landscape' THEN r.width IS NOT NULL AND r.width>r.height
      WHEN 'wide' THEN r.width IS NOT NULL AND r.width::numeric/r.height>=1.7
      ELSE false END)
    AND ((p_cursor_updated_at IS NULL AND p_cursor_id IS NULL)
      OR (p_cursor_updated_at IS NOT NULL AND p_cursor_id IS NOT NULL
        AND (r.updated_at,r.id)<(p_cursor_updated_at,p_cursor_id)))
  ORDER BY r.updated_at DESC,r.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit,30),1),100)+1;
$$;
REVOKE ALL ON FUNCTION public.loomic_design_resources_list_scoped(
  text,text,text,text,uuid,uuid,text,text,timestamptz,uuid,integer,uuid
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.loomic_design_resources_list_scoped(
  text,text,text,text,uuid,uuid,text,text,timestamptz,uuid,integer,uuid
) TO authenticated,service_role;

-- A replaying submitter may encounter a durable queued job before its first
-- process has charged it. Locking the job makes charge-or-replay atomic and
-- also allows a later request to recover a pre-billing process crash.
CREATE OR REPLACE FUNCTION public.loomic_deduct_credits_idempotent(
  p_workspace_id uuid,
  p_user_id uuid,
  p_amount integer,
  p_job_id uuid,
  p_description text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE
  job_row public.background_jobs%ROWTYPE;
  transaction_id uuid;
BEGIN
  SELECT * INTO job_row FROM public.background_jobs
  WHERE id=p_job_id FOR UPDATE;
  IF job_row.id IS NULL
    OR job_row.workspace_id IS DISTINCT FROM p_workspace_id
    OR job_row.created_by IS DISTINCT FROM p_user_id
  THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='credit_job_not_found';
  END IF;
  IF job_row.credits_transaction_id IS NOT NULL THEN
    IF job_row.credits_cost IS DISTINCT FROM p_amount THEN
      RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='credit_price_mismatch';
    END IF;
    RETURN jsonb_build_object(
      'transaction_id',job_row.credits_transaction_id,'charged_new',false
    );
  END IF;
  SELECT id INTO transaction_id FROM public.credit_transactions
  WHERE job_id=p_job_id AND transaction_type='generation_deduct'
  LIMIT 1;
  IF transaction_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'transaction_id',transaction_id,'charged_new',false
    );
  END IF;
  transaction_id := public.deduct_credits(
    p_workspace_id,p_user_id,p_amount,p_job_id,p_description
  );
  RETURN jsonb_build_object(
    'transaction_id',transaction_id,'charged_new',true
  );
END;
$$;
REVOKE ALL ON FUNCTION public.loomic_deduct_credits_idempotent(
  uuid,uuid,integer,uuid,text
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.loomic_deduct_credits_idempotent(
  uuid,uuid,integer,uuid,text
) TO service_role;
