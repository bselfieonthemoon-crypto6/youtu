-- Credit mutations are server-only, but service-role access alone is not a
-- business invariant. Bind every generation charge/refund to the exact job and
-- derive daily grants from the persisted subscription plan.

CREATE UNIQUE INDEX credit_transactions_one_generation_deduct_per_job
  ON public.credit_transactions (job_id)
  WHERE transaction_type = 'generation_deduct'
    AND job_id IS NOT NULL;

ALTER TABLE public.payment_events
  ADD COLUMN delivery_fingerprint text;

CREATE UNIQUE INDEX payment_events_delivery_fingerprint_key
  ON public.payment_events (delivery_fingerprint)
  WHERE delivery_fingerprint IS NOT NULL;

CREATE UNIQUE INDEX credit_transactions_one_subscription_grant_per_delivery
  ON public.credit_transactions ((metadata->>'payment_fingerprint'))
  WHERE transaction_type = 'subscription_grant'
    AND metadata ? 'payment_fingerprint';

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

  SELECT billing_credits_cost, true INTO v_snapshot_cost, v_snapshot_found
  FROM public.provider_execution_snapshots
  WHERE background_job_id = p_job_id;

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

CREATE OR REPLACE FUNCTION public.refund_credits(
  p_workspace_id uuid,
  p_user_id uuid,
  p_amount integer,
  p_job_id uuid,
  p_description text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  job_row public.background_jobs%ROWTYPE;
  deduct_row public.credit_transactions%ROWTYPE;
  v_balance integer;
  v_version integer;
  v_new_balance integer;
  v_tx_id uuid;
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
  IF job_row.status::text NOT IN ('canceled', 'dead_letter') THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'credit_job_not_refundable';
  END IF;

  SELECT * INTO deduct_row
  FROM public.credit_transactions
  WHERE job_id = p_job_id
    AND workspace_id = p_workspace_id
    AND user_id = p_user_id
    AND transaction_type = 'generation_deduct';

  IF deduct_row.id IS NULL
    OR deduct_row.amount >= 0
    OR -deduct_row.amount IS DISTINCT FROM p_amount
    OR job_row.credits_cost IS DISTINCT FROM p_amount
    OR job_row.credits_transaction_id IS DISTINCT FROM deduct_row.id
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'credit_refund_mismatch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.credit_transactions
    WHERE job_id = p_job_id AND transaction_type = 'generation_refund'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'credit_job_already_refunded';
  END IF;

  SELECT balance, version INTO v_balance, v_version
  FROM public.credit_balances
  WHERE workspace_id = p_workspace_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'credit_balance_not_found';
  END IF;

  v_new_balance := v_balance + p_amount;
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
    (p_workspace_id, p_user_id, 'generation_refund', p_amount, v_new_balance, p_job_id, p_description)
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_daily_credits(
  p_workspace_id uuid,
  p_amount integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_plan public.subscription_plan;
  v_expected_amount integer;
  v_claim_id uuid;
  v_version integer;
  v_balance integer;
  v_new_balance integer;
BEGIN
  SELECT plan INTO v_plan
  FROM public.subscriptions
  WHERE workspace_id = p_workspace_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'credit_subscription_not_found';
  END IF;

  v_expected_amount := CASE v_plan WHEN 'free' THEN 50 ELSE 0 END;
  IF v_expected_amount <= 0 THEN RETURN false; END IF;
  IF p_amount IS DISTINCT FROM v_expected_amount THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'credit_daily_amount_mismatch';
  END IF;

  INSERT INTO public.credit_balances (workspace_id, balance, version)
  VALUES (p_workspace_id, 0, 0)
  ON CONFLICT (workspace_id) DO NOTHING;

  SELECT balance, version INTO v_balance, v_version
  FROM public.credit_balances
  WHERE workspace_id = p_workspace_id
  FOR UPDATE;

  INSERT INTO public.daily_credit_claims (workspace_id, claim_date, amount)
  VALUES (p_workspace_id, CURRENT_DATE, v_expected_amount)
  ON CONFLICT (workspace_id, claim_date) DO NOTHING
  RETURNING id INTO v_claim_id;

  IF v_claim_id IS NULL THEN RETURN false; END IF;

  v_new_balance := v_balance + v_expected_amount;
  UPDATE public.credit_balances
  SET balance = v_new_balance,
      version = v_version + 1,
      updated_at = now()
  WHERE workspace_id = p_workspace_id AND version = v_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'credit_concurrent_modification';
  END IF;

  INSERT INTO public.credit_transactions
    (workspace_id, transaction_type, amount, balance_after, description)
  VALUES
    (p_workspace_id, 'daily_grant', v_expected_amount, v_new_balance, 'Daily free credits');

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.grant_subscription_credits(
  p_workspace_id uuid,
  p_plan public.subscription_plan,
  p_payment_fingerprint text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current_plan public.subscription_plan;
  v_amount integer;
  v_balance integer;
  v_version integer;
  v_new_balance integer;
BEGIN
  IF p_payment_fingerprint IS NULL
    OR p_payment_fingerprint !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'credit_payment_fingerprint_invalid';
  END IF;

  SELECT plan INTO v_current_plan
  FROM public.subscriptions
  WHERE workspace_id = p_workspace_id
  FOR SHARE;

  IF NOT FOUND OR v_current_plan IS DISTINCT FROM p_plan THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'credit_subscription_plan_mismatch';
  END IF;

  v_amount := CASE p_plan
    WHEN 'starter' THEN 1200
    WHEN 'pro' THEN 5000
    WHEN 'ultra' THEN 15000
    WHEN 'business' THEN 50000
    ELSE 0
  END;
  IF v_amount <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'credit_subscription_plan_not_billable';
  END IF;

  INSERT INTO public.credit_balances (workspace_id, balance, version)
  VALUES (p_workspace_id, 0, 0)
  ON CONFLICT (workspace_id) DO NOTHING;

  SELECT balance, version INTO v_balance, v_version
  FROM public.credit_balances
  WHERE workspace_id = p_workspace_id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.credit_transactions
    WHERE transaction_type = 'subscription_grant'
      AND metadata->>'payment_fingerprint' = p_payment_fingerprint
  ) THEN
    RETURN false;
  END IF;

  v_new_balance := v_balance + v_amount;
  UPDATE public.credit_balances
  SET balance = v_new_balance,
      version = v_version + 1,
      updated_at = now()
  WHERE workspace_id = p_workspace_id AND version = v_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'credit_concurrent_modification';
  END IF;

  INSERT INTO public.credit_transactions
    (workspace_id, transaction_type, amount, balance_after, description, metadata)
  VALUES
    (p_workspace_id, 'subscription_grant', v_amount, v_new_balance,
     p_plan::text || ' plan - monthly credits granted',
     jsonb_build_object('payment_fingerprint', p_payment_fingerprint));

  RETURN true;
END;
$$;

-- Plan changes must come from the verified payment webhook path. Keep the old
-- function for migration compatibility, but make it non-callable by the app.
REVOKE EXECUTE ON FUNCTION public.grant_plan_credits(uuid, public.subscription_plan, integer)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.deduct_credits(uuid, uuid, integer, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refund_credits(uuid, uuid, integer, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_daily_credits(uuid, integer)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.deduct_credits(uuid, uuid, integer, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_credits(uuid, uuid, integer, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_daily_credits(uuid, integer)
  TO service_role;
REVOKE EXECUTE ON FUNCTION public.grant_subscription_credits(uuid, public.subscription_plan, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_subscription_credits(uuid, public.subscription_plan, text)
  TO service_role;
