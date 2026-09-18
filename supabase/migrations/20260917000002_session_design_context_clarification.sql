-- Remember that the assistant is waiting for clarification, so the next short
-- answer is treated as a generation request (skill preload + series capture)
-- instead of an unrelated "no design" turn. Method state only.
ALTER TABLE public.session_design_context
  ADD COLUMN awaiting_clarification boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.session_design_context.awaiting_clarification IS 'True after an ask_clarification turn; cleared once the user answers or the topic changes.';
