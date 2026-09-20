-- B5b: platform channel health - self-test history and failure rates by error code.
--
-- Section four of the plan asks for cross-workspace channel visibility: which
-- channels exist, when each was last tested and what the test said, and which error
-- codes are actually costing us jobs. All three functions are reads; the console
-- still has no way to change somebody else's channel configuration, because that
-- would let a platform admin silently redirect a workspace's traffic.
--
-- Attribution note. `background_jobs.payload->>model` is a display token, not a
-- reference: it reads "workspace:<uuid>", "local:<name>" or a bare upstream model
-- name, and historical rows point at model ids that no longer exist. The record the
-- runtime writes to say which channel actually served a job is
-- `provider_execution_snapshots.provider_config_id`, so that is the join used here.
-- Jobs that have no snapshot (text/agent work, and rows imported before snapshots
-- existed) are counted and reported as unattributed rather than quietly dropped.

-- ---------------------------------------------------------------------------
-- Cross-workspace channel directory
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_channel_directory(
  p_actor_user_id uuid,
  p_workspace_id uuid DEFAULT NULL,
  p_query text DEFAULT NULL,
  p_enabled boolean DEFAULT NULL,
  p_test_status text DEFAULT NULL,
  p_days integer DEFAULT 30,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_since timestamptz;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_query text := nullif(btrim(COALESCE(p_query, '')), '');
  v_total integer;
  v_total_jobs integer;
  v_total_failures integer;
  v_channels jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  v_since := now() - make_interval(days => v_days);

  WITH base AS (
    SELECT c.id, c.workspace_id, c.display_name, c.adapter, c.base_url, c.enabled, c.revision,
           c.api_key_last_four, c.created_at, c.updated_at,
           c.last_tested_at, c.last_test_status, c.last_test_error_code,
           w.name AS workspace_name
    FROM public.workspace_provider_configs c
    JOIN public.workspaces w ON w.id = c.workspace_id
    WHERE (p_workspace_id IS NULL OR c.workspace_id = p_workspace_id)
      AND (p_enabled IS NULL OR c.enabled = p_enabled)
      AND (p_test_status IS NULL OR c.last_test_status = p_test_status)
      AND (v_query IS NULL
           OR c.display_name ILIKE '%' || v_query || '%'
           OR c.base_url ILIKE '%' || v_query || '%'
           OR w.name ILIKE '%' || v_query || '%')
  ),
  -- DISTINCT (config, job): one job can carry several snapshots (one per attempt),
  -- and counting attempts instead of jobs would inflate every failure rate.
  window_jobs AS (
    SELECT DISTINCT s.provider_config_id AS config_id, j.id AS job_id, j.status, j.error_code, j.created_at
    FROM public.background_jobs j
    JOIN public.provider_execution_snapshots s ON s.background_job_id = j.id
    WHERE j.created_at >= v_since
      AND s.provider_config_id IN (SELECT id FROM base)
  ),
  per_channel AS (
    SELECT config_id,
           count(*) AS jobs,
           count(*) FILTER (WHERE status IN ('failed', 'dead_letter')) AS failures,
           max(created_at) FILTER (WHERE status IN ('failed', 'dead_letter')) AS last_failure_at
    FROM window_jobs
    GROUP BY config_id
  ),
  per_error AS (
    SELECT config_id, error_code,
           count(*) AS failures,
           max(created_at) AS last_seen_at
    FROM window_jobs
    WHERE status IN ('failed', 'dead_letter') AND error_code IS NOT NULL
    GROUP BY config_id, error_code
  )
  SELECT
    (SELECT count(*) FROM base),
    COALESCE((SELECT sum(jobs) FROM per_channel), 0),
    COALESCE((SELECT sum(failures) FROM per_channel), 0),
    COALESCE((
      SELECT jsonb_agg(page.row_data
                       ORDER BY page.failures DESC, page.workspace_name, page.display_name, page.id)
      FROM (
        SELECT jsonb_build_object(
                 'id', b.id,
                 'workspaceId', b.workspace_id,
                 'workspaceName', b.workspace_name,
                 'displayName', b.display_name,
                 'adapter', b.adapter,
                 'baseUrl', b.base_url,
                 'enabled', b.enabled,
                 'revision', b.revision,
                 'apiKeyLastFour', b.api_key_last_four,
                 'createdAt', b.created_at,
                 'updatedAt', b.updated_at,
                 'lastTestedAt', b.last_tested_at,
                 'lastTestStatus', b.last_test_status,
                 'lastTestErrorCode', b.last_test_error_code,
                 'modelCount', COALESCE(m.model_count, 0),
                 'enabledModelCount', COALESCE(m.enabled_model_count, 0),
                 'modalities', COALESCE(m.modalities, '[]'::jsonb),
                 'windowDays', v_days,
                 'jobs', COALESCE(pc.jobs, 0),
                 'failures', COALESCE(pc.failures, 0),
                 'failureRate', CASE WHEN COALESCE(pc.jobs, 0) > 0
                                     THEN round(pc.failures::numeric / pc.jobs::numeric, 4)
                                     ELSE NULL END,
                 'lastFailureAt', pc.last_failure_at,
                 'topErrorCodes', COALESCE(pe.rows, '[]'::jsonb)
               ) AS row_data,
               COALESCE(pc.failures, 0) AS failures,
               b.workspace_name,
               b.display_name,
               b.id
        FROM base b
        LEFT JOIN per_channel pc ON pc.config_id = b.id
        LEFT JOIN LATERAL (
          SELECT count(*) AS model_count,
                 count(*) FILTER (WHERE mm.enabled) AS enabled_model_count,
                 to_jsonb(array_agg(DISTINCT mm.modality ORDER BY mm.modality)) AS modalities
          FROM public.workspace_provider_models mm
          WHERE mm.provider_config_id = b.id
        ) m ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object(
                   'errorCode', z.error_code, 'count', z.failures, 'lastSeenAt', z.last_seen_at)
                   ORDER BY z.failures DESC, z.error_code) AS rows
          FROM (
            SELECT e.error_code, e.failures, e.last_seen_at
            FROM per_error e
            WHERE e.config_id = b.id
            ORDER BY e.failures DESC, e.error_code
            LIMIT 5
          ) z
        ) pe ON true
        ORDER BY COALESCE(pc.failures, 0) DESC, b.workspace_name, b.display_name, b.id
        LIMIT v_limit OFFSET v_offset
      ) page
    ), '[]'::jsonb)
  INTO v_total, v_total_jobs, v_total_failures, v_channels;

  RETURN jsonb_build_object(
    'total', v_total,
    'windowDays', v_days,
    'totalJobs', v_total_jobs,
    'totalFailures', v_total_failures,
    'channels', v_channels
  );
