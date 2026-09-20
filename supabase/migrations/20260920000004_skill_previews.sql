-- B4a: platform skill catalog images (skill_previews).
--
-- Skills carry only a lucide `icon_name` today: no cover, no example images, and
-- no version history. This adds the images on top of the existing platform asset
-- machinery — `asset_objects.scope = 'platform'` + the `platform-assets` bucket —
-- so no new bucket, no new storage policy and no change to any RLS contract.
-- The `platform-assets` bucket has no authenticated policies at all, so a preview
-- is displayed only through a server route that checks the row is published and
-- then signs the URL with the service role.
--
-- Writes follow the B1-B3 rules: platform admin, a stated reason, and the audit
-- row in the same transaction as the change.

CREATE TABLE public.skill_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id uuid NOT NULL REFERENCES public.skills(id) ON DELETE CASCADE,
  asset_object_id uuid NOT NULL REFERENCES public.asset_objects(id) ON DELETE RESTRICT,
  role text NOT NULL DEFAULT 'example' CHECK (role IN ('cover', 'example')),
  caption text CHECK (caption IS NULL OR char_length(caption) <= 300),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, asset_object_id)
);

COMMENT ON TABLE public.skill_previews IS
  'Platform-admin-managed skill images (cover / examples) backed by platform-scope asset_objects. Published rows are served to customers through a server route; service-role access only.';
COMMENT ON COLUMN public.skill_previews.role IS
  'cover = the card image; example = a sample output shown in the skill detail.';
COMMENT ON COLUMN public.skill_previews.status IS
  'draft is visible only in the console; published is visible to every signed-in user.';

CREATE INDEX skill_previews_skill_idx ON public.skill_previews (skill_id, sort_order, created_at);
-- At most one PUBLISHED cover per skill, so "which image is the card" is never
-- ambiguous. Draft covers are unrestricted.
CREATE UNIQUE INDEX skill_previews_one_published_cover_idx
  ON public.skill_previews (skill_id) WHERE role = 'cover' AND status = 'published';

ALTER TABLE public.skill_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skill_previews FORCE ROW LEVEL SECURITY;
-- Deliberately no policies: reads and writes go through the service role.

