-- Persist user-visible run history and explicitly link tool executions to
-- committed plan steps.  Plan links are nullable by design: an ambiguous
-- execution must remain unassociated rather than be guessed.

ALTER TABLE public.agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_status_check;

ALTER TABLE public.agent_runs
  ADD CONSTRAINT agent_runs_status_check
    CHECK (status IN ('accepted', 'running', 'completed', 'failed', 'canceled')),
  ADD COLUMN execution_mode text NOT NULL DEFAULT 'fast'
    CHECK (execution_mode IN ('fast', 'thinking')),
  ADD COLUMN created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN started_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX agent_runs_created_by_created_at_idx
  ON public.agent_runs(created_by, created_at DESC);

CREATE TRIGGER agent_runs_updated_at
  BEFORE UPDATE ON public.agent_runs
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);

ALTER TABLE public.tool_executions
  ADD COLUMN plan_id text,
  ADD COLUMN plan_step_id text,
  ADD CONSTRAINT tool_executions_plan_link_pair_check CHECK (
    (plan_id IS NULL AND plan_step_id IS NULL)
    OR (plan_id IS NOT NULL AND plan_step_id IS NOT NULL)
  );

CREATE INDEX tool_executions_plan_step_idx
  ON public.tool_executions(run_id, plan_id, plan_step_id)
  WHERE plan_step_id IS NOT NULL;

