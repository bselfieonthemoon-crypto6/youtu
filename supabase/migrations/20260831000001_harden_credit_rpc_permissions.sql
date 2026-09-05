-- Credit mutation RPCs are server-only. PostgreSQL grants EXECUTE on new
-- functions to PUBLIC by default, which would let browser clients call these
-- SECURITY DEFINER functions and choose arbitrary amounts/workspaces.

REVOKE EXECUTE ON FUNCTION public.deduct_credits(uuid, uuid, integer, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refund_credits(uuid, uuid, integer, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_daily_credits(uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.grant_plan_credits(uuid, public.subscription_plan, integer)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.deduct_credits(uuid, uuid, integer, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_credits(uuid, uuid, integer, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_daily_credits(uuid, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.grant_plan_credits(uuid, public.subscription_plan, integer)
  TO service_role;
