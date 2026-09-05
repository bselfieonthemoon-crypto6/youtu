-- Recover authoritative design_nodes bindings from Canvas metadata and retire
-- designs whose only Canvas node has disappeared. This function is deliberately
-- service-only: browser-provided designId values must never bypass workspace and
-- project checks.

CREATE TABLE public.design_binding_reconcile_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  cursor_updated_at timestamptz,
  cursor_canvas_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.design_binding_reconcile_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_binding_reconcile_state FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.design_binding_reconcile_state
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.design_binding_reconcile_state TO service_role;
INSERT INTO public.design_binding_reconcile_state(singleton) VALUES (true);

CREATE OR REPLACE FUNCTION private.loomic_validate_design_node_project()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  canvas_project_id uuid;
  design_project_id uuid;
  canvas_workspace_id uuid;
  design_workspace_id uuid;
BEGIN
  SELECT c.project_id, c.workspace_id
  INTO canvas_project_id, canvas_workspace_id
  FROM public.canvases c WHERE c.id = NEW.canvas_id;
  SELECT d.project_id, d.workspace_id
  INTO design_project_id, design_workspace_id
  FROM public.design_documents d WHERE d.id = NEW.design_id;
  IF canvas_project_id IS NULL OR design_project_id IS NULL
    OR canvas_project_id IS DISTINCT FROM design_project_id
    OR canvas_workspace_id IS DISTINCT FROM NEW.workspace_id
    OR design_workspace_id IS DISTINCT FROM NEW.workspace_id
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'design_node_project_mismatch';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.loomic_validate_design_node_project()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.loomic_validate_design_node_project()
  TO service_role;
CREATE TRIGGER design_nodes_validate_project
BEFORE INSERT OR UPDATE OF canvas_id, design_id, workspace_id
ON public.design_nodes
FOR EACH ROW EXECUTE FUNCTION private.loomic_validate_design_node_project();

