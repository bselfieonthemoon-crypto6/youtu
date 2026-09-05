BEGIN;

-- Stage 5 is additive: the Stage 1 catalog tables remain the source of truth.
-- Mutations are service-only, actor-authorized, CAS protected and replayable.

ALTER TABLE public.design_resources
  ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0);
ALTER TABLE public.design_templates
  ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  ADD COLUMN category_id uuid REFERENCES public.resource_categories(id) ON DELETE SET NULL;
ALTER TABLE public.text_presets
  ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  ADD COLUMN category_id uuid REFERENCES public.resource_categories(id) ON DELETE SET NULL,
  ADD COLUMN license_url text,
  ADD COLUMN attribution text,
  ADD COLUMN published_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN published_at timestamptz;
ALTER TABLE public.font_families
  ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  ADD COLUMN published_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN published_at timestamptz;
ALTER TABLE public.font_faces
  ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  ADD COLUMN allow_web_embed boolean NOT NULL DEFAULT false,
  ADD COLUMN updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN deleted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN published_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN published_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.resource_categories
  ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  ADD COLUMN updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN deleted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN published_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN published_at timestamptz;
ALTER TABLE public.resource_tags
  ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  ADD COLUMN updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN deleted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN published_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN published_at timestamptz;

ALTER TABLE public.design_template_asset_refs
  ADD COLUMN resource_id uuid REFERENCES public.design_resources(id) ON DELETE SET NULL;

ALTER TABLE public.design_resources
  ADD CONSTRAINT design_resources_dimensions_pair_check CHECK (
    (width IS NULL AND height IS NULL) OR (width IS NOT NULL AND height IS NOT NULL)
  ),
  ADD CONSTRAINT design_resources_checksum_check CHECK (
    checksum_sha256 IS NULL OR checksum_sha256 ~ '^[a-f0-9]{64}$'
  );
ALTER TABLE public.font_faces
  ADD CONSTRAINT font_faces_checksum_check CHECK (
    checksum_sha256 IS NULL OR checksum_sha256 ~ '^[a-f0-9]{64}$'
  );

CREATE UNIQUE INDEX resource_categories_live_name_key
  ON public.resource_categories(
    scope,
    COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
  ) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX resource_tags_live_name_key
  ON public.resource_tags(
    scope,
    COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
  ) WHERE deleted_at IS NULL;

