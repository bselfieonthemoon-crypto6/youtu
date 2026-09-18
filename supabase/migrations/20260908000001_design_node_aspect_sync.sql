BEGIN;
-- Keep the existing locking, authorization and revision semantics intact.
DO $$
DECLARE body text; needle text := '  next_canvas_revision := canvas_row.revision + 1;';
BEGIN
  SELECT pg_get_functiondef('private.loomic_write_design_node_state(uuid,uuid,bigint,uuid,bigint,boolean,uuid)'::regprocedure) INTO body;
  IF strpos(body, needle) = 0 THEN RAISE EXCEPTION 'design node writer shape changed'; END IF;
  body := replace(body, needle, $patch$
  IF NOT p_deleted THEN
    SELECT COALESCE(jsonb_agg(
      CASE WHEN e->>'id' = node_row.element_id
        AND (e->>'width')::numeric > 0 AND (e->>'height')::numeric > 0
        AND abs((e->>'width')::numeric / (e->>'height')::numeric - d.width::numeric / d.height) > 0.00001
      THEN e || jsonb_build_object(
        'width', greatest((e->>'width')::numeric,(e->>'height')::numeric) * d.width / greatest(d.width,d.height),
        'height', greatest((e->>'width')::numeric,(e->>'height')::numeric) * d.height / greatest(d.width,d.height),
        'version', coalesce((e->>'version')::integer,0) + 1
      ) ELSE e END ORDER BY ordinal), '[]'::jsonb)
      INTO next_elements
      FROM jsonb_array_elements(next_elements) WITH ORDINALITY AS entries(e,ordinal)
      CROSS JOIN public.design_documents d WHERE d.id = p_design_id;
  END IF;
  next_canvas_revision := canvas_row.revision + 1;
$patch$);
  EXECUTE body;
END;
$$;
COMMIT;
