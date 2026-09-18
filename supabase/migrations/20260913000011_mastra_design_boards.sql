-- Mastra-native design board creation. This is intentionally independent of
-- agent_design_tasks, task runs, target scopes, approvals and continuations.
CREATE TABLE public.mastra_design_creation_batches (
  run_id uuid PRIMARY KEY REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  session_id uuid NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  input jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.mastra_design_creation_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mastra_design_creation_batches FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.mastra_design_creation_batches FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mastra_design_creation_batches TO service_role;

CREATE FUNCTION public.loomic_mastra_create_design_boards(
  p_user uuid,
  p_session uuid,
  p_run uuid,
  p_prompt text,
  p_expected_canvas_revision bigint,
  p_boards jsonb,
  p_source_assets uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  canvas_row public.canvases;
  run_row public.agent_runs;
  prior public.mastra_design_creation_batches;
  params jsonb;
  created jsonb;
  results jsonb := '[]'::jsonb;
  board jsonb;
  claims text;
  idx integer := 0;
  asset uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'mastra_design_creation_service_role_forbidden';
  END IF;
  IF p_user IS NULL OR p_session IS NULL OR p_run IS NULL
    OR p_prompt IS NULL OR length(btrim(p_prompt)) = 0 OR length(p_prompt) > 16000
    OR p_expected_canvas_revision IS NULL OR p_expected_canvas_revision < 0
    OR jsonb_typeof(p_boards) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_boards) NOT BETWEEN 1 AND 8
    OR cardinality(COALESCE(p_source_assets, '{}'::uuid[])) > 20
  THEN
    RAISE EXCEPTION 'mastra_design_creation_input_invalid';
  END IF;

  SELECT * INTO run_row
  FROM public.agent_runs
  WHERE id = p_run AND session_id = p_session AND created_by = p_user
  FOR UPDATE;
  IF NOT FOUND OR run_row.status NOT IN ('accepted', 'running') THEN
    RAISE EXCEPTION 'mastra_design_creation_run_inactive';
  END IF;

  SELECT c.* INTO canvas_row
  FROM public.canvases c
  JOIN public.chat_sessions s ON s.canvas_id = c.id
  WHERE s.id = p_session
  FOR UPDATE OF c;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mastra_design_creation_session_forbidden';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE workspace_id = canvas_row.workspace_id
      AND user_id = p_user
      AND role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'mastra_design_creation_workspace_forbidden';
  END IF;

  params := jsonb_build_object(
    'prompt', p_prompt,
    'canvasRevision', p_expected_canvas_revision,
    'boards', p_boards,
    'sources', COALESCE(p_source_assets, '{}'::uuid[])
  );
  SELECT * INTO prior
  FROM public.mastra_design_creation_batches
  WHERE run_id = p_run;
  IF FOUND THEN
    IF prior.created_by IS DISTINCT FROM p_user
      OR prior.session_id IS DISTINCT FROM p_session
      OR prior.input IS DISTINCT FROM params
    THEN
      RAISE EXCEPTION 'mastra_design_creation_replay_conflict';
    END IF;
    RETURN prior.result || '{"replayed":true}'::jsonb;
  END IF;

  IF canvas_row.revision IS DISTINCT FROM p_expected_canvas_revision THEN
    RAISE EXCEPTION 'mastra_design_creation_canvas_conflict';
  END IF;
  FOREACH asset IN ARRAY COALESCE(p_source_assets, '{}'::uuid[]) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.asset_objects
      WHERE id = asset
        AND workspace_id = canvas_row.workspace_id
        AND deletion_pending_at IS NULL
    ) THEN
      RAISE EXCEPTION 'mastra_design_creation_source_forbidden';
    END IF;
  END LOOP;

  claims := current_setting('request.jwt.claims', true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'authenticated', 'sub', p_user)::text,
    true
  );
  FOR board IN SELECT value FROM jsonb_array_elements(p_boards) LOOP
    idx := idx + 1;
    IF jsonb_typeof(board) IS DISTINCT FROM 'object'
      OR jsonb_typeof(board->'name') IS DISTINCT FROM 'string'
      OR length(btrim(board->>'name')) NOT BETWEEN 1 AND 200
      OR jsonb_typeof(board->'width') IS DISTINCT FROM 'number'
      OR jsonb_typeof(board->'height') IS DISTINCT FROM 'number'
      OR jsonb_typeof(board->'x') IS DISTINCT FROM 'number'
      OR jsonb_typeof(board->'y') IS DISTINCT FROM 'number'
      OR (board->>'width')::numeric <> trunc((board->>'width')::numeric)
      OR (board->>'height')::numeric <> trunc((board->>'height')::numeric)
      OR (board->>'width')::numeric NOT BETWEEN 1 AND 32768
      OR (board->>'height')::numeric NOT BETWEEN 1 AND 32768
      OR abs((board->>'x')::numeric) > 1000000
      OR abs((board->>'y')::numeric) > 1000000
      OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(board) key
        WHERE key NOT IN ('name', 'width', 'height', 'x', 'y')
      )
    THEN
      RAISE EXCEPTION 'mastra_design_creation_input_invalid';
    END IF;

    created := public.loomic_design_create(
      extensions.gen_random_uuid(),
      canvas_row.id,
      canvas_row.revision,
      'mastra-board-' || p_run::text || '-' || idx::text,
      board->>'name',
      (board->>'width')::integer,
      (board->>'height')::integer,
      (board->>'x')::double precision,
      (board->>'y')::double precision,
      320.0 * (board->>'width')::double precision /
        GREATEST((board->>'width')::double precision, (board->>'height')::double precision),
      320.0 * (board->>'height')::double precision /
        GREATEST((board->>'width')::double precision, (board->>'height')::double precision),
      '#ffffff',
      NULL
    );
    canvas_row.revision := (created->>'canvas_revision')::bigint;
    results := results || jsonb_build_array(created);
  END LOOP;
  PERFORM set_config('request.jwt.claims', claims, true);

  created := jsonb_build_object(
    'status', 'created',
    'canvas_id', canvas_row.id,
    'boards', results,
    'replayed', false
  );
  INSERT INTO public.mastra_design_creation_batches(
    run_id, created_by, session_id, input, result
  ) VALUES (p_run, p_user, p_session, params, created);
  RETURN created;
END
$$;

REVOKE ALL ON FUNCTION public.loomic_mastra_create_design_boards(
  uuid, uuid, uuid, text, bigint, jsonb, uuid[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_mastra_create_design_boards(
  uuid, uuid, uuid, text, bigint, jsonb, uuid[]
) TO service_role;

NOTIFY pgrst, 'reload schema';