CREATE OR REPLACE FUNCTION public.loomic_design_binding_reconcile(
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  canvas_row public.canvases%ROWTYPE;
  binding_row public.design_nodes%ROWTYPE;
  design_row public.design_documents%ROWTYPE;
  element_row record;
  element jsonb;
  metadata_design_id uuid;
  next_elements jsonb;
  canonical_metadata jsonb;
  canvas_changed boolean;
  scanned_count integer := 0;
  attached_count integer := 0;
  orphaned_count integer := 0;
  rejected_count integer := 0;
  deleted_node_count integer := 0;
  normalized_count integer := 0;
  next_design_revision bigint;
  v_cursor_updated_at timestamptz;
  v_cursor_canvas_id uuid;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_binding_reconcile_limit_invalid';
  END IF;

  -- Only one batch may repair bindings at once. Canvas/create transactions still
  -- serialize with us through the row lock and the live-design unique index.
  IF NOT pg_try_advisory_xact_lock(hashtext('loomic_design_binding_reconcile')) THEN
    RETURN jsonb_build_object(
      'scanned_canvases', 0, 'attached', 0, 'orphaned', 0,
      'rejected', 0, 'deleted_nodes', 0, 'normalized', 0,
      'busy', true
    );
  END IF;

  SELECT s.cursor_updated_at, s.cursor_canvas_id
  INTO v_cursor_updated_at, v_cursor_canvas_id
  FROM public.design_binding_reconcile_state s
  WHERE s.singleton
  FOR UPDATE;

  FOR canvas_row IN
    SELECT c.*
    FROM public.canvases c
    WHERE jsonb_typeof(c.content->'elements') = 'array'
      AND (
        v_cursor_updated_at IS NULL
        OR (c.updated_at, c.id) > (v_cursor_updated_at, v_cursor_canvas_id)
      )
      AND (
        EXISTS (
          SELECT 1 FROM public.design_nodes n
          WHERE n.canvas_id = c.id AND n.deleted_at IS NULL
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(c.content->'elements') e
          WHERE COALESCE((e->>'isDeleted')::boolean, false) = false
            AND e#>>'{customData,kind}' = 'loomic-design'
        )
      )
    ORDER BY c.updated_at, c.id
    LIMIT p_limit
    FOR UPDATE OF c SKIP LOCKED
  LOOP
    scanned_count := scanned_count + 1;
    v_cursor_updated_at := canvas_row.updated_at;
    v_cursor_canvas_id := canvas_row.id;
    next_elements := canvas_row.content->'elements';
    canvas_changed := false;

    -- A live authoritative binding without a live design-shaped element is an
    -- orphan. Retire both sides once; a later pass cannot resurrect the design.
    FOR binding_row IN
      SELECT n.* FROM public.design_nodes n
      WHERE n.canvas_id = canvas_row.id AND n.deleted_at IS NULL
      ORDER BY n.element_id
      FOR UPDATE
    LOOP
      SELECT * INTO design_row
      FROM public.design_documents d
      WHERE d.id = binding_row.design_id
      FOR UPDATE;
      IF design_row.id IS NULL
        OR design_row.workspace_id IS DISTINCT FROM canvas_row.workspace_id
        OR design_row.project_id IS DISTINCT FROM canvas_row.project_id
      THEN
        UPDATE public.design_nodes
        SET deleted_at = now(), deleted_by = NULL
        WHERE canvas_id = binding_row.canvas_id
          AND element_id = binding_row.element_id
          AND deleted_at IS NULL;
        rejected_count := rejected_count + 1;
        CONTINUE;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(next_elements) e
        WHERE e->>'id' = binding_row.element_id
          AND COALESCE((e->>'isDeleted')::boolean, false) = false
          AND e#>>'{customData,kind}' = 'loomic-design'
      ) THEN
        UPDATE public.design_nodes
        SET deleted_at = now(), deleted_by = NULL
        WHERE canvas_id = binding_row.canvas_id
          AND element_id = binding_row.element_id
          AND deleted_at IS NULL;

        IF design_row.id IS NOT NULL AND design_row.deleted_at IS NULL THEN
          next_design_revision := design_row.revision + 1;
          UPDATE public.design_documents
          SET revision = next_design_revision,
              preview_status = CASE
                WHEN design_row.preview_asset_object_id IS NULL THEN 'missing'
                ELSE 'stale'
              END,
              deleted_at = now(), deleted_by = NULL,
              purge_after = now() + interval '30 days', updated_by = NULL
          WHERE id = design_row.id;
          INSERT INTO public.design_document_versions(
            design_id, workspace_id, revision, parent_revision, command_batch,
            changed_object_ids, snapshot, actor_kind, idempotency_key
          ) VALUES (
            design_row.id, design_row.workspace_id, next_design_revision,
            design_row.revision, '[]'::jsonb, ARRAY[]::uuid[], NULL, 'system',
            extensions.gen_random_uuid()
          );
          INSERT INTO public.design_event_outbox(
            design_id, workspace_id, revision, event_type, payload
          ) VALUES (
            design_row.id, design_row.workspace_id, next_design_revision,
            'design.sync', jsonb_build_object(
              'type', 'design.sync', 'designId', design_row.id,
              'revision', next_design_revision, 'updateType', 'deleted'
            )
          );
        END IF;
        orphaned_count := orphaned_count + 1;
      END IF;
    END LOOP;

    -- Validate every live metadata candidate. Existing bindings are authority;
    -- otherwise only an unbound live design in the same project/workspace may attach.
    FOR element_row IN
      SELECT value, ordinality
      FROM jsonb_array_elements(next_elements) WITH ORDINALITY
    LOOP
      element := element_row.value;
      IF COALESCE((element->>'isDeleted')::boolean, false)
        OR element#>>'{customData,kind}' IS DISTINCT FROM 'loomic-design'
      THEN
        CONTINUE;
      END IF;

      SELECT * INTO binding_row
      FROM public.design_nodes n
      WHERE n.canvas_id = canvas_row.id
        AND n.element_id = element->>'id'
        AND n.deleted_at IS NULL
      FOR UPDATE;

      IF binding_row.design_id IS NOT NULL THEN
        SELECT * INTO design_row
        FROM public.design_documents d
        WHERE d.id = binding_row.design_id
        FOR UPDATE;
        IF design_row.id IS NULL
          OR design_row.workspace_id IS DISTINCT FROM canvas_row.workspace_id
          OR design_row.project_id IS DISTINCT FROM canvas_row.project_id
          OR design_row.deleted_at IS NOT NULL
        THEN
          element := jsonb_set(element, '{isDeleted}', 'true'::jsonb, true);
          UPDATE public.design_nodes
          SET deleted_at = COALESCE(deleted_at, now()), deleted_by = NULL
          WHERE canvas_id = binding_row.canvas_id
            AND element_id = binding_row.element_id;
          deleted_node_count := deleted_node_count + 1;
        ELSE
          IF element#>>'{customData,designId}' IS DISTINCT FROM binding_row.design_id::text THEN
            rejected_count := rejected_count + 1;
          END IF;
          canonical_metadata := jsonb_build_object(
            'kind', 'loomic-design', 'schemaVersion', 1,
            'designId', design_row.id, 'revision', design_row.revision,
            'previewAssetObjectId', design_row.preview_asset_object_id,
            'previewRevision', design_row.preview_revision
          );
          IF element->'customData' IS DISTINCT FROM canonical_metadata THEN
            element := jsonb_set(element, '{customData}', canonical_metadata, true);
            normalized_count := normalized_count + 1;
          END IF;
        END IF;
      ELSE
        metadata_design_id := NULL;
        BEGIN
          metadata_design_id := (element#>>'{customData,designId}')::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
          metadata_design_id := NULL;
        END;

        SELECT * INTO design_row
        FROM public.design_documents d
        WHERE d.id = metadata_design_id
          AND d.workspace_id = canvas_row.workspace_id
          AND d.project_id = canvas_row.project_id
          AND d.deleted_at IS NULL
        FOR UPDATE;

        IF design_row.id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.design_nodes n
          WHERE n.design_id = design_row.id AND n.deleted_at IS NULL
        ) THEN
          BEGIN
            INSERT INTO public.design_nodes(
              canvas_id, element_id, design_id, workspace_id, created_by,
              deleted_at, deleted_by
            ) VALUES (
              canvas_row.id, element->>'id', design_row.id,
              canvas_row.workspace_id, NULL, NULL, NULL
            )
            ON CONFLICT (canvas_id, element_id) DO UPDATE
            SET design_id = EXCLUDED.design_id,
                workspace_id = EXCLUDED.workspace_id,
                deleted_at = NULL, deleted_by = NULL
            WHERE public.design_nodes.deleted_at IS NOT NULL;
            IF FOUND THEN
              attached_count := attached_count + 1;
              canonical_metadata := jsonb_build_object(
                'kind', 'loomic-design', 'schemaVersion', 1,
                'designId', design_row.id, 'revision', design_row.revision,
                'previewAssetObjectId', design_row.preview_asset_object_id,
                'previewRevision', design_row.preview_revision
              );
              IF element->'customData' IS DISTINCT FROM canonical_metadata THEN
                element := jsonb_set(element, '{customData}', canonical_metadata, true);
                normalized_count := normalized_count + 1;
              END IF;
            ELSE
              element := jsonb_set(element, '{isDeleted}', 'true'::jsonb, true);
              rejected_count := rejected_count + 1;
            END IF;
          EXCEPTION WHEN unique_violation THEN
            element := jsonb_set(element, '{isDeleted}', 'true'::jsonb, true);
            rejected_count := rejected_count + 1;
          END;
        ELSE
          -- Includes malformed/cross-tenant IDs, cross-project IDs, deleted
          -- designs, and a duplicate node for a design already bound elsewhere.
          element := jsonb_set(element, '{isDeleted}', 'true'::jsonb, true);
          rejected_count := rejected_count + 1;
        END IF;
      END IF;

      IF element IS DISTINCT FROM element_row.value THEN
        next_elements := jsonb_set(
          next_elements,
          ARRAY[(element_row.ordinality - 1)::text],
          element,
          false
        );
        canvas_changed := true;
      END IF;
    END LOOP;

    IF canvas_changed THEN
      UPDATE public.canvases
      SET content = jsonb_set(canvas_row.content, '{elements}', next_elements, true),
          revision = canvas_row.revision + 1
      WHERE id = canvas_row.id;
    END IF;
  END LOOP;

  UPDATE public.design_binding_reconcile_state
  SET cursor_updated_at = CASE WHEN scanned_count = 0 THEN NULL ELSE v_cursor_updated_at END,
      cursor_canvas_id = CASE WHEN scanned_count = 0 THEN NULL ELSE v_cursor_canvas_id END,
      updated_at = now()
  WHERE singleton;

  RETURN jsonb_build_object(
    'scanned_canvases', scanned_count,
    'attached', attached_count,
    'orphaned', orphaned_count,
    'rejected', rejected_count,
    'deleted_nodes', deleted_node_count,
    'normalized', normalized_count,
    'busy', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.loomic_design_binding_reconcile(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loomic_design_binding_reconcile(integer)
  TO service_role;