END;
$$;

COMMENT ON FUNCTION public.admin_channel_directory(uuid, uuid, text, boolean, text, integer, integer, integer) IS
  'Platform-admin channel list across workspaces: identity, model counts, last self-test result, and job/failure counters attributed through provider_execution_snapshots. Read-only.';

-- ---------------------------------------------------------------------------
-- One channel: identity, self-test history, failure breakdown, recent failures
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_channel_detail(
  p_actor_user_id uuid,
  p_config_id uuid,
  p_days integer DEFAULT 30,
  p_history_limit integer DEFAULT 20,
  p_job_limit integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_since timestamptz;
  v_history_limit integer := LEAST(GREATEST(COALESCE(p_history_limit, 20), 1), 100);
  v_job_limit integer := LEAST(GREATEST(COALESCE(p_job_limit, 20), 1), 100);
  v_channel jsonb;
  v_history jsonb;
  v_errors jsonb;
  v_failures jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  v_since := now() - make_interval(days => v_days);

  SELECT jsonb_build_object(
           'id', c.id,
           'workspaceId', c.workspace_id,
           'workspaceName', w.name,
           'displayName', c.display_name,
           'adapter', c.adapter,
           'baseUrl', c.base_url,
           'enabled', c.enabled,
           'revision', c.revision,
           'apiKeyLastFour', c.api_key_last_four,
           'createdAt', c.created_at,
           'updatedAt', c.updated_at,
           'createdByEmail', creator.email,
           'updatedByEmail', updater.email,
           'lastTestedAt', c.last_tested_at,
           'lastTestStatus', c.last_test_status,
           'lastTestErrorCode', c.last_test_error_code,
           'modelCount', COALESCE(m.model_count, 0),
           'enabledModelCount', COALESCE(m.enabled_model_count, 0),
           'modalities', COALESCE(m.modalities, '[]'::jsonb),
           'windowDays', v_days,
           'jobs', COALESCE(pc.jobs, 0),
           'failures', COALESCE(pc.failures, 0),
           'failureRate', CASE WHEN COALESCE(pc.jobs, 0) > 0
                               THEN round(pc.failures::numeric / pc.jobs::numeric, 4)
                               ELSE NULL END,
           'lastFailureAt', pc.last_failure_at
         )
    INTO v_channel
    FROM public.workspace_provider_configs c
    JOIN public.workspaces w ON w.id = c.workspace_id
    LEFT JOIN public.profiles creator ON creator.id = c.created_by
    LEFT JOIN public.profiles updater ON updater.id = c.updated_by
    LEFT JOIN LATERAL (
      SELECT count(*) AS model_count,
             count(*) FILTER (WHERE mm.enabled) AS enabled_model_count,
             to_jsonb(array_agg(DISTINCT mm.modality ORDER BY mm.modality)) AS modalities
      FROM public.workspace_provider_models mm
      WHERE mm.provider_config_id = c.id
    ) m ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS jobs,
             count(*) FILTER (WHERE j.status IN ('failed', 'dead_letter')) AS failures,
             max(j.created_at) FILTER (WHERE j.status IN ('failed', 'dead_letter')) AS last_failure_at
      FROM (
        SELECT DISTINCT j2.id, j2.status, j2.created_at
        FROM public.background_jobs j2
        JOIN public.provider_execution_snapshots s ON s.background_job_id = j2.id
        WHERE s.provider_config_id = c.id AND j2.created_at >= v_since
      ) j
    ) pc ON true
   WHERE c.id = p_config_id;

  IF v_channel IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_CHANNEL: no such provider configuration';
  END IF;

  -- The self-test records live in the same table as configuration changes, so the
  -- history shows both and the UI reads the action to tell them apart.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'action', e.action,
           'actorUserId', e.actor_user_id,
           'actorEmail', p.email,
           'errorCode', e.safe_details ->> 'errorCode',
           'createdAt', e.created_at
         ) ORDER BY e.created_at DESC), '[]'::jsonb)
    INTO v_history
    FROM (
      SELECT ae.action, ae.actor_user_id, ae.safe_details, ae.created_at
      FROM public.workspace_provider_audit_events ae
      WHERE ae.provider_config_id = p_config_id
      ORDER BY ae.created_at DESC
      LIMIT v_history_limit
    ) e
    LEFT JOIN public.profiles p ON p.id = e.actor_user_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'errorCode', x.error_code,
           'failures', x.failures,
           'failed', x.failed,
           'deadLetter', x.dead_letter,
           'lastSeenAt', x.last_seen_at
         ) ORDER BY x.failures DESC, x.error_code), '[]'::jsonb)
    INTO v_errors
    FROM (
      SELECT j.error_code,
             count(*) AS failures,
             count(*) FILTER (WHERE j.status = 'failed') AS failed,
             count(*) FILTER (WHERE j.status = 'dead_letter') AS dead_letter,
             max(j.created_at) AS last_seen_at
      FROM (
        SELECT DISTINCT j2.id, j2.status, j2.error_code, j2.created_at
        FROM public.background_jobs j2
        JOIN public.provider_execution_snapshots s ON s.background_job_id = j2.id
        WHERE s.provider_config_id = p_config_id
          AND j2.created_at >= v_since
          AND j2.status IN ('failed', 'dead_letter')
          AND j2.error_code IS NOT NULL
      ) j
      GROUP BY j.error_code
    ) x;

  -- Recent failures ignore the window on purpose: "why did this channel break" is
  -- a question about the newest evidence, whatever the reporting period says.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'jobId', y.id,
           'jobType', y.job_type::text,
           'status', y.status::text,
           'errorCode', y.error_code,
           'createdAt', y.created_at,
           'finishedAt', COALESCE(y.completed_at, y.failed_at, y.canceled_at)
         ) ORDER BY y.created_at DESC), '[]'::jsonb)
    INTO v_failures
    FROM (
      SELECT j2.id, j2.job_type, j2.status, j2.error_code, j2.created_at,
             j2.completed_at, j2.failed_at, j2.canceled_at
      FROM public.background_jobs j2
      WHERE j2.status IN ('failed', 'dead_letter')
        AND EXISTS (
          SELECT 1 FROM public.provider_execution_snapshots s
          WHERE s.background_job_id = j2.id AND s.provider_config_id = p_config_id
        )
      ORDER BY j2.created_at DESC
      LIMIT v_job_limit
    ) y;

  RETURN jsonb_build_object(
    'channel', v_channel,
    'history', v_history,
    'errorCodes', v_errors,
    'failures', v_failures
  );
