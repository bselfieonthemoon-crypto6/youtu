-- Stage 2: atomic design lifecycle, preview CAS and durable async delivery.
-- All mutating entry points in this migration are service-role only. The
-- application must pass the authenticated actor explicitly and these
-- functions re-check workspace ownership instead of trusting service role.

SELECT pgmq.create('design_preview_jobs');
SELECT pgmq.create('design_export_jobs');
SELECT pgmq.create('design_resource_import_jobs');

CREATE UNIQUE INDEX IF NOT EXISTS background_jobs_design_export_idempotency_key
  ON public.background_jobs(
    design_id,
    created_by,
    ((payload->>'idempotency_key'))
  )
  WHERE job_type = 'design_export'
    AND design_id IS NOT NULL
    AND payload ? 'idempotency_key';

CREATE TABLE public.design_lifecycle_requests (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  design_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  idempotency_key uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('rename', 'soft_delete', 'restore')),
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT design_lifecycle_requests_design_workspace_fkey
    FOREIGN KEY (design_id, workspace_id)
    REFERENCES public.design_documents(id, workspace_id)
    ON DELETE CASCADE,
  CONSTRAINT design_lifecycle_requests_idempotency_key
    UNIQUE (design_id, idempotency_key)
);

CREATE TABLE public.design_copy_requests (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  source_design_id uuid NOT NULL,
  canvas_id uuid NOT NULL,
  canvas_element_id text NOT NULL CHECK (char_length(canvas_element_id) BETWEEN 1 AND 200),
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT design_copy_requests_source_workspace_fkey
    FOREIGN KEY (source_design_id, workspace_id)
    REFERENCES public.design_documents(id, workspace_id)
    ON DELETE CASCADE,
  CONSTRAINT design_copy_requests_canvas_workspace_fkey
    FOREIGN KEY (canvas_id, workspace_id)
    REFERENCES public.canvases(id, workspace_id)
    ON DELETE CASCADE,
  CONSTRAINT design_copy_requests_idempotency_key
    UNIQUE (workspace_id, actor_user_id, request_id)
);

CREATE TABLE public.design_preview_requests (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  design_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  idempotency_key uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('queue', 'commit')),
  expected_revision bigint NOT NULL CHECK (expected_revision >= 0),
  job_id uuid REFERENCES public.background_jobs(id) ON DELETE SET NULL,
  preview_asset_object_id uuid REFERENCES public.asset_objects(id) ON DELETE RESTRICT,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT design_preview_requests_design_workspace_fkey
    FOREIGN KEY (design_id, workspace_id)
    REFERENCES public.design_documents(id, workspace_id)
    ON DELETE CASCADE,
  CONSTRAINT design_preview_requests_idempotency_key
    UNIQUE (design_id, idempotency_key)
);

ALTER TABLE public.design_lifecycle_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_lifecycle_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.design_copy_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_copy_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.design_preview_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_preview_requests FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.design_lifecycle_requests, public.design_copy_requests,
  public.design_preview_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.design_lifecycle_requests, public.design_copy_requests,
  public.design_preview_requests TO service_role;

-- A mutation and its later preview may legitimately share a design revision.
-- Keep one event per update type rather than one event per coarse event_type.
ALTER TABLE public.design_event_outbox
  DROP CONSTRAINT IF EXISTS design_event_outbox_design_revision_event_key;
CREATE UNIQUE INDEX design_event_outbox_design_revision_update_key
  ON public.design_event_outbox(
    design_id,
    revision,
    event_type,
    (COALESCE(payload->>'updateType', payload->>'type'))
  );

