-- Stage 5 mixed manifest imports: atomically persist normalized work items so
-- metadata-only catalog entities and binary-backed entities share one job.

ALTER TABLE public.resource_import_items
  DROP CONSTRAINT IF EXISTS resource_import_items_result_entity_kind_check;

ALTER TABLE public.resource_import_items
  ADD CONSTRAINT resource_import_items_result_entity_kind_check CHECK (
    result_entity_kind IS NULL OR result_entity_kind IN (
      'resource', 'template', 'text_preset', 'font_family', 'font_face',
      'category', 'tag'
    )
  );

CREATE OR REPLACE FUNCTION public.loomic_resource_import_manifest_enqueue(
  p_request_id uuid,
  p_scope text,
  p_workspace_id uuid,
  p_manifest_items jsonb,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  item_count integer;
  normalized_items jsonb;
  request_hash text;
  request_row public.catalog_mutation_requests%ROWTYPE;
  new_id uuid := extensions.gen_random_uuid();
  result_value jsonb;
BEGIN
  PERFORM private.loomic_assert_catalog_actor(
    p_scope,
    p_workspace_id,
    p_actor_user_id
  );

  IF p_request_id IS NULL
    OR jsonb_typeof(p_manifest_items) IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'resource_import_manifest_invalid';
  END IF;

  item_count := jsonb_array_length(p_manifest_items);
  IF item_count NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'resource_import_item_count_invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_manifest_items) AS entry(item)
    WHERE jsonb_typeof(entry.item) IS DISTINCT FROM 'object'
      OR NOT private.loomic_jsonb_object_has_only_keys(
        entry.item,
        ARRAY['source_key', 'entity_kind', 'asset_object_id', 'metadata']
      )
      OR NOT entry.item ? 'source_key'
      OR jsonb_typeof(entry.item->'source_key') IS DISTINCT FROM 'string'
      OR char_length(btrim(entry.item->>'source_key')) NOT BETWEEN 1 AND 500
      OR NOT entry.item ? 'entity_kind'
      OR jsonb_typeof(entry.item->'entity_kind') IS DISTINCT FROM 'string'
      OR entry.item->>'entity_kind' NOT IN (
        'resource', 'template', 'text_preset', 'font_family', 'font_face',
        'category', 'tag'
      )
      OR NOT entry.item ? 'metadata'
      OR jsonb_typeof(entry.item->'metadata') IS DISTINCT FROM 'object'
      OR (
        entry.item ? 'asset_object_id'
        AND entry.item->'asset_object_id' <> 'null'::jsonb
        AND (
          jsonb_typeof(entry.item->'asset_object_id') IS DISTINCT FROM 'string'
          OR private.try_parse_uuid(entry.item->>'asset_object_id') IS NULL
        )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'resource_import_manifest_invalid';
  END IF;

  IF (
    SELECT count(*) <> count(DISTINCT btrim(entry.item->>'source_key'))
    FROM jsonb_array_elements(p_manifest_items) AS entry(item)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'resource_import_manifest_source_key_duplicate';
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'source_key', btrim(entry.item->>'source_key'),
      'entity_kind', entry.item->>'entity_kind',
      'asset_object_id', private.try_parse_uuid(
        entry.item->>'asset_object_id'
      ),
      'metadata', entry.item->'metadata'
    )
    ORDER BY entry.ordinality
  )
  INTO normalized_items
  FROM jsonb_array_elements(p_manifest_items)
    WITH ORDINALITY AS entry(item, ordinality);

  request_hash := md5(jsonb_build_object(
    'scope', p_scope,
    'workspace', p_workspace_id,
    'manifest_items', normalized_items
  )::text);

  INSERT INTO public.catalog_mutation_requests(
    actor_user_id,
    request_id,
    operation,
    entity_kind,
    input_hash
  )
  VALUES (
    p_actor_user_id,
    p_request_id,
    'import_create',
    'import_job',
    request_hash
  )
  ON CONFLICT DO NOTHING;

  SELECT * INTO request_row
  FROM public.catalog_mutation_requests
  WHERE actor_user_id = p_actor_user_id
    AND request_id = p_request_id
  FOR UPDATE;

  IF request_row.operation <> 'import_create'
    OR request_row.entity_kind <> 'import_job'
    OR request_row.input_hash <> request_hash
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'catalog_idempotency_conflict';
  END IF;
  IF request_row.result IS NOT NULL THEN
    RETURN jsonb_set(request_row.result, '{replayed}', 'true'::jsonb, true);
  END IF;

  INSERT INTO public.resource_import_jobs(
    id,
    scope,
    workspace_id,
    source_kind,
    source,
    total_items,
    created_by,
    request_id,
    input_hash
  )
  VALUES (
    new_id,
    p_scope,
    p_workspace_id,
    'manifest',
    jsonb_build_object(
      'version', 1,
      'mode', 'inline',
      'items', normalized_items
    ),
    item_count,
    p_actor_user_id,
    p_request_id,
    request_hash
  );

  INSERT INTO public.resource_import_items(
    import_job_id,
    source_key,
    asset_object_id,
    metadata
  )
  SELECT
    new_id,
    entry.item->>'source_key',
    private.try_parse_uuid(entry.item->>'asset_object_id'),
    (entry.item->'metadata') || jsonb_build_object(
      'entity_kind', entry.item->>'entity_kind',
      'manifest_index', entry.ordinality - 1
    )
  FROM jsonb_array_elements(normalized_items)
    WITH ORDINALITY AS entry(item, ordinality);

  result_value := jsonb_build_object(
    'import_job_id', new_id,
    'status', 'queued',
    'replayed', false
  );
  UPDATE public.catalog_mutation_requests
  SET entity_id = new_id,
      result = result_value,
      completed_at = now()
  WHERE actor_user_id = p_actor_user_id
    AND request_id = p_request_id;

  RETURN result_value;
END;
$$;

REVOKE ALL ON FUNCTION public.loomic_resource_import_manifest_enqueue(
  uuid, text, uuid, jsonb, uuid
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.loomic_resource_import_manifest_enqueue(
  uuid, text, uuid, jsonb, uuid
) TO service_role;
