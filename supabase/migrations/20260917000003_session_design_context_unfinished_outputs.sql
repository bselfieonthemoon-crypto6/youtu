-- Durable record of what the last run left undone: requests the image tool
-- refused before any submission attempt, plus plan steps still pending or
-- in_progress when the run ended (which is the only way a user cancellation
-- leaves recoverable evidence).
--
-- The next continuation turn ("继续 / 接着做 / 再来") is briefed from this
-- column, because the model never receives previous tool results, so a refused
-- edit_image and its title are otherwise invisible to the following turn.
--
-- Method/progress state only: this column resumes no job, creates no design
-- write and grants no execution, billing, model, ratio or source authority.
-- Every later submission still re-derives its own authorization per run.
ALTER TABLE public.session_design_context
  ADD COLUMN unfinished_outputs jsonb;

COMMENT ON COLUMN public.session_design_context.unfinished_outputs IS 'Bounded array of outputs the last run left unfinished ({title, kind: refused|planned, prompt?, operation?, aspectRatio?, sourceAssetIds?}); NULL when the last run left nothing. Progress/method state, not authorization.';

-- Bound matches SESSION_UNFINISHED_MAX_ITEMS in
-- apps/server/src/agent/session-design-context.ts (the hard run limit is 8, so
-- one run can never legitimately exceed it).
ALTER TABLE public.session_design_context
  ADD CONSTRAINT session_design_context_unfinished_outputs_bounded
  CHECK (
    unfinished_outputs IS NULL
    OR (jsonb_typeof(unfinished_outputs) = 'array' AND jsonb_array_length(unfinished_outputs) <= 8)
  );
