-- P0 #3 — truthful health check: the two `private` tables it needs.
--
-- Why this migration exists at all: `/api/health` used to be a constant
-- `{ok:true}`. It reported a healthy stack while message writes were failing in
-- the database, so nobody (human or monitor) could see the breakage. The
-- replacement probes five components, and two of them need durable state the
-- database did not have:
--
--   1. `private.loomic_health_probe` — a SINGLETON row whose `checked_at` is
--      upserted on every health request and read back in the same round trip.
--      A read-only `select 1` would NOT have caught the reported failure, where
--      reads succeeded and writes did not, so the probe must write. The
--      `singleton` primary key holding a constant 'health' means the table can
--      never grow: one row, rewritten in place, forever.
--
--   2. `private.loomic_worker_heartbeats` — the worker process upserts
--      `worker_id` + `last_seen_at` every 10s (see `worker-heartbeat.ts`), and
--      health calls the worker OFFLINE when the freshest row is older than 30s
--      (three missed beats, so one slow write cannot raise a false alarm).
--      Without it, "queue depth 0" and "nobody is consuming the queue" are
--      indistinguishable — the second half of the reported complaint.
--
-- Both tables live in the `private` schema ON PURPOSE: they are operational
-- state, not tenant data, and must never be exposed through PostgREST or
-- reachable by `anon`/`authenticated`. Only the server and worker (both
-- `service_role` through their own Supabase clients) read and write them.
--
-- Why the write path is an RPC: both the probe write and the worker heartbeat
-- write go through `public.loomic_*` SECURITY DEFINER functions, because
-- PostgREST in this deployment exposes only `public,storage,graphql_public`
-- (PGRST_DB_SCHEMAS) — a REST write straight to a `private` table answers
-- `PGRST205 could not find the table`, which is exactly what a first attempt at
-- this migration did. The functions are SECURITY DEFINER with `search_path = ''`
-- (every reference fully qualified), and EXECUTE is granted to `service_role`
-- ONLY, matching the house convention for public RPCs.
--
-- Cost: the probe is two statements on a one-row table plus one upsert on a
-- small table; measured well under the health endpoint's 900ms budget.

CREATE SCHEMA IF NOT EXISTS private;

-- ---------------------------------------------------------------------------
-- Database read+write probe: singleton row
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS private.loomic_health_probe (
  -- Constant 'health'. The primary key is what makes the table a singleton and
  -- what makes the upsert an idempotent update of the same row.
  singleton text PRIMARY KEY CHECK (singleton = 'health'),
  checked_at timestamptz NOT NULL,
  checked_by text
);

COMMENT ON TABLE private.loomic_health_probe IS
  'Singleton row rewritten by the /api/health database write probe. Never read for business logic; it exists so a health check can prove the database accepts a real write.';

-- New table => no policies (deny-all to anon/authenticated) and FORCE RLS, so
-- the service role is the only caller that can touch it. `service_role` has
-- BYPASSRLS in Supabase, which is what makes the grants below usable.
ALTER TABLE private.loomic_health_probe ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.loomic_health_probe FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.loomic_health_probe FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Worker liveness: one row per worker process identity
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS private.loomic_worker_heartbeats (
  worker_id text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- The queues this worker is actually polling, so health can say WHICH work
  -- this worker is responsible for instead of only "something is alive".
  queues text[] NOT NULL DEFAULT '{}'::text[],
  version text
);

COMMENT ON TABLE private.loomic_worker_heartbeats IS
  'One upserted row per worker process (keyed by WORKER_ID, or a derived id when unset). /api/health reads the freshest last_seen_at and calls the worker offline past a documented threshold.';

ALTER TABLE private.loomic_worker_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.loomic_worker_heartbeats FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.loomic_worker_heartbeats FROM PUBLIC, anon, authenticated;
-- No direct table grant: PostgREST only exposes `public,storage,graphql_public`
-- (PGRST_DB_SCHEMAS), so a REST write to this table answers
-- `PGRST205: could not find the table`. The worker writes through the
-- `public.loomic_worker_heartbeat_write` RPC below, which is also why the read
-- side is an RPC — one grant surface, one place the timings live.

-- Both tables grow by exactly one row per worker process, not per beat, but the
-- freshness read is an index-only scan with this index regardless of size.
CREATE INDEX IF NOT EXISTS loomic_worker_heartbeats_last_seen_at_idx
  ON private.loomic_worker_heartbeats (last_seen_at DESC);