END;
$$;

COMMENT ON FUNCTION public.admin_channel_detail(uuid, uuid, integer, integer, integer) IS
  'Platform-admin channel detail: identity, self-test and configuration history, per-error-code failure breakdown for the window, and the newest failing jobs. Read-only.';

-- ---------------------------------------------------------------------------
-- Platform-wide failure rates by error code
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_channel_failure_rates(
  p_actor_user_id uuid,
  p_days integer DEFAULT 30,
  p_limit integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_since timestamptz;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_total_jobs integer;
  v_total_failures integer;
  v_attributed_jobs integer;
  v_attributed_failures integer;
  v_channels integer;
  v_rows jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  v_since := now() - make_interval(days => v_days);

  -- Two rates, both named for what they measure. The provider rate is the one an
  -- operator acts on ("how often does a channel let us down"), but only jobs that
  -- reached a channel can have one; the overall rate covers every job in the window
  -- so a class of failure that never touches a channel stays visible instead of
  -- disappearing from the denominator.
  SELECT count(*),
         count(*) FILTER (WHERE j.status IN ('failed', 'dead_letter')),
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM public.provider_execution_snapshots s WHERE s.background_job_id = j.id)),
         count(*) FILTER (WHERE j.status IN ('failed', 'dead_letter') AND EXISTS (
           SELECT 1 FROM public.provider_execution_snapshots s WHERE s.background_job_id = j.id))
    INTO v_total_jobs, v_total_failures, v_attributed_jobs, v_attributed_failures
    FROM public.background_jobs j
   WHERE j.created_at >= v_since;

  SELECT count(DISTINCT s.provider_config_id)
    INTO v_channels
    FROM public.provider_execution_snapshots s
    JOIN public.background_jobs j ON j.id = s.background_job_id
   WHERE j.created_at >= v_since;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'errorCode', r.error_code,
           'failures', r.failures,
           'failed', r.failed,
           'deadLetter', r.dead_letter,
           'share', CASE WHEN v_total_failures > 0
                         THEN round(r.failures::numeric / v_total_failures::numeric, 4)
                         ELSE NULL END,
           'channelCount', r.channel_count,
           'lastSeenAt', r.last_seen_at
         ) ORDER BY r.failures DESC, r.error_code), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT j.error_code,
             count(*) AS failures,
             count(*) FILTER (WHERE j.status = 'failed') AS failed,
             count(*) FILTER (WHERE j.status = 'dead_letter') AS dead_letter,
             max(j.created_at) AS last_seen_at,
             count(DISTINCT s.provider_config_id) AS channel_count
      FROM public.background_jobs j
      LEFT JOIN public.provider_execution_snapshots s ON s.background_job_id = j.id
      WHERE j.created_at >= v_since
        AND j.status IN ('failed', 'dead_letter')
        AND j.error_code IS NOT NULL
      GROUP BY j.error_code
      ORDER BY count(*) DESC, j.error_code
      LIMIT v_limit
    ) r;

  RETURN jsonb_build_object(
    'windowDays', v_days,
    'totalJobs', v_total_jobs,
    'totalFailures', v_total_failures,
    'overallFailureRate', CASE WHEN v_total_jobs > 0
                               THEN round(v_total_failures::numeric / v_total_jobs::numeric, 4)
                               ELSE NULL END,
    'providerJobs', v_attributed_jobs,
    'providerFailures', v_attributed_failures,
    'providerFailureRate', CASE WHEN v_attributed_jobs > 0
                                THEN round(v_attributed_failures::numeric / v_attributed_jobs::numeric, 4)
                                ELSE NULL END,
    'channelCount', v_channels,
    'errorCodes', v_rows
  );
END;
$$;

COMMENT ON FUNCTION public.admin_channel_failure_rates(uuid, integer, integer) IS
  'Platform-admin failure rates for a window: per error code with its share of all failures and how many channels it touched, plus both the provider-attributed rate and the all-jobs rate. Read-only.';

REVOKE ALL ON FUNCTION public.admin_channel_directory(uuid, uuid, text, boolean, text, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_channel_detail(uuid, uuid, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_channel_failure_rates(uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_channel_directory(uuid, uuid, text, boolean, text, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_channel_detail(uuid, uuid, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_channel_failure_rates(uuid, integer, integer) TO service_role;