CREATE INDEX design_templates_catalog_cursor_idx
  ON public.design_templates(scope, workspace_id, status, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX text_presets_catalog_cursor_idx
  ON public.text_presets(scope, workspace_id, status, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX design_resources_catalog_cursor_idx
  ON public.design_resources(scope, workspace_id, status, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX font_families_catalog_cursor_idx
  ON public.font_families(scope, workspace_id, status, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX font_faces_catalog_cursor_idx
  ON public.font_faces(scope, workspace_id, status, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX resource_categories_catalog_cursor_idx
  ON public.resource_categories(scope, workspace_id, status, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX resource_tags_catalog_cursor_idx
  ON public.resource_tags(scope, workspace_id, status, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE public.design_template_font_refs (
  template_id uuid NOT NULL REFERENCES public.design_templates(id) ON DELETE CASCADE,
  object_id text NOT NULL CHECK (char_length(object_id) BETWEEN 1 AND 200),
  font_face_id uuid NOT NULL REFERENCES public.font_faces(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, object_id, font_face_id)
);
CREATE INDEX design_template_font_refs_face_idx
  ON public.design_template_font_refs(font_face_id);

CREATE TABLE public.text_preset_font_refs (
  text_preset_id uuid NOT NULL REFERENCES public.text_presets(id) ON DELETE CASCADE,
  object_id text NOT NULL CHECK (char_length(object_id) BETWEEN 1 AND 200),
  font_face_id uuid NOT NULL REFERENCES public.font_faces(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (text_preset_id, object_id, font_face_id)
);
CREATE INDEX text_preset_font_refs_face_idx
  ON public.text_preset_font_refs(font_face_id);

CREATE TABLE public.design_template_tag_links (
  template_id uuid NOT NULL REFERENCES public.design_templates(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES public.resource_tags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, tag_id)
);

CREATE TABLE public.text_preset_tag_links (
  text_preset_id uuid NOT NULL REFERENCES public.text_presets(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES public.resource_tags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (text_preset_id, tag_id)
);

CREATE TABLE public.catalog_mutation_requests (
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN (
    'create', 'update', 'set_status', 'soft_delete', 'restore', 'import_create'
  )),
  entity_kind text NOT NULL CHECK (entity_kind IN (
    'resource', 'template', 'text_preset', 'font_family', 'font_face',
    'category', 'tag', 'import_job'
  )),
  entity_id uuid,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{32}$'),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (actor_user_id, request_id)
);

ALTER TABLE public.resource_import_jobs
  ADD COLUMN request_id uuid,
  ADD COLUMN input_hash text,
  ADD COLUMN background_job_id uuid REFERENCES public.background_jobs(id) ON DELETE SET NULL,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN claim_token uuid,
  ADD COLUMN last_error text;
ALTER TABLE public.resource_import_items
  ADD COLUMN result_entity_kind text CHECK (result_entity_kind IN (
    'resource', 'template', 'text_preset', 'font_family', 'font_face'
  )),
  ADD COLUMN result_entity_id uuid,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);

CREATE UNIQUE INDEX resource_import_jobs_actor_request_key
  ON public.resource_import_jobs(created_by, request_id)
  WHERE request_id IS NOT NULL;
CREATE INDEX resource_import_jobs_claim_idx
  ON public.resource_import_jobs(status, available_at, created_at)
  WHERE status IN ('queued', 'running');

DROP TRIGGER IF EXISTS font_faces_set_updated_at ON public.font_faces;
CREATE TRIGGER font_faces_set_updated_at BEFORE UPDATE ON public.font_faces
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS resource_categories_set_updated_at ON public.resource_categories;
CREATE TRIGGER resource_categories_set_updated_at BEFORE UPDATE ON public.resource_categories
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS resource_tags_set_updated_at ON public.resource_tags;
CREATE TRIGGER resource_tags_set_updated_at BEFORE UPDATE ON public.resource_tags
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION private.loomic_assert_catalog_actor(
  p_scope text,
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
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'catalog_write_forbidden';
  END IF;
  IF p_scope = 'platform' THEN
    IF p_workspace_id IS NOT NULL OR NOT private.is_platform_admin(p_actor_user_id) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'catalog_write_forbidden';
    END IF;
  ELSIF p_scope = 'workspace' THEN
    IF p_workspace_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = p_workspace_id AND wm.user_id = p_actor_user_id
        AND wm.role IN ('owner', 'admin')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'catalog_write_forbidden';
    END IF;
  ELSE
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'catalog_scope_invalid';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.loomic_catalog_record(
  p_entity_kind text,
  p_entity_id uuid
)
RETURNS TABLE(
  scope text,
  workspace_id uuid,
  status text,
  deleted_at timestamptz,
  revision bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  CASE p_entity_kind
    WHEN 'resource' THEN RETURN QUERY SELECT r.scope, r.workspace_id, r.status, r.deleted_at, r.revision FROM public.design_resources r WHERE r.id = p_entity_id;
    WHEN 'template' THEN RETURN QUERY SELECT r.scope, r.workspace_id, r.status, r.deleted_at, r.revision FROM public.design_templates r WHERE r.id = p_entity_id;
    WHEN 'text_preset' THEN RETURN QUERY SELECT r.scope, r.workspace_id, r.status, r.deleted_at, r.revision FROM public.text_presets r WHERE r.id = p_entity_id;
    WHEN 'font_family' THEN RETURN QUERY SELECT r.scope, r.workspace_id, r.status, r.deleted_at, r.revision FROM public.font_families r WHERE r.id = p_entity_id;
    WHEN 'font_face' THEN RETURN QUERY SELECT r.scope, r.workspace_id, r.status, r.deleted_at, r.revision FROM public.font_faces r WHERE r.id = p_entity_id;
    WHEN 'category' THEN RETURN QUERY SELECT r.scope, r.workspace_id, r.status, r.deleted_at, r.revision FROM public.resource_categories r WHERE r.id = p_entity_id;
    WHEN 'tag' THEN RETURN QUERY SELECT r.scope, r.workspace_id, r.status, r.deleted_at, r.revision FROM public.resource_tags r WHERE r.id = p_entity_id;
    ELSE RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'catalog_entity_kind_invalid';
  END CASE;
END;
$$;

-- Replace the polymorphic Stage 1 trigger body so a category row never tries
-- to dereference preview_asset_object_id (record fields are table-specific).
CREATE OR REPLACE FUNCTION private.validate_design_catalog_relationship()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  parent_scope text; parent_workspace_id uuid;
  asset_scope text; asset_workspace_id uuid;
  category_scope text; category_workspace_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'font_faces' THEN
    SELECT scope,workspace_id INTO parent_scope,parent_workspace_id FROM public.font_families WHERE id=NEW.family_id;
    IF parent_scope IS DISTINCT FROM NEW.scope OR parent_workspace_id IS DISTINCT FROM NEW.workspace_id
    THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='font_family_scope_mismatch'; END IF;
    SELECT scope,workspace_id INTO asset_scope,asset_workspace_id FROM public.asset_objects WHERE id=NEW.asset_object_id;
    IF asset_scope IS DISTINCT FROM NEW.scope OR asset_workspace_id IS DISTINCT FROM NEW.workspace_id
    THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='catalog_asset_scope_mismatch'; END IF;
  ELSIF TG_TABLE_NAME = 'resource_categories' THEN
    IF NEW.parent_id IS NOT NULL THEN
      SELECT scope,workspace_id INTO parent_scope,parent_workspace_id FROM public.resource_categories WHERE id=NEW.parent_id;
      IF parent_scope IS DISTINCT FROM NEW.scope OR parent_workspace_id IS DISTINCT FROM NEW.workspace_id
      THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='resource_category_scope_mismatch'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'design_resources' THEN
    SELECT scope,workspace_id INTO asset_scope,asset_workspace_id FROM public.asset_objects WHERE id=NEW.asset_object_id;
    IF asset_scope IS DISTINCT FROM NEW.scope OR asset_workspace_id IS DISTINCT FROM NEW.workspace_id
    THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='catalog_asset_scope_mismatch'; END IF;
    IF NEW.category_id IS NOT NULL THEN
      SELECT scope,workspace_id INTO category_scope,category_workspace_id FROM public.resource_categories WHERE id=NEW.category_id;
      IF category_scope IS DISTINCT FROM NEW.scope OR category_workspace_id IS DISTINCT FROM NEW.workspace_id
      THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='resource_category_scope_mismatch'; END IF;
    END IF;
    IF NEW.preview_asset_object_id IS NOT NULL THEN
      SELECT scope,workspace_id INTO asset_scope,asset_workspace_id FROM public.asset_objects WHERE id=NEW.preview_asset_object_id;
      IF asset_scope IS DISTINCT FROM NEW.scope OR asset_workspace_id IS DISTINCT FROM NEW.workspace_id
      THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='catalog_preview_scope_mismatch'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'design_templates' THEN
    IF NEW.preview_asset_object_id IS NOT NULL THEN
      SELECT scope,workspace_id INTO asset_scope,asset_workspace_id FROM public.asset_objects WHERE id=NEW.preview_asset_object_id;
      IF asset_scope IS DISTINCT FROM NEW.scope OR asset_workspace_id IS DISTINCT FROM NEW.workspace_id
      THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='catalog_preview_scope_mismatch'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'text_presets' THEN
    IF NEW.preview_asset_object_id IS NOT NULL THEN
      SELECT scope,workspace_id INTO asset_scope,asset_workspace_id FROM public.asset_objects WHERE id=NEW.preview_asset_object_id;
      IF asset_scope IS DISTINCT FROM NEW.scope OR asset_workspace_id IS DISTINCT FROM NEW.workspace_id
      THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='catalog_preview_scope_mismatch'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION private.loomic_validate_category_tree()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'resource_category_cycle';
  END IF;
  IF NEW.parent_id IS NOT NULL AND EXISTS (
    WITH RECURSIVE ancestors(id, parent_id) AS (
      SELECT c.id, c.parent_id FROM public.resource_categories c WHERE c.id = NEW.parent_id
      UNION ALL
      SELECT c.id, c.parent_id FROM public.resource_categories c
      JOIN ancestors a ON c.id = a.parent_id
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'resource_category_cycle';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER resource_categories_validate_cycle
BEFORE INSERT OR UPDATE OF parent_id ON public.resource_categories
FOR EACH ROW EXECUTE FUNCTION private.loomic_validate_category_tree();

CREATE OR REPLACE FUNCTION private.loomic_validate_catalog_reference_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  owner_scope text;
  owner_workspace uuid;
  ref_scope text;
  ref_workspace uuid;
  ref_asset uuid;
  ref_deleted_at timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'design_template_font_refs' THEN
    SELECT scope, workspace_id INTO owner_scope, owner_workspace FROM public.design_templates WHERE id = NEW.template_id;
    SELECT scope, workspace_id, deleted_at INTO ref_scope, ref_workspace, ref_deleted_at FROM public.font_faces WHERE id = NEW.font_face_id;
  ELSIF TG_TABLE_NAME = 'text_preset_font_refs' THEN
    SELECT scope, workspace_id INTO owner_scope, owner_workspace FROM public.text_presets WHERE id = NEW.text_preset_id;
    SELECT scope, workspace_id, deleted_at INTO ref_scope, ref_workspace, ref_deleted_at FROM public.font_faces WHERE id = NEW.font_face_id;
  ELSIF TG_TABLE_NAME = 'design_template_tag_links' THEN
    SELECT scope, workspace_id INTO owner_scope, owner_workspace FROM public.design_templates WHERE id = NEW.template_id;
    SELECT scope, workspace_id, deleted_at INTO ref_scope, ref_workspace, ref_deleted_at FROM public.resource_tags WHERE id = NEW.tag_id;
  ELSIF TG_TABLE_NAME = 'text_preset_tag_links' THEN
    SELECT scope, workspace_id INTO owner_scope, owner_workspace FROM public.text_presets WHERE id = NEW.text_preset_id;
    SELECT scope, workspace_id, deleted_at INTO ref_scope, ref_workspace, ref_deleted_at FROM public.resource_tags WHERE id = NEW.tag_id;
  ELSIF TG_TABLE_NAME = 'design_template_asset_refs' AND NEW.resource_id IS NOT NULL THEN
    SELECT scope, workspace_id INTO owner_scope, owner_workspace FROM public.design_templates WHERE id = NEW.template_id;
    SELECT scope, workspace_id, asset_object_id, deleted_at
    INTO ref_scope, ref_workspace, ref_asset, ref_deleted_at
    FROM public.design_resources WHERE id = NEW.resource_id FOR KEY SHARE;
    IF ref_deleted_at IS NOT NULL OR ref_asset IS DISTINCT FROM NEW.asset_object_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'template_resource_asset_mismatch';
    END IF;
  END IF;
  IF ref_deleted_at IS NOT NULL OR owner_scope IS DISTINCT FROM ref_scope OR owner_workspace IS DISTINCT FROM ref_workspace THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'catalog_reference_scope_mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.loomic_validate_catalog_category_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE category_scope text; category_workspace uuid; category_deleted_at timestamptz;
BEGIN
  IF NEW.category_id IS NULL THEN RETURN NEW; END IF;
  SELECT scope,workspace_id,deleted_at INTO category_scope,category_workspace,category_deleted_at
  FROM public.resource_categories WHERE id=NEW.category_id;
  IF category_deleted_at IS NOT NULL OR category_scope IS DISTINCT FROM NEW.scope
    OR category_workspace IS DISTINCT FROM NEW.workspace_id
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='resource_category_scope_mismatch'; END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER design_template_font_refs_validate_scope BEFORE INSERT OR UPDATE ON public.design_template_font_refs
FOR EACH ROW EXECUTE FUNCTION private.loomic_validate_catalog_reference_scope();
CREATE TRIGGER text_preset_font_refs_validate_scope BEFORE INSERT OR UPDATE ON public.text_preset_font_refs
FOR EACH ROW EXECUTE FUNCTION private.loomic_validate_catalog_reference_scope();
CREATE TRIGGER design_template_tag_links_validate_scope BEFORE INSERT OR UPDATE ON public.design_template_tag_links
FOR EACH ROW EXECUTE FUNCTION private.loomic_validate_catalog_reference_scope();
CREATE TRIGGER text_preset_tag_links_validate_scope BEFORE INSERT OR UPDATE ON public.text_preset_tag_links
FOR EACH ROW EXECUTE FUNCTION private.loomic_validate_catalog_reference_scope();
CREATE TRIGGER design_template_asset_refs_validate_resource BEFORE INSERT OR UPDATE OF resource_id ON public.design_template_asset_refs
FOR EACH ROW EXECUTE FUNCTION private.loomic_validate_catalog_reference_scope();
CREATE TRIGGER design_templates_validate_category BEFORE INSERT OR UPDATE OF category_id ON public.design_templates
FOR EACH ROW EXECUTE FUNCTION private.loomic_validate_catalog_category_scope();
CREATE TRIGGER text_presets_validate_category BEFORE INSERT OR UPDATE OF category_id ON public.text_presets
FOR EACH ROW EXECUTE FUNCTION private.loomic_validate_catalog_category_scope();

CREATE OR REPLACE FUNCTION private.loomic_lock_design_resource_reference()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE resource_deleted_at timestamptz; resource_scope text; resource_workspace uuid;
BEGIN
  IF NEW.resource_id IS NULL THEN RETURN NEW; END IF;
  SELECT deleted_at,scope,workspace_id INTO resource_deleted_at,resource_scope,resource_workspace
  FROM public.design_resources WHERE id=NEW.resource_id FOR KEY SHARE;
  IF resource_deleted_at IS NOT NULL
    OR (resource_scope='workspace' AND resource_workspace IS DISTINCT FROM NEW.workspace_id)
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='design_resource_workspace_mismatch'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER design_document_asset_refs_lock_resource
BEFORE INSERT OR UPDATE OF resource_id ON public.design_document_asset_refs
FOR EACH ROW EXECUTE FUNCTION private.loomic_lock_design_resource_reference();

CREATE OR REPLACE FUNCTION private.loomic_validate_recent_resource_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  resource_row public.design_resources%ROWTYPE;
BEGIN
  SELECT * INTO resource_row FROM public.design_resources WHERE id = NEW.resource_id;
  IF resource_row.id IS NULL OR resource_row.deleted_at IS NOT NULL OR resource_row.status <> 'published'
    OR (resource_row.scope = 'workspace' AND resource_row.workspace_id IS DISTINCT FROM NEW.workspace_id)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'recent_resource_scope_mismatch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER resource_recent_uses_validate_scope BEFORE INSERT OR UPDATE ON public.resource_recent_uses
FOR EACH ROW EXECUTE FUNCTION private.loomic_validate_recent_resource_scope();

CREATE OR REPLACE FUNCTION private.loomic_validate_import_item_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE job_scope text; job_workspace uuid; asset_scope text; asset_workspace uuid; asset_deleting timestamptz;
BEGIN
  IF NEW.asset_object_id IS NULL THEN RETURN NEW; END IF;
  SELECT scope,workspace_id INTO job_scope,job_workspace FROM public.resource_import_jobs WHERE id=NEW.import_job_id;
  SELECT scope,workspace_id,deletion_pending_at INTO asset_scope,asset_workspace,asset_deleting
  FROM public.asset_objects WHERE id=NEW.asset_object_id FOR KEY SHARE;
  IF asset_deleting IS NOT NULL OR asset_scope IS DISTINCT FROM job_scope OR asset_workspace IS DISTINCT FROM job_workspace
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='resource_import_asset_scope_mismatch'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER resource_import_items_validate_scope BEFORE INSERT OR UPDATE OF asset_object_id,import_job_id ON public.resource_import_items
FOR EACH ROW EXECUTE FUNCTION private.loomic_validate_import_item_scope();

CREATE OR REPLACE FUNCTION private.loomic_sync_catalog_references(
  p_entity_kind text,
  p_entity_id uuid,
  p_document jsonb,
  p_tag_ids jsonb DEFAULT '[]'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  item jsonb;
  object_id text;
  asset_id uuid;
  resource_id uuid;
  font_id uuid;
BEGIN
  IF jsonb_typeof(p_tag_ids) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'catalog_tag_ids_invalid';
  END IF;
  IF p_entity_kind = 'resource' THEN
    DELETE FROM public.resource_tag_links rtl WHERE rtl.resource_id = p_entity_id;
    INSERT INTO public.resource_tag_links(resource_id, tag_id)
    SELECT p_entity_id, (value#>>'{}')::uuid FROM jsonb_array_elements(p_tag_ids)
    ON CONFLICT DO NOTHING;
    RETURN;
  ELSIF p_entity_kind = 'template' THEN
    PERFORM private.loomic_validate_design_scene(
      p_document,
      (p_document#>>'{canvas,width}')::integer,
      (p_document#>>'{canvas,height}')::integer
    );
    DELETE FROM public.design_template_asset_refs WHERE template_id = p_entity_id;
    DELETE FROM public.design_template_font_refs WHERE template_id = p_entity_id;
    DELETE FROM public.design_template_tag_links WHERE template_id = p_entity_id;
    FOR item IN SELECT object_data FROM private.loomic_scene_objects(p_document) LOOP
      object_id := NULLIF(btrim(COALESCE(item->>'objectId', '')), '');
      asset_id := private.try_parse_uuid(item->>'assetObjectId');
      resource_id := private.try_parse_uuid(item->>'resourceId');
      font_id := private.try_parse_uuid(item->>'fontFaceId');
      IF object_id IS NOT NULL AND asset_id IS NOT NULL THEN
        INSERT INTO public.design_template_asset_refs(template_id, object_id, slot, asset_object_id, resource_id)
        VALUES (p_entity_id, object_id, 'source', asset_id, resource_id);
      END IF;
      IF object_id IS NOT NULL AND font_id IS NOT NULL THEN
        INSERT INTO public.design_template_font_refs(template_id, object_id, font_face_id)
        VALUES (p_entity_id, object_id, font_id);
      END IF;
    END LOOP;
    INSERT INTO public.design_template_tag_links(template_id, tag_id)
    SELECT p_entity_id, (value#>>'{}')::uuid FROM jsonb_array_elements(p_tag_ids)
    ON CONFLICT DO NOTHING;
    RETURN;
  ELSIF p_entity_kind = 'text_preset' THEN
    IF jsonb_typeof(p_document) <> 'object'
      OR p_document->>'schemaVersion' <> '1'
      OR jsonb_typeof(p_document->'objects') <> 'array'
      OR jsonb_array_length(p_document->'objects') NOT BETWEEN 1 AND 100
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_document->'objects') object_data
        WHERE object_data->>'type' NOT IN ('text', 'textbox', 'rect', 'circle', 'triangle', 'group')
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'text_preset_style_invalid';
    END IF;
    PERFORM private.loomic_validate_design_scene(jsonb_build_object(
      'schemaVersion', 1, 'engine', 'fabric',
      'canvas', jsonb_build_object('width', 1, 'height', 1, 'background', NULL),
      'objects', p_document->'objects'
    ), 1, 1);
    DELETE FROM public.text_preset_font_refs WHERE text_preset_id = p_entity_id;
    DELETE FROM public.text_preset_tag_links WHERE text_preset_id = p_entity_id;
    FOR item IN SELECT object_data FROM private.loomic_scene_objects(jsonb_build_object('objects', p_document->'objects')) LOOP
      object_id := NULLIF(btrim(COALESCE(item->>'objectId', '')), '');
      font_id := private.try_parse_uuid(item->>'fontFaceId');
      IF object_id IS NOT NULL AND font_id IS NOT NULL THEN
        INSERT INTO public.text_preset_font_refs(text_preset_id, object_id, font_face_id)
        VALUES (p_entity_id, object_id, font_id);
      END IF;
    END LOOP;
    INSERT INTO public.text_preset_tag_links(text_preset_id, tag_id)
    SELECT p_entity_id, (value#>>'{}')::uuid FROM jsonb_array_elements(p_tag_ids)
    ON CONFLICT DO NOTHING;
    RETURN;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.loomic_catalog_publishable(
  p_entity_kind text,
  p_entity_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  ok boolean := false;
BEGIN
  CASE p_entity_kind
    WHEN 'resource' THEN
      SELECT r.preview_asset_object_id IS NOT NULL
        AND ao.deletion_pending_at IS NULL AND pa.deletion_pending_at IS NULL
        AND ao.scope = r.scope AND ao.workspace_id IS NOT DISTINCT FROM r.workspace_id
        AND pa.scope = r.scope AND pa.workspace_id IS NOT DISTINCT FROM r.workspace_id
      INTO ok FROM public.design_resources r
      JOIN public.asset_objects ao ON ao.id = r.asset_object_id
      JOIN public.asset_objects pa ON pa.id = r.preview_asset_object_id
      WHERE r.id = p_entity_id AND r.deleted_at IS NULL;
    WHEN 'template' THEN
      SELECT t.preview_asset_object_id IS NOT NULL
        AND pa.deletion_pending_at IS NULL
        AND pa.scope = t.scope AND pa.workspace_id IS NOT DISTINCT FROM t.workspace_id
        AND NOT EXISTS (
          SELECT 1 FROM public.design_template_asset_refs ar
          JOIN public.asset_objects ao ON ao.id = ar.asset_object_id
          LEFT JOIN public.design_resources r ON r.id = ar.resource_id
          WHERE ar.template_id = t.id AND (
            ao.deletion_pending_at IS NOT NULL OR ao.scope <> t.scope
            OR ao.workspace_id IS DISTINCT FROM t.workspace_id
            OR (ar.resource_id IS NOT NULL AND (r.deleted_at IS NOT NULL OR r.status <> 'published'))
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.design_template_font_refs fr
          JOIN public.font_faces ff ON ff.id = fr.font_face_id
          JOIN public.font_families f ON f.id = ff.family_id
          WHERE fr.template_id = t.id AND (
            ff.deleted_at IS NOT NULL OR ff.status <> 'published' OR NOT ff.allow_web_embed
            OR f.deleted_at IS NOT NULL OR f.status <> 'published'
          )
        )
      INTO ok FROM public.design_templates t
      JOIN public.asset_objects pa ON pa.id = t.preview_asset_object_id
      WHERE t.id = p_entity_id AND t.deleted_at IS NULL;
    WHEN 'text_preset' THEN
      SELECT t.preview_asset_object_id IS NOT NULL
        AND pa.deletion_pending_at IS NULL
        AND pa.scope = t.scope AND pa.workspace_id IS NOT DISTINCT FROM t.workspace_id
        AND NOT EXISTS (
          SELECT 1 FROM public.text_preset_font_refs fr
          JOIN public.font_faces ff ON ff.id = fr.font_face_id
          JOIN public.font_families f ON f.id = ff.family_id
          WHERE fr.text_preset_id = t.id AND (
            ff.deleted_at IS NOT NULL OR ff.status <> 'published' OR NOT ff.allow_web_embed
            OR f.deleted_at IS NOT NULL OR f.status <> 'published'
          )
        )
      INTO ok FROM public.text_presets t
      JOIN public.asset_objects pa ON pa.id = t.preview_asset_object_id
      WHERE t.id = p_entity_id AND t.deleted_at IS NULL;
    WHEN 'font_face' THEN
      SELECT ff.allow_web_embed AND ff.checksum_sha256 ~ '^[a-f0-9]{64}$'
        AND ao.deletion_pending_at IS NULL AND ao.scope = ff.scope
        AND ao.workspace_id IS NOT DISTINCT FROM ff.workspace_id
      INTO ok FROM public.font_faces ff
      JOIN public.asset_objects ao ON ao.id = ff.asset_object_id
      WHERE ff.id = p_entity_id AND ff.deleted_at IS NULL;
    WHEN 'font_family' THEN
      SELECT EXISTS (
        SELECT 1 FROM public.font_faces ff WHERE ff.family_id = f.id
          AND ff.deleted_at IS NULL AND ff.status = 'published' AND ff.allow_web_embed
      ) INTO ok FROM public.font_families f WHERE f.id = p_entity_id AND f.deleted_at IS NULL;
    WHEN 'category', 'tag' THEN ok := true;
    ELSE ok := false;
  END CASE;
  RETURN COALESCE(ok, false);
END;
$$;

CREATE OR REPLACE FUNCTION private.loomic_catalog_transition_allowed(p_from text, p_to text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_from = p_to OR (p_from, p_to) IN (
    ('draft', 'pending_review'),
    ('pending_review', 'draft'), ('pending_review', 'published'), ('pending_review', 'rejected'),
    ('rejected', 'draft'), ('rejected', 'pending_review'),
    ('published', 'disabled'),
    ('disabled', 'draft'), ('disabled', 'published')
  );
$$;

ALTER TABLE public.design_template_font_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_template_font_refs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.text_preset_font_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.text_preset_font_refs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.design_template_tag_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_template_tag_links FORCE ROW LEVEL SECURITY;
ALTER TABLE public.text_preset_tag_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.text_preset_tag_links FORCE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_mutation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_mutation_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY "design_template_font_refs_select_catalog" ON public.design_template_font_refs
FOR SELECT TO authenticated USING (EXISTS (
  SELECT 1 FROM public.design_templates t WHERE t.id = template_id
    AND private.can_read_design_catalog_record(t.scope, t.workspace_id, t.status, t.deleted_at)
));
CREATE POLICY "text_preset_font_refs_select_catalog" ON public.text_preset_font_refs
FOR SELECT TO authenticated USING (EXISTS (
  SELECT 1 FROM public.text_presets t WHERE t.id = text_preset_id
    AND private.can_read_design_catalog_record(t.scope, t.workspace_id, t.status, t.deleted_at)
));
CREATE POLICY "design_template_tag_links_select_catalog" ON public.design_template_tag_links
FOR SELECT TO authenticated USING (EXISTS (
  SELECT 1 FROM public.design_templates t WHERE t.id = template_id
    AND private.can_read_design_catalog_record(t.scope, t.workspace_id, t.status, t.deleted_at)
));
CREATE POLICY "text_preset_tag_links_select_catalog" ON public.text_preset_tag_links
FOR SELECT TO authenticated USING (EXISTS (
  SELECT 1 FROM public.text_presets t WHERE t.id = text_preset_id
    AND private.can_read_design_catalog_record(t.scope, t.workspace_id, t.status, t.deleted_at)
));

GRANT SELECT ON public.design_template_font_refs, public.text_preset_font_refs,
  public.design_template_tag_links, public.text_preset_tag_links TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.design_template_font_refs, public.text_preset_font_refs,
  public.design_template_tag_links, public.text_preset_tag_links FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.catalog_mutation_requests FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION private.loomic_assert_catalog_actor(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_catalog_record(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_validate_category_tree() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_validate_catalog_reference_scope() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_validate_catalog_category_scope() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_lock_design_resource_reference() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_validate_recent_resource_scope() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_validate_import_item_scope() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_sync_catalog_references(text, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_catalog_publishable(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_catalog_transition_allowed(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.loomic_assert_catalog_actor(text, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION private.loomic_catalog_record(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION private.loomic_sync_catalog_references(text, uuid, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION private.loomic_catalog_publishable(text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.loomic_design_resources_list(
  p_scope text,
  p_kind text,
  p_status text,
  p_query text,
  p_category_id uuid,
  p_tag_id uuid,
  p_format text,
  p_aspect_ratio text,
  p_cursor_updated_at timestamptz,
  p_cursor_id uuid,
  p_limit integer,
  p_active_workspace_id uuid DEFAULT NULL
)
RETURNS TABLE(item jsonb)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT to_jsonb(r)
    || jsonb_build_object(
      'tag_ids', COALESCE((
        SELECT jsonb_agg(rtl.tag_id ORDER BY rtl.tag_id)
        FROM public.resource_tag_links rtl WHERE rtl.resource_id=r.id
      ), '[]'::jsonb),
      'mime_type', ao.mime_type
    ) AS item
  FROM public.design_resources r
  JOIN public.asset_objects ao ON ao.id=r.asset_object_id
  LEFT JOIN public.resource_categories rc ON rc.id=r.category_id
  WHERE r.deleted_at IS NULL
    AND (p_active_workspace_id IS NULL OR r.scope='platform' OR r.workspace_id=p_active_workspace_id)
    AND (p_scope IS NULL OR r.scope=p_scope)
    AND (p_kind IS NULL OR r.kind=p_kind)
    AND (p_status IS NULL OR r.status=p_status)
    AND (p_category_id IS NULL OR r.category_id=p_category_id)
    AND (p_tag_id IS NULL OR EXISTS(
      SELECT 1 FROM public.resource_tag_links rtl WHERE rtl.resource_id=r.id AND rtl.tag_id=p_tag_id
    ))
    AND (p_query IS NULL OR btrim(p_query)='' OR r.name ILIKE '%'||p_query||'%'
      OR COALESCE(r.description,'') ILIKE '%'||p_query||'%'
      OR COALESCE(rc.name,'') ILIKE '%'||p_query||'%'
      OR EXISTS(SELECT 1 FROM public.resource_tag_links rtl JOIN public.resource_tags rt ON rt.id=rtl.tag_id
        WHERE rtl.resource_id=r.id AND rt.name ILIKE '%'||p_query||'%'))
    AND (p_format IS NULL OR CASE p_format
      WHEN 'png' THEN ao.mime_type='image/png'
      WHEN 'jpeg' THEN ao.mime_type IN ('image/jpeg','image/jpg')
      WHEN 'webp' THEN ao.mime_type='image/webp'
      WHEN 'gif' THEN ao.mime_type='image/gif'
      WHEN 'svg' THEN ao.mime_type='image/svg+xml'
      ELSE false END)
    AND (p_aspect_ratio IS NULL OR CASE p_aspect_ratio
      WHEN 'square' THEN r.width IS NOT NULL AND abs(r.width-r.height)<=greatest(r.width,r.height)*0.05
      WHEN 'portrait' THEN r.width IS NOT NULL AND r.height>r.width
      WHEN 'landscape' THEN r.width IS NOT NULL AND r.width>r.height
      WHEN 'wide' THEN r.width IS NOT NULL AND r.width::numeric/r.height>=1.7
      ELSE false END)
    AND ((p_cursor_updated_at IS NULL AND p_cursor_id IS NULL)
      OR (p_cursor_updated_at IS NOT NULL AND p_cursor_id IS NOT NULL
        AND (r.updated_at,r.id)<(p_cursor_updated_at,p_cursor_id)))
  ORDER BY r.updated_at DESC,r.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit,30),1),100)+1;
$$;

REVOKE ALL ON FUNCTION public.loomic_design_resources_list(text,text,text,text,uuid,uuid,text,text,timestamptz,uuid,integer,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.loomic_design_resources_list(text,text,text,text,uuid,uuid,text,text,timestamptz,uuid,integer,uuid)
  TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.loomic_design_resource_collection_list(
  p_collection text,
  p_workspace_id uuid,
  p_cursor_used_at timestamptz,
  p_cursor_id uuid,
  p_limit integer
)
RETURNS TABLE(item jsonb)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path=''
AS $$
  WITH collection_rows AS (
    SELECT r.*,CASE WHEN p_collection='favorites' THEN rf.created_at ELSE ru.used_at END AS collection_used_at
    FROM public.design_resources r
    LEFT JOIN public.resource_favorites rf ON p_collection='favorites'
      AND rf.resource_id=r.id AND rf.user_id=auth.uid()
    LEFT JOIN public.resource_recent_uses ru ON p_collection='recent'
      AND ru.resource_id=r.id AND ru.user_id=auth.uid() AND ru.workspace_id=p_workspace_id
    WHERE r.deleted_at IS NULL
      AND ((p_collection='favorites' AND rf.resource_id IS NOT NULL)
        OR (p_collection='recent' AND p_workspace_id IS NOT NULL AND ru.resource_id IS NOT NULL))
  )
  SELECT to_jsonb(r) || jsonb_build_object(
    'tag_ids',COALESCE((SELECT jsonb_agg(rtl.tag_id ORDER BY rtl.tag_id)
      FROM public.resource_tag_links rtl WHERE rtl.resource_id=r.id),'[]'::jsonb),
    'collection_used_at',r.collection_used_at
  )
  FROM collection_rows r
  WHERE ((p_cursor_used_at IS NULL AND p_cursor_id IS NULL)
    OR (p_cursor_used_at IS NOT NULL AND p_cursor_id IS NOT NULL
      AND (r.collection_used_at,r.id)<(p_cursor_used_at,p_cursor_id)))
  ORDER BY r.collection_used_at DESC,r.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit,30),1),100)+1;
$$;
REVOKE ALL ON FUNCTION public.loomic_design_resource_collection_list(text,uuid,timestamptz,uuid,integer)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.loomic_design_resource_collection_list(text,uuid,timestamptz,uuid,integer)
  TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.loomic_catalog_create(
  p_request_id uuid,
  p_entity_kind text,
  p_scope text,
  p_workspace_id uuid,
  p_payload jsonb,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  request_hash text;
  request_row public.catalog_mutation_requests%ROWTYPE;
  new_id uuid := extensions.gen_random_uuid();
  result_value jsonb;
  document_value jsonb;
BEGIN
  PERFORM private.loomic_assert_catalog_actor(p_scope, p_workspace_id, p_actor_user_id);
  IF p_request_id IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'catalog_create_invalid';
  END IF;
  request_hash := md5(jsonb_build_object(
    'kind', p_entity_kind, 'scope', p_scope, 'workspace_id', p_workspace_id,
    'payload', p_payload
  )::text);
  INSERT INTO public.catalog_mutation_requests(
    actor_user_id, request_id, operation, entity_kind, input_hash
  ) VALUES (p_actor_user_id, p_request_id, 'create', p_entity_kind, request_hash)
  ON CONFLICT DO NOTHING;
  SELECT * INTO request_row FROM public.catalog_mutation_requests
  WHERE actor_user_id = p_actor_user_id AND request_id = p_request_id FOR UPDATE;
  IF request_row.operation <> 'create' OR request_row.entity_kind <> p_entity_kind
    OR request_row.input_hash <> request_hash
  THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'catalog_idempotency_conflict';
  END IF;
  IF request_row.result IS NOT NULL THEN
    RETURN jsonb_set(request_row.result, '{replayed}', 'true'::jsonb, true);
  END IF;

  CASE p_entity_kind
    WHEN 'resource' THEN
      IF NOT private.loomic_jsonb_object_has_only_keys(p_payload, ARRAY[
        'kind','name','description','asset_object_id','preview_asset_object_id',
        'width','height','checksum_sha256','category_id','tag_ids','source_url',
        'author','license_name','license_url','attribution','usage_restrictions'
      ]) THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'catalog_payload_unknown_field'; END IF;
      INSERT INTO public.design_resources(
        id, scope, workspace_id, kind, name, description, asset_object_id,
        preview_asset_object_id, width, height, checksum_sha256, category_id,
        source_url, author, license_name, license_url, attribution,
        usage_restrictions, created_by, updated_by
      ) VALUES (
        new_id, p_scope, p_workspace_id, p_payload->>'kind', p_payload->>'name',
        p_payload->>'description', (p_payload->>'asset_object_id')::uuid,
        private.try_parse_uuid(p_payload->>'preview_asset_object_id'),
        (p_payload->>'width')::integer, (p_payload->>'height')::integer,
        p_payload->>'checksum_sha256', private.try_parse_uuid(p_payload->>'category_id'),
        p_payload->>'source_url', p_payload->>'author', p_payload->>'license_name',
        p_payload->>'license_url', p_payload->>'attribution',
        p_payload->>'usage_restrictions', p_actor_user_id, p_actor_user_id
      );
      PERFORM private.loomic_sync_catalog_references(
        'resource', new_id, '{}'::jsonb, COALESCE(p_payload->'tag_ids', '[]'::jsonb)
      );
    WHEN 'template' THEN
      IF NOT private.loomic_jsonb_object_has_only_keys(p_payload, ARRAY[
        'name','description','scene','preview_asset_object_id','category_id','tag_ids',
        'source_url','author','license_name','license_url','attribution','usage_restrictions'
      ]) THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'catalog_payload_unknown_field'; END IF;
      document_value := p_payload->'scene';
      PERFORM private.loomic_validate_design_scene(
        document_value, (document_value#>>'{canvas,width}')::integer,
        (document_value#>>'{canvas,height}')::integer
      );
      INSERT INTO public.design_templates(
        id, scope, workspace_id, name, description, scene, width, height,
        preview_asset_object_id, category_id, source_url, author, license_name,
        license_url, attribution, usage_restrictions, created_by, updated_by
      ) VALUES (
        new_id, p_scope, p_workspace_id, p_payload->>'name', p_payload->>'description',
        document_value, (document_value#>>'{canvas,width}')::integer,
        (document_value#>>'{canvas,height}')::integer,
        private.try_parse_uuid(p_payload->>'preview_asset_object_id'),
        private.try_parse_uuid(p_payload->>'category_id'), p_payload->>'source_url',
        p_payload->>'author', p_payload->>'license_name', p_payload->>'license_url',
        p_payload->>'attribution', p_payload->>'usage_restrictions',
        p_actor_user_id, p_actor_user_id
      );
      PERFORM private.loomic_sync_catalog_references(
        'template', new_id, document_value, COALESCE(p_payload->'tag_ids', '[]'::jsonb)
      );
    WHEN 'text_preset' THEN
      IF NOT private.loomic_jsonb_object_has_only_keys(p_payload, ARRAY[
        'name','style','preview_asset_object_id','category_id','tag_ids','source_url',
        'author','license_name','license_url','attribution','usage_restrictions'
      ]) THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'catalog_payload_unknown_field'; END IF;
      document_value := p_payload->'style';
      INSERT INTO public.text_presets(
        id, scope, workspace_id, name, style, preview_asset_object_id, category_id,
        source_url, author, license_name, license_url, attribution,
        usage_restrictions, created_by, updated_by
      ) VALUES (
        new_id, p_scope, p_workspace_id, p_payload->>'name', document_value,
        private.try_parse_uuid(p_payload->>'preview_asset_object_id'),
        private.try_parse_uuid(p_payload->>'category_id'), p_payload->>'source_url',
        p_payload->>'author', p_payload->>'license_name', p_payload->>'license_url',
        p_payload->>'attribution', p_payload->>'usage_restrictions',
        p_actor_user_id, p_actor_user_id
      );
      PERFORM private.loomic_sync_catalog_references(
        'text_preset', new_id, document_value, COALESCE(p_payload->'tag_ids', '[]'::jsonb)
      );
    WHEN 'font_family' THEN
      IF NOT private.loomic_jsonb_object_has_only_keys(p_payload, ARRAY[
        'name','source_url','author','license_name','license_url','attribution','usage_restrictions'
      ]) THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'catalog_payload_unknown_field'; END IF;
      INSERT INTO public.font_families(
        id, scope, workspace_id, name, source_url, author, license_name,
        license_url, attribution, usage_restrictions, created_by, updated_by
      ) VALUES (
        new_id, p_scope, p_workspace_id, p_payload->>'name', p_payload->>'source_url',
        p_payload->>'author', p_payload->>'license_name', p_payload->>'license_url',
        p_payload->>'attribution', p_payload->>'usage_restrictions',
        p_actor_user_id, p_actor_user_id
      );
    WHEN 'font_face' THEN
      IF NOT private.loomic_jsonb_object_has_only_keys(p_payload, ARRAY[
        'family_id','asset_object_id','style','weight','format','checksum_sha256','allow_web_embed'
      ]) THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'catalog_payload_unknown_field'; END IF;
      INSERT INTO public.font_faces(
        id, family_id, scope, workspace_id, asset_object_id, style, weight,
        format, checksum_sha256, allow_web_embed, created_by, updated_by
      ) VALUES (
        new_id, (p_payload->>'family_id')::uuid, p_scope, p_workspace_id,
        (p_payload->>'asset_object_id')::uuid, p_payload->>'style',
        (p_payload->>'weight')::integer, p_payload->>'format',
        p_payload->>'checksum_sha256', (p_payload->>'allow_web_embed')::boolean,
        p_actor_user_id, p_actor_user_id
      );
    WHEN 'category' THEN
      IF NOT private.loomic_jsonb_object_has_only_keys(p_payload, ARRAY['parent_id','name','slug','sort_order'])
      THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'catalog_payload_unknown_field'; END IF;
      INSERT INTO public.resource_categories(
        id, scope, workspace_id, parent_id, name, slug, sort_order, created_by, updated_by
      ) VALUES (
        new_id, p_scope, p_workspace_id, private.try_parse_uuid(p_payload->>'parent_id'),
        p_payload->>'name', p_payload->>'slug', COALESCE((p_payload->>'sort_order')::integer, 0),
        p_actor_user_id, p_actor_user_id
      );
    WHEN 'tag' THEN
      IF NOT private.loomic_jsonb_object_has_only_keys(p_payload, ARRAY['name','slug'])
      THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'catalog_payload_unknown_field'; END IF;
      INSERT INTO public.resource_tags(
        id, scope, workspace_id, name, slug, created_by, updated_by
      ) VALUES (new_id, p_scope, p_workspace_id, p_payload->>'name', p_payload->>'slug', p_actor_user_id, p_actor_user_id);
    ELSE RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'catalog_entity_kind_invalid';
  END CASE;

  result_value := jsonb_build_object(
    'entity_kind', p_entity_kind, 'entity_id', new_id, 'revision', 0,
    'status', 'draft', 'replayed', false
  );
  UPDATE public.catalog_mutation_requests SET entity_id = new_id,
    result = result_value, completed_at = now()
  WHERE actor_user_id = p_actor_user_id AND request_id = p_request_id;
  RETURN result_value;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_catalog_update(
  p_request_id uuid,
  p_entity_kind text,
  p_entity_id uuid,
  p_expected_revision bigint,
  p_patch jsonb,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  request_hash text;
  request_row public.catalog_mutation_requests%ROWTYPE;
  catalog_row record;
  document_value jsonb;
  new_revision bigint;
  result_value jsonb;
BEGIN
  SELECT * INTO catalog_row FROM private.loomic_catalog_record(p_entity_kind, p_entity_id);
  IF catalog_row IS NULL THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'catalog_not_found'; END IF;
  PERFORM private.loomic_assert_catalog_actor(catalog_row.scope, catalog_row.workspace_id, p_actor_user_id);
  IF jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'catalog_update_empty';
  END IF;
  request_hash := md5(jsonb_build_object(
    'kind', p_entity_kind, 'id', p_entity_id, 'revision', p_expected_revision, 'patch', p_patch
  )::text);
  INSERT INTO public.catalog_mutation_requests(actor_user_id, request_id, operation, entity_kind, entity_id, input_hash)
  VALUES (p_actor_user_id, p_request_id, 'update', p_entity_kind, p_entity_id, request_hash)
  ON CONFLICT DO NOTHING;
  SELECT * INTO request_row FROM public.catalog_mutation_requests
  WHERE actor_user_id = p_actor_user_id AND request_id = p_request_id FOR UPDATE;
  IF request_row.operation <> 'update' OR request_row.entity_kind <> p_entity_kind
    OR request_row.entity_id <> p_entity_id OR request_row.input_hash <> request_hash
  THEN RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'catalog_idempotency_conflict'; END IF;
  IF request_row.result IS NOT NULL THEN RETURN jsonb_set(request_row.result, '{replayed}', 'true'::jsonb, true); END IF;
  IF catalog_row.deleted_at IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'catalog_not_found'; END IF;
  IF catalog_row.revision <> p_expected_revision THEN RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'catalog_revision_conflict'; END IF;

  CASE p_entity_kind
    WHEN 'resource' THEN
      IF NOT private.loomic_jsonb_object_has_only_keys(p_patch, ARRAY[
        'name','description','preview_asset_object_id','category_id','tag_ids','source_url',
        'author','license_name','license_url','attribution','usage_restrictions'
      ]) THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'catalog_patch_unknown_field'; END IF;
      UPDATE public.design_resources SET
        name = CASE WHEN p_patch ? 'name' THEN p_patch->>'name' ELSE name END,
        description = CASE WHEN p_patch ? 'description' THEN p_patch->>'description' ELSE description END,
        preview_asset_object_id = CASE WHEN p_patch ? 'preview_asset_object_id' THEN private.try_parse_uuid(p_patch->>'preview_asset_object_id') ELSE preview_asset_object_id END,
        category_id = CASE WHEN p_patch ? 'category_id' THEN private.try_parse_uuid(p_patch->>'category_id') ELSE category_id END,
        source_url = CASE WHEN p_patch ? 'source_url' THEN p_patch->>'source_url' ELSE source_url END,
        author = CASE WHEN p_patch ? 'author' THEN p_patch->>'author' ELSE author END,
        license_name = CASE WHEN p_patch ? 'license_name' THEN p_patch->>'license_name' ELSE license_name END,
        license_url = CASE WHEN p_patch ? 'license_url' THEN p_patch->>'license_url' ELSE license_url END,
        attribution = CASE WHEN p_patch ? 'attribution' THEN p_patch->>'attribution' ELSE attribution END,
        usage_restrictions = CASE WHEN p_patch ? 'usage_restrictions' THEN p_patch->>'usage_restrictions' ELSE usage_restrictions END,
        revision = revision + 1, updated_by = p_actor_user_id
      WHERE id = p_entity_id AND revision = p_expected_revision RETURNING revision INTO new_revision;
      IF p_patch ? 'tag_ids' THEN PERFORM private.loomic_sync_catalog_references('resource', p_entity_id, '{}'::jsonb, p_patch->'tag_ids'); END IF;
    WHEN 'template' THEN
      IF NOT private.loomic_jsonb_object_has_only_keys(p_patch, ARRAY[
        'name','description','scene','preview_asset_object_id','category_id','tag_ids','source_url',
        'author','license_name','license_url','attribution','usage_restrictions'
      ]) THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'catalog_patch_unknown_field'; END IF;
      IF p_patch ? 'scene' THEN
        document_value := p_patch->'scene';
        PERFORM private.loomic_validate_design_scene(document_value, (document_value#>>'{canvas,width}')::integer, (document_value#>>'{canvas,height}')::integer);
      END IF;
      UPDATE public.design_templates SET
        name = CASE WHEN p_patch ? 'name' THEN p_patch->>'name' ELSE name END,
        description = CASE WHEN p_patch ? 'description' THEN p_patch->>'description' ELSE description END,
        scene = CASE WHEN p_patch ? 'scene' THEN document_value ELSE scene END,
        width = CASE WHEN p_patch ? 'scene' THEN (document_value#>>'{canvas,width}')::integer ELSE width END,
        height = CASE WHEN p_patch ? 'scene' THEN (document_value#>>'{canvas,height}')::integer ELSE height END,
        preview_asset_object_id = CASE WHEN p_patch ? 'preview_asset_object_id' THEN private.try_parse_uuid(p_patch->>'preview_asset_object_id') ELSE preview_asset_object_id END,
        category_id = CASE WHEN p_patch ? 'category_id' THEN private.try_parse_uuid(p_patch->>'category_id') ELSE category_id END,
        source_url = CASE WHEN p_patch ? 'source_url' THEN p_patch->>'source_url' ELSE source_url END,
        author = CASE WHEN p_patch ? 'author' THEN p_patch->>'author' ELSE author END,
        license_name = CASE WHEN p_patch ? 'license_name' THEN p_patch->>'license_name' ELSE license_name END,
        license_url = CASE WHEN p_patch ? 'license_url' THEN p_patch->>'license_url' ELSE license_url END,
        attribution = CASE WHEN p_patch ? 'attribution' THEN p_patch->>'attribution' ELSE attribution END,
        usage_restrictions = CASE WHEN p_patch ? 'usage_restrictions' THEN p_patch->>'usage_restrictions' ELSE usage_restrictions END,
        revision = revision + 1, updated_by = p_actor_user_id
      WHERE id = p_entity_id AND revision = p_expected_revision RETURNING revision, scene INTO new_revision, document_value;
      IF p_patch ? 'scene' OR p_patch ? 'tag_ids' THEN
        PERFORM private.loomic_sync_catalog_references('template', p_entity_id, document_value,
          CASE WHEN p_patch ? 'tag_ids' THEN p_patch->'tag_ids' ELSE (SELECT COALESCE(jsonb_agg(tag_id), '[]'::jsonb) FROM public.design_template_tag_links WHERE template_id = p_entity_id) END);
      END IF;
    WHEN 'text_preset' THEN
      IF NOT private.loomic_jsonb_object_has_only_keys(p_patch, ARRAY[
        'name','style','preview_asset_object_id','category_id','tag_ids','source_url',
        'author','license_name','license_url','attribution','usage_restrictions'
      ]) THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'catalog_patch_unknown_field'; END IF;
      UPDATE public.text_presets SET
        name = CASE WHEN p_patch ? 'name' THEN p_patch->>'name' ELSE name END,
        style = CASE WHEN p_patch ? 'style' THEN p_patch->'style' ELSE style END,
        preview_asset_object_id = CASE WHEN p_patch ? 'preview_asset_object_id' THEN private.try_parse_uuid(p_patch->>'preview_asset_object_id') ELSE preview_asset_object_id END,
        category_id = CASE WHEN p_patch ? 'category_id' THEN private.try_parse_uuid(p_patch->>'category_id') ELSE category_id END,
        source_url = CASE WHEN p_patch ? 'source_url' THEN p_patch->>'source_url' ELSE source_url END,
        author = CASE WHEN p_patch ? 'author' THEN p_patch->>'author' ELSE author END,
        license_name = CASE WHEN p_patch ? 'license_name' THEN p_patch->>'license_name' ELSE license_name END,
        license_url = CASE WHEN p_patch ? 'license_url' THEN p_patch->>'license_url' ELSE license_url END,
        attribution = CASE WHEN p_patch ? 'attribution' THEN p_patch->>'attribution' ELSE attribution END,
        usage_restrictions = CASE WHEN p_patch ? 'usage_restrictions' THEN p_patch->>'usage_restrictions' ELSE usage_restrictions END,
        revision = revision + 1, updated_by = p_actor_user_id
      WHERE id = p_entity_id AND revision = p_expected_revision RETURNING revision, style INTO new_revision, document_value;
      IF p_patch ? 'style' OR p_patch ? 'tag_ids' THEN
        PERFORM private.loomic_sync_catalog_references('text_preset', p_entity_id, document_value,
          CASE WHEN p_patch ? 'tag_ids' THEN p_patch->'tag_ids' ELSE (SELECT COALESCE(jsonb_agg(tag_id), '[]'::jsonb) FROM public.text_preset_tag_links WHERE text_preset_id = p_entity_id) END);
      END IF;
    WHEN 'font_family' THEN
      IF NOT private.loomic_jsonb_object_has_only_keys(p_patch, ARRAY['name','source_url','author','license_name','license_url','attribution','usage_restrictions'])
      THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'catalog_patch_unknown_field'; END IF;
      UPDATE public.font_families SET
        name = CASE WHEN p_patch ? 'name' THEN p_patch->>'name' ELSE name END,
        source_url = CASE WHEN p_patch ? 'source_url' THEN p_patch->>'source_url' ELSE source_url END,
        author = CASE WHEN p_patch ? 'author' THEN p_patch->>'author' ELSE author END,
        license_name = CASE WHEN p_patch ? 'license_name' THEN p_patch->>'license_name' ELSE license_name END,
        license_url = CASE WHEN p_patch ? 'license_url' THEN p_patch->>'license_url' ELSE license_url END,
        attribution = CASE WHEN p_patch ? 'attribution' THEN p_patch->>'attribution' ELSE attribution END,
        usage_restrictions = CASE WHEN p_patch ? 'usage_restrictions' THEN p_patch->>'usage_restrictions' ELSE usage_restrictions END,
        revision = revision + 1, updated_by = p_actor_user_id
      WHERE id = p_entity_id AND revision = p_expected_revision RETURNING revision INTO new_revision;
    WHEN 'font_face' THEN
      IF NOT private.loomic_jsonb_object_has_only_keys(p_patch, ARRAY['style','weight','allow_web_embed'])
      THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'catalog_patch_unknown_field'; END IF;
      UPDATE public.font_faces SET
        style = CASE WHEN p_patch ? 'style' THEN p_patch->>'style' ELSE style END,
        weight = CASE WHEN p_patch ? 'weight' THEN (p_patch->>'weight')::integer ELSE weight END,
        allow_web_embed = CASE WHEN p_patch ? 'allow_web_embed' THEN (p_patch->>'allow_web_embed')::boolean ELSE allow_web_embed END,
        revision = revision + 1, updated_by = p_actor_user_id
      WHERE id = p_entity_id AND revision = p_expected_revision RETURNING revision INTO new_revision;
    WHEN 'category' THEN
      IF NOT private.loomic_jsonb_object_has_only_keys(p_patch, ARRAY['parent_id','name','slug','sort_order'])
      THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'catalog_patch_unknown_field'; END IF;
      UPDATE public.resource_categories SET
        parent_id = CASE WHEN p_patch ? 'parent_id' THEN private.try_parse_uuid(p_patch->>'parent_id') ELSE parent_id END,
        name = CASE WHEN p_patch ? 'name' THEN p_patch->>'name' ELSE name END,
        slug = CASE WHEN p_patch ? 'slug' THEN p_patch->>'slug' ELSE slug END,
        sort_order = CASE WHEN p_patch ? 'sort_order' THEN (p_patch->>'sort_order')::integer ELSE sort_order END,
        revision = revision + 1, updated_by = p_actor_user_id
      WHERE id = p_entity_id AND revision = p_expected_revision RETURNING revision INTO new_revision;
    WHEN 'tag' THEN
      IF NOT private.loomic_jsonb_object_has_only_keys(p_patch, ARRAY['name','slug'])
      THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'catalog_patch_unknown_field'; END IF;
      UPDATE public.resource_tags SET
        name = CASE WHEN p_patch ? 'name' THEN p_patch->>'name' ELSE name END,
        slug = CASE WHEN p_patch ? 'slug' THEN p_patch->>'slug' ELSE slug END,
        revision = revision + 1, updated_by = p_actor_user_id
      WHERE id = p_entity_id AND revision = p_expected_revision RETURNING revision INTO new_revision;
    ELSE RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'catalog_entity_kind_invalid';
  END CASE;
  IF new_revision IS NULL THEN RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'catalog_revision_conflict'; END IF;
  result_value := jsonb_build_object('entity_kind', p_entity_kind, 'entity_id', p_entity_id,
    'revision', new_revision, 'status', catalog_row.status, 'replayed', false);
  UPDATE public.catalog_mutation_requests SET result = result_value, completed_at = now()
  WHERE actor_user_id = p_actor_user_id AND request_id = p_request_id;
  RETURN result_value;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_catalog_set_status(
  p_request_id uuid,
  p_entity_kind text,
  p_entity_id uuid,
  p_expected_revision bigint,
  p_status text,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  request_hash text;
  request_row public.catalog_mutation_requests%ROWTYPE;
  catalog_row record;
  new_revision bigint;
  result_value jsonb;
BEGIN
  IF p_status NOT IN ('draft','pending_review','published','rejected','disabled') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'catalog_status_invalid';
  END IF;
  SELECT * INTO catalog_row FROM private.loomic_catalog_record(p_entity_kind, p_entity_id);
  IF catalog_row IS NULL THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'catalog_not_found'; END IF;
  PERFORM private.loomic_assert_catalog_actor(catalog_row.scope, catalog_row.workspace_id, p_actor_user_id);
  request_hash := md5(jsonb_build_object('kind',p_entity_kind,'id',p_entity_id,'revision',p_expected_revision,'status',p_status)::text);
  INSERT INTO public.catalog_mutation_requests(actor_user_id,request_id,operation,entity_kind,entity_id,input_hash)
  VALUES(p_actor_user_id,p_request_id,'set_status',p_entity_kind,p_entity_id,request_hash) ON CONFLICT DO NOTHING;
  SELECT * INTO request_row FROM public.catalog_mutation_requests WHERE actor_user_id=p_actor_user_id AND request_id=p_request_id FOR UPDATE;
  IF request_row.operation <> 'set_status' OR request_row.entity_kind <> p_entity_kind
    OR request_row.entity_id <> p_entity_id OR request_row.input_hash <> request_hash
  THEN RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='catalog_idempotency_conflict'; END IF;
  IF request_row.result IS NOT NULL THEN RETURN jsonb_set(request_row.result,'{replayed}','true'::jsonb,true); END IF;
  IF catalog_row.deleted_at IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'catalog_not_found'; END IF;
  IF catalog_row.revision <> p_expected_revision THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='catalog_revision_conflict'; END IF;
  IF NOT private.loomic_catalog_transition_allowed(catalog_row.status,p_status) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='catalog_status_transition_invalid';
  END IF;
  IF p_status = 'published' AND NOT private.loomic_catalog_publishable(p_entity_kind,p_entity_id) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='catalog_publication_dependencies_unavailable';
  END IF;
  IF p_status = catalog_row.status THEN
    new_revision := catalog_row.revision;
  ELSE
    CASE p_entity_kind
      WHEN 'resource' THEN UPDATE public.design_resources SET status=p_status,revision=revision+1,updated_by=p_actor_user_id,published_by=CASE WHEN p_status='published' THEN p_actor_user_id ELSE published_by END,published_at=CASE WHEN p_status='published' THEN now() ELSE published_at END WHERE id=p_entity_id AND revision=p_expected_revision RETURNING revision INTO new_revision;
      WHEN 'template' THEN UPDATE public.design_templates SET status=p_status,revision=revision+1,updated_by=p_actor_user_id,published_by=CASE WHEN p_status='published' THEN p_actor_user_id ELSE published_by END,published_at=CASE WHEN p_status='published' THEN now() ELSE published_at END WHERE id=p_entity_id AND revision=p_expected_revision RETURNING revision INTO new_revision;
      WHEN 'text_preset' THEN UPDATE public.text_presets SET status=p_status,revision=revision+1,updated_by=p_actor_user_id,published_by=CASE WHEN p_status='published' THEN p_actor_user_id ELSE published_by END,published_at=CASE WHEN p_status='published' THEN now() ELSE published_at END WHERE id=p_entity_id AND revision=p_expected_revision RETURNING revision INTO new_revision;
      WHEN 'font_family' THEN UPDATE public.font_families SET status=p_status,revision=revision+1,updated_by=p_actor_user_id,published_by=CASE WHEN p_status='published' THEN p_actor_user_id ELSE published_by END,published_at=CASE WHEN p_status='published' THEN now() ELSE published_at END WHERE id=p_entity_id AND revision=p_expected_revision RETURNING revision INTO new_revision;
      WHEN 'font_face' THEN UPDATE public.font_faces SET status=p_status,revision=revision+1,updated_by=p_actor_user_id,published_by=CASE WHEN p_status='published' THEN p_actor_user_id ELSE published_by END,published_at=CASE WHEN p_status='published' THEN now() ELSE published_at END WHERE id=p_entity_id AND revision=p_expected_revision RETURNING revision INTO new_revision;
      WHEN 'category' THEN UPDATE public.resource_categories SET status=p_status,revision=revision+1,updated_by=p_actor_user_id,published_by=CASE WHEN p_status='published' THEN p_actor_user_id ELSE published_by END,published_at=CASE WHEN p_status='published' THEN now() ELSE published_at END WHERE id=p_entity_id AND revision=p_expected_revision RETURNING revision INTO new_revision;
      WHEN 'tag' THEN UPDATE public.resource_tags SET status=p_status,revision=revision+1,updated_by=p_actor_user_id,published_by=CASE WHEN p_status='published' THEN p_actor_user_id ELSE published_by END,published_at=CASE WHEN p_status='published' THEN now() ELSE published_at END WHERE id=p_entity_id AND revision=p_expected_revision RETURNING revision INTO new_revision;
      ELSE RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='catalog_entity_kind_invalid';
    END CASE;
    IF new_revision IS NULL THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='catalog_revision_conflict'; END IF;
  END IF;
  result_value:=jsonb_build_object('entity_kind',p_entity_kind,'entity_id',p_entity_id,'revision',new_revision,'status',p_status,'replayed',false);
  UPDATE public.catalog_mutation_requests SET result=result_value,completed_at=now() WHERE actor_user_id=p_actor_user_id AND request_id=p_request_id;
  RETURN result_value;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_catalog_set_deleted(
  p_request_id uuid,
  p_entity_kind text,
  p_entity_id uuid,
  p_expected_revision bigint,
  p_deleted boolean,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  operation_value text := CASE WHEN p_deleted THEN 'soft_delete' ELSE 'restore' END;
  request_hash text;
  request_row public.catalog_mutation_requests%ROWTYPE;
  catalog_row record;
  new_revision bigint;
  new_status text;
  result_value jsonb;
BEGIN
  SELECT * INTO catalog_row FROM private.loomic_catalog_record(p_entity_kind,p_entity_id);
  IF catalog_row IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='catalog_not_found'; END IF;
  PERFORM private.loomic_assert_catalog_actor(catalog_row.scope,catalog_row.workspace_id,p_actor_user_id);
  request_hash:=md5(jsonb_build_object('kind',p_entity_kind,'id',p_entity_id,'revision',p_expected_revision,'deleted',p_deleted)::text);
  INSERT INTO public.catalog_mutation_requests(actor_user_id,request_id,operation,entity_kind,entity_id,input_hash)
  VALUES(p_actor_user_id,p_request_id,operation_value,p_entity_kind,p_entity_id,request_hash) ON CONFLICT DO NOTHING;
  SELECT * INTO request_row FROM public.catalog_mutation_requests WHERE actor_user_id=p_actor_user_id AND request_id=p_request_id FOR UPDATE;
  IF request_row.operation<>operation_value OR request_row.entity_kind<>p_entity_kind OR request_row.entity_id<>p_entity_id OR request_row.input_hash<>request_hash
  THEN RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='catalog_idempotency_conflict'; END IF;
  IF request_row.result IS NOT NULL THEN RETURN jsonb_set(request_row.result,'{replayed}','true'::jsonb,true); END IF;
  IF catalog_row.revision<>p_expected_revision THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='catalog_revision_conflict'; END IF;
  IF p_deleted = (catalog_row.deleted_at IS NOT NULL) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='catalog_delete_state_conflict'; END IF;
  IF p_deleted AND p_entity_kind='resource' THEN
    PERFORM 1 FROM public.design_resources WHERE id=p_entity_id FOR UPDATE;
  END IF;
  IF p_deleted AND (
    (p_entity_kind='resource' AND (
      EXISTS(SELECT 1 FROM public.design_document_asset_refs WHERE resource_id=p_entity_id)
      OR EXISTS(SELECT 1 FROM public.design_template_asset_refs WHERE resource_id=p_entity_id)
    ))
    OR (p_entity_kind='font_face' AND (
      EXISTS(SELECT 1 FROM public.design_document_font_refs WHERE font_face_id=p_entity_id)
      OR EXISTS(SELECT 1 FROM public.design_template_font_refs WHERE font_face_id=p_entity_id)
      OR EXISTS(SELECT 1 FROM public.text_preset_font_refs WHERE font_face_id=p_entity_id)
    ))
    OR (p_entity_kind='font_family' AND EXISTS(
      SELECT 1 FROM public.font_faces WHERE family_id=p_entity_id AND deleted_at IS NULL
    ))
    OR (p_entity_kind='category' AND (
      EXISTS(SELECT 1 FROM public.design_resources WHERE category_id=p_entity_id AND deleted_at IS NULL)
      OR EXISTS(SELECT 1 FROM public.design_templates WHERE category_id=p_entity_id AND deleted_at IS NULL)
      OR EXISTS(SELECT 1 FROM public.text_presets WHERE category_id=p_entity_id AND deleted_at IS NULL)
      OR EXISTS(SELECT 1 FROM public.resource_categories WHERE parent_id=p_entity_id AND deleted_at IS NULL)
    ))
    OR (p_entity_kind='tag' AND (
      EXISTS(SELECT 1 FROM public.resource_tag_links WHERE tag_id=p_entity_id)
      OR EXISTS(SELECT 1 FROM public.design_template_tag_links WHERE tag_id=p_entity_id)
      OR EXISTS(SELECT 1 FROM public.text_preset_tag_links WHERE tag_id=p_entity_id)
    ))
  ) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='catalog_entity_in_use'; END IF;
  new_status:=CASE WHEN p_deleted THEN catalog_row.status ELSE 'draft' END;
  CASE p_entity_kind
    WHEN 'resource' THEN UPDATE public.design_resources SET deleted_at=CASE WHEN p_deleted THEN now() ELSE NULL END,deleted_by=CASE WHEN p_deleted THEN p_actor_user_id ELSE NULL END,status=new_status,revision=revision+1,updated_by=p_actor_user_id WHERE id=p_entity_id AND revision=p_expected_revision RETURNING revision INTO new_revision;
    WHEN 'template' THEN UPDATE public.design_templates SET deleted_at=CASE WHEN p_deleted THEN now() ELSE NULL END,deleted_by=CASE WHEN p_deleted THEN p_actor_user_id ELSE NULL END,status=new_status,revision=revision+1,updated_by=p_actor_user_id WHERE id=p_entity_id AND revision=p_expected_revision RETURNING revision INTO new_revision;
    WHEN 'text_preset' THEN UPDATE public.text_presets SET deleted_at=CASE WHEN p_deleted THEN now() ELSE NULL END,deleted_by=CASE WHEN p_deleted THEN p_actor_user_id ELSE NULL END,status=new_status,revision=revision+1,updated_by=p_actor_user_id WHERE id=p_entity_id AND revision=p_expected_revision RETURNING revision INTO new_revision;
    WHEN 'font_family' THEN UPDATE public.font_families SET deleted_at=CASE WHEN p_deleted THEN now() ELSE NULL END,deleted_by=CASE WHEN p_deleted THEN p_actor_user_id ELSE NULL END,status=new_status,revision=revision+1,updated_by=p_actor_user_id WHERE id=p_entity_id AND revision=p_expected_revision RETURNING revision INTO new_revision;
    WHEN 'font_face' THEN UPDATE public.font_faces SET deleted_at=CASE WHEN p_deleted THEN now() ELSE NULL END,deleted_by=CASE WHEN p_deleted THEN p_actor_user_id ELSE NULL END,status=new_status,revision=revision+1,updated_by=p_actor_user_id WHERE id=p_entity_id AND revision=p_expected_revision RETURNING revision INTO new_revision;
    WHEN 'category' THEN UPDATE public.resource_categories SET deleted_at=CASE WHEN p_deleted THEN now() ELSE NULL END,deleted_by=CASE WHEN p_deleted THEN p_actor_user_id ELSE NULL END,status=new_status,revision=revision+1,updated_by=p_actor_user_id WHERE id=p_entity_id AND revision=p_expected_revision RETURNING revision INTO new_revision;
    WHEN 'tag' THEN UPDATE public.resource_tags SET deleted_at=CASE WHEN p_deleted THEN now() ELSE NULL END,deleted_by=CASE WHEN p_deleted THEN p_actor_user_id ELSE NULL END,status=new_status,revision=revision+1,updated_by=p_actor_user_id WHERE id=p_entity_id AND revision=p_expected_revision RETURNING revision INTO new_revision;
    ELSE RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='catalog_entity_kind_invalid';
  END CASE;
  IF new_revision IS NULL THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='catalog_revision_conflict'; END IF;
  result_value:=jsonb_build_object('entity_kind',p_entity_kind,'entity_id',p_entity_id,'revision',new_revision,'status',new_status,'replayed',false);
  UPDATE public.catalog_mutation_requests SET result=result_value,completed_at=now() WHERE actor_user_id=p_actor_user_id AND request_id=p_request_id;
  RETURN result_value;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_resource_favorite_set(p_resource_id uuid,p_favorite boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE user_id_value uuid := auth.uid(); resource_row public.design_resources%ROWTYPE;
BEGIN
  IF auth.role()<>'authenticated' OR user_id_value IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='authentication_required'; END IF;
  SELECT * INTO resource_row FROM public.design_resources WHERE id=p_resource_id FOR KEY SHARE;
  IF resource_row.id IS NULL OR NOT private.can_read_design_catalog_record(resource_row.scope,resource_row.workspace_id,resource_row.status,resource_row.deleted_at)
  THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='resource_not_available'; END IF;
  IF p_favorite THEN INSERT INTO public.resource_favorites(user_id,resource_id) VALUES(user_id_value,p_resource_id) ON CONFLICT DO NOTHING;
  ELSE DELETE FROM public.resource_favorites WHERE user_id=user_id_value AND resource_id=p_resource_id; END IF;
  RETURN jsonb_build_object('resource_id',p_resource_id,'favorite',p_favorite);
END; $$;

CREATE OR REPLACE FUNCTION public.loomic_record_resource_recent_use(p_resource_id uuid,p_workspace_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE user_id_value uuid := auth.uid(); row_value public.resource_recent_uses%ROWTYPE; resource_row public.design_resources%ROWTYPE;
BEGIN
  IF auth.role()<>'authenticated' OR user_id_value IS NULL OR NOT private.is_workspace_member(p_workspace_id)
  THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='resource_recent_forbidden'; END IF;
  SELECT * INTO resource_row FROM public.design_resources WHERE id=p_resource_id FOR KEY SHARE;
  IF resource_row.id IS NULL OR resource_row.status<>'published'
    OR NOT private.can_read_design_catalog_record(resource_row.scope,resource_row.workspace_id,resource_row.status,resource_row.deleted_at)
    OR (resource_row.scope='workspace' AND resource_row.workspace_id IS DISTINCT FROM p_workspace_id)
  THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='resource_not_available'; END IF;
  INSERT INTO public.resource_recent_uses(user_id,resource_id,workspace_id,used_at,use_count)
  VALUES(user_id_value,p_resource_id,p_workspace_id,now(),1)
  ON CONFLICT(user_id,resource_id,workspace_id) DO UPDATE SET used_at=now(),use_count=public.resource_recent_uses.use_count+1
  RETURNING * INTO row_value;
  RETURN jsonb_build_object('resource_id',row_value.resource_id,'workspace_id',row_value.workspace_id,'used_at',row_value.used_at,'use_count',row_value.use_count);
END; $$;

CREATE OR REPLACE FUNCTION public.loomic_resource_import_create(
  p_request_id uuid,p_scope text,p_workspace_id uuid,p_source_kind text,p_source jsonb,p_actor_user_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE request_hash text; request_row public.catalog_mutation_requests%ROWTYPE; new_id uuid:=extensions.gen_random_uuid(); item_count integer; result_value jsonb;
BEGIN
  PERFORM private.loomic_assert_catalog_actor(p_scope,p_workspace_id,p_actor_user_id);
  IF p_source_kind NOT IN ('local_upload','url','manifest') OR jsonb_typeof(p_source)<>'object' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='resource_import_source_invalid'; END IF;
  IF p_source_kind='local_upload' THEN
    IF NOT private.loomic_jsonb_object_has_only_keys(p_source,ARRAY['asset_object_ids']) OR jsonb_typeof(p_source->'asset_object_ids')<>'array'
    THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='resource_import_source_invalid'; END IF;
    item_count:=jsonb_array_length(p_source->'asset_object_ids');
  ELSIF p_source_kind='url' THEN
    IF NOT private.loomic_jsonb_object_has_only_keys(p_source,ARRAY['source_urls']) OR jsonb_typeof(p_source->'source_urls')<>'array'
      OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_source->'source_urls') u WHERE u !~ '^https?://')
    THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='resource_import_source_invalid'; END IF;
    item_count:=jsonb_array_length(p_source->'source_urls');
  ELSE
    IF NOT private.loomic_jsonb_object_has_only_keys(p_source,ARRAY['manifest_asset_object_id'])
    THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='resource_import_source_invalid'; END IF;
    item_count:=CASE WHEN private.try_parse_uuid(p_source->>'manifest_asset_object_id') IS NULL THEN 0 ELSE 1 END;
  END IF;
  IF item_count NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='resource_import_item_count_invalid'; END IF;
  request_hash:=md5(jsonb_build_object('scope',p_scope,'workspace',p_workspace_id,'source_kind',p_source_kind,'source',p_source)::text);
  INSERT INTO public.catalog_mutation_requests(actor_user_id,request_id,operation,entity_kind,input_hash) VALUES(p_actor_user_id,p_request_id,'import_create','import_job',request_hash) ON CONFLICT DO NOTHING;
  SELECT * INTO request_row FROM public.catalog_mutation_requests WHERE actor_user_id=p_actor_user_id AND request_id=p_request_id FOR UPDATE;
  IF request_row.operation<>'import_create' OR request_row.entity_kind<>'import_job' OR request_row.input_hash<>request_hash THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='catalog_idempotency_conflict'; END IF;
  IF request_row.result IS NOT NULL THEN RETURN jsonb_set(request_row.result,'{replayed}','true'::jsonb,true); END IF;
  INSERT INTO public.resource_import_jobs(id,scope,workspace_id,source_kind,source,total_items,created_by,request_id,input_hash)
  VALUES(new_id,p_scope,p_workspace_id,p_source_kind,p_source,item_count,p_actor_user_id,p_request_id,request_hash);
  IF p_source_kind='local_upload' THEN
    INSERT INTO public.resource_import_items(import_job_id,source_key,asset_object_id)
    SELECT new_id,value,value::uuid FROM jsonb_array_elements_text(p_source->'asset_object_ids');
  ELSIF p_source_kind='url' THEN
    INSERT INTO public.resource_import_items(import_job_id,source_key)
    SELECT new_id,value FROM jsonb_array_elements_text(p_source->'source_urls');
  ELSE
    INSERT INTO public.resource_import_items(import_job_id,source_key,asset_object_id)
    VALUES(new_id,p_source->>'manifest_asset_object_id',(p_source->>'manifest_asset_object_id')::uuid);
  END IF;
  result_value:=jsonb_build_object('import_job_id',new_id,'status','queued','replayed',false);
  UPDATE public.catalog_mutation_requests SET entity_id=new_id,result=result_value,completed_at=now() WHERE actor_user_id=p_actor_user_id AND request_id=p_request_id;
  RETURN result_value;
END; $$;

CREATE OR REPLACE FUNCTION public.loomic_resource_import_claim(p_claim_token uuid,p_limit integer DEFAULT 10)
RETURNS SETOF public.resource_import_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='service_role_required'; END IF;
  IF p_claim_token IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='resource_import_claim_invalid'; END IF;
  RETURN QUERY WITH candidates AS (
    SELECT id FROM public.resource_import_jobs WHERE attempt_count<3 AND (
      (status='queued' AND available_at<=now()) OR (status='running' AND claimed_at<now()-interval '5 minutes')
    ) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT p_limit
  ), updated AS (
    UPDATE public.resource_import_jobs j SET status='running',started_at=COALESCE(started_at,now()),claimed_at=now(),claim_token=p_claim_token,attempt_count=attempt_count+1
    FROM candidates c WHERE j.id=c.id RETURNING j.*
  ) SELECT * FROM updated;
END; $$;

CREATE OR REPLACE FUNCTION public.loomic_resource_import_finalize_item(
  p_import_job_id uuid,p_item_id uuid,p_status text,p_result_entity_kind text,p_result_entity_id uuid,
  p_asset_object_id uuid,p_error_code text,p_error_message text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item_row public.resource_import_items%ROWTYPE; job_row public.resource_import_jobs%ROWTYPE; result_row record; completed_count integer; failed_count integer; pending_count integer;
BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='service_role_required'; END IF;
  IF p_status NOT IN ('imported','duplicate','failed','rejected') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='resource_import_item_status_invalid'; END IF;
  SELECT * INTO item_row FROM public.resource_import_items WHERE id=p_item_id AND import_job_id=p_import_job_id FOR UPDATE;
  IF item_row.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='resource_import_item_not_found'; END IF;
  IF item_row.status IN ('imported','duplicate','failed','rejected') THEN RETURN jsonb_build_object('item_id',item_row.id,'status',item_row.status,'replayed',true); END IF;
  SELECT * INTO job_row FROM public.resource_import_jobs WHERE id=p_import_job_id FOR UPDATE;
  IF p_status IN ('imported','duplicate') THEN
    IF p_result_entity_kind IS NULL OR p_result_entity_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='resource_import_result_required'; END IF;
    SELECT * INTO result_row FROM private.loomic_catalog_record(p_result_entity_kind,p_result_entity_id);
    IF result_row IS NULL OR result_row.deleted_at IS NOT NULL OR result_row.scope IS DISTINCT FROM job_row.scope
      OR result_row.workspace_id IS DISTINCT FROM job_row.workspace_id
    THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='resource_import_result_scope_mismatch'; END IF;
  ELSIF p_result_entity_kind IS NOT NULL OR p_result_entity_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='resource_import_result_invalid';
  END IF;
  UPDATE public.resource_import_items SET status=p_status,result_entity_kind=p_result_entity_kind,result_entity_id=p_result_entity_id,
    resource_id=CASE WHEN p_result_entity_kind='resource' THEN p_result_entity_id ELSE NULL END,
    asset_object_id=COALESCE(p_asset_object_id,asset_object_id),error_code=p_error_code,error_message=p_error_message,
    attempt_count=attempt_count+1,completed_at=now() WHERE id=p_item_id;
  SELECT count(*) FILTER(WHERE status IN ('imported','duplicate')),count(*) FILTER(WHERE status IN ('failed','rejected')),
    count(*) FILTER(WHERE status IN ('pending','running')) INTO completed_count,failed_count,pending_count
  FROM public.resource_import_items WHERE import_job_id=p_import_job_id;
  UPDATE public.resource_import_jobs SET completed_items=completed_count,failed_items=failed_count,
    status=CASE WHEN pending_count=0 AND failed_count>0 THEN 'failed' WHEN pending_count=0 THEN 'completed' ELSE status END,
    completed_at=CASE WHEN pending_count=0 THEN now() ELSE NULL END,
    claimed_at=CASE WHEN pending_count=0 THEN NULL ELSE claimed_at END,claim_token=CASE WHEN pending_count=0 THEN NULL ELSE claim_token END
  WHERE id=p_import_job_id RETURNING * INTO job_row;
  RETURN jsonb_build_object('item_id',p_item_id,'status',p_status,'job_status',job_row.status,'replayed',false);
END; $$;

REVOKE ALL ON FUNCTION public.loomic_catalog_create(uuid,text,text,uuid,jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.loomic_catalog_update(uuid,text,uuid,bigint,jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.loomic_catalog_set_status(uuid,text,uuid,bigint,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.loomic_catalog_set_deleted(uuid,text,uuid,bigint,boolean,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.loomic_resource_favorite_set(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.loomic_record_resource_recent_use(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.loomic_resource_import_create(uuid,text,uuid,text,jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.loomic_resource_import_claim(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.loomic_resource_import_finalize_item(uuid,uuid,text,text,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.loomic_catalog_create(uuid,text,text,uuid,jsonb,uuid),
  public.loomic_catalog_update(uuid,text,uuid,bigint,jsonb,uuid),
  public.loomic_catalog_set_status(uuid,text,uuid,bigint,text,uuid),
  public.loomic_catalog_set_deleted(uuid,text,uuid,bigint,boolean,uuid),
  public.loomic_resource_import_create(uuid,text,uuid,text,jsonb,uuid),
  public.loomic_resource_import_claim(uuid,integer),
  public.loomic_resource_import_finalize_item(uuid,uuid,text,text,uuid,uuid,text,text)
TO service_role;
GRANT EXECUTE ON FUNCTION public.loomic_resource_favorite_set(uuid,boolean),
  public.loomic_record_resource_recent_use(uuid,uuid) TO authenticated;

COMMIT;