CREATE TRIGGER skill_previews_updated_at
  BEFORE UPDATE ON public.skill_previews
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime (updated_at);

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_attach_skill_preview(
  p_actor_user_id uuid,
  p_skill_id uuid,
  p_asset_object_id uuid,
  p_role text,
  p_caption text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_asset record;
  v_preview_id uuid;
  v_sort integer;
  v_after jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 2 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a reason is required for a skill image change';
  END IF;
  IF p_role NOT IN ('cover', 'example') THEN
    RAISE EXCEPTION 'INVALID_ROLE: the preview role must be cover or example';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.skills s WHERE s.id = p_skill_id) THEN
    RAISE EXCEPTION 'UNKNOWN_SKILL: no such skill';
  END IF;

  SELECT id, scope, mime_type, bucket FROM public.asset_objects WHERE id = p_asset_object_id INTO v_asset;
  IF v_asset.id IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_ASSET: no such asset object';
  END IF;
  -- Only platform-scope assets may be attached: a workspace asset would leak one
  -- tenant's upload to every other tenant through the published preview.
  IF v_asset.scope <> 'platform' THEN
    RAISE EXCEPTION 'INVALID_ASSET_SCOPE: skill previews require a platform-scope asset';
  END IF;

  SELECT coalesce(max(sort_order), -1) + 1 INTO v_sort
    FROM public.skill_previews WHERE skill_id = p_skill_id;

  INSERT INTO public.skill_previews (skill_id, asset_object_id, role, caption, sort_order, status, created_by)
  VALUES (p_skill_id, p_asset_object_id, p_role, NULLIF(btrim(coalesce(p_caption, '')), ''), v_sort, 'draft', p_actor_user_id)
  RETURNING id INTO v_preview_id;

  v_after := jsonb_build_object(
    'previewId', v_preview_id,
    'role', p_role,
    'status', 'draft',
    'sortOrder', v_sort
  );

  INSERT INTO public.admin_audit_events
    (actor_user_id, action, target_kind, target_id, reason, before, after)
  VALUES
    (p_actor_user_id, 'skill.preview.attach', 'skill', p_skill_id::text, btrim(p_reason), NULL, v_after);

  RETURN v_after;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_publish_skill_preview(
  p_actor_user_id uuid,
  p_preview_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_preview record;
  v_demoted jsonb := '[]'::jsonb;
  v_after jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 2 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a reason is required for a skill image change';
  END IF;

  SELECT id, skill_id, role, status INTO v_preview FROM public.skill_previews WHERE id = p_preview_id;
  IF v_preview.id IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_PREVIEW: no such skill preview';
  END IF;

  -- Publishing a cover replaces the current one: demote it in the same
  -- transaction instead of failing, and record both facts in the audit row.
  IF v_preview.role = 'cover' THEN
    WITH demoted AS (
      UPDATE public.skill_previews
         SET status = 'draft', updated_at = now()
       WHERE skill_id = v_preview.skill_id AND role = 'cover' AND status = 'published' AND id <> v_preview.id
      RETURNING id
    )
    SELECT coalesce(jsonb_agg(to_jsonb(id)), '[]'::jsonb) INTO v_demoted FROM demoted;
  END IF;

  UPDATE public.skill_previews SET status = 'published', updated_at = now() WHERE id = v_preview.id;

  v_after := jsonb_build_object(
    'previewId', v_preview.id,
    'role', v_preview.role,
    'status', 'published',
    'statusBefore', v_preview.status,
    'demotedPreviewIds', v_demoted
  );

  INSERT INTO public.admin_audit_events
    (actor_user_id, action, target_kind, target_id, reason, before, after)
  VALUES
    (p_actor_user_id, 'skill.preview.publish', 'skill', v_preview.skill_id::text, btrim(p_reason),
     jsonb_build_object('status', v_preview.status), v_after);

  RETURN v_after;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_unpublish_skill_preview(
  p_actor_user_id uuid,
  p_preview_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_preview record;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 2 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a reason is required for a skill image change';
  END IF;

  SELECT id, skill_id, status INTO v_preview FROM public.skill_previews WHERE id = p_preview_id;
  IF v_preview.id IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_PREVIEW: no such skill preview';
  END IF;

  UPDATE public.skill_previews SET status = 'draft', updated_at = now() WHERE id = v_preview.id;

  INSERT INTO public.admin_audit_events
    (actor_user_id, action, target_kind, target_id, reason, before, after)
  VALUES
    (p_actor_user_id, 'skill.preview.unpublish', 'skill', v_preview.skill_id::text, btrim(p_reason),
     jsonb_build_object('status', v_preview.status), jsonb_build_object('status', 'draft', 'previewId', v_preview.id));

  RETURN jsonb_build_object('previewId', v_preview.id, 'status', 'draft');
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_skill_preview(
  p_actor_user_id uuid,
  p_preview_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_preview record;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 2 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a reason is required for a skill image change';
  END IF;

  SELECT id, skill_id, role, status, asset_object_id INTO v_preview
    FROM public.skill_previews WHERE id = p_preview_id;
  IF v_preview.id IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_PREVIEW: no such skill preview';
  END IF;

  -- The row goes away; the asset object deliberately stays for the existing GC
  -- path to reclaim, so storage is never deleted from inside an admin action.
  DELETE FROM public.skill_previews WHERE id = v_preview.id;

  INSERT INTO public.admin_audit_events
    (actor_user_id, action, target_kind, target_id, reason, before, after)
  VALUES
    (p_actor_user_id, 'skill.preview.delete', 'skill', v_preview.skill_id::text, btrim(p_reason),
     jsonb_build_object('previewId', v_preview.id, 'role', v_preview.role, 'status', v_preview.status,
                        'assetObjectId', v_preview.asset_object_id),
     NULL);

  RETURN jsonb_build_object('previewId', v_preview.id, 'deleted', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_reorder_skill_previews(
  p_actor_user_id uuid,
  p_skill_id uuid,
  p_ordered_ids uuid[],
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
  v_matched integer;
  v_before jsonb;
  v_after jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 2 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a reason is required for a skill image change';
  END IF;
  IF p_ordered_ids IS NULL OR array_length(p_ordered_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'INVALID_ORDER: an ordered list of preview ids is required';
  END IF;
  IF array_length(p_ordered_ids, 1) <> (SELECT count(DISTINCT value) FROM unnest(p_ordered_ids) AS value) THEN
    RAISE EXCEPTION 'INVALID_ORDER: the ordered list contains duplicates';
  END IF;

  SELECT count(*) INTO v_count FROM public.skill_previews WHERE skill_id = p_skill_id;
  SELECT count(*) INTO v_matched FROM public.skill_previews
   WHERE skill_id = p_skill_id AND id = ANY (p_ordered_ids);
  -- Every preview of the skill must be present, otherwise the omitted rows would
  -- silently keep a stale relative order.
  IF v_matched <> v_count THEN
    RAISE EXCEPTION 'INVALID_ORDER: the ordered list must contain every preview of this skill';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'sortOrder', sort_order) ORDER BY sort_order), '[]'::jsonb)
    INTO v_before FROM public.skill_previews WHERE skill_id = p_skill_id;

  UPDATE public.skill_previews sp
     SET sort_order = ordered.position - 1, updated_at = now()
    FROM (SELECT id, ordinality AS position FROM unnest(p_ordered_ids) WITH ORDINALITY AS t(id, ordinality)) ordered
   WHERE sp.id = ordered.id AND sp.skill_id = p_skill_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'sortOrder', sort_order) ORDER BY sort_order), '[]'::jsonb)
    INTO v_after FROM public.skill_previews WHERE skill_id = p_skill_id;

  INSERT INTO public.admin_audit_events
    (actor_user_id, action, target_kind, target_id, reason, before, after)
  VALUES
    (p_actor_user_id, 'skill.preview.reorder', 'skill', p_skill_id::text, btrim(p_reason),
     jsonb_build_object('order', v_before), jsonb_build_object('order', v_after));

  RETURN jsonb_build_object('ordered', v_matched);
