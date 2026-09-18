-- Session-level sticky Skill selection and series preferences.
--
-- Method state only: this table never stores execution authorization. Image
-- submission, aspect-ratio approximation and source lineage stay per-run.
-- One row per conversation session; absent row means "no remembered state".
CREATE TABLE public.session_design_context (
  session_id        uuid PRIMARY KEY REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  active_skill      text,
  active_skill_hash text,
  series            jsonb,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_design_context_active_skill_length CHECK (active_skill IS NULL OR length(active_skill) <= 63),
  CONSTRAINT session_design_context_active_skill_hash_length CHECK (active_skill_hash IS NULL OR length(active_skill_hash) <= 128),
  CONSTRAINT session_design_context_series_object CHECK (series IS NULL OR jsonb_typeof(series) = 'object')
);

COMMENT ON TABLE public.session_design_context IS 'Per-conversation sticky Skill selection and series (style/size/material) preferences. Method state, not authorization.';

CREATE TRIGGER session_design_context_updated_at
  BEFORE UPDATE ON public.session_design_context
  FOR EACH ROW
  EXECUTE FUNCTION extensions.moddatetime(updated_at);

ALTER TABLE public.session_design_context ENABLE ROW LEVEL SECURITY;

CREATE POLICY session_design_context_select ON public.session_design_context
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.chat_sessions cs
      JOIN public.canvases c ON c.id = cs.canvas_id
      JOIN public.projects p ON p.id = c.project_id
      JOIN public.workspace_members wm ON wm.workspace_id = p.workspace_id
      WHERE cs.id = session_design_context.session_id
        AND wm.user_id = auth.uid()
    )
  );

CREATE POLICY session_design_context_insert ON public.session_design_context
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.chat_sessions cs
      JOIN public.canvases c ON c.id = cs.canvas_id
      JOIN public.projects p ON p.id = c.project_id
      JOIN public.workspace_members wm ON wm.workspace_id = p.workspace_id
      WHERE cs.id = session_design_context.session_id
        AND wm.user_id = auth.uid()
    )
  );

CREATE POLICY session_design_context_update ON public.session_design_context
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.chat_sessions cs
      JOIN public.canvases c ON c.id = cs.canvas_id
      JOIN public.projects p ON p.id = c.project_id
      JOIN public.workspace_members wm ON wm.workspace_id = p.workspace_id
      WHERE cs.id = session_design_context.session_id
        AND wm.user_id = auth.uid()
    )
  );

CREATE POLICY session_design_context_delete ON public.session_design_context
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.chat_sessions cs
      JOIN public.canvases c ON c.id = cs.canvas_id
      JOIN public.projects p ON p.id = c.project_id
      JOIN public.workspace_members wm ON wm.workspace_id = p.workspace_id
      WHERE cs.id = session_design_context.session_id
        AND wm.user_id = auth.uid()
    )
  );
