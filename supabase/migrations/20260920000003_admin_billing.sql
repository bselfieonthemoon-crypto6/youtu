-- B3: platform-admin plan and credit management, plus per-workspace reconciliation.
--
-- The old authenticated plan override was deliberately removed from the HTTP API
-- (a security test asserts `/api/credits/admin/set-plan` stays 404), so today a
-- self-hosted install with no payment provider cannot change a plan at all. This
-- adds the capability back on the correct footing: platform admins only, a stated
-- reason, and the audit row written in the same transaction as the change.
--
-- Nothing here changes how generation is billed. `deduct_credits`,
-- `refund_credits` and the tier guard are untouched; these functions only move a
-- workspace's plan and balance through the same ledger the rest of the system
-- reads, so a later reconciliation sees one consistent story.

-- ---------------------------------------------------------------------------
-- Set plan (optionally granting credits in the same transaction)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_workspace_plan(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_plan public.subscription_plan,
  p_grant_credits integer,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_name text;
  v_plan_before public.subscription_plan;
  v_balance integer;
  v_version integer;
  v_new_balance integer;
  v_grant integer := COALESCE(p_grant_credits, 0);
  v_after jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 2 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a reason is required for a billing change';
  END IF;
  IF v_grant < 0 OR v_grant > 1000000 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: granted credits must be between 0 and 1000000';
  END IF;
  SELECT w.name INTO v_workspace_name FROM public.workspaces w WHERE w.id = p_workspace_id;
  IF v_workspace_name IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_WORKSPACE: no such workspace';
  END IF;

  -- Both rows are created by the workspace trigger; upsert anyway so a workspace
  -- from before that trigger (or with a missing row) cannot break an admin action.
  INSERT INTO public.subscriptions (workspace_id, plan) VALUES (p_workspace_id, p_plan)
  ON CONFLICT (workspace_id) DO NOTHING;
  INSERT INTO public.credit_balances (workspace_id, balance, version) VALUES (p_workspace_id, 0, 0)
  ON CONFLICT (workspace_id) DO NOTHING;

  SELECT plan INTO v_plan_before FROM public.subscriptions WHERE workspace_id = p_workspace_id;
  SELECT balance, version INTO v_balance, v_version
    FROM public.credit_balances WHERE workspace_id = p_workspace_id FOR UPDATE;

  UPDATE public.subscriptions
     SET plan = p_plan, updated_at = now()
   WHERE workspace_id = p_workspace_id;

  v_new_balance := v_balance + v_grant;
  IF v_grant > 0 THEN
    UPDATE public.credit_balances
       SET balance = v_new_balance, version = v_version + 1, updated_at = now()
     WHERE workspace_id = p_workspace_id AND version = v_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CONCURRENT_MODIFICATION: credit balance changed while updating';
    END IF;

    INSERT INTO public.credit_transactions
      (workspace_id, user_id, transaction_type, amount, balance_after, description)
    VALUES
      (p_workspace_id, p_actor_user_id, 'subscription_grant', v_grant, v_new_balance,
       '平台管理员调整套餐为 ' || p_plan::text || '：' || btrim(p_reason));
  END IF;

  v_after := jsonb_build_object(
    'plan', p_plan,
    'planBefore', v_plan_before,
    'grantedCredits', v_grant,
    'balance', v_new_balance
  );

  INSERT INTO public.admin_audit_events
    (actor_user_id, action, target_kind, target_id, workspace_id, reason, before, after)
  VALUES
    (p_actor_user_id, 'workspace.plan.set', 'workspace', p_workspace_id::text, p_workspace_id,
     btrim(p_reason),
     jsonb_build_object('plan', v_plan_before, 'balance', v_balance),
     v_after);

  RETURN v_after;
END;
$$;

COMMENT ON FUNCTION public.admin_set_workspace_plan(uuid, uuid, public.subscription_plan, integer, text) IS
  'Platform-admin: set a workspace plan and optionally grant credits, writing one ledger row and one audit row in the same transaction.';

-- ---------------------------------------------------------------------------
-- Adjust credits (grant or deduct) without touching the plan
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_adjust_credits(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_delta integer,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_name text;
  v_balance integer;
  v_version integer;
  v_new_balance integer;
  v_after jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 2 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a reason is required for a billing change';
  END IF;
  IF p_delta IS NULL OR p_delta = 0 OR abs(p_delta) > 1000000 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: the adjustment must be a non-zero amount within 1000000';
  END IF;
  SELECT w.name INTO v_workspace_name FROM public.workspaces w WHERE w.id = p_workspace_id;
  IF v_workspace_name IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_WORKSPACE: no such workspace';
  END IF;

  INSERT INTO public.credit_balances (workspace_id, balance, version) VALUES (p_workspace_id, 0, 0)
  ON CONFLICT (workspace_id) DO NOTHING;

  SELECT balance, version INTO v_balance, v_version
    FROM public.credit_balances WHERE workspace_id = p_workspace_id FOR UPDATE;

  v_new_balance := v_balance + p_delta;
  IF v_new_balance < 0 THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE: the adjustment would make the balance negative';
  END IF;

  UPDATE public.credit_balances
     SET balance = v_new_balance, version = v_version + 1, updated_at = now()
   WHERE workspace_id = p_workspace_id AND version = v_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONCURRENT_MODIFICATION: credit balance changed while updating';
  END IF;

  INSERT INTO public.credit_transactions
    (workspace_id, user_id, transaction_type, amount, balance_after, description)
  VALUES
    (p_workspace_id, p_actor_user_id, 'admin_adjustment', p_delta, v_new_balance, btrim(p_reason));

  v_after := jsonb_build_object('delta', p_delta, 'balance', v_new_balance);

  INSERT INTO public.admin_audit_events
    (actor_user_id, action, target_kind, target_id, workspace_id, reason, before, after)
  VALUES
    (p_actor_user_id, 'credits.adjust', 'workspace', p_workspace_id::text, p_workspace_id,
     btrim(p_reason),
     jsonb_build_object('balance', v_balance),
     v_after);

  RETURN v_after;
END;
$$;

COMMENT ON FUNCTION public.admin_adjust_credits(uuid, uuid, integer, text) IS
  'Platform-admin: grant or deduct workspace credits (never below zero), writing one admin_adjustment ledger row and one audit row atomically.';

-- ---------------------------------------------------------------------------
-- Per-workspace billing view + reconciliation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_workspace_billing(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_tx_limit integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_tx_limit, 20), 1), 100);
  v_workspace record;
  v_balance integer;
  v_transactions jsonb;
  v_mismatches jsonb;
  v_deducted integer;
  v_refunded integer;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;

  SELECT w.id, w.name, w.type, w.created_at,
         s.plan, s.billing_period, s.current_period_start, s.current_period_end,
         s.canceled_at, s.stripe_subscription_id
    INTO v_workspace
    FROM public.workspaces w
    LEFT JOIN public.subscriptions s ON s.workspace_id = w.id
   WHERE w.id = p_workspace_id;
  IF v_workspace.id IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_WORKSPACE: no such workspace';
  END IF;

  SELECT balance INTO v_balance FROM public.credit_balances WHERE workspace_id = p_workspace_id;

  SELECT coalesce(sum(-ct.amount) FILTER (WHERE ct.transaction_type = 'generation_deduct'), 0),
         coalesce(sum(ct.amount) FILTER (WHERE ct.transaction_type = 'generation_refund'), 0)
    INTO v_deducted, v_refunded
    FROM public.credit_transactions ct
   WHERE ct.workspace_id = p_workspace_id AND ct.created_at >= now() - interval '30 days';

  SELECT coalesce(jsonb_agg(row_data ORDER BY created_at DESC), '[]'::jsonb) INTO v_transactions
  FROM (
    SELECT jsonb_build_object(
             'id', ct.id,
             'transactionType', ct.transaction_type,
             'amount', ct.amount,
             'balanceAfter', ct.balance_after,
             'jobId', ct.job_id,
             'description', ct.description,
             'actorEmail', p.email,
             'createdAt', ct.created_at
           ) AS row_data,
           ct.created_at
      FROM public.credit_transactions ct
      LEFT JOIN public.profiles p ON p.id = ct.user_id
     WHERE ct.workspace_id = p_workspace_id
     ORDER BY ct.created_at DESC
     LIMIT v_limit
  ) page;

  -- Reconciliation: a job whose recorded cost differs from what the ledger
  -- actually charged (or charged nothing / charged without a recorded cost).
  SELECT coalesce(jsonb_agg(row_data ORDER BY created_at DESC), '[]'::jsonb) INTO v_mismatches
  FROM (
    SELECT jsonb_build_object(
             'jobId', bj.id,
             'status', bj.status,
             'jobType', bj.job_type,
             'recordedCreditsCost', coalesce(bj.credits_cost, 0),
             'ledgerCharged', coalesce(sum(-ct.amount) FILTER (WHERE ct.transaction_type = 'generation_deduct'), 0),
             'ledgerRefunded', coalesce(sum(ct.amount) FILTER (WHERE ct.transaction_type = 'generation_refund'), 0),
             'createdAt', bj.created_at
           ) AS row_data,
           bj.created_at
      FROM public.background_jobs bj
      LEFT JOIN public.credit_transactions ct ON ct.job_id = bj.id
     WHERE bj.workspace_id = p_workspace_id
     GROUP BY bj.id, bj.status, bj.job_type, bj.credits_cost, bj.created_at
    HAVING coalesce(bj.credits_cost, 0) <> coalesce(sum(-ct.amount) FILTER (WHERE ct.transaction_type = 'generation_deduct'), 0)
     ORDER BY bj.created_at DESC
     LIMIT 20
  ) page;

  RETURN jsonb_build_object(
    'workspace', jsonb_build_object(
      'id', v_workspace.id,
      'name', v_workspace.name,
      'type', v_workspace.type,
      'createdAt', v_workspace.created_at
    ),
    'plan', coalesce(v_workspace.plan, 'free'),
    'balance', coalesce(v_balance, 0),
    'subscription', jsonb_build_object(
      'billingPeriod', v_workspace.billing_period,
      'currentPeriodStart', v_workspace.current_period_start,
      'currentPeriodEnd', v_workspace.current_period_end,
      'canceledAt', v_workspace.canceled_at,
      'hasExternalSubscription', v_workspace.stripe_subscription_id IS NOT NULL
    ),
    'last30d', jsonb_build_object('deductedCredits', v_deducted, 'refundedCredits', v_refunded),
    'recentTransactions', v_transactions,
    'mismatchedJobs', v_mismatches
  );
END;
$$;

COMMENT ON FUNCTION public.admin_workspace_billing(uuid, uuid, integer) IS
  'Platform-admin: one workspace''s plan, balance, subscription window, 30-day ledger totals, recent transactions and jobs whose recorded cost disagrees with the ledger. Read-only.';

REVOKE ALL ON FUNCTION public.admin_set_workspace_plan(uuid, uuid, public.subscription_plan, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_adjust_credits(uuid, uuid, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_workspace_billing(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_workspace_plan(uuid, uuid, public.subscription_plan, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_adjust_credits(uuid, uuid, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_workspace_billing(uuid, uuid, integer) TO service_role;