END;
$$;

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_skill_catalog(
  p_actor_user_id uuid,
  p_query text DEFAULT NULL,
  p_limit integer DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_needle text := NULLIF(btrim(COALESCE(p_query, '')), '');
  v_skills jsonb;
BEGIN
  IF NOT private.is_platform_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor is not an active platform admin';
  END IF;

  SELECT coalesce(jsonb_agg(page.row_data ORDER BY page.slug), '[]'::jsonb) INTO v_skills
  FROM (
    SELECT jsonb_build_object(
             'id', s.id,
             'slug', s.slug,
             'name', s.name,
             'displayName', s.metadata -> 'loomic' ->> 'displayName',
             'category', s.category,
             'source', s.source,
             'version', s.version,
             'iconName', s.icon_name,
             'outputKinds', coalesce(s.metadata -> 'loomic' -> 'outputKinds', '[]'::jsonb),
             'enabledWorkspaces', (SELECT count(*) FROM public.workspace_skills ws WHERE ws.skill_id = s.id AND ws.enabled),
             'installCount', (SELECT count(*) FROM public.workspace_skills ws WHERE ws.skill_id = s.id),
             'previewCount', (SELECT count(*) FROM public.skill_previews sp WHERE sp.skill_id = s.id),
             'publishedPreviewCount', (SELECT count(*) FROM public.skill_previews sp
                                        WHERE sp.skill_id = s.id AND sp.status = 'published'),
             'hasPublishedCover', EXISTS (SELECT 1 FROM public.skill_previews sp
                                           WHERE sp.skill_id = s.id AND sp.role = 'cover' AND sp.status = 'published')
           ) AS row_data,
           s.slug
      FROM public.skills s
     WHERE (v_needle IS NULL
            OR s.slug ILIKE '%' || v_needle || '%'
            OR s.name ILIKE '%' || v_needle || '%'
            OR coalesce(s.metadata -> 'loomic' ->> 'displayName', '') ILIKE '%' || v_needle || '%')
     ORDER BY s.slug
     LIMIT v_limit
  ) page;

  RETURN jsonb_build_object('skills', v_skills);
END;
$$;

COMMENT ON FUNCTION public.admin_skill_catalog(uuid, text, integer) IS
  'Platform-admin skill catalog: identity, output kinds, workspace enablement counts and preview counts. Read-only.';

REVOKE ALL ON FUNCTION public.admin_attach_skill_preview(uuid, uuid, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_publish_skill_preview(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_unpublish_skill_preview(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_delete_skill_preview(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_reorder_skill_previews(uuid, uuid, uuid[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_skill_catalog(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_attach_skill_preview(uuid, uuid, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_publish_skill_preview(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_unpublish_skill_preview(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_delete_skill_preview(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_reorder_skill_previews(uuid, uuid, uuid[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_skill_catalog(uuid, text, integer) TO service_role;
