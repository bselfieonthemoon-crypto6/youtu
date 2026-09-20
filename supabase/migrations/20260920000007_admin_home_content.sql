-- B6a: platform management for the home content libraries.
--
-- Section six of the plan: `home_discovery_cases` / `home_discovery_categories` and
-- `home_example_categories` / `home_example_examples` had no management surface at
-- all - the browser reads them directly (RLS grants SELECT on active rows) and the
-- only writers were migrations and import scripts. This adds the console's read and
-- write functions for them.
--
-- Three facts about these tables shaped the design, all verified against the schema
-- before writing anything:
--
--   1. `is_active` IS the publish switch. The RLS policy for authenticated readers is
--      `is_active = true`, and a case additionally requires its category to be active,
--      so deactivating a category hides every case under it. The console says so out
--      loud rather than letting an operator discover it.
--   2. There is a UNIQUE index on (category_key, sort_order) for both content tables,
--      and on (sort_order) alone for both category tables. That makes "set this row's
--      sort_order" a landmine: the second row that wants position 3 violates the
--      index. Order therefore never travels through the upsert. New rows are appended
--      and every reordering goes through an explicit reorder function, which parks the
--      rows on temporary negative positions first so the final assignment cannot
--      collide mid-flight.
--   3. The category foreign keys are ON DELETE CASCADE, so "delete category" would
--      silently take its whole library with it. There is no delete for categories:
--      deactivate instead. Deleting a case or an example is allowed.
--
-- The image fields are public URLs (`project-assets/home-seeds/...`) that the home
-- page renders directly in the browser, so the console edits URLs and does not move
-- imagery onto a private bucket - that would change the customer-facing read path.

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_home_content_overview(
  p_actor_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_discovery jsonb;
  v_example jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;

  SELECT jsonb_build_object(
           'categories', coalesce((
             SELECT jsonb_agg(jsonb_build_object(
                      'key', c.key, 'label', c.label, 'sortOrder', c.sort_order, 'isActive', c.is_active,
                      'updatedAt', c.updated_at,
                      'itemCount', COALESCE(counts.total, 0),
                      'activeItemCount', COALESCE(counts.active_total, 0))
                    ORDER BY c.sort_order, c.key)
             FROM public.home_discovery_categories c
             LEFT JOIN LATERAL (
               SELECT count(*) AS total, count(*) FILTER (WHERE d.is_active) AS active_total
               FROM public.home_discovery_cases d WHERE d.category_key = c.key
             ) counts ON true
           ), '[]'::jsonb),
           'itemCount', (SELECT count(*) FROM public.home_discovery_cases),
           'activeItemCount', (SELECT count(*) FROM public.home_discovery_cases WHERE is_active)
         )
    INTO v_discovery;

  SELECT jsonb_build_object(
           'categories', coalesce((
             SELECT jsonb_agg(jsonb_build_object(
                      'key', c.key, 'label', c.label, 'dataType', c.data_type, 'accent', c.accent,
                      'sortOrder', c.sort_order, 'isActive', c.is_active, 'updatedAt', c.updated_at,
                      'itemCount', COALESCE(counts.total, 0),
                      'activeItemCount', COALESCE(counts.active_total, 0))
                    ORDER BY c.sort_order, c.key)
             FROM public.home_example_categories c
             LEFT JOIN LATERAL (
               SELECT count(*) AS total, count(*) FILTER (WHERE e.is_active) AS active_total
               FROM public.home_example_examples e WHERE e.category_key = c.key
             ) counts ON true
           ), '[]'::jsonb),
           'itemCount', (SELECT count(*) FROM public.home_example_examples),
           'activeItemCount', (SELECT count(*) FROM public.home_example_examples WHERE is_active)
         )
    INTO v_example;

  RETURN jsonb_build_object('discovery', v_discovery, 'example', v_example);
END;
$$;

COMMENT ON FUNCTION public.admin_home_content_overview(uuid) IS
  'Platform-admin home content overview: both libraries with every category, its publish state and how many entries are live. Read-only.';

CREATE OR REPLACE FUNCTION public.admin_home_content_list(
  p_actor_user_id uuid,
  p_kind text,
  p_category_key text DEFAULT NULL,
  p_active boolean DEFAULT NULL,
  p_query text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_kind text := nullif(btrim(COALESCE(p_kind, '')), '');
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_query text := nullif(btrim(COALESCE(p_query, '')), '');
  v_active boolean := p_active;
  v_total integer;
  v_items jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  IF v_kind NOT IN ('discovery_case', 'example_example') THEN
    RAISE EXCEPTION 'UNKNOWN_KIND: kind must be discovery_case or example_example';
  END IF;

  IF v_kind = 'discovery_case' THEN
    SELECT count(*) INTO v_total
    FROM public.home_discovery_cases d
    WHERE (p_category_key IS NULL OR d.category_key = p_category_key)
      AND (v_active IS NULL OR d.is_active = v_active)
      AND (v_query IS NULL OR d.title ILIKE '%' || v_query || '%'
           OR d.author_name ILIKE '%' || v_query || '%'
           OR d.id ILIKE '%' || v_query || '%');

    SELECT coalesce(jsonb_agg(page.row_data ORDER BY page.category_key, page.sort_order, page.id), '[]'::jsonb)
      INTO v_items
      FROM (
        SELECT jsonb_build_object(
                 'id', d.id, 'categoryKey', d.category_key, 'title', d.title,
                 'coverImageUrl', d.cover_image_url, 'authorName', d.author_name,
                 'authorAvatarUrl', d.author_avatar_url, 'caseUrl', d.case_url,
                 'seedPrompt', d.seed_prompt, 'viewCount', d.view_count, 'likeCount', d.like_count,
                 'sortOrder', d.sort_order, 'isActive', d.is_active,
                 'createdAt', d.created_at, 'updatedAt', d.updated_at,
                 'categoryIsActive', c.is_active
               ) AS row_data,
               d.category_key, d.sort_order, d.id
        FROM public.home_discovery_cases d
        LEFT JOIN public.home_discovery_categories c ON c.key = d.category_key
        WHERE (p_category_key IS NULL OR d.category_key = p_category_key)
          AND (v_active IS NULL OR d.is_active = v_active)
          AND (v_query IS NULL OR d.title ILIKE '%' || v_query || '%'
               OR d.author_name ILIKE '%' || v_query || '%'
               OR d.id ILIKE '%' || v_query || '%')
        ORDER BY d.category_key, d.sort_order, d.id
        LIMIT v_limit OFFSET v_offset
      ) page;
  ELSE
    SELECT count(*) INTO v_total
    FROM public.home_example_examples e
    WHERE (p_category_key IS NULL OR e.category_key = p_category_key)
      AND (v_active IS NULL OR e.is_active = v_active)
      AND (v_query IS NULL OR e.title ILIKE '%' || v_query || '%'
           OR e.prompt ILIKE '%' || v_query || '%');

    SELECT coalesce(jsonb_agg(page.row_data ORDER BY page.category_key, page.sort_order, page.id), '[]'::jsonb)
      INTO v_items
      FROM (
        SELECT jsonb_build_object(
                 'id', e.id, 'categoryKey', e.category_key, 'title', e.title, 'prompt', e.prompt,
                 'imageUrls', to_jsonb(e.image_urls), 'inputMentions', e.input_mentions,
                 'sortOrder', e.sort_order, 'isActive', e.is_active,
                 'createdAt', e.created_at, 'updatedAt', e.updated_at,
                 'categoryIsActive', c.is_active
               ) AS row_data,
               e.category_key, e.sort_order, e.id
        FROM public.home_example_examples e
        LEFT JOIN public.home_example_categories c ON c.key = e.category_key
        WHERE (p_category_key IS NULL OR e.category_key = p_category_key)
          AND (v_active IS NULL OR e.is_active = v_active)
          AND (v_query IS NULL OR e.title ILIKE '%' || v_query || '%'
               OR e.prompt ILIKE '%' || v_query || '%')
        ORDER BY e.category_key, e.sort_order, e.id
        LIMIT v_limit OFFSET v_offset
      ) page;
  END IF;

  RETURN jsonb_build_object('kind', v_kind, 'total', v_total, 'items', v_items);
END;
$$;

COMMENT ON FUNCTION public.admin_home_content_list(uuid, text, text, boolean, text, integer, integer) IS
  'Platform-admin home content list for one kind (discovery_case or example_example), filterable by category, publish state and text. Includes the parent category''s own state, because that decides whether the entry is actually visible. Read-only.';

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.admin_require_reason(p_reason text)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 2 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a reason is required';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.admin_write_home_audit(
  p_actor_user_id uuid,
  p_action text,
  p_target_id text,
  p_reason text,
  p_before jsonb,
  p_after jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.admin_audit_events
    (actor_user_id, action, target_kind, target_id, workspace_id, reason, before, after)
  VALUES
    (p_actor_user_id, p_action, 'home_content', p_target_id, NULL, btrim(p_reason), p_before, p_after);
END;
$$;

REVOKE ALL ON FUNCTION private.admin_require_reason(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.admin_write_home_audit(uuid, text, text, text, jsonb, jsonb) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Discovery cases
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_upsert_home_discovery_case(
  p_actor_user_id uuid,
  p_case_id text,
  p_category_key text,
  p_title text,
  p_cover_image_url text,
  p_author_name text DEFAULT NULL,
  p_author_avatar_url text DEFAULT NULL,
  p_case_url text DEFAULT NULL,
  p_seed_prompt text DEFAULT NULL,
  p_is_active boolean DEFAULT true,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id text := nullif(btrim(COALESCE(p_case_id, '')), '');
  v_category text := nullif(btrim(COALESCE(p_category_key, '')), '');
  v_before jsonb;
  v_after jsonb;
  v_action text;
  v_next integer;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  PERFORM private.admin_require_reason(p_reason);
  IF v_category IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_CATEGORY: a category is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.home_discovery_categories c WHERE c.key = v_category) THEN
    RAISE EXCEPTION 'UNKNOWN_CATEGORY: no such discovery category';
  END IF;
  IF COALESCE(btrim(p_title), '') = '' THEN
    RAISE EXCEPTION 'INVALID_CONTENT: a title is required';
  END IF;
  IF COALESCE(btrim(p_cover_image_url), '') = '' THEN
    RAISE EXCEPTION 'INVALID_CONTENT: a cover image URL is required';
  END IF;
  IF char_length(btrim(p_title)) > 200 OR char_length(btrim(p_cover_image_url)) > 1000 THEN
    RAISE EXCEPTION 'INVALID_CONTENT: the title or cover image URL is too long';
  END IF;

  -- Ids in this table are short slugs; generate one when the caller has none, and
  -- keep looking until it is free (the space is 7 hex-ish chars, so this is a
  -- loop that ends immediately in practice).
  IF v_id IS NULL THEN
    LOOP
      v_id := substr(replace(gen_random_uuid()::text, '-', ''), 1, 7);
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.home_discovery_cases d WHERE d.id = v_id);
    END LOOP;
  END IF;
  IF char_length(v_id) > 64 THEN
    RAISE EXCEPTION 'INVALID_CONTENT: the case id is too long';
  END IF;

  SELECT to_jsonb(d) INTO v_before FROM public.home_discovery_cases d WHERE d.id = v_id;

  IF v_before IS NULL THEN
    -- New rows go to the end of their category: the unique index on
    -- (category_key, sort_order) makes any other choice a possible collision.
    SELECT COALESCE(max(d.sort_order), -1) + 1 INTO v_next
    FROM public.home_discovery_cases d WHERE d.category_key = v_category;
  ELSE
    -- A case that moves to another category needs a fresh position there; one that
    -- stays keeps its own (the unique index is per category, so it cannot clash).
    IF (v_before ->> 'category_key') = v_category THEN
      v_next := (v_before ->> 'sort_order')::integer;
    ELSE
      SELECT COALESCE(max(d.sort_order), -1) + 1 INTO v_next
      FROM public.home_discovery_cases d WHERE d.category_key = v_category AND d.id <> v_id;
    END IF;
  END IF;

  INSERT INTO public.home_discovery_cases
    (id, category_key, title, cover_image_url, author_name, author_avatar_url, case_url, seed_prompt,
     sort_order, is_active)
  VALUES
    (v_id, v_category, btrim(p_title), btrim(p_cover_image_url),
     COALESCE(btrim(p_author_name), ''), COALESCE(btrim(p_author_avatar_url), ''),
     COALESCE(btrim(p_case_url), ''), COALESCE(p_seed_prompt, ''),
     v_next, COALESCE(p_is_active, true))
  ON CONFLICT (id) DO UPDATE SET
    category_key = EXCLUDED.category_key,
    title = EXCLUDED.title,
    cover_image_url = EXCLUDED.cover_image_url,
    author_name = EXCLUDED.author_name,
    author_avatar_url = EXCLUDED.author_avatar_url,
    case_url = EXCLUDED.case_url,
    seed_prompt = EXCLUDED.seed_prompt,
    sort_order = EXCLUDED.sort_order,
    is_active = EXCLUDED.is_active;

  SELECT to_jsonb(d) INTO v_after FROM public.home_discovery_cases d WHERE d.id = v_id;
  v_action := CASE WHEN v_before IS NULL THEN 'home.discovery_case.create' ELSE 'home.discovery_case.update' END;
  PERFORM private.admin_write_home_audit(p_actor_user_id, v_action, v_id, p_reason, v_before, v_after);

  RETURN jsonb_build_object('id', v_id, 'created', v_before IS NULL, 'sortOrder', v_next);
END;
$$;

COMMENT ON FUNCTION public.admin_upsert_home_discovery_case(uuid, text, text, text, text, text, text, text, text, boolean, text) IS
  'Platform-admin: create or update a home discovery case (view and like counts are never touched here) and audit it atomically.';

CREATE OR REPLACE FUNCTION public.admin_upsert_home_example_example(
  p_actor_user_id uuid,
  p_example_id uuid,
  p_category_key text,
  p_title text,
  p_prompt text DEFAULT NULL,
  p_image_urls text[] DEFAULT NULL,
  p_input_mentions jsonb DEFAULT NULL,
  p_is_active boolean DEFAULT true,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid := p_example_id;
  v_category text := nullif(btrim(COALESCE(p_category_key, '')), '');
  v_images text[] := COALESCE(p_image_urls, '{}'::text[]);
  v_mentions jsonb := COALESCE(p_input_mentions, '[]'::jsonb);
  v_before jsonb;
  v_after jsonb;
  v_action text;
  v_next integer;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  PERFORM private.admin_require_reason(p_reason);
  IF v_category IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_CATEGORY: a category is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.home_example_categories c WHERE c.key = v_category) THEN
    RAISE EXCEPTION 'UNKNOWN_CATEGORY: no such example category';
  END IF;
  IF COALESCE(btrim(p_title), '') = '' THEN
    RAISE EXCEPTION 'INVALID_CONTENT: a title is required';
  END IF;
  IF char_length(btrim(p_title)) > 200 THEN
    RAISE EXCEPTION 'INVALID_CONTENT: the title is too long';
  END IF;
  -- Every image is rendered straight into an <img> on the home page, so an empty or
  -- oversized entry is rejected here rather than becoming a broken tile.
  IF EXISTS (SELECT 1 FROM unnest(v_images) AS url WHERE COALESCE(btrim(url), '') = '' OR char_length(url) > 1000) THEN
    RAISE EXCEPTION 'INVALID_CONTENT: every preview image needs a URL of at most 1000 characters';
  END IF;
  IF jsonb_typeof(v_mentions) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_CONTENT: input mentions must be an array';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_mentions) AS mention
    WHERE jsonb_typeof(mention) <> 'object'
      OR COALESCE(btrim(mention ->> 'name'), '') = ''
      OR COALESCE(btrim(mention ->> 'imgSrc'), '') = ''
      OR COALESCE(mention ->> 'type', '') NOT IN ('tool', 'image')
  ) THEN
    RAISE EXCEPTION 'INVALID_CONTENT: each input mention needs a name, an image URL and a type of tool or image';
  END IF;

  IF v_id IS NULL THEN
    v_id := gen_random_uuid();
  END IF;

  SELECT to_jsonb(e) INTO v_before FROM public.home_example_examples e WHERE e.id = v_id;

  IF v_before IS NULL THEN
    SELECT COALESCE(max(e.sort_order), -1) + 1 INTO v_next
    FROM public.home_example_examples e WHERE e.category_key = v_category;
  ELSE
    IF (v_before ->> 'category_key') = v_category THEN
      v_next := (v_before ->> 'sort_order')::integer;
    ELSE
      SELECT COALESCE(max(e.sort_order), -1) + 1 INTO v_next
      FROM public.home_example_examples e WHERE e.category_key = v_category AND e.id <> v_id;
    END IF;
  END IF;

  INSERT INTO public.home_example_examples
    (id, category_key, title, prompt, image_urls, input_mentions, sort_order, is_active)
  VALUES
    (v_id, v_category, btrim(p_title), COALESCE(btrim(p_prompt), ''), v_images, v_mentions,
     v_next, COALESCE(p_is_active, true))
  ON CONFLICT (id) DO UPDATE SET
    category_key = EXCLUDED.category_key,
    title = EXCLUDED.title,
    prompt = EXCLUDED.prompt,
    image_urls = EXCLUDED.image_urls,
    input_mentions = EXCLUDED.input_mentions,
    sort_order = EXCLUDED.sort_order,
    is_active = EXCLUDED.is_active;

  SELECT to_jsonb(e) INTO v_after FROM public.home_example_examples e WHERE e.id = v_id;
  v_action := CASE WHEN v_before IS NULL THEN 'home.example_example.create' ELSE 'home.example_example.update' END;
  PERFORM private.admin_write_home_audit(p_actor_user_id, v_action, v_id::text, p_reason, v_before, v_after);

  RETURN jsonb_build_object('id', v_id, 'created', v_before IS NULL, 'sortOrder', v_next);
END;
$$;

COMMENT ON FUNCTION public.admin_upsert_home_example_example(uuid, uuid, text, text, text, text[], jsonb, boolean, text) IS
  'Platform-admin: create or update a home example (prompt, preview images and input mentions validated) and audit it atomically.';

CREATE OR REPLACE FUNCTION public.admin_upsert_home_category(
  p_actor_user_id uuid,
  p_kind text,
  p_key text,
  p_label text,
  p_data_type text DEFAULT NULL,
  p_accent text DEFAULT NULL,
  p_is_active boolean DEFAULT true,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind text := nullif(btrim(COALESCE(p_kind, '')), '');
  v_key text := nullif(btrim(COALESCE(p_key, '')), '');
  v_before jsonb;
  v_after jsonb;
  v_action text;
  v_next integer;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  PERFORM private.admin_require_reason(p_reason);
  IF v_kind NOT IN ('discovery_category', 'example_category') THEN
    RAISE EXCEPTION 'UNKNOWN_KIND: kind must be discovery_category or example_category';
  END IF;
  IF v_key IS NULL OR COALESCE(btrim(p_label), '') = '' THEN
    RAISE EXCEPTION 'INVALID_CONTENT: a key and a label are required';
  END IF;
  IF v_key !~ '^[a-z0-9][a-z0-9-]{0,62}$' THEN
    RAISE EXCEPTION 'INVALID_CONTENT: the key must be lower-case letters, digits and dashes';
  END IF;
  IF char_length(btrim(p_label)) > 100 THEN
    RAISE EXCEPTION 'INVALID_CONTENT: the label is too long';
  END IF;

  IF v_kind = 'discovery_category' THEN
    IF p_accent IS NOT NULL AND btrim(p_accent) <> '' THEN
      RAISE EXCEPTION 'INVALID_CONTENT: discovery categories have no accent';
    END IF;
    SELECT to_jsonb(c) INTO v_before FROM public.home_discovery_categories c WHERE c.key = v_key;
    IF v_before IS NULL THEN
      SELECT COALESCE(max(c.sort_order), -1) + 1 INTO v_next FROM public.home_discovery_categories c;
    ELSE
      v_next := (v_before ->> 'sort_order')::integer;
    END IF;
    INSERT INTO public.home_discovery_categories (key, label, sort_order, is_active)
    VALUES (v_key, btrim(p_label), v_next, COALESCE(p_is_active, true))
    ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, is_active = EXCLUDED.is_active;
    SELECT to_jsonb(c) INTO v_after FROM public.home_discovery_categories c WHERE c.key = v_key;
  ELSE
    IF COALESCE(btrim(p_data_type), '') = '' THEN
      RAISE EXCEPTION 'INVALID_CONTENT: example categories need a data type';
    END IF;
    IF p_accent IS NOT NULL AND btrim(p_accent) <> '' AND btrim(p_accent) <> 'special' THEN
      RAISE EXCEPTION 'INVALID_CONTENT: accent must be special or empty';
    END IF;
    SELECT to_jsonb(c) INTO v_before FROM public.home_example_categories c WHERE c.key = v_key;
    IF v_before IS NULL THEN
      SELECT COALESCE(max(c.sort_order), -1) + 1 INTO v_next FROM public.home_example_categories c;
    ELSE
      v_next := (v_before ->> 'sort_order')::integer;
    END IF;
    INSERT INTO public.home_example_categories (key, label, data_type, accent, sort_order, is_active)
    VALUES (v_key, btrim(p_label), btrim(p_data_type),
            nullif(btrim(COALESCE(p_accent, '')), ''), v_next, COALESCE(p_is_active, true))
    ON CONFLICT (key) DO UPDATE SET
      label = EXCLUDED.label, data_type = EXCLUDED.data_type, accent = EXCLUDED.accent,
      is_active = EXCLUDED.is_active;
    SELECT to_jsonb(c) INTO v_after FROM public.home_example_categories c WHERE c.key = v_key;
  END IF;

  v_action := CASE WHEN v_before IS NULL THEN 'home.category.create' ELSE 'home.category.update' END;
  PERFORM private.admin_write_home_audit(p_actor_user_id, v_action, v_key, p_reason, v_before, v_after);

  RETURN jsonb_build_object('key', v_key, 'kind', v_kind, 'created', v_before IS NULL, 'sortOrder', v_next);
END;
$$;

COMMENT ON FUNCTION public.admin_upsert_home_category(uuid, text, text, text, text, text, boolean, text) IS
  'Platform-admin: create or update a home content category. Creating one appends it; renaming keeps its position. There is no category delete - the foreign keys cascade.';

-- ---------------------------------------------------------------------------
-- Publish switch
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_home_content_active(
  p_actor_user_id uuid,
  p_kind text,
  p_entity_id text,
  p_is_active boolean,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind text := nullif(btrim(COALESCE(p_kind, '')), '');
  v_id text := nullif(btrim(COALESCE(p_entity_id, '')), '');
  v_before jsonb;
  v_after jsonb;
  v_hidden integer := 0;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  PERFORM private.admin_require_reason(p_reason);
  IF v_kind NOT IN ('discovery_case', 'example_example', 'discovery_category', 'example_category') THEN
    RAISE EXCEPTION 'UNKNOWN_KIND: unsupported home content kind';
  END IF;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_CONTENT: an id is required';
  END IF;

  IF v_kind = 'discovery_case' THEN
    SELECT to_jsonb(d) INTO v_before FROM public.home_discovery_cases d WHERE d.id = v_id;
    IF v_before IS NULL THEN RAISE EXCEPTION 'UNKNOWN_CONTENT: no such discovery case'; END IF;
    UPDATE public.home_discovery_cases SET is_active = p_is_active WHERE id = v_id;
    SELECT to_jsonb(d) INTO v_after FROM public.home_discovery_cases d WHERE d.id = v_id;
  ELSIF v_kind = 'example_example' THEN
    SELECT to_jsonb(e) INTO v_before FROM public.home_example_examples e WHERE e.id = v_id::uuid;
    IF v_before IS NULL THEN RAISE EXCEPTION 'UNKNOWN_CONTENT: no such example'; END IF;
    UPDATE public.home_example_examples SET is_active = p_is_active WHERE id = v_id::uuid;
    SELECT to_jsonb(e) INTO v_after FROM public.home_example_examples e WHERE e.id = v_id::uuid;
  ELSIF v_kind = 'discovery_category' THEN
    SELECT to_jsonb(c) INTO v_before FROM public.home_discovery_categories c WHERE c.key = v_id;
    IF v_before IS NULL THEN RAISE EXCEPTION 'UNKNOWN_CONTENT: no such discovery category'; END IF;
    UPDATE public.home_discovery_categories SET is_active = p_is_active WHERE key = v_id;
    SELECT count(*) INTO v_hidden FROM public.home_discovery_cases d
     WHERE d.category_key = v_id AND d.is_active AND NOT p_is_active;
    SELECT to_jsonb(c) INTO v_after FROM public.home_discovery_categories c WHERE c.key = v_id;
  ELSE
    SELECT to_jsonb(c) INTO v_before FROM public.home_example_categories c WHERE c.key = v_id;
    IF v_before IS NULL THEN RAISE EXCEPTION 'UNKNOWN_CONTENT: no such example category'; END IF;
    UPDATE public.home_example_categories SET is_active = p_is_active WHERE key = v_id;
    SELECT count(*) INTO v_hidden FROM public.home_example_examples e
     WHERE e.category_key = v_id AND e.is_active AND NOT p_is_active;
    SELECT to_jsonb(c) INTO v_after FROM public.home_example_categories c WHERE c.key = v_id;
  END IF;

  PERFORM private.admin_write_home_audit(
    p_actor_user_id,
    'home.' || v_kind || CASE WHEN p_is_active THEN '.activate' ELSE '.deactivate' END,
    v_id, p_reason, v_before, v_after);

  RETURN jsonb_build_object(
    'kind', v_kind, 'id', v_id, 'isActive', p_is_active,
    'wasActive', COALESCE((v_before ->> 'is_active')::boolean, false),
    -- Deactivating a category hides its entries even though their own flag still
    -- says true; the console reports the number so the consequence is visible.
    'hiddenItems', v_hidden);
END;
$$;

COMMENT ON FUNCTION public.admin_set_home_content_active(uuid, text, text, boolean, text) IS
  'Platform-admin: publish or unpublish a home content entry or category and audit it atomically. For a category it also returns how many live entries the change hides.';

-- ---------------------------------------------------------------------------
-- Reordering
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_reorder_home_content(
  p_actor_user_id uuid,
  p_kind text,
  p_category_key text,
  p_ordered_ids text[],
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind text := nullif(btrim(COALESCE(p_kind, '')), '');
  v_category text := nullif(btrim(COALESCE(p_category_key, '')), '');
  v_ids text[] := COALESCE(p_ordered_ids, '{}'::text[]);
  v_total integer;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  PERFORM private.admin_require_reason(p_reason);
  IF v_kind NOT IN ('discovery_case', 'example_example') THEN
    RAISE EXCEPTION 'UNKNOWN_KIND: kind must be discovery_case or example_example';
  END IF;
  IF v_category IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_CATEGORY: a category is required';
  END IF;
  IF COALESCE(array_length(v_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'INVALID_ORDER: an ordered list is required';
  END IF;
  IF COALESCE(array_length(v_ids, 1), 0) <> (SELECT count(DISTINCT value) FROM unnest(v_ids) AS value) THEN
    RAISE EXCEPTION 'INVALID_ORDER: the ordered list contains duplicates';
  END IF;

  IF v_kind = 'discovery_case' THEN
    SELECT count(*) INTO v_total FROM public.home_discovery_cases d WHERE d.category_key = v_category;
    IF v_total <> array_length(v_ids, 1)
       OR EXISTS (SELECT 1 FROM unnest(v_ids) AS wanted(id)
                  WHERE NOT EXISTS (SELECT 1 FROM public.home_discovery_cases d
                                     WHERE d.id = wanted.id AND d.category_key = v_category)) THEN
      RAISE EXCEPTION 'INVALID_ORDER: the list must contain exactly the entries of this category';
    END IF;
    -- Park every row on a temporary negative position first: the unique index on
    -- (category_key, sort_order) would reject the final assignment otherwise.
    UPDATE public.home_discovery_cases d SET sort_order = -1 - ordered.position
    FROM (SELECT value AS id, (ordinality - 1) AS position
          FROM unnest(v_ids) WITH ORDINALITY AS t(value, ordinality)) ordered
    WHERE d.id = ordered.id;
    UPDATE public.home_discovery_cases d SET sort_order = ordered.position
    FROM (SELECT value AS id, (ordinality - 1) AS position
          FROM unnest(v_ids) WITH ORDINALITY AS t(value, ordinality)) ordered
    WHERE d.id = ordered.id;
  ELSE
    SELECT count(*) INTO v_total FROM public.home_example_examples e WHERE e.category_key = v_category;
    IF v_total <> array_length(v_ids, 1)
       OR EXISTS (SELECT 1 FROM unnest(v_ids) AS wanted(id)
                  WHERE NOT EXISTS (SELECT 1 FROM public.home_example_examples e
                                     WHERE e.id = wanted.id::uuid AND e.category_key = v_category)) THEN
      RAISE EXCEPTION 'INVALID_ORDER: the list must contain exactly the entries of this category';
    END IF;
    UPDATE public.home_example_examples e SET sort_order = -1 - ordered.position
    FROM (SELECT value AS id, (ordinality - 1) AS position
          FROM unnest(v_ids) WITH ORDINALITY AS t(value, ordinality)) ordered
    WHERE e.id = ordered.id::uuid;
    UPDATE public.home_example_examples e SET sort_order = ordered.position
    FROM (SELECT value AS id, (ordinality - 1) AS position
          FROM unnest(v_ids) WITH ORDINALITY AS t(value, ordinality)) ordered
    WHERE e.id = ordered.id::uuid;
  END IF;

  PERFORM private.admin_write_home_audit(
    p_actor_user_id, 'home.' || v_kind || '.reorder', v_category, p_reason,
    NULL, jsonb_build_object('orderedIds', to_jsonb(v_ids), 'count', array_length(v_ids, 1)));

  RETURN jsonb_build_object('kind', v_kind, 'categoryKey', v_category, 'ordered', array_length(v_ids, 1));
END;
$$;

COMMENT ON FUNCTION public.admin_reorder_home_content(uuid, text, text, text[], text) IS
  'Platform-admin: set the display order of one category''s entries. The list must name every entry of that category exactly once; reordering is a full permutation, never a bare sort_order write.';

CREATE OR REPLACE FUNCTION public.admin_reorder_home_categories(
  p_actor_user_id uuid,
  p_kind text,
  p_ordered_keys text[],
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind text := nullif(btrim(COALESCE(p_kind, '')), '');
  v_keys text[] := COALESCE(p_ordered_keys, '{}'::text[]);
  v_total integer;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  PERFORM private.admin_require_reason(p_reason);
  IF v_kind NOT IN ('discovery_category', 'example_category') THEN
    RAISE EXCEPTION 'UNKNOWN_KIND: kind must be discovery_category or example_category';
  END IF;
  IF COALESCE(array_length(v_keys, 1), 0) = 0 THEN
    RAISE EXCEPTION 'INVALID_ORDER: an ordered list is required';
  END IF;
  IF COALESCE(array_length(v_keys, 1), 0) <> (SELECT count(DISTINCT value) FROM unnest(v_keys) AS value) THEN
    RAISE EXCEPTION 'INVALID_ORDER: the ordered list contains duplicates';
  END IF;

  -- sort_order is unique across the whole table here, so the list has to name every
  -- category of that library, published or not.
  IF v_kind = 'discovery_category' THEN
    SELECT count(*) INTO v_total FROM public.home_discovery_categories;
    IF v_total <> array_length(v_keys, 1)
       OR EXISTS (SELECT 1 FROM unnest(v_keys) AS wanted(key)
                  WHERE NOT EXISTS (SELECT 1 FROM public.home_discovery_categories c WHERE c.key = wanted.key)) THEN
      RAISE EXCEPTION 'INVALID_ORDER: the list must contain every discovery category';
    END IF;
    UPDATE public.home_discovery_categories c SET sort_order = -1 - ordered.position
    FROM (SELECT value AS key, (ordinality - 1) AS position
          FROM unnest(v_keys) WITH ORDINALITY AS t(value, ordinality)) ordered
    WHERE c.key = ordered.key;
    UPDATE public.home_discovery_categories c SET sort_order = ordered.position
    FROM (SELECT value AS key, (ordinality - 1) AS position
          FROM unnest(v_keys) WITH ORDINALITY AS t(value, ordinality)) ordered
    WHERE c.key = ordered.key;
  ELSE
    SELECT count(*) INTO v_total FROM public.home_example_categories;
    IF v_total <> array_length(v_keys, 1)
       OR EXISTS (SELECT 1 FROM unnest(v_keys) AS wanted(key)
                  WHERE NOT EXISTS (SELECT 1 FROM public.home_example_categories c WHERE c.key = wanted.key)) THEN
      RAISE EXCEPTION 'INVALID_ORDER: the list must contain every example category';
    END IF;
    UPDATE public.home_example_categories c SET sort_order = -1 - ordered.position
    FROM (SELECT value AS key, (ordinality - 1) AS position
          FROM unnest(v_keys) WITH ORDINALITY AS t(value, ordinality)) ordered
    WHERE c.key = ordered.key;
    UPDATE public.home_example_categories c SET sort_order = ordered.position
    FROM (SELECT value AS key, (ordinality - 1) AS position
          FROM unnest(v_keys) WITH ORDINALITY AS t(value, ordinality)) ordered
    WHERE c.key = ordered.key;
  END IF;

  PERFORM private.admin_write_home_audit(
    p_actor_user_id, 'home.' || v_kind || '.reorder', 'categories', p_reason,
    NULL, jsonb_build_object('orderedKeys', to_jsonb(v_keys), 'count', array_length(v_keys, 1)));

  RETURN jsonb_build_object('kind', v_kind, 'ordered', array_length(v_keys, 1));
END;
$$;

COMMENT ON FUNCTION public.admin_reorder_home_categories(uuid, text, text[], text) IS
  'Platform-admin: set the display order of a home content library''s categories. The list must name every category of that library.';

-- ---------------------------------------------------------------------------
-- Delete (entries only - categories cascade and are unpublished instead)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_delete_home_content(
  p_actor_user_id uuid,
  p_kind text,
  p_entity_id text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind text := nullif(btrim(COALESCE(p_kind, '')), '');
  v_id text := nullif(btrim(COALESCE(p_entity_id, '')), '');
  v_before jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  PERFORM private.admin_require_reason(p_reason);
  IF v_kind NOT IN ('discovery_case', 'example_example') THEN
    -- The category foreign keys are ON DELETE CASCADE, so a category delete would
    -- remove its whole library in one statement. Unpublish it instead.
    RAISE EXCEPTION 'UNSUPPORTED_TARGET: only discovery cases and examples can be deleted';
  END IF;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_CONTENT: an id is required';
  END IF;

  IF v_kind = 'discovery_case' THEN
    SELECT to_jsonb(d) INTO v_before FROM public.home_discovery_cases d WHERE d.id = v_id;
    IF v_before IS NULL THEN RAISE EXCEPTION 'UNKNOWN_CONTENT: no such discovery case'; END IF;
    DELETE FROM public.home_discovery_cases WHERE id = v_id;
  ELSE
    SELECT to_jsonb(e) INTO v_before FROM public.home_example_examples e WHERE e.id = v_id::uuid;
    IF v_before IS NULL THEN RAISE EXCEPTION 'UNKNOWN_CONTENT: no such example'; END IF;
    DELETE FROM public.home_example_examples WHERE id = v_id::uuid;
  END IF;

  PERFORM private.admin_write_home_audit(
    p_actor_user_id, 'home.' || v_kind || '.delete', v_id, p_reason, v_before, NULL);

  RETURN jsonb_build_object('kind', v_kind, 'id', v_id, 'deleted', true);
END;
$$;

COMMENT ON FUNCTION public.admin_delete_home_content(uuid, text, text, text) IS
  'Platform-admin: delete a home discovery case or example and audit it atomically. Categories are refused because their foreign keys cascade.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.admin_home_content_overview(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_home_content_list(uuid, text, text, boolean, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_upsert_home_discovery_case(uuid, text, text, text, text, text, text, text, text, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_upsert_home_example_example(uuid, uuid, text, text, text, text[], jsonb, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_upsert_home_category(uuid, text, text, text, text, text, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_home_content_active(uuid, text, text, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_reorder_home_content(uuid, text, text, text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_reorder_home_categories(uuid, text, text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_delete_home_content(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_home_content_overview(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_home_content_list(uuid, text, text, boolean, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_upsert_home_discovery_case(uuid, text, text, text, text, text, text, text, text, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_upsert_home_example_example(uuid, uuid, text, text, text, text[], jsonb, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_upsert_home_category(uuid, text, text, text, text, text, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_home_content_active(uuid, text, text, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_reorder_home_content(uuid, text, text, text[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_reorder_home_categories(uuid, text, text[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_delete_home_content(uuid, text, text, text) TO service_role;
