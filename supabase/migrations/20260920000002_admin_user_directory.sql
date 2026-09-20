-- B2: platform-level user directory and cross-workspace membership management.
--
-- Three write paths plus two read paths, all platform-admin only:
--   admin_add_workspace_member / admin_set_workspace_member_role / admin_remove_workspace_member
--   admin_user_directory / admin_workspace_directory
--
-- Same rules as B1: the write RPCs re-check the actor, require a reason and write
-- the admin_audit_events row in the same transaction, so a change can never exist
-- without its audit record. Reads are RPCs because the directory needs per-user
-- aggregates (last activity, 30-day runs/jobs/spend, workspace list) that would
-- otherwise be N+1 queries against PostgREST.
--
-- Ownership is deliberately NOT transferable here: a workspace's owner membership
-- is immutable in this console, exactly as it already is for workspace admins
-- (`member_owner_immutable`). Transferring ownership is its own product decision.

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_user_directory(
  p_actor_user_id uuid,
  p_query text DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 25,
  p_offset integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_needle text := NULLIF(btrim(COALESCE(p_query, '')), '');
  v_total integer;
  v_users jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;

  SELECT count(*) INTO v_total
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.id = u.id
  WHERE (p_user_id IS NULL OR u.id = p_user_id)
    AND (v_needle IS NULL
         OR coalesce(p.email, u.email) ILIKE '%' || v_needle || '%'
         OR coalesce(p.display_name, '') ILIKE '%' || v_needle || '%');

  SELECT coalesce(jsonb_agg(page.row_data ORDER BY page.created_at DESC, page.user_id), '[]'::jsonb)
  INTO v_users
  FROM (
    SELECT
      jsonb_build_object(
        'userId', u.id,
        'email', coalesce(p.email, u.email),
        'displayName', p.display_name,
        'createdAt', u.created_at,
        'isPlatformAdmin', coalesce(pa.is_active AND pa.revoked_at IS NULL, false),
        'lastActiveAt', greatest(activity.last_session_at, activity.last_job_at),
        'runs30d', coalesce(activity.runs_30d, 0),
        'jobs30d', coalesce(activity.jobs_30d, 0),
        'creditsSpent30d', coalesce(activity.credits_30d, 0),
        'workspaces', coalesce(memberships.workspaces, '[]'::jsonb)
      ) AS row_data,
      u.created_at AS created_at,
      u.id AS user_id
    FROM auth.users u
    LEFT JOIN public.profiles p ON p.id = u.id
    LEFT JOIN public.platform_admins pa ON pa.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT
        (SELECT max(cs.updated_at) FROM public.chat_sessions cs WHERE cs.created_by = u.id) AS last_session_at,
        (SELECT max(bj.created_at) FROM public.background_jobs bj WHERE bj.created_by = u.id) AS last_job_at,
        (SELECT count(*) FROM public.agent_runs ar
           JOIN public.chat_sessions cs2 ON cs2.id = ar.session_id
          WHERE cs2.created_by = u.id AND ar.created_at >= now() - interval '30 days') AS runs_30d,
        (SELECT count(*) FROM public.background_jobs bj2
          WHERE bj2.created_by = u.id AND bj2.created_at >= now() - interval '30 days') AS jobs_30d,
        (SELECT coalesce(sum(-ct.amount), 0) FROM public.credit_transactions ct
          WHERE ct.user_id = u.id AND ct.transaction_type = 'generation_deduct'
            AND ct.created_at >= now() - interval '30 days') AS credits_30d
    ) activity ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'type', w.type, 'role', wm.role)
                       ORDER BY wm.created_at) AS workspaces
      FROM public.workspace_members wm
      JOIN public.workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = u.id
    ) memberships ON true
    WHERE (p_user_id IS NULL OR u.id = p_user_id)
      AND (v_needle IS NULL
           OR coalesce(p.email, u.email) ILIKE '%' || v_needle || '%'
           OR coalesce(p.display_name, '') ILIKE '%' || v_needle || '%')
    ORDER BY u.created_at DESC, u.id
    LIMIT v_limit OFFSET v_offset
  ) page;

  RETURN jsonb_build_object('total', v_total, 'users', v_users);
END;
$$;

COMMENT ON FUNCTION public.admin_user_directory(uuid, text, uuid, integer, integer) IS
  'Platform-admin user directory: email/name search with 30-day activity and per-user workspace memberships. Read-only.';