CREATE OR REPLACE FUNCTION private.loomic_assert_design_actor(
  p_workspace_id uuid,
  p_actor_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF p_actor_user_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.workspace_members wm
    WHERE wm.workspace_id = p_workspace_id
      AND wm.user_id = p_actor_user_id
      AND wm.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'design_write_forbidden';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.loomic_assert_design_member(
  p_workspace_id uuid,
  p_actor_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF p_actor_user_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.workspace_members wm
    WHERE wm.workspace_id = p_workspace_id
      AND wm.user_id = p_actor_user_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'design_read_forbidden';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.loomic_write_design_node_state(
  p_design_id uuid,
  p_workspace_id uuid,
  p_revision bigint,
  p_preview_asset_object_id uuid,
  p_preview_revision bigint,
  p_deleted boolean,
  p_actor_user_id uuid
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  node_row public.design_nodes%ROWTYPE;
  canvas_row public.canvases%ROWTYPE;
  next_elements jsonb;
  matched_count integer;
  next_canvas_revision bigint;
BEGIN
  SELECT * INTO node_row
  FROM public.design_nodes n
  WHERE n.design_id = p_design_id
  ORDER BY n.created_at
  LIMIT 1
  FOR UPDATE;

  IF node_row.design_id IS NULL
    OR node_row.workspace_id IS DISTINCT FROM p_workspace_id
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'design_node_binding_missing';
  END IF;

  SELECT * INTO canvas_row
  FROM public.canvases c
  WHERE c.id = node_row.canvas_id
  FOR UPDATE;
  IF canvas_row.id IS NULL
    OR canvas_row.workspace_id IS DISTINCT FROM p_workspace_id
    OR jsonb_typeof(canvas_row.content->'elements') <> 'array'
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'design_canvas_binding_invalid';
  END IF;

  SELECT
    COALESCE(jsonb_agg(
      CASE WHEN element->>'id' = node_row.element_id THEN
        jsonb_set(
          jsonb_set(element, '{isDeleted}', to_jsonb(p_deleted), true),
          '{customData}',
          COALESCE(element->'customData', '{}'::jsonb) || jsonb_build_object(
            'kind', 'loomic-design',
            'schemaVersion', 1,
            'designId', p_design_id,
            'revision', p_revision,
            'previewAssetObjectId', p_preview_asset_object_id,
            'previewRevision', p_preview_revision
          ),
          true
        )
      ELSE element END
      ORDER BY ordinal
    ), '[]'::jsonb),
    count(*) FILTER (WHERE element->>'id' = node_row.element_id)
  INTO next_elements, matched_count
  FROM jsonb_array_elements(canvas_row.content->'elements')
    WITH ORDINALITY AS entries(element, ordinal);

  IF matched_count <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'design_canvas_element_missing';
  END IF;

  next_canvas_revision := canvas_row.revision + 1;
  UPDATE public.canvases
  SET content = jsonb_set(canvas_row.content, '{elements}', next_elements, true),
      revision = next_canvas_revision
  WHERE id = canvas_row.id;

  UPDATE public.design_nodes
  SET deleted_at = CASE WHEN p_deleted THEN now() ELSE NULL END,
      deleted_by = CASE WHEN p_deleted THEN p_actor_user_id ELSE NULL END
  WHERE canvas_id = node_row.canvas_id
    AND element_id = node_row.element_id;

  RETURN next_canvas_revision;
END;
$$;

REVOKE ALL ON FUNCTION private.loomic_assert_design_actor(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_assert_design_member(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_write_design_node_state(
  uuid, uuid, bigint, uuid, bigint, boolean, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.loomic_assert_design_actor(uuid, uuid),
  private.loomic_assert_design_member(uuid, uuid),
  private.loomic_write_design_node_state(uuid, uuid, bigint, uuid, bigint, boolean, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.loomic_design_rename(
  p_design_id uuid,
  p_expected_revision bigint,
  p_idempotency_key uuid,
  p_name text,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  design_row public.design_documents%ROWTYPE;
  request_row public.design_lifecycle_requests%ROWTYPE;
  request_payload jsonb;
  next_revision bigint;
  result jsonb;
BEGIN
  IF p_design_id IS NULL OR p_idempotency_key IS NULL
    OR p_expected_revision IS NULL OR p_expected_revision < 0
    OR NULLIF(btrim(COALESCE(p_name, '')), '') IS NULL
    OR char_length(btrim(p_name)) > 200
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_rename_invalid';
  END IF;

  SELECT * INTO design_row
  FROM public.design_documents d
  WHERE d.id = p_design_id
  FOR UPDATE;
  IF design_row.id IS NULL OR design_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'design_not_found';
  END IF;
  PERFORM private.loomic_assert_design_actor(design_row.workspace_id, p_actor_user_id);

  request_payload := jsonb_build_object(
    'expected_revision', p_expected_revision,
    'name', btrim(p_name)
  );
  SELECT * INTO request_row
  FROM public.design_lifecycle_requests r
  WHERE r.design_id = p_design_id AND r.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF request_row.id IS NOT NULL THEN
    IF request_row.operation <> 'rename'
      OR request_row.actor_user_id <> p_actor_user_id
      OR request_row.request_payload IS DISTINCT FROM request_payload
      OR request_row.response IS NULL
    THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'design_idempotency_conflict';
    END IF;
    RETURN jsonb_set(request_row.response, '{replayed}', 'true'::jsonb, true);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.design_document_versions v
    WHERE v.design_id = p_design_id AND v.idempotency_key = p_idempotency_key
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'design_idempotency_conflict';
  END IF;
  IF design_row.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'design_revision_conflict',
      DETAIL = jsonb_build_object(
        'expected_revision', p_expected_revision,
        'latest_revision', design_row.revision,
        'retryable', false
      )::text;
  END IF;

  INSERT INTO public.design_lifecycle_requests(
    design_id, workspace_id, actor_user_id, idempotency_key,
    operation, request_payload
  ) VALUES (
    p_design_id, design_row.workspace_id, p_actor_user_id, p_idempotency_key,
    'rename', request_payload
  );

  next_revision := design_row.revision + 1;
  UPDATE public.design_documents
  SET name = btrim(p_name),
      revision = next_revision,
      preview_status = CASE
        WHEN design_row.preview_asset_object_id IS NULL THEN 'missing'
        ELSE 'stale'
      END,
      updated_by = p_actor_user_id
  WHERE id = p_design_id;

  INSERT INTO public.design_document_versions(
    design_id, workspace_id, revision, parent_revision, command_batch,
    changed_object_ids, snapshot, actor_kind, actor_user_id, idempotency_key
  ) VALUES (
    p_design_id, design_row.workspace_id, next_revision, design_row.revision,
    '[]'::jsonb, ARRAY[]::uuid[], NULL, 'user', p_actor_user_id, p_idempotency_key
  );
  INSERT INTO public.design_event_outbox(
    design_id, workspace_id, revision, event_type, payload
  ) VALUES (
    p_design_id, design_row.workspace_id, next_revision, 'design.sync',
    jsonb_build_object(
      'type', 'design.sync', 'designId', p_design_id,
      'revision', next_revision, 'updateType', 'renamed'
    )
  );

  result := jsonb_build_object(
    'design_id', p_design_id, 'revision', next_revision, 'replayed', false
  );
  UPDATE public.design_lifecycle_requests
  SET response = result, completed_at = now()
  WHERE design_id = p_design_id AND idempotency_key = p_idempotency_key;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_design_soft_delete(
  p_design_id uuid,
  p_expected_revision bigint,
  p_idempotency_key uuid,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  design_row public.design_documents%ROWTYPE;
  request_row public.design_lifecycle_requests%ROWTYPE;
  request_payload jsonb;
  next_revision bigint;
  result jsonb;
BEGIN
  IF p_design_id IS NULL OR p_idempotency_key IS NULL
    OR p_expected_revision IS NULL OR p_expected_revision < 0
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_delete_invalid';
  END IF;

  SELECT * INTO design_row
  FROM public.design_documents d
  WHERE d.id = p_design_id
  FOR UPDATE;
  IF design_row.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'design_not_found';
  END IF;
  PERFORM private.loomic_assert_design_actor(design_row.workspace_id, p_actor_user_id);

  request_payload := jsonb_build_object('expected_revision', p_expected_revision);
  SELECT * INTO request_row
  FROM public.design_lifecycle_requests r
  WHERE r.design_id = p_design_id AND r.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF request_row.id IS NOT NULL THEN
    IF request_row.operation <> 'soft_delete'
      OR request_row.actor_user_id <> p_actor_user_id
      OR request_row.request_payload IS DISTINCT FROM request_payload
      OR request_row.response IS NULL
    THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'design_idempotency_conflict';
    END IF;
    RETURN jsonb_set(request_row.response, '{replayed}', 'true'::jsonb, true);
  END IF;
  IF design_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'design_not_found';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.design_document_versions v
    WHERE v.design_id = p_design_id AND v.idempotency_key = p_idempotency_key
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'design_idempotency_conflict';
  END IF;
  IF design_row.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'design_revision_conflict',
      DETAIL = jsonb_build_object(
        'expected_revision', p_expected_revision,
        'latest_revision', design_row.revision,
        'retryable', false
      )::text;
  END IF;

  INSERT INTO public.design_lifecycle_requests(
    design_id, workspace_id, actor_user_id, idempotency_key,
    operation, request_payload
  ) VALUES (
    p_design_id, design_row.workspace_id, p_actor_user_id, p_idempotency_key,
    'soft_delete', request_payload
  );

  next_revision := design_row.revision + 1;
  UPDATE public.design_documents
  SET revision = next_revision,
      preview_status = CASE
        WHEN design_row.preview_asset_object_id IS NULL THEN 'missing'
        ELSE 'stale'
      END,
      deleted_at = now(),
      deleted_by = p_actor_user_id,
      purge_after = now() + interval '30 days',
      updated_by = p_actor_user_id
  WHERE id = p_design_id;
  PERFORM private.loomic_write_design_node_state(
    p_design_id, design_row.workspace_id, next_revision,
    design_row.preview_asset_object_id, design_row.preview_revision,
    true, p_actor_user_id
  );

  INSERT INTO public.design_document_versions(
    design_id, workspace_id, revision, parent_revision, command_batch,
    changed_object_ids, snapshot, actor_kind, actor_user_id, idempotency_key
  ) VALUES (
    p_design_id, design_row.workspace_id, next_revision, design_row.revision,
    '[]'::jsonb, ARRAY[]::uuid[], NULL, 'user', p_actor_user_id, p_idempotency_key
  );
  INSERT INTO public.design_event_outbox(
    design_id, workspace_id, revision, event_type, payload
  ) VALUES (
    p_design_id, design_row.workspace_id, next_revision, 'design.sync',
    jsonb_build_object(
      'type', 'design.sync', 'designId', p_design_id,
      'revision', next_revision, 'updateType', 'deleted'
    )
  );

  result := jsonb_build_object(
    'design_id', p_design_id, 'revision', next_revision, 'replayed', false
  );
  UPDATE public.design_lifecycle_requests
  SET response = result, completed_at = now()
  WHERE design_id = p_design_id AND idempotency_key = p_idempotency_key;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_design_restore(
  p_design_id uuid,
  p_expected_revision bigint,
  p_idempotency_key uuid,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  design_row public.design_documents%ROWTYPE;
  request_row public.design_lifecycle_requests%ROWTYPE;
  request_payload jsonb;
  next_revision bigint;
  result jsonb;
BEGIN
  IF p_design_id IS NULL OR p_idempotency_key IS NULL
    OR p_expected_revision IS NULL OR p_expected_revision < 0
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_restore_invalid';
  END IF;

  SELECT * INTO design_row
  FROM public.design_documents d
  WHERE d.id = p_design_id
  FOR UPDATE;
  IF design_row.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'design_not_found';
  END IF;
  PERFORM private.loomic_assert_design_actor(design_row.workspace_id, p_actor_user_id);

  request_payload := jsonb_build_object('expected_revision', p_expected_revision);
  SELECT * INTO request_row
  FROM public.design_lifecycle_requests r
  WHERE r.design_id = p_design_id AND r.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF request_row.id IS NOT NULL THEN
    IF request_row.operation <> 'restore'
      OR request_row.actor_user_id <> p_actor_user_id
      OR request_row.request_payload IS DISTINCT FROM request_payload
      OR request_row.response IS NULL
    THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'design_idempotency_conflict';
    END IF;
    RETURN jsonb_set(request_row.response, '{replayed}', 'true'::jsonb, true);
  END IF;
  IF design_row.deleted_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_is_not_deleted';
  END IF;
  IF design_row.purge_after IS NULL OR design_row.purge_after <= now() THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'design_restore_window_expired';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.design_document_versions v
    WHERE v.design_id = p_design_id AND v.idempotency_key = p_idempotency_key
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'design_idempotency_conflict';
  END IF;
  IF design_row.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'design_revision_conflict',
      DETAIL = jsonb_build_object(
        'expected_revision', p_expected_revision,
        'latest_revision', design_row.revision,
        'retryable', false
      )::text;
  END IF;

  INSERT INTO public.design_lifecycle_requests(
    design_id, workspace_id, actor_user_id, idempotency_key,
    operation, request_payload
  ) VALUES (
    p_design_id, design_row.workspace_id, p_actor_user_id, p_idempotency_key,
    'restore', request_payload
  );

  next_revision := design_row.revision + 1;
  UPDATE public.design_documents
  SET revision = next_revision,
      preview_status = CASE
        WHEN design_row.preview_asset_object_id IS NULL THEN 'missing'
        ELSE 'stale'
      END,
      deleted_at = NULL,
      deleted_by = NULL,
      purge_after = NULL,
      updated_by = p_actor_user_id
  WHERE id = p_design_id;
  PERFORM private.loomic_write_design_node_state(
    p_design_id, design_row.workspace_id, next_revision,
    design_row.preview_asset_object_id, design_row.preview_revision,
    false, p_actor_user_id
  );

  INSERT INTO public.design_document_versions(
    design_id, workspace_id, revision, parent_revision, command_batch,
    changed_object_ids, snapshot, actor_kind, actor_user_id, idempotency_key
  ) VALUES (
    p_design_id, design_row.workspace_id, next_revision, design_row.revision,
    '[]'::jsonb, ARRAY[]::uuid[], NULL, 'user', p_actor_user_id, p_idempotency_key
  );
  INSERT INTO public.design_event_outbox(
    design_id, workspace_id, revision, event_type, payload
  ) VALUES (
    p_design_id, design_row.workspace_id, next_revision, 'design.sync',
    jsonb_build_object(
      'type', 'design.sync', 'designId', p_design_id,
      'revision', next_revision, 'updateType', 'restored'
    )
  );

  result := jsonb_build_object(
    'design_id', p_design_id, 'revision', next_revision, 'replayed', false
  );
  UPDATE public.design_lifecycle_requests
  SET response = result, completed_at = now()
  WHERE design_id = p_design_id AND idempotency_key = p_idempotency_key;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_design_copy(
  p_request_id uuid,
  p_source_design_id uuid,
  p_canvas_id uuid,
  p_expected_canvas_revision bigint,
  p_canvas_element_id text,
  p_name text,
  p_node_x double precision,
  p_node_y double precision,
  p_node_width double precision,
  p_node_height double precision,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  canvas_row public.canvases%ROWTYPE;
  source_row public.design_documents%ROWTYPE;
  request_row public.design_copy_requests%ROWTYPE;
  request_payload jsonb;
  source_object jsonb;
  cloned_object jsonb;
  cloned_child_ids jsonb;
  original_object_id text;
  object_id_map jsonb := '{}'::jsonb;
  scene_objects jsonb := '[]'::jsonb;
  cloned_scene jsonb;
  canvas_elements jsonb;
  node_element jsonb;
  new_design_id uuid := extensions.gen_random_uuid();
  next_canvas_revision bigint;
  result jsonb;
  final_name text;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF p_request_id IS NULL OR p_source_design_id IS NULL OR p_canvas_id IS NULL
    OR p_expected_canvas_revision IS NULL OR p_expected_canvas_revision < 0
    OR NULLIF(btrim(COALESCE(p_canvas_element_id, '')), '') IS NULL
    OR char_length(p_canvas_element_id) > 200
    OR p_node_x IS NULL OR p_node_y IS NULL
    OR p_node_width IS NULL OR p_node_height IS NULL
    OR p_node_width <= 0 OR p_node_height <= 0
    OR p_node_width > 10000 OR p_node_height > 10000
    OR p_node_x::text IN ('NaN', 'Infinity', '-Infinity')
    OR p_node_y::text IN ('NaN', 'Infinity', '-Infinity')
    OR p_node_width::text IN ('NaN', 'Infinity', '-Infinity')
    OR p_node_height::text IN ('NaN', 'Infinity', '-Infinity')
    OR (p_name IS NOT NULL AND (
      NULLIF(btrim(p_name), '') IS NULL OR char_length(btrim(p_name)) > 200
    ))
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_copy_invalid';
  END IF;

  SELECT * INTO canvas_row
  FROM public.canvases c
  WHERE c.id = p_canvas_id
  FOR UPDATE;
  IF canvas_row.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'canvas_not_found';
  END IF;
  PERFORM private.loomic_assert_design_actor(canvas_row.workspace_id, p_actor_user_id);

  request_payload := jsonb_build_object(
    'source_design_id', p_source_design_id,
    'canvas_id', p_canvas_id,
    'expected_canvas_revision', p_expected_canvas_revision,
    'canvas_element_id', p_canvas_element_id,
    'name', p_name,
    'node', jsonb_build_object(
      'x', p_node_x, 'y', p_node_y,
      'width', p_node_width, 'height', p_node_height
    )
  );
  SELECT * INTO request_row
  FROM public.design_copy_requests r
  WHERE r.workspace_id = canvas_row.workspace_id
    AND r.actor_user_id = p_actor_user_id
    AND r.request_id = p_request_id
  FOR UPDATE;
  IF request_row.id IS NOT NULL THEN
    IF request_row.request_payload IS DISTINCT FROM request_payload
      OR request_row.response IS NULL
    THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'design_idempotency_conflict';
    END IF;
    RETURN jsonb_set(request_row.response, '{replayed}', 'true'::jsonb, true);
  END IF;

  SELECT * INTO source_row
  FROM public.design_documents d
  WHERE d.id = p_source_design_id
    AND d.workspace_id = canvas_row.workspace_id
    AND d.deleted_at IS NULL
  FOR SHARE;
  IF source_row.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'source_design_not_found';
  END IF;
  IF canvas_row.revision IS DISTINCT FROM p_expected_canvas_revision THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'canvas_revision_conflict',
      DETAIL = jsonb_build_object(
        'expected_revision', p_expected_canvas_revision,
        'latest_revision', canvas_row.revision,
        'retryable', false
      )::text;
  END IF;

  canvas_elements := COALESCE(canvas_row.content->'elements', '[]'::jsonb);
  IF jsonb_typeof(canvas_elements) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'canvas_content_invalid';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(canvas_elements) element
    WHERE element->>'id' = p_canvas_element_id
      AND COALESCE((element->>'isDeleted')::boolean, false) = false
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'canvas_element_id_exists';
  END IF;

  FOR source_object IN
    SELECT value FROM jsonb_array_elements(source_row.scene->'objects')
  LOOP
    original_object_id := source_object->>'objectId';
    object_id_map := object_id_map || jsonb_build_object(
      original_object_id, extensions.gen_random_uuid()::text
    );
  END LOOP;
  FOR source_object IN
    SELECT value FROM jsonb_array_elements(source_row.scene->'objects')
  LOOP
    original_object_id := source_object->>'objectId';
    cloned_object := jsonb_set(
      source_object,
      '{objectId}',
      to_jsonb(object_id_map->>original_object_id),
      true
    );
    IF source_object->>'type' = 'group' THEN
      SELECT COALESCE(
        jsonb_agg(to_jsonb(object_id_map->>(child_id#>>'{}')) ORDER BY ordinal),
        '[]'::jsonb
      )
      INTO cloned_child_ids
      FROM jsonb_array_elements(source_object->'childObjectIds')
        WITH ORDINALITY AS children(child_id, ordinal);
      cloned_object := jsonb_set(
        cloned_object, '{childObjectIds}', cloned_child_ids, true
      );
    END IF;
    scene_objects := scene_objects || jsonb_build_array(cloned_object);
  END LOOP;
  cloned_scene := jsonb_set(source_row.scene, '{objects}', scene_objects, true);
  PERFORM private.loomic_validate_design_scene(
    cloned_scene, source_row.width, source_row.height
  );

  INSERT INTO public.design_copy_requests(
    workspace_id, actor_user_id, request_id, source_design_id,
    canvas_id, canvas_element_id, request_payload
  ) VALUES (
    canvas_row.workspace_id, p_actor_user_id, p_request_id, p_source_design_id,
    p_canvas_id, p_canvas_element_id, request_payload
  );

  final_name := COALESCE(NULLIF(btrim(p_name), ''), source_row.name || ' 副本');
  INSERT INTO public.design_documents(
    id, workspace_id, project_id, name, scene, schema_version,
    engine_version, width, height, revision, created_by, updated_by
  ) VALUES (
    new_design_id, canvas_row.workspace_id, canvas_row.project_id,
    final_name, cloned_scene, source_row.schema_version,
    source_row.engine_version, source_row.width, source_row.height,
    0, p_actor_user_id, p_actor_user_id
  );
  PERFORM private.loomic_sync_design_references(
    new_design_id, canvas_row.workspace_id, cloned_scene
  );
  INSERT INTO public.design_document_versions(
    design_id, workspace_id, revision, parent_revision, command_batch,
    changed_object_ids, snapshot, actor_kind, actor_user_id, idempotency_key
  ) VALUES (
    new_design_id, canvas_row.workspace_id, 0, NULL, '[]'::jsonb,
    ARRAY[]::uuid[], cloned_scene, 'user', p_actor_user_id, p_request_id
  );

  node_element := jsonb_build_object(
    'id', p_canvas_element_id,
    'type', 'rectangle',
    'x', p_node_x,
    'y', p_node_y,
    'width', p_node_width,
    'height', p_node_height,
    'angle', 0,
    'strokeColor', '#d7d3ff',
    'backgroundColor', '#ffffff',
    'fillStyle', 'solid',
    'strokeWidth', 1,
    'strokeStyle', 'solid',
    'roughness', 0,
    'opacity', 100,
    'groupIds', '[]'::jsonb,
    'frameId', NULL,
    'roundness', jsonb_build_object('type', 3),
    'seed', floor(random() * 2147483646 + 1)::integer,
    'version', 1,
    'versionNonce', floor(random() * 2147483646 + 1)::integer,
    'isDeleted', false,
    'boundElements', NULL,
    'updated', (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
    'link', NULL,
    'locked', false,
    'customData', jsonb_build_object(
      'kind', 'loomic-design',
      'schemaVersion', 1,
      'designId', new_design_id,
      'revision', 0,
      'previewAssetObjectId', NULL,
      'previewRevision', 0
    )
  );
  next_canvas_revision := canvas_row.revision + 1;
  UPDATE public.canvases
  SET content = jsonb_set(
        canvas_row.content,
        '{elements}',
        canvas_elements || jsonb_build_array(node_element),
        true
      ),
      revision = next_canvas_revision
  WHERE id = p_canvas_id;
  INSERT INTO public.design_nodes(
    canvas_id, element_id, design_id, workspace_id, created_by
  ) VALUES (
    p_canvas_id, p_canvas_element_id, new_design_id,
    canvas_row.workspace_id, p_actor_user_id
  );
  INSERT INTO public.design_event_outbox(
    design_id, workspace_id, revision, event_type, payload
  ) VALUES (
    new_design_id, canvas_row.workspace_id, 0, 'design.sync',
    jsonb_build_object(
      'type', 'design.sync', 'designId', new_design_id,
      'revision', 0, 'updateType', 'created',
      'changedObjectIds', '[]'::jsonb,
      'previewAssetObjectId', NULL, 'previewRevision', 0
    )
  );

  result := jsonb_build_object(
    'design_id', new_design_id,
    'canvas_element_id', p_canvas_element_id,
    'design_revision', 0,
    'canvas_revision', next_canvas_revision,
    'replayed', false
  );
  UPDATE public.design_copy_requests
  SET response = result, completed_at = now()
  WHERE workspace_id = canvas_row.workspace_id
    AND actor_user_id = p_actor_user_id
    AND request_id = p_request_id;
  RETURN result;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_copy_invalid';
END;
$$;

REVOKE ALL ON FUNCTION public.loomic_design_rename(uuid, bigint, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.loomic_design_soft_delete(uuid, bigint, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.loomic_design_restore(uuid, bigint, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.loomic_design_copy(
  uuid, uuid, uuid, bigint, text, text,
  double precision, double precision, double precision, double precision, uuid
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.loomic_design_rename(uuid, bigint, uuid, text, uuid),
  public.loomic_design_soft_delete(uuid, bigint, uuid, uuid),
  public.loomic_design_restore(uuid, bigint, uuid, uuid),
  public.loomic_design_copy(
    uuid, uuid, uuid, bigint, text, text,
    double precision, double precision, double precision, double precision, uuid
  ) TO service_role;

CREATE OR REPLACE FUNCTION public.loomic_design_preview_queue(
  p_design_id uuid,
  p_expected_revision bigint,
  p_idempotency_key uuid,
  p_job_id uuid,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  design_row public.design_documents%ROWTYPE;
  request_row public.design_preview_requests%ROWTYPE;
  result jsonb;
BEGIN
  IF p_design_id IS NULL OR p_idempotency_key IS NULL OR p_job_id IS NULL
    OR p_expected_revision IS NULL OR p_expected_revision < 0
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_preview_queue_invalid';
  END IF;
  SELECT * INTO design_row
  FROM public.design_documents d
  WHERE d.id = p_design_id
  FOR UPDATE;
  IF design_row.id IS NULL OR design_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'design_not_found';
  END IF;
  PERFORM private.loomic_assert_design_member(design_row.workspace_id, p_actor_user_id);

  SELECT * INTO request_row
  FROM public.design_preview_requests r
  WHERE r.design_id = p_design_id AND r.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF request_row.id IS NOT NULL THEN
    IF request_row.operation <> 'queue'
      OR request_row.actor_user_id IS DISTINCT FROM p_actor_user_id
      OR request_row.expected_revision IS DISTINCT FROM p_expected_revision
      OR request_row.response IS NULL
    THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'design_idempotency_conflict';
    END IF;
    RETURN jsonb_set(request_row.response, '{replayed}', 'true'::jsonb, true);
  END IF;
  IF design_row.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'design_revision_conflict',
      DETAIL = jsonb_build_object(
        'expected_revision', p_expected_revision,
        'latest_revision', design_row.revision,
        'retryable', false
      )::text;
  END IF;

  result := jsonb_build_object(
    'design_id', p_design_id,
    'revision', design_row.revision,
    'status', CASE
      WHEN design_row.preview_status = 'ready' THEN 'ready'
      ELSE 'queued'
    END,
    'job_id', CASE
      WHEN design_row.preview_status = 'ready' THEN NULL
      ELSE p_job_id
    END,
    'replayed', false
  );
  IF design_row.preview_status <> 'ready' THEN
    INSERT INTO public.background_jobs(
      id, workspace_id, project_id, canvas_id, target_kind, design_id,
      queue_name, job_type, status, payload, created_by
    ) VALUES (
      p_job_id, design_row.workspace_id, design_row.project_id, NULL,
      'design', p_design_id, 'design_preview_jobs', 'design_preview', 'queued',
      jsonb_build_object(
        'design_id', p_design_id,
        'revision', p_expected_revision,
        'idempotency_key', p_idempotency_key,
        'requested_by', p_actor_user_id
      ),
      p_actor_user_id
    );
    UPDATE public.design_documents
    SET preview_status = 'queued', updated_by = p_actor_user_id
    WHERE id = p_design_id;
  END IF;
  INSERT INTO public.design_preview_requests(
    design_id, workspace_id, actor_user_id, idempotency_key,
    operation, expected_revision, job_id, response, completed_at
  ) VALUES (
    p_design_id, design_row.workspace_id, p_actor_user_id, p_idempotency_key,
    'queue', p_expected_revision,
    CASE WHEN design_row.preview_status = 'ready' THEN NULL ELSE p_job_id END,
    result, now()
  );
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_design_preview_commit(
  p_design_id uuid,
  p_expected_revision bigint,
  p_idempotency_key uuid,
  p_preview_asset_object_id uuid,
  p_preview_revision bigint,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  design_row public.design_documents%ROWTYPE;
  request_row public.design_preview_requests%ROWTYPE;
  result jsonb;
BEGIN
  IF p_design_id IS NULL OR p_idempotency_key IS NULL
    OR p_preview_asset_object_id IS NULL
    OR p_expected_revision IS NULL OR p_expected_revision < 0
    OR p_preview_revision IS DISTINCT FROM p_expected_revision
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_preview_commit_invalid';
  END IF;
  SELECT * INTO design_row
  FROM public.design_documents d
  WHERE d.id = p_design_id
  FOR UPDATE;
  IF design_row.id IS NULL OR design_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'design_not_found';
  END IF;
  PERFORM private.loomic_assert_design_member(design_row.workspace_id, p_actor_user_id);
  IF NOT private.loomic_asset_is_usable(
    p_preview_asset_object_id, design_row.workspace_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'preview_asset_not_usable';
  END IF;

  SELECT * INTO request_row
  FROM public.design_preview_requests r
  WHERE r.design_id = p_design_id AND r.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF request_row.id IS NOT NULL THEN
    IF request_row.operation <> 'commit'
      OR request_row.actor_user_id IS DISTINCT FROM p_actor_user_id
      OR request_row.expected_revision IS DISTINCT FROM p_expected_revision
      OR request_row.preview_asset_object_id IS DISTINCT FROM p_preview_asset_object_id
      OR request_row.response IS NULL
    THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'design_idempotency_conflict';
    END IF;
    RETURN jsonb_set(request_row.response, '{replayed}', 'true'::jsonb, true);
  END IF;

  IF design_row.revision IS DISTINCT FROM p_expected_revision THEN
    result := jsonb_build_object(
      'design_id', p_design_id,
      'revision', design_row.revision,
      'committed', false,
      'replayed', false
    );
    INSERT INTO public.design_preview_requests(
      design_id, workspace_id, actor_user_id, idempotency_key,
      operation, expected_revision, preview_asset_object_id,
      response, completed_at
    ) VALUES (
      p_design_id, design_row.workspace_id, p_actor_user_id, p_idempotency_key,
      'commit', p_expected_revision, p_preview_asset_object_id,
      result, now()
    );
    RETURN result;
  END IF;

  IF design_row.preview_status = 'ready'
    AND design_row.preview_asset_object_id = p_preview_asset_object_id
    AND design_row.preview_revision = p_preview_revision
  THEN
    result := jsonb_build_object(
      'design_id', p_design_id,
      'revision', design_row.revision,
      'committed', true,
      'replayed', false
    );
  ELSE
    UPDATE public.design_documents
    SET preview_asset_object_id = p_preview_asset_object_id,
        preview_revision = p_preview_revision,
        preview_status = 'ready',
        updated_by = p_actor_user_id
    WHERE id = p_design_id AND revision = p_expected_revision;
    PERFORM private.loomic_write_design_node_state(
      p_design_id, design_row.workspace_id, design_row.revision,
      p_preview_asset_object_id, p_preview_revision, false, p_actor_user_id
    );
    INSERT INTO public.design_event_outbox(
      design_id, workspace_id, revision, event_type, payload
    ) VALUES (
      p_design_id, design_row.workspace_id, design_row.revision, 'design.sync',
      jsonb_build_object(
        'type', 'design.sync', 'designId', p_design_id,
        'revision', design_row.revision, 'updateType', 'preview',
        'previewAssetObjectId', p_preview_asset_object_id,
        'previewRevision', p_preview_revision
      )
    )
    ON CONFLICT DO NOTHING;
    result := jsonb_build_object(
      'design_id', p_design_id,
      'revision', design_row.revision,
      'committed', true,
      'replayed', false
    );
  END IF;

  INSERT INTO public.design_preview_requests(
    design_id, workspace_id, actor_user_id, idempotency_key,
    operation, expected_revision, preview_asset_object_id,
    response, completed_at
  ) VALUES (
    p_design_id, design_row.workspace_id, p_actor_user_id, p_idempotency_key,
    'commit', p_expected_revision, p_preview_asset_object_id,
    result, now()
  );
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_design_reconcile_references(
  p_design_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  design_row public.design_documents%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  SELECT * INTO design_row
  FROM public.design_documents d
  WHERE d.id = p_design_id
  FOR SHARE;
  IF design_row.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'design_not_found';
  END IF;
  PERFORM private.loomic_sync_design_references(
    p_design_id, design_row.workspace_id, design_row.scene
  );
  RETURN jsonb_build_object(
    'design_id', p_design_id,
    'revision', design_row.revision,
    'reconciled', true
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_design_outbox_claim(
  p_limit integer,
  p_claim_token uuid,
  p_now timestamptz DEFAULT now()
)
RETURNS SETOF public.design_event_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_claim_token IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'outbox_claim_invalid';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT o.id
    FROM public.design_event_outbox o
    WHERE o.attempt_count < 3
      AND (
        (o.status IN ('pending', 'failed') AND o.available_at <= p_now)
        OR (
          o.status = 'publishing'
          AND o.claimed_at < p_now - interval '5 minutes'
        )
      )
    ORDER BY o.available_at, o.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE public.design_event_outbox o
  SET status = 'publishing',
      attempt_count = o.attempt_count + 1,
      claimed_at = p_now,
      claim_token = p_claim_token,
      last_error = NULL
  FROM candidates c
  WHERE o.id = c.id
  RETURNING o.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_design_outbox_mark_published(
  p_event_id uuid,
  p_claim_token uuid,
  p_published_at timestamptz DEFAULT now()
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  affected integer;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  UPDATE public.design_event_outbox
  SET status = 'published',
      published_at = p_published_at,
      claimed_at = NULL,
      claim_token = NULL,
      last_error = NULL
  WHERE id = p_event_id
    AND status = 'publishing'
    AND claim_token = p_claim_token;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_design_outbox_mark_failed(
  p_event_id uuid,
  p_claim_token uuid,
  p_error text,
  p_now timestamptz DEFAULT now()
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  affected integer;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  UPDATE public.design_event_outbox
  SET status = 'failed',
      available_at = p_now + make_interval(
        secs => LEAST(300, 5 * power(2, GREATEST(attempt_count - 1, 0))::integer)
      ),
      claimed_at = NULL,
      claim_token = NULL,
      last_error = left(COALESCE(p_error, 'outbox_publish_failed'), 2000)
  WHERE id = p_event_id
    AND status = 'publishing'
    AND claim_token = p_claim_token;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_design_outbox_reconcile(
  p_now timestamptz DEFAULT now()
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  affected integer;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  UPDATE public.design_event_outbox
  SET status = 'failed',
      available_at = p_now,
      claimed_at = NULL,
      claim_token = NULL,
      last_error = COALESCE(last_error, 'outbox_claim_lease_expired')
  WHERE status = 'publishing'
    AND claimed_at < p_now - interval '5 minutes';
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_job_finalization_claim(
  p_job_id uuid,
  p_command_id uuid,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  job_row public.background_jobs%ROWTYPE;
  finalization_row public.job_target_finalizations%ROWTYPE;
  acquired boolean := false;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF p_job_id IS NULL OR p_command_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'job_finalization_claim_invalid';
  END IF;

  SELECT * INTO job_row
  FROM public.background_jobs j
  WHERE j.id = p_job_id
  FOR UPDATE;
  IF job_row.id IS NULL OR job_row.status <> 'succeeded'
    OR job_row.target_kind NOT IN ('canvas', 'design')
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'job_not_finalizable';
  END IF;

  SELECT * INTO finalization_row
  FROM public.job_target_finalizations f
  WHERE f.job_id = p_job_id
    AND f.target_kind = job_row.target_kind
    AND f.target_id = CASE
      WHEN job_row.target_kind = 'canvas' THEN job_row.canvas_id
      ELSE job_row.design_id
    END
  FOR UPDATE;

  IF finalization_row.id IS NULL THEN
    INSERT INTO public.job_target_finalizations(
      id, job_id, workspace_id, target_kind, target_id, status,
      command_id, attempt_count
    ) VALUES (
      p_command_id, p_job_id, job_row.workspace_id, job_row.target_kind,
      CASE WHEN job_row.target_kind = 'canvas'
        THEN job_row.canvas_id ELSE job_row.design_id END,
      'running', p_command_id, 1
    )
    RETURNING * INTO finalization_row;
    acquired := true;
  ELSIF finalization_row.command_id <> p_command_id THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'job_finalization_command_conflict';
  ELSIF finalization_row.status IN ('completed', 'needs_attention') THEN
    acquired := false;
  ELSIF finalization_row.status = 'running'
    AND finalization_row.updated_at >= p_now - interval '5 minutes'
  THEN
    acquired := false;
  ELSE
    UPDATE public.job_target_finalizations
    SET status = 'running',
        attempt_count = attempt_count + 1,
        error_code = NULL,
        error_message = NULL,
        completed_at = NULL
    WHERE id = finalization_row.id
    RETURNING * INTO finalization_row;
    acquired := true;
  END IF;

  RETURN jsonb_build_object(
    'acquired', acquired,
    'finalization', to_jsonb(finalization_row)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_job_finalization_finish(
  p_job_id uuid,
  p_command_id uuid,
  p_status text,
  p_result jsonb DEFAULT NULL,
  p_error_code text DEFAULT NULL,
  p_error_message text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  finalization_row public.job_target_finalizations%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF p_status NOT IN ('completed', 'needs_attention', 'failed') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'job_finalization_status_invalid';
  END IF;
  UPDATE public.job_target_finalizations
  SET status = p_status,
      result = p_result,
      error_code = p_error_code,
      error_message = left(p_error_message, 2000),
      completed_at = CASE
        WHEN p_status IN ('completed', 'needs_attention') THEN now()
        ELSE NULL
      END
  WHERE job_id = p_job_id
    AND command_id = p_command_id
    AND status = 'running'
  RETURNING * INTO finalization_row;
  IF finalization_row.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'job_finalization_claim_lost';
  END IF;
  RETURN to_jsonb(finalization_row);
END;
$$;

REVOKE ALL ON FUNCTION public.loomic_design_preview_queue(uuid, bigint, uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.loomic_design_preview_commit(
  uuid, bigint, uuid, uuid, bigint, uuid
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.loomic_design_reconcile_references(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.loomic_design_outbox_claim(integer, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.loomic_design_outbox_mark_published(uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.loomic_design_outbox_mark_failed(uuid, uuid, text, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.loomic_design_outbox_reconcile(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.loomic_job_finalization_claim(uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.loomic_job_finalization_finish(
  uuid, uuid, text, jsonb, text, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.loomic_design_preview_queue(uuid, bigint, uuid, uuid, uuid),
  public.loomic_design_preview_commit(uuid, bigint, uuid, uuid, bigint, uuid),
  public.loomic_design_reconcile_references(uuid),
  public.loomic_design_outbox_claim(integer, uuid, timestamptz),
  public.loomic_design_outbox_mark_published(uuid, uuid, timestamptz),
  public.loomic_design_outbox_mark_failed(uuid, uuid, text, timestamptz),
  public.loomic_design_outbox_reconcile(timestamptz),
  public.loomic_job_finalization_claim(uuid, uuid, timestamptz),
  public.loomic_job_finalization_finish(uuid, uuid, text, jsonb, text, text)
  TO service_role;
