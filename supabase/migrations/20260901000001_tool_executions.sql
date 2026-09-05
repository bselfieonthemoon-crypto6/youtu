-- Durable server-written ledger for agent tool execution and safe read-only retries.
CREATE TABLE public.tool_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  tool_call_id text NOT NULL,
  tool_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'canceled')),
  input jsonb,
  output jsonb,
  output_summary text,
  artifacts jsonb,
  error_code text,
  error_message text,
  retryable boolean NOT NULL DEFAULT false,
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  retry_of uuid REFERENCES public.tool_executions(id) ON DELETE SET NULL,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  retry_request_id uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, tool_call_id)
);

CREATE UNIQUE INDEX tool_executions_retry_request_idx
  ON public.tool_executions(requested_by, retry_request_id)
  WHERE retry_request_id IS NOT NULL;
CREATE INDEX tool_executions_run_created_idx
  ON public.tool_executions(run_id, created_at);
CREATE INDEX tool_executions_retry_of_idx
  ON public.tool_executions(retry_of)
  WHERE retry_of IS NOT NULL;

CREATE TRIGGER tool_executions_updated_at
  BEFORE UPDATE ON public.tool_executions
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);

ALTER TABLE public.tool_executions ENABLE ROW LEVEL SECURITY;

-- agent_runs is intentionally server-only, so expose only a boolean ownership
-- check to the RLS policy rather than granting clients access to run metadata.
CREATE OR REPLACE FUNCTION public.can_access_agent_run(target_run_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.agent_runs ar
    JOIN public.chat_sessions cs ON cs.id = ar.session_id
    JOIN public.canvases c ON c.id = cs.canvas_id
    JOIN public.projects p ON p.id = c.project_id
    JOIN public.workspace_members wm ON wm.workspace_id = p.workspace_id
    WHERE ar.id = target_run_id
      AND wm.user_id = auth.uid()
  );
$$;

REVOKE ALL ON FUNCTION public.can_access_agent_run(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_access_agent_run(uuid) TO authenticated;

CREATE POLICY tool_executions_select ON public.tool_executions
  FOR SELECT TO authenticated
  USING (public.can_access_agent_run(run_id));

-- No INSERT/UPDATE/DELETE policies: only the service-role server writes.
GRANT SELECT ON public.tool_executions TO authenticated;