-- ---------------------------------------------------------------------------
-- Probe RPC: a real write plus a read-back of the row just written
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.loomic_health_probe_write(
  p_singleton text,
  p_checked_by text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row private.loomic_health_probe;
  v_written timestamptz;
BEGIN
  -- The caller may only address the singleton. Anything else is a bug in the
  -- probe, not a row to create.
  IF p_singleton IS DISTINCT FROM 'health' THEN
    RAISE EXCEPTION 'loomic_health_probe_key_invalid';
  END IF;

  v_written := clock_timestamp();

  INSERT INTO private.loomic_health_probe (singleton, checked_at, checked_by)
  VALUES ('health', v_written, nullif(btrim(COALESCE(p_checked_by, '')), ''))
  ON CONFLICT (singleton) DO UPDATE
    SET checked_at = EXCLUDED.checked_at,
        checked_by = EXCLUDED.checked_by;

  -- Read back the persisted row. `INSERT ... RETURNING` cannot be used with the
  -- upsert here without a second statement anyway, and this is the value the
  -- probe compares against what it asked to write.
  SELECT * INTO v_row
  FROM private.loomic_health_probe
  WHERE singleton = 'health';

  IF NOT FOUND OR v_row.checked_at IS DISTINCT FROM v_written THEN
    RAISE EXCEPTION 'loomic_health_probe_write_not_visible';
  END IF;

  RETURN jsonb_build_object('writtenAt', v_row.checked_at);
END;
$$;

COMMENT ON FUNCTION public.loomic_health_probe_write(text, text) IS
  'Upserts the single private.loomic_health_probe row with a server-side timestamp and returns the persisted value, proving the database accepts a real write. Called by /api/health.';

-- `p_checked_by` is the server's own worker/host label, never user input; the
-- only constrained input is the singleton key.
REVOKE ALL ON FUNCTION public.loomic_health_probe_write(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_health_probe_write(text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- Worker heartbeat write RPC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.loomic_worker_heartbeat_write(
  p_worker_id text,
  p_queues text[] DEFAULT '{}'::text[],
  p_version text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_worker_id text := nullif(btrim(COALESCE(p_worker_id, '')), '');
  v_row private.loomic_worker_heartbeats;
BEGIN
  IF v_worker_id IS NULL OR length(v_worker_id) > 120 THEN
    RAISE EXCEPTION 'loomic_worker_heartbeat_id_invalid';
  END IF;

  -- `last_seen_at` is server time, never client time: a worker with a skewed
  -- clock must not be able to report itself fresh (or stale) on its own word.
  INSERT INTO private.loomic_worker_heartbeats (worker_id, last_seen_at, queues, version)
  VALUES (
    v_worker_id,
    clock_timestamp(),
    COALESCE(p_queues, '{}'::text[]),
    nullif(btrim(COALESCE(p_version, '')), '')
  )
  ON CONFLICT (worker_id) DO UPDATE
    SET last_seen_at = EXCLUDED.last_seen_at,
        queues = EXCLUDED.queues,
        version = EXCLUDED.version
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('workerId', v_row.worker_id, 'lastSeenAt', v_row.last_seen_at);
END;
$$;

COMMENT ON FUNCTION public.loomic_worker_heartbeat_write(text, text[], text) IS
  'Upserts this worker process heartbeat (server-side timestamp) into private.loomic_worker_heartbeats. Called periodically by the worker so /api/health can call it offline.';

REVOKE ALL ON FUNCTION public.loomic_worker_heartbeat_write(text, text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_worker_heartbeat_write(text, text[], text) TO service_role;

-- ---------------------------------------------------------------------------
-- Worker freshness RPC: newest beat plus the online count in one round trip
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.loomic_worker_heartbeat_snapshot(
  p_stale_after_seconds integer DEFAULT 30
) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  WITH fresh AS (
    SELECT worker_id, last_seen_at, queues, version
    FROM private.loomic_worker_heartbeats
    -- Clamped so a caller cannot turn the threshold into a nonsense value.
    WHERE last_seen_at >= clock_timestamp()
      - make_interval(secs => LEAST(GREATEST(COALESCE(p_stale_after_seconds, 30), 5), 3600))
  )
  SELECT jsonb_build_object(
    'onlineCount', (SELECT count(*) FROM fresh),
    'freshest', COALESCE((
      SELECT jsonb_build_object(
        'workerId', f.worker_id,
        'lastSeenAt', f.last_seen_at,
        'queues', to_jsonb(f.queues),
        'version', f.version
      )
      FROM fresh f
      ORDER BY f.last_seen_at DESC
      LIMIT 1
    ), 'null'::jsonb)
  );
$$;

COMMENT ON FUNCTION public.loomic_worker_heartbeat_snapshot(integer) IS
  'Newest worker heartbeat within the staleness window plus how many workers are online. Called by /api/health; an empty freshest means the worker is offline.';

REVOKE ALL ON FUNCTION public.loomic_worker_heartbeat_snapshot(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_worker_heartbeat_snapshot(integer) TO service_role;

-- PostgREST keeps its own schema cache; without this the two new RPCs would
-- answer PGRST202 ("could not find the function in the schema cache") until the
-- process restarted, which looks exactly like the bug this work is fixing.
NOTIFY pgrst, 'reload schema';
