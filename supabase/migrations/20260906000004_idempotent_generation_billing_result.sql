-- Expose whether this caller created the charge so only its owner may refund.
DROP FUNCTION IF EXISTS public.loomic_deduct_credits_idempotent(
  uuid,uuid,integer,uuid,text
);
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
