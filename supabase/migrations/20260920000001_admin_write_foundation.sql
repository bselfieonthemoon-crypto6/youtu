-- B1: write-operation foundation for the platform operations console.
--
-- Two problems this closes:
--   1. There is no platform-level audit trail. The only audit table today is
--      workspace_provider_audit_events, which covers provider configuration and
--      nothing else, so "who changed this workspace's plan" had no answer.
--   2. Platform admin grant/revoke only existed as hand-written SQL with no
--      guard, so an operator could revoke the last admin and lock the install
--      out of its own console.
--
-- The write paths are RPCs (not service-role table writes) on purpose: the audit
-- row must commit in the SAME transaction as the change it describes, otherwise a
-- failed audit write would leave an unaudited privileged change behind. Each RPC
-- also re-checks the actor with private.is_platform_admin, so the HTTP guard is
-- defence in depth rather than the only control.
--
-- Authorization model stays exactly as it is today: nothing here changes
-- auth.users, the RLS contracts, or any policy. The audit table is FORCE ROW
-- LEVEL SECURITY with no policies, so only the service role can read or write it
-- (server-mediated access only).

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
CREATE TABLE public.admin_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (char_length(btrim(action)) BETWEEN 3 AND 100),
  target_kind text NOT NULL CHECK (char_length(btrim(target_kind)) BETWEEN 2 AND 40),
  target_id text NOT NULL CHECK (char_length(btrim(target_id)) BETWEEN 1 AND 200),
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE SET NULL,
  reason text CHECK (reason IS NULL OR char_length(reason) <= 500),
  before jsonb CHECK (before IS NULL OR jsonb_typeof(before) = 'object'),
  after jsonb CHECK (after IS NULL OR jsonb_typeof(after) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.admin_audit_events IS
  'Platform-admin write audit trail: who changed what, when, why, and the before/after snapshot. Written inside the same transaction as the change. Service-role access only.';
COMMENT ON COLUMN public.admin_audit_events.action IS
  'Stable action id, e.g. platform_admin.grant, platform_admin.revoke, workspace.plan.set, credits.adjust, skill.preview.publish.';
COMMENT ON COLUMN public.admin_audit_events.target_kind IS
  'Domain object kind the action applied to: user, workspace, skill, job, provider_config, ...';

CREATE INDEX admin_audit_events_created_at_idx ON public.admin_audit_events (created_at DESC);
CREATE INDEX admin_audit_events_target_idx ON public.admin_audit_events (target_kind, target_id, created_at DESC);
CREATE INDEX admin_audit_events_actor_idx ON public.admin_audit_events (actor_user_id, created_at DESC);

ALTER TABLE public.admin_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit_events FORCE ROW LEVEL SECURITY;
-- Deliberately no policies: the server reads this through the service role, and no
-- workspace member may read the platform's operation log through PostgREST.

-- ---------------------------------------------------------------------------
-- Platform admin grant / revoke
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_grant_platform_admin(
  p_actor_user_id uuid,
  p_user_id uuid,
  p_reason text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_TARGET: user id is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id) THEN
    RAISE EXCEPTION 'UNKNOWN_USER: no such auth user';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 2 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a reason is required for an access change';
  END IF;

  SELECT to_jsonb(pa) INTO v_before FROM public.platform_admins pa WHERE pa.user_id = p_user_id;

  INSERT INTO public.platform_admins (user_id, is_active, granted_by, granted_at, revoked_at)
  VALUES (p_user_id, true, p_actor_user_id, now(), NULL)
  ON CONFLICT (user_id) DO UPDATE
    SET is_active = true,
        granted_by = p_actor_user_id,
        granted_at = now(),
        revoked_at = NULL;

  SELECT to_jsonb(pa) INTO v_after FROM public.platform_admins pa WHERE pa.user_id = p_user_id;

  INSERT INTO public.admin_audit_events
    (actor_user_id, action, target_kind, target_id, reason, before, after)
  VALUES
    (p_actor_user_id, 'platform_admin.grant', 'user', p_user_id::text, btrim(p_reason), v_before, v_after);

  RETURN p_user_id::text;
END;
$$;

COMMENT ON FUNCTION public.admin_grant_platform_admin(uuid, uuid, text) IS
  'Grant (or re-activate) platform admin rights and write the audit row atomically. Actor must already be an active platform admin; a reason is required.';

CREATE OR REPLACE FUNCTION public.admin_revoke_platform_admin(
  p_actor_user_id uuid,
  p_user_id uuid,
  p_reason text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_remaining integer;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_TARGET: user id is required';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 2 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a reason is required for an access change';
  END IF;

  SELECT to_jsonb(pa) INTO v_before FROM public.platform_admins pa WHERE pa.user_id = p_user_id;
  IF v_before IS NULL OR (v_before->>'is_active')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'NOT_PLATFORM_ADMIN: target is not an active platform admin';
  END IF;

  -- Serialize concurrent revokes so two operators cannot each remove one of the
  -- last two admins and leave the install with none.
  PERFORM pg_advisory_xact_lock(hashtext('admin_platform_admins')::bigint);

  SELECT count(*) INTO v_remaining
  FROM public.platform_admins
  WHERE is_active AND revoked_at IS NULL AND user_id <> p_user_id;

  IF v_remaining = 0 THEN
    RAISE EXCEPTION 'LAST_PLATFORM_ADMIN: refusing to revoke the last active platform admin';
  END IF;

  UPDATE public.platform_admins
  SET is_active = false, revoked_at = now()
  WHERE user_id = p_user_id;

  SELECT to_jsonb(pa) INTO v_after FROM public.platform_admins pa WHERE pa.user_id = p_user_id;

  INSERT INTO public.admin_audit_events
    (actor_user_id, action, target_kind, target_id, reason, before, after)
  VALUES
    (p_actor_user_id, 'platform_admin.revoke', 'user', p_user_id::text, btrim(p_reason), v_before, v_after);

  RETURN p_user_id::text;
END;
$$;

COMMENT ON FUNCTION public.admin_revoke_platform_admin(uuid, uuid, text) IS
  'Revoke platform admin rights and write the audit row atomically. Refuses to remove the last active platform admin (which also covers revoking yourself when you are the only one).';

REVOKE ALL ON FUNCTION public.admin_grant_platform_admin(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_revoke_platform_admin(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_grant_platform_admin(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_revoke_platform_admin(uuid, uuid, text) TO service_role;
