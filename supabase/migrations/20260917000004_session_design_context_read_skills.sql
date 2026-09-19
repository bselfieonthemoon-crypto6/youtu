-- Bounded record of the Skill guides this conversation actually READ.
--
-- History is replayed to the model as plain user/assistant text, so a previous
-- turn's tool receipts never reach a later turn. A run that had genuinely loaded
-- two guides (use_skill returned status=loaded with a full body and a content
-- hash) was told by itself two turns later that "没有实际加载过任何技能正文", and
-- then answered a follow-up about those Skills from memory instead of re-reading
-- the catalog — producing a wrong comparison table.
--
-- This column is the persisted answer to "which guides has this conversation
-- already loaded", injected into current_context as evidence. Method state only:
-- it selects no Skill, resumes no job, and grants no execution, billing, model,
-- ratio or source authority.
ALTER TABLE public.session_design_context
  ADD COLUMN IF NOT EXISTS read_skills jsonb;

COMMENT ON COLUMN public.session_design_context.read_skills IS 'Bounded, newest-first array of Skill guides this conversation actually loaded ({slug, version?, at?}); NULL when nothing was read. Evidence for the next turn, never authorization.';

-- Bound matches SESSION_READ_SKILLS_MAX_ITEMS in
-- apps/server/src/agent/session-design-context.ts.
ALTER TABLE public.session_design_context
  DROP CONSTRAINT IF EXISTS session_design_context_read_skills_bounded;
ALTER TABLE public.session_design_context
  ADD CONSTRAINT session_design_context_read_skills_bounded
  CHECK (
    read_skills IS NULL
    OR (jsonb_typeof(read_skills) = 'array' AND jsonb_array_length(read_skills) <= 12)
  );