CREATE OR REPLACE FUNCTION public.admin_workspace_directory(
  p_actor_user_id uuid,
  p_query text DEFAULT NULL,
  p_limit integer DEFAULT 25
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
  v_needle text := NULLIF(btrim(COALESCE(p_query, '')), '');
  v_workspaces jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;

  SELECT coalesce(jsonb_agg(page.row_data ORDER BY page.created_at DESC, page.id), '[]'::jsonb)
  INTO v_workspaces
  FROM (
    SELECT
      jsonb_build_object(
        'id', w.id,
        'name', w.name,
        'type', w.type,
        'createdAt', w.created_at,
        'memberCount', (SELECT count(*) FROM public.workspace_members wm WHERE wm.workspace_id = w.id)
      ) AS row_data,
      w.created_at,
      w.id
    FROM public.workspaces w
    WHERE (v_needle IS NULL OR w.name ILIKE '%' || v_needle || '%' OR w.id::text = v_needle)
    ORDER BY w.created_at DESC, w.id
    LIMIT v_limit
  ) page;

  RETURN jsonb_build_object('workspaces', v_workspaces);
END;
$$;

COMMENT ON FUNCTION public.admin_workspace_directory(uuid, text, integer) IS
  'Platform-admin workspace picker: name search with member counts. Read-only.';

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_add_workspace_member(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_user_id uuid,
  p_role public.workspace_member_role,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_after jsonb;
  v_workspace_name text;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 2 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a reason is required for a membership change';
  END IF;
  IF p_role = 'owner' THEN
    RAISE EXCEPTION 'INVALID_ROLE: ownership transfer is not available in this console';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id) THEN
    RAISE EXCEPTION 'UNKNOWN_USER: no such auth user';
  END IF;
  SELECT w.name INTO v_workspace_name FROM public.workspaces w WHERE w.id = p_workspace_id;
  IF v_workspace_name IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_WORKSPACE: no such workspace';
  END IF;
  IF EXISTS (SELECT 1 FROM public.workspace_members wm
              WHERE wm.workspace_id = p_workspace_id AND wm.user_id = p_user_id) THEN
    RAISE EXCEPTION 'ALREADY_MEMBER: the user is already a member of this workspace';
  END IF;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (p_workspace_id, p_user_id, p_role);

  v_after := jsonb_build_object('role', p_role, 'workspaceId', p_workspace_id, 'userId', p_user_id);

  INSERT INTO public.admin_audit_events
    (actor_user_id, action, target_kind, target_id, workspace_id, reason, before, after)
  VALUES
    (p_actor_user_id, 'workspace.member.add', 'user', p_user_id::text, p_workspace_id,
     btrim(p_reason), NULL, v_after);

  RETURN v_after;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_workspace_member_role(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_user_id uuid,
  p_role public.workspace_member_role,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before public.workspace_member_role;
  v_after jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 2 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a reason is required for a membership change';
  END IF;
  IF p_role = 'owner' THEN
    RAISE EXCEPTION 'INVALID_ROLE: ownership transfer is not available in this console';
  END IF;

  SELECT wm.role INTO v_before FROM public.workspace_members wm
   WHERE wm.workspace_id = p_workspace_id AND wm.user_id = p_user_id;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'NOT_MEMBER: the user is not a member of this workspace';
  END IF;
  IF v_before = 'owner' THEN
    RAISE EXCEPTION 'OWNER_IMMUTABLE: the workspace owner membership cannot be changed here';
  END IF;

  UPDATE public.workspace_members
     SET role = p_role
   WHERE workspace_id = p_workspace_id AND user_id = p_user_id;

  v_after := jsonb_build_object('role', p_role, 'workspaceId', p_workspace_id, 'userId', p_user_id);

  INSERT INTO public.admin_audit_events
    (actor_user_id, action, target_kind, target_id, workspace_id, reason, before, after)
  VALUES
    (p_actor_user_id, 'workspace.member.role', 'user', p_user_id::text, p_workspace_id,
     btrim(p_reason), jsonb_build_object('role', v_before), v_after);

  RETURN v_after;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_remove_workspace_member(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_user_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before public.workspace_member_role;
  v_after jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 2 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a reason is required for a membership change';
  END IF;

  SELECT wm.role INTO v_before FROM public.workspace_members wm
   WHERE wm.workspace_id = p_workspace_id AND wm.user_id = p_user_id;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'NOT_MEMBER: the user is not a member of this workspace';
  END IF;
  IF v_before = 'owner' THEN
    RAISE EXCEPTION 'OWNER_IMMUTABLE: the workspace owner membership cannot be removed here';
  END IF;

  DELETE FROM public.workspace_members
   WHERE workspace_id = p_workspace_id AND user_id = p_user_id;

  v_after := jsonb_build_object('removed', true, 'workspaceId', p_workspace_id, 'userId', p_user_id);

  INSERT INTO public.admin_audit_events
    (actor_user_id, action, target_kind, target_id, workspace_id, reason, before, after)
  VALUES
    (p_actor_user_id, 'workspace.member.remove', 'user', p_user_id::text, p_workspace_id,
     btrim(p_reason), jsonb_build_object('role', v_before), v_after);

  RETURN v_after;
END;
$$;

COMMENT ON FUNCTION public.admin_add_workspace_member(uuid, uuid, uuid, public.workspace_member_role, text) IS
  'Platform-admin: add a registered user to any workspace (admin/member only) and audit it atomically.';
COMMENT ON FUNCTION public.admin_set_workspace_member_role(uuid, uuid, uuid, public.workspace_member_role, text) IS
  'Platform-admin: change a non-owner membership role and audit it atomically.';
COMMENT ON FUNCTION public.admin_remove_workspace_member(uuid, uuid, uuid, text) IS
  'Platform-admin: remove a non-owner membership and audit it atomically.';

REVOKE ALL ON FUNCTION public.admin_user_directory(uuid, text, uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_workspace_directory(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_add_workspace_member(uuid, uuid, uuid, public.workspace_member_role, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_workspace_member_role(uuid, uuid, uuid, public.workspace_member_role, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_remove_workspace_member(uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_user_directory(uuid, text, uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_workspace_directory(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_add_workspace_member(uuid, uuid, uuid, public.workspace_member_role, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_workspace_member_role(uuid, uuid, uuid, public.workspace_member_role, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_remove_workspace_member(uuid, uuid, uuid, text) TO service_role;
