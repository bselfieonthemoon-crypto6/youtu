-- Loomic native design board: additive database foundation.
-- This migration intentionally keeps existing canvas/media APIs compatible while
-- introducing the durable design, catalog, command, outbox and GC contracts.

-- ---------------------------------------------------------------------------
-- Shared authorization helpers and backwards-compatible core-table extensions
-- ---------------------------------------------------------------------------

CREATE TABLE public.platform_admins (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT platform_admins_active_state_check CHECK (
    (is_active AND revoked_at IS NULL) OR (NOT is_active)
  )
);

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_admins FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_admins FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.is_platform_admin(p_user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_user_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.platform_admins pa
    WHERE pa.user_id = p_user_id
      AND pa.is_active
      AND pa.revoked_at IS NULL
  );
$$;

REVOKE ALL ON FUNCTION private.is_platform_admin(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.is_platform_admin(uuid) TO authenticated, service_role;

ALTER TABLE public.canvases
  ADD COLUMN IF NOT EXISTS workspace_id uuid,
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0;

UPDATE public.canvases c
SET workspace_id = p.workspace_id
FROM public.projects p
WHERE p.id = c.project_id
  AND c.workspace_id IS NULL;

CREATE OR REPLACE FUNCTION private.set_canvas_workspace_and_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  resolved_workspace_id uuid;
BEGIN
  SELECT p.workspace_id
  INTO resolved_workspace_id
  FROM public.projects p
  WHERE p.id = NEW.project_id;

  IF resolved_workspace_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'canvas_project_not_found';
  END IF;

  IF NEW.workspace_id IS NOT NULL AND NEW.workspace_id IS DISTINCT FROM resolved_workspace_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'canvas_workspace_mismatch';
  END IF;

  NEW.workspace_id := resolved_workspace_id;
  IF TG_OP = 'UPDATE' AND NEW.revision = OLD.revision THEN
    NEW.revision := OLD.revision + 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS canvases_set_workspace_and_revision ON public.canvases;
CREATE TRIGGER canvases_set_workspace_and_revision
BEFORE INSERT OR UPDATE OF project_id, workspace_id, content, name, is_primary, revision
ON public.canvases
FOR EACH ROW EXECUTE FUNCTION private.set_canvas_workspace_and_revision();

ALTER TABLE public.canvases
  ALTER COLUMN workspace_id SET NOT NULL,
  DROP CONSTRAINT IF EXISTS canvases_project_workspace_fkey,
  ADD CONSTRAINT canvases_project_workspace_fkey
    FOREIGN KEY (project_id, workspace_id)
    REFERENCES public.projects(id, workspace_id)
    ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS canvases_id_workspace_id_key
  ON public.canvases(id, workspace_id);
CREATE INDEX IF NOT EXISTS canvases_workspace_id_idx
  ON public.canvases(workspace_id);

ALTER TABLE public.asset_objects
  ADD COLUMN IF NOT EXISTS scope text,
  ADD COLUMN IF NOT EXISTS gc_eligible_at timestamptz,
  ADD COLUMN IF NOT EXISTS gc_claim_token uuid,
  ADD COLUMN IF NOT EXISTS gc_claimed_at timestamptz;

UPDATE public.asset_objects
SET scope = 'workspace'
WHERE scope IS NULL;

ALTER TABLE public.asset_objects
  ALTER COLUMN scope SET DEFAULT 'workspace',
  ALTER COLUMN scope SET NOT NULL,
  ALTER COLUMN workspace_id DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS asset_objects_bucket_check,
  DROP CONSTRAINT IF EXISTS asset_objects_scope_workspace_check,
  ADD CONSTRAINT asset_objects_bucket_check
    CHECK (bucket IN ('project-assets', 'workspace-assets', 'user-avatars', 'platform-assets')),
  ADD CONSTRAINT asset_objects_scope_workspace_check CHECK (
    (scope = 'platform' AND workspace_id IS NULL AND project_id IS NULL AND bucket = 'platform-assets')
    OR
    (scope = 'workspace' AND workspace_id IS NOT NULL AND bucket <> 'platform-assets')
  );

CREATE INDEX IF NOT EXISTS asset_objects_scope_workspace_idx
  ON public.asset_objects(scope, workspace_id);
CREATE INDEX IF NOT EXISTS asset_objects_gc_eligible_idx
  ON public.asset_objects(gc_eligible_at)
  WHERE gc_eligible_at IS NOT NULL;

INSERT INTO storage.buckets (id, name, public)
VALUES ('platform-assets', 'platform-assets', false)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name, public = false;

-- Platform storage is delivered through the authenticated content service.
-- No browser INSERT/UPDATE/DELETE policies are deliberately created here.
DROP POLICY IF EXISTS "platform_assets_select_public" ON storage.objects;
DROP POLICY IF EXISTS "platform_assets_insert_authenticated" ON storage.objects;
DROP POLICY IF EXISTS "platform_assets_update_authenticated" ON storage.objects;
DROP POLICY IF EXISTS "platform_assets_delete_authenticated" ON storage.objects;

-- ---------------------------------------------------------------------------
-- Design documents, node bindings, command history and references
-- ---------------------------------------------------------------------------

CREATE TABLE public.design_documents (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  scene jsonb NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  engine_version text NOT NULL DEFAULT 'fabric@7.4.0'
    CHECK (char_length(btrim(engine_version)) BETWEEN 1 AND 80),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 32768),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 32768),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  preview_asset_object_id uuid REFERENCES public.asset_objects(id) ON DELETE RESTRICT,
  preview_revision bigint NOT NULL DEFAULT 0,
  preview_status text NOT NULL DEFAULT 'missing'
    CHECK (preview_status IN ('missing', 'stale', 'queued', 'ready', 'error')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at timestamptz,
  purge_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT design_documents_project_workspace_fkey
    FOREIGN KEY (project_id, workspace_id)
    REFERENCES public.projects(id, workspace_id)
    ON DELETE CASCADE,
  CONSTRAINT design_documents_scene_shape_check CHECK (
    jsonb_typeof(scene) = 'object'
    AND scene->>'engine' = 'fabric'
    AND jsonb_typeof(scene->'canvas') = 'object'
    AND jsonb_typeof(scene->'objects') = 'array'
  ),
  CONSTRAINT design_documents_preview_state_check CHECK (
    preview_revision >= 0
    AND preview_revision <= revision
    AND (
      (preview_status = 'missing'
        AND preview_asset_object_id IS NULL AND preview_revision = 0)
      OR (preview_status = 'ready'
        AND preview_asset_object_id IS NOT NULL AND preview_revision = revision)
      OR (preview_status = 'stale'
        AND preview_asset_object_id IS NOT NULL AND preview_revision < revision)
      OR (preview_status IN ('queued', 'error') AND (
        (preview_asset_object_id IS NOT NULL AND preview_revision < revision)
        OR (preview_asset_object_id IS NULL AND preview_revision = 0)
      ))
    )
  ),
  CONSTRAINT design_documents_soft_delete_check CHECK (
    (deleted_at IS NULL AND purge_after IS NULL)
    OR (deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purge_after >= deleted_at)
  ),
  CONSTRAINT design_documents_id_workspace_id_key UNIQUE (id, workspace_id)
);

CREATE INDEX design_documents_workspace_updated_idx
  ON public.design_documents(workspace_id, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX design_documents_project_updated_idx
  ON public.design_documents(project_id, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX design_documents_purge_after_idx
  ON public.design_documents(purge_after)
  WHERE deleted_at IS NOT NULL;

CREATE TRIGGER design_documents_set_updated_at
BEFORE UPDATE ON public.design_documents
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.design_creation_requests (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  canvas_id uuid NOT NULL,
  design_id uuid REFERENCES public.design_documents(id) ON DELETE SET NULL,
  canvas_element_id text NOT NULL CHECK (char_length(canvas_element_id) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed')),
  response jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT design_creation_requests_canvas_workspace_fkey
    FOREIGN KEY (canvas_id, workspace_id)
    REFERENCES public.canvases(id, workspace_id)
    ON DELETE CASCADE,
  CONSTRAINT design_creation_requests_idempotency_key
    UNIQUE (workspace_id, created_by, request_id)
);

CREATE INDEX design_creation_requests_design_idx
  ON public.design_creation_requests(design_id)
  WHERE design_id IS NOT NULL;

CREATE TABLE public.design_nodes (
  canvas_id uuid NOT NULL,
  element_id text NOT NULL CHECK (char_length(element_id) BETWEEN 1 AND 200),
  design_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (canvas_id, element_id),
  CONSTRAINT design_nodes_canvas_workspace_fkey
    FOREIGN KEY (canvas_id, workspace_id)
    REFERENCES public.canvases(id, workspace_id)
    ON DELETE CASCADE,
  CONSTRAINT design_nodes_design_workspace_fkey
    FOREIGN KEY (design_id, workspace_id)
    REFERENCES public.design_documents(id, workspace_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX design_nodes_one_live_node_per_design_key
  ON public.design_nodes(design_id)
  WHERE deleted_at IS NULL;
CREATE INDEX design_nodes_workspace_idx
  ON public.design_nodes(workspace_id, updated_at DESC);

CREATE TRIGGER design_nodes_set_updated_at
BEFORE UPDATE ON public.design_nodes
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.design_document_versions (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  design_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  parent_revision bigint CHECK (parent_revision IS NULL OR parent_revision >= 0),
  command_batch jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(command_batch) = 'array'),
  changed_object_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  snapshot jsonb,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'agent', 'system', 'job')),
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  agent_run_id uuid REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  tool_execution_id uuid REFERENCES public.tool_executions(id) ON DELETE SET NULL,
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT design_document_versions_design_workspace_fkey
    FOREIGN KEY (design_id, workspace_id)
    REFERENCES public.design_documents(id, workspace_id)
    ON DELETE CASCADE,
  CONSTRAINT design_document_versions_revision_key UNIQUE (design_id, revision),
  CONSTRAINT design_document_versions_idempotency_key UNIQUE (design_id, idempotency_key),
  CONSTRAINT design_document_versions_parent_fkey
    FOREIGN KEY (design_id, parent_revision)
    REFERENCES public.design_document_versions(design_id, revision)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT design_document_versions_snapshot_check CHECK (
    snapshot IS NULL OR jsonb_typeof(snapshot) = 'object'
  )
);

CREATE INDEX design_document_versions_design_created_idx
  ON public.design_document_versions(design_id, created_at DESC);

CREATE TABLE public.design_document_asset_refs (
  design_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  object_id text NOT NULL CHECK (char_length(object_id) BETWEEN 1 AND 200),
  slot text NOT NULL DEFAULT 'source' CHECK (char_length(slot) BETWEEN 1 AND 80),
  asset_object_id uuid NOT NULL REFERENCES public.asset_objects(id) ON DELETE RESTRICT,
  resource_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (design_id, object_id, slot),
  CONSTRAINT design_document_asset_refs_design_workspace_fkey
    FOREIGN KEY (design_id, workspace_id)
    REFERENCES public.design_documents(id, workspace_id)
    ON DELETE CASCADE
);

CREATE INDEX design_document_asset_refs_asset_idx
  ON public.design_document_asset_refs(asset_object_id);

CREATE TABLE public.design_document_font_refs (
  design_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  object_id text NOT NULL CHECK (char_length(object_id) BETWEEN 1 AND 200),
  font_face_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (design_id, object_id, font_face_id),
  CONSTRAINT design_document_font_refs_design_workspace_fkey
    FOREIGN KEY (design_id, workspace_id)
    REFERENCES public.design_documents(id, workspace_id)
    ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Platform/workspace catalog, templates, fonts, taxonomies and imports
-- ---------------------------------------------------------------------------

CREATE TABLE public.font_families (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('platform', 'workspace')),
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_review', 'published', 'rejected', 'disabled')),
  source_url text,
  author text,
  license_name text,
  license_url text,
  attribution text,
  usage_restrictions text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT font_families_scope_workspace_check CHECK (
    (scope = 'platform' AND workspace_id IS NULL)
    OR (scope = 'workspace' AND workspace_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX font_families_live_name_key
  ON public.font_families(scope, COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  WHERE deleted_at IS NULL;

CREATE TABLE public.font_faces (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES public.font_families(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('platform', 'workspace')),
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  asset_object_id uuid NOT NULL REFERENCES public.asset_objects(id) ON DELETE RESTRICT,
  style text NOT NULL DEFAULT 'normal' CHECK (style IN ('normal', 'italic', 'oblique')),
  weight integer NOT NULL DEFAULT 400 CHECK (weight BETWEEN 1 AND 1000),
  format text NOT NULL CHECK (format IN ('woff2', 'woff', 'ttf', 'otf')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_review', 'published', 'rejected', 'disabled')),
  checksum_sha256 text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT font_faces_scope_workspace_check CHECK (
    (scope = 'platform' AND workspace_id IS NULL)
    OR (scope = 'workspace' AND workspace_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX font_faces_live_variant_key
  ON public.font_faces(family_id, style, weight)
  WHERE deleted_at IS NULL;
CREATE INDEX font_faces_asset_idx ON public.font_faces(asset_object_id);

ALTER TABLE public.design_document_font_refs
  ADD CONSTRAINT design_document_font_refs_font_face_fkey
  FOREIGN KEY (font_face_id) REFERENCES public.font_faces(id) ON DELETE RESTRICT;

CREATE TABLE public.design_templates (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('platform', 'workspace')),
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  description text,
  scene jsonb NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  engine_version text NOT NULL DEFAULT 'fabric@7.4.0',
  width integer NOT NULL CHECK (width BETWEEN 1 AND 32768),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 32768),
  preview_asset_object_id uuid REFERENCES public.asset_objects(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_review', 'published', 'rejected', 'disabled')),
  source_url text,
  author text,
  license_name text,
  license_url text,
  attribution text,
  usage_restrictions text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  published_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  published_at timestamptz,
  deleted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT design_templates_scope_workspace_check CHECK (
    (scope = 'platform' AND workspace_id IS NULL)
    OR (scope = 'workspace' AND workspace_id IS NOT NULL)
  ),
  CONSTRAINT design_templates_scene_shape_check CHECK (
    jsonb_typeof(scene) = 'object'
    AND scene->>'engine' = 'fabric'
    AND jsonb_typeof(scene->'objects') = 'array'
  )
);

CREATE UNIQUE INDEX design_templates_live_name_key
  ON public.design_templates(scope, COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  WHERE deleted_at IS NULL;
CREATE INDEX design_templates_catalog_idx
  ON public.design_templates(scope, workspace_id, status, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TRIGGER design_templates_set_updated_at
BEFORE UPDATE ON public.design_templates
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.design_template_asset_refs (
  template_id uuid NOT NULL REFERENCES public.design_templates(id) ON DELETE CASCADE,
  object_id text NOT NULL CHECK (char_length(object_id) BETWEEN 1 AND 200),
  slot text NOT NULL DEFAULT 'source' CHECK (char_length(slot) BETWEEN 1 AND 80),
  asset_object_id uuid NOT NULL REFERENCES public.asset_objects(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, object_id, slot)
);

CREATE INDEX design_template_asset_refs_asset_idx
  ON public.design_template_asset_refs(asset_object_id);

CREATE TABLE public.text_presets (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('platform', 'workspace')),
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  style jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(style) = 'object'),
  font_face_id uuid REFERENCES public.font_faces(id) ON DELETE SET NULL,
  preview_asset_object_id uuid REFERENCES public.asset_objects(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_review', 'published', 'rejected', 'disabled')),
  source_url text,
  author text,
  license_name text,
  usage_restrictions text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT text_presets_scope_workspace_check CHECK (
    (scope = 'platform' AND workspace_id IS NULL)
    OR (scope = 'workspace' AND workspace_id IS NOT NULL)
  )
);

CREATE INDEX text_presets_catalog_idx
  ON public.text_presets(scope, workspace_id, status, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TRIGGER text_presets_set_updated_at
BEFORE UPDATE ON public.text_presets
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.design_resources (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('platform', 'workspace')),
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('image', 'svg', 'illustration', 'icon', 'background', 'mockup')),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  description text,
  asset_object_id uuid NOT NULL REFERENCES public.asset_objects(id) ON DELETE RESTRICT,
  preview_asset_object_id uuid REFERENCES public.asset_objects(id) ON DELETE RESTRICT,
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  checksum_sha256 text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_review', 'published', 'rejected', 'disabled')),
  source_url text,
  author text,
  license_name text,
  license_url text,
  attribution text,
  usage_restrictions text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  published_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  published_at timestamptz,
  deleted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT design_resources_scope_workspace_check CHECK (
    (scope = 'platform' AND workspace_id IS NULL)
    OR (scope = 'workspace' AND workspace_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX design_resources_live_checksum_key
  ON public.design_resources(scope, COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), checksum_sha256)
  WHERE deleted_at IS NULL AND checksum_sha256 IS NOT NULL;
CREATE INDEX design_resources_catalog_idx
  ON public.design_resources(scope, workspace_id, status, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX design_resources_asset_idx ON public.design_resources(asset_object_id);

CREATE TRIGGER design_resources_set_updated_at
BEFORE UPDATE ON public.design_resources
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.resource_categories (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('platform', 'workspace')),
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES public.resource_categories(id) ON DELETE SET NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  slug text NOT NULL CHECK (char_length(btrim(slug)) BETWEEN 1 AND 120),
  sort_order integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_review', 'published', 'rejected', 'disabled')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resource_categories_scope_workspace_check CHECK (
    (scope = 'platform' AND workspace_id IS NULL)
    OR (scope = 'workspace' AND workspace_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX resource_categories_live_slug_key
  ON public.resource_categories(scope, COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), slug)
  WHERE deleted_at IS NULL;

CREATE TABLE public.resource_tags (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('platform', 'workspace')),
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  slug text NOT NULL CHECK (char_length(btrim(slug)) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_review', 'published', 'rejected', 'disabled')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resource_tags_scope_workspace_check CHECK (
    (scope = 'platform' AND workspace_id IS NULL)
    OR (scope = 'workspace' AND workspace_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX resource_tags_live_slug_key
  ON public.resource_tags(scope, COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), slug)
  WHERE deleted_at IS NULL;

CREATE TABLE public.resource_tag_links (
  resource_id uuid NOT NULL REFERENCES public.design_resources(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES public.resource_tags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_id, tag_id)
);

ALTER TABLE public.design_resources
  ADD COLUMN category_id uuid REFERENCES public.resource_categories(id) ON DELETE SET NULL;

CREATE INDEX design_resources_category_idx
  ON public.design_resources(category_id)
  WHERE category_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE public.resource_favorites (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES public.design_resources(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, resource_id)
);

CREATE INDEX resource_favorites_user_created_idx
  ON public.resource_favorites(user_id, created_at DESC);

CREATE TABLE public.resource_recent_uses (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES public.design_resources(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  used_at timestamptz NOT NULL DEFAULT now(),
  use_count bigint NOT NULL DEFAULT 1 CHECK (use_count > 0),
  PRIMARY KEY (user_id, resource_id, workspace_id)
);

CREATE INDEX resource_recent_uses_user_used_idx
  ON public.resource_recent_uses(user_id, workspace_id, used_at DESC);

CREATE TABLE public.resource_import_jobs (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('platform', 'workspace')),
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK (source_kind IN ('local_upload', 'url', 'manifest')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'canceled')),
  source jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source) = 'object'),
  total_items integer NOT NULL DEFAULT 0 CHECK (total_items >= 0),
  completed_items integer NOT NULL DEFAULT 0 CHECK (completed_items >= 0),
  failed_items integer NOT NULL DEFAULT 0 CHECK (failed_items >= 0),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT resource_import_jobs_scope_workspace_check CHECK (
    (scope = 'platform' AND workspace_id IS NULL)
    OR (scope = 'workspace' AND workspace_id IS NOT NULL)
  )
);

CREATE TABLE public.resource_import_items (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  import_job_id uuid NOT NULL REFERENCES public.resource_import_jobs(id) ON DELETE CASCADE,
  source_key text NOT NULL CHECK (char_length(btrim(source_key)) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'imported', 'duplicate', 'failed', 'rejected')),
  resource_id uuid REFERENCES public.design_resources(id) ON DELETE SET NULL,
  asset_object_id uuid REFERENCES public.asset_objects(id) ON DELETE RESTRICT,
  error_code text,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT resource_import_items_job_source_key UNIQUE (import_job_id, source_key)
);

CREATE INDEX resource_import_items_job_status_idx
  ON public.resource_import_items(import_job_id, status);

CREATE TABLE public.job_target_finalizations (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.background_jobs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  target_kind text NOT NULL CHECK (target_kind IN ('canvas', 'design')),
  target_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'needs_attention', 'failed')),
  command_id uuid NOT NULL,
  result jsonb,
  error_code text,
  error_message text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT job_target_finalizations_target_key UNIQUE (job_id, target_kind, target_id),
  CONSTRAINT job_target_finalizations_command_key UNIQUE (command_id)
);

CREATE INDEX job_target_finalizations_status_idx
  ON public.job_target_finalizations(status, updated_at);

CREATE TRIGGER job_target_finalizations_set_updated_at
BEFORE UPDATE ON public.job_target_finalizations
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.design_event_outbox (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  design_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  event_type text NOT NULL DEFAULT 'design.sync'
    CHECK (event_type IN ('design.sync', 'design.deleted', 'design.restored', 'design.preview')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'publishing', 'published', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claim_token uuid,
  published_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT design_event_outbox_design_workspace_fkey
    FOREIGN KEY (design_id, workspace_id)
    REFERENCES public.design_documents(id, workspace_id)
    ON DELETE CASCADE,
  CONSTRAINT design_event_outbox_design_revision_event_key
    UNIQUE (design_id, revision, event_type)
);

CREATE INDEX design_event_outbox_delivery_idx
  ON public.design_event_outbox(status, available_at, created_at)
  WHERE status IN ('pending', 'failed');

-- Freeze the authoritative target alongside the existing job payload. Legacy
-- rows are backfilled only when they actually have a target; chat-only jobs use
-- a genuine NULL target_kind and NULL target ids.
ALTER TABLE public.background_jobs
  ADD COLUMN IF NOT EXISTS target_kind text,
  ADD COLUMN IF NOT EXISTS design_id uuid REFERENCES public.design_documents(id) ON DELETE SET NULL;

UPDATE public.background_jobs
SET target_kind = CASE
  WHEN design_id IS NOT NULL THEN 'design'
  WHEN canvas_id IS NOT NULL THEN 'canvas'
  ELSE NULL
END
WHERE target_kind IS NULL;

ALTER TABLE public.background_jobs
  ALTER COLUMN target_kind DROP DEFAULT,
  ALTER COLUMN target_kind DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS background_jobs_target_kind_check,
  ADD CONSTRAINT background_jobs_target_kind_check CHECK (
    (target_kind IS NULL AND canvas_id IS NULL AND design_id IS NULL)
    OR (target_kind = 'canvas' AND canvas_id IS NOT NULL AND design_id IS NULL)
    OR (target_kind = 'design' AND design_id IS NOT NULL AND canvas_id IS NULL)
  );

CREATE INDEX IF NOT EXISTS background_jobs_design_id_idx
  ON public.background_jobs(design_id)
  WHERE design_id IS NOT NULL;

ALTER TYPE public.background_job_type ADD VALUE IF NOT EXISTS 'design_preview';
ALTER TYPE public.background_job_type ADD VALUE IF NOT EXISTS 'design_export';
ALTER TYPE public.background_job_type ADD VALUE IF NOT EXISTS 'design_resource_import';

-- ---------------------------------------------------------------------------
-- Scope checks, catalog visibility and reference integrity
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.can_read_design_catalog_record(
  p_scope text,
  p_workspace_id uuid,
  p_status text,
  p_deleted_at timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (SELECT auth.uid()) IS NOT NULL
    AND p_deleted_at IS NULL
    AND (
      (p_scope = 'platform' AND (
        p_status = 'published'
        OR private.is_platform_admin((SELECT auth.uid()))
      ))
      OR
      (p_scope = 'workspace' AND p_workspace_id IS NOT NULL AND (
        (p_status = 'published' AND private.is_workspace_member(p_workspace_id))
        OR private.is_workspace_admin_or_owner(p_workspace_id)
      ))
    );
$$;

CREATE OR REPLACE FUNCTION private.can_manage_design_catalog_record(
  p_scope text,
  p_workspace_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (SELECT auth.uid()) IS NOT NULL
    AND (
      (p_scope = 'platform' AND private.is_platform_admin((SELECT auth.uid())))
      OR
      (p_scope = 'workspace' AND p_workspace_id IS NOT NULL
        AND private.is_workspace_admin_or_owner(p_workspace_id))
    );
$$;

REVOKE ALL ON FUNCTION private.can_read_design_catalog_record(text, uuid, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.can_manage_design_catalog_record(text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.can_read_design_catalog_record(text, uuid, text, timestamptz)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.can_manage_design_catalog_record(text, uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.loomic_scene_objects(p_scene jsonb)
RETURNS TABLE(object_data jsonb)
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  WITH RECURSIVE objects(object_data) AS (
    SELECT value
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(p_scene->'objects') = 'array' THEN p_scene->'objects'
        ELSE '[]'::jsonb
      END
    )
    UNION ALL
    SELECT child.value
    FROM objects parent
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(parent.object_data->'objects') = 'array'
          THEN parent.object_data->'objects'
        ELSE '[]'::jsonb
      END
    ) child
  )
  SELECT object_data FROM objects;
$$;

CREATE OR REPLACE FUNCTION private.loomic_asset_is_usable(
  p_asset_object_id uuid,
  p_workspace_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.asset_objects ao
    WHERE ao.id = p_asset_object_id
      AND ao.deletion_pending_at IS NULL
      AND (
        (ao.scope = 'workspace' AND ao.workspace_id = p_workspace_id)
        OR
        (ao.scope = 'platform' AND (
          EXISTS (
            SELECT 1 FROM public.design_resources r
            WHERE r.deleted_at IS NULL AND r.status = 'published'
              AND (r.asset_object_id = ao.id OR r.preview_asset_object_id = ao.id)
          )
          OR EXISTS (
            SELECT 1 FROM public.font_faces ff
            WHERE ff.deleted_at IS NULL AND ff.status = 'published'
              AND ff.asset_object_id = ao.id
          )
          OR EXISTS (
            SELECT 1 FROM public.design_template_asset_refs tr
            JOIN public.design_templates t ON t.id = tr.template_id
            WHERE tr.asset_object_id = ao.id
              AND t.deleted_at IS NULL AND t.status = 'published'
          )
        ))
      )
  );
$$;

CREATE OR REPLACE FUNCTION private.loomic_font_is_usable(
  p_font_face_id uuid,
  p_workspace_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.font_faces ff
    WHERE ff.id = p_font_face_id
      AND ff.deleted_at IS NULL
      AND (
        (ff.scope = 'workspace' AND ff.workspace_id = p_workspace_id)
        OR (ff.scope = 'platform' AND ff.status = 'published')
      )
  );
$$;

CREATE OR REPLACE FUNCTION private.loomic_sync_design_references(
  p_design_id uuid,
  p_workspace_id uuid,
  p_scene jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  scene_object jsonb;
  object_id text;
  asset_id uuid;
  font_id uuid;
  source_resource_id uuid;
BEGIN
  DELETE FROM public.design_document_asset_refs WHERE design_id = p_design_id;
  DELETE FROM public.design_document_font_refs WHERE design_id = p_design_id;

  FOR scene_object IN SELECT object_data FROM private.loomic_scene_objects(p_scene)
  LOOP
    object_id := NULLIF(btrim(COALESCE(scene_object->>'objectId', '')), '');
    IF object_id IS NULL THEN
      CONTINUE;
    END IF;

    asset_id := private.try_parse_uuid(scene_object->>'assetObjectId');
    IF asset_id IS NOT NULL THEN
      IF NOT private.loomic_asset_is_usable(asset_id, p_workspace_id) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'design_asset_not_available';
      END IF;
      source_resource_id := private.try_parse_uuid(scene_object->>'resourceId');
      INSERT INTO public.design_document_asset_refs(
        design_id, workspace_id, object_id, slot, asset_object_id, resource_id
      ) VALUES (
        p_design_id, p_workspace_id, object_id, 'source', asset_id, source_resource_id
      );
    END IF;

    font_id := private.try_parse_uuid(scene_object->>'fontFaceId');
    IF font_id IS NOT NULL THEN
      IF NOT private.loomic_font_is_usable(font_id, p_workspace_id) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'design_font_not_available';
      END IF;
      INSERT INTO public.design_document_font_refs(
        design_id, workspace_id, object_id, font_face_id
      ) VALUES (p_design_id, p_workspace_id, object_id, font_id);
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION private.loomic_scene_objects(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_asset_is_usable(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_font_is_usable(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_sync_design_references(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.loomic_scene_objects(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION private.loomic_asset_is_usable(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION private.loomic_font_is_usable(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION private.loomic_sync_design_references(uuid, uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION private.validate_design_reference_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  source_resource_scope text;
  source_resource_workspace_id uuid;
  source_resource_status text;
  source_resource_deleted_at timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'design_document_asset_refs' THEN
    IF NOT private.loomic_asset_is_usable(NEW.asset_object_id, NEW.workspace_id) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'design_asset_workspace_mismatch';
    END IF;
    IF NEW.resource_id IS NOT NULL THEN
      SELECT scope, workspace_id, status, deleted_at
      INTO source_resource_scope, source_resource_workspace_id,
        source_resource_status, source_resource_deleted_at
      FROM public.design_resources
      WHERE id = NEW.resource_id;
      IF source_resource_scope IS NULL
        OR source_resource_deleted_at IS NOT NULL
        OR (
          source_resource_scope = 'workspace'
          AND source_resource_workspace_id IS DISTINCT FROM NEW.workspace_id
        )
        OR (source_resource_scope = 'platform' AND source_resource_status <> 'published')
      THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'design_resource_workspace_mismatch';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'design_document_font_refs' THEN
    IF NOT private.loomic_font_is_usable(NEW.font_face_id, NEW.workspace_id) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'design_font_workspace_mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER design_document_asset_refs_validate_scope
BEFORE INSERT OR UPDATE ON public.design_document_asset_refs
FOR EACH ROW EXECUTE FUNCTION private.validate_design_reference_scope();

CREATE TRIGGER design_document_font_refs_validate_scope
BEFORE INSERT OR UPDATE ON public.design_document_font_refs
FOR EACH ROW EXECUTE FUNCTION private.validate_design_reference_scope();

-- ---------------------------------------------------------------------------
-- RLS: members read designs; only controlled RPC/service paths write them.
-- Published catalog rows are readable, while draft rows remain admin-only.
-- ---------------------------------------------------------------------------

ALTER TABLE public.design_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.design_creation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_creation_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.design_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_nodes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.design_document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_document_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.design_document_asset_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_document_asset_refs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.design_document_font_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_document_font_refs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.design_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE public.design_template_asset_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_template_asset_refs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.text_presets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.text_presets FORCE ROW LEVEL SECURITY;
ALTER TABLE public.design_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_resources FORCE ROW LEVEL SECURITY;
ALTER TABLE public.font_families ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.font_families FORCE ROW LEVEL SECURITY;
ALTER TABLE public.font_faces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.font_faces FORCE ROW LEVEL SECURITY;
ALTER TABLE public.resource_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_categories FORCE ROW LEVEL SECURITY;
ALTER TABLE public.resource_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_tags FORCE ROW LEVEL SECURITY;
ALTER TABLE public.resource_tag_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_tag_links FORCE ROW LEVEL SECURITY;
ALTER TABLE public.resource_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_favorites FORCE ROW LEVEL SECURITY;
ALTER TABLE public.resource_recent_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_recent_uses FORCE ROW LEVEL SECURITY;
ALTER TABLE public.resource_import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_import_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.resource_import_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_import_items FORCE ROW LEVEL SECURITY;
ALTER TABLE public.job_target_finalizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_target_finalizations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.design_event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_event_outbox FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "asset_objects_select_member" ON public.asset_objects;
DROP POLICY IF EXISTS "asset_objects_select_authorized" ON public.asset_objects;
CREATE POLICY "asset_objects_select_authorized"
ON public.asset_objects FOR SELECT TO authenticated
USING (
  deletion_pending_at IS NULL
  AND (
    (scope = 'workspace' AND private.is_workspace_member(workspace_id))
    OR (scope = 'platform' AND (
      private.is_platform_admin(auth.uid())
      OR EXISTS (
        SELECT 1 FROM public.design_resources r
        WHERE r.scope = 'platform' AND r.status = 'published'
          AND r.deleted_at IS NULL
          AND (r.asset_object_id = asset_objects.id
            OR r.preview_asset_object_id = asset_objects.id)
      )
      OR EXISTS (
        SELECT 1 FROM public.design_templates t
        WHERE t.scope = 'platform' AND t.status = 'published'
          AND t.deleted_at IS NULL
          AND t.preview_asset_object_id = asset_objects.id
      )
      OR EXISTS (
        SELECT 1
        FROM public.design_template_asset_refs tr
        JOIN public.design_templates t ON t.id = tr.template_id
        WHERE t.scope = 'platform' AND t.status = 'published'
          AND t.deleted_at IS NULL AND tr.asset_object_id = asset_objects.id
      )
      OR EXISTS (
        SELECT 1 FROM public.text_presets tp
        WHERE tp.scope = 'platform' AND tp.status = 'published'
          AND tp.deleted_at IS NULL
          AND tp.preview_asset_object_id = asset_objects.id
      )
      OR EXISTS (
        SELECT 1 FROM public.font_faces ff
        WHERE ff.scope = 'platform' AND ff.status = 'published'
          AND ff.deleted_at IS NULL AND ff.asset_object_id = asset_objects.id
      )
    ))
  )
);

DROP POLICY IF EXISTS "asset_objects_insert_admin" ON public.asset_objects;
DROP POLICY IF EXISTS "asset_objects_update_admin" ON public.asset_objects;
DROP POLICY IF EXISTS "asset_objects_delete_admin" ON public.asset_objects;
REVOKE INSERT, UPDATE, DELETE ON public.asset_objects FROM PUBLIC, anon, authenticated;

CREATE POLICY "design_documents_select_member"
ON public.design_documents FOR SELECT TO authenticated
USING (deleted_at IS NULL AND private.is_workspace_member(workspace_id));

CREATE POLICY "design_nodes_select_member"
ON public.design_nodes FOR SELECT TO authenticated
USING (
  deleted_at IS NULL
  AND private.is_workspace_member(workspace_id)
  AND EXISTS (
    SELECT 1 FROM public.design_documents d
    WHERE d.id = design_id AND d.deleted_at IS NULL
  )
);

CREATE POLICY "design_document_versions_select_member"
ON public.design_document_versions FOR SELECT TO authenticated
USING (
  private.is_workspace_member(workspace_id)
  AND EXISTS (
    SELECT 1 FROM public.design_documents d
    WHERE d.id = design_id AND d.deleted_at IS NULL
  )
);

CREATE POLICY "design_document_asset_refs_select_member"
ON public.design_document_asset_refs FOR SELECT TO authenticated
USING (
  private.is_workspace_member(workspace_id)
  AND EXISTS (
    SELECT 1 FROM public.design_documents d
    WHERE d.id = design_id AND d.deleted_at IS NULL
  )
);

CREATE POLICY "design_document_font_refs_select_member"
ON public.design_document_font_refs FOR SELECT TO authenticated
USING (
  private.is_workspace_member(workspace_id)
  AND EXISTS (
    SELECT 1 FROM public.design_documents d
    WHERE d.id = design_id AND d.deleted_at IS NULL
  )
);

CREATE POLICY "design_templates_select_catalog"
ON public.design_templates FOR SELECT TO authenticated
USING (private.can_read_design_catalog_record(scope, workspace_id, status, deleted_at));

CREATE POLICY "design_template_asset_refs_select_catalog"
ON public.design_template_asset_refs FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.design_templates t
  WHERE t.id = template_id
    AND private.can_read_design_catalog_record(t.scope, t.workspace_id, t.status, t.deleted_at)
));

CREATE POLICY "text_presets_select_catalog"
ON public.text_presets FOR SELECT TO authenticated
USING (private.can_read_design_catalog_record(scope, workspace_id, status, deleted_at));

CREATE POLICY "design_resources_select_catalog"
ON public.design_resources FOR SELECT TO authenticated
USING (private.can_read_design_catalog_record(scope, workspace_id, status, deleted_at));

CREATE POLICY "font_families_select_catalog"
ON public.font_families FOR SELECT TO authenticated
USING (private.can_read_design_catalog_record(scope, workspace_id, status, deleted_at));

CREATE POLICY "font_faces_select_catalog"
ON public.font_faces FOR SELECT TO authenticated
USING (private.can_read_design_catalog_record(scope, workspace_id, status, deleted_at));

CREATE POLICY "resource_categories_select_catalog"
ON public.resource_categories FOR SELECT TO authenticated
USING (private.can_read_design_catalog_record(scope, workspace_id, status, deleted_at));

CREATE POLICY "resource_tags_select_catalog"
ON public.resource_tags FOR SELECT TO authenticated
USING (private.can_read_design_catalog_record(scope, workspace_id, status, deleted_at));

CREATE POLICY "resource_tag_links_select_catalog"
ON public.resource_tag_links FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.design_resources r
  WHERE r.id = resource_id
    AND private.can_read_design_catalog_record(r.scope, r.workspace_id, r.status, r.deleted_at)
));

CREATE POLICY "resource_favorites_select_own"
ON public.resource_favorites FOR SELECT TO authenticated
USING (user_id = auth.uid());
CREATE POLICY "resource_favorites_insert_own"
ON public.resource_favorites FOR INSERT TO authenticated
WITH CHECK (
  user_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.design_resources r
    WHERE r.id = resource_id
      AND private.can_read_design_catalog_record(r.scope, r.workspace_id, r.status, r.deleted_at)
  )
);
CREATE POLICY "resource_favorites_delete_own"
ON public.resource_favorites FOR DELETE TO authenticated
USING (user_id = auth.uid());

CREATE POLICY "resource_recent_uses_select_own"
ON public.resource_recent_uses FOR SELECT TO authenticated
USING (user_id = auth.uid() AND private.is_workspace_member(workspace_id));
CREATE POLICY "resource_recent_uses_insert_own"
ON public.resource_recent_uses FOR INSERT TO authenticated
WITH CHECK (
  user_id = auth.uid()
  AND private.is_workspace_member(workspace_id)
  AND EXISTS (
    SELECT 1 FROM public.design_resources r
    WHERE r.id = resource_id
      AND private.can_read_design_catalog_record(r.scope, r.workspace_id, r.status, r.deleted_at)
  )
);
CREATE POLICY "resource_recent_uses_update_own"
ON public.resource_recent_uses FOR UPDATE TO authenticated
USING (user_id = auth.uid() AND private.is_workspace_member(workspace_id))
WITH CHECK (user_id = auth.uid() AND private.is_workspace_member(workspace_id));
CREATE POLICY "resource_recent_uses_delete_own"
ON public.resource_recent_uses FOR DELETE TO authenticated
USING (user_id = auth.uid() AND private.is_workspace_member(workspace_id));

CREATE POLICY "resource_import_jobs_select_admin"
ON public.resource_import_jobs FOR SELECT TO authenticated
USING (private.can_manage_design_catalog_record(scope, workspace_id));

CREATE POLICY "resource_import_items_select_admin"
ON public.resource_import_items FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.resource_import_jobs j
  WHERE j.id = import_job_id
    AND private.can_manage_design_catalog_record(j.scope, j.workspace_id)
));

GRANT SELECT ON public.design_documents, public.design_nodes,
  public.design_document_versions, public.design_document_asset_refs,
  public.design_document_font_refs, public.design_templates,
  public.design_template_asset_refs, public.text_presets,
  public.design_resources, public.font_families, public.font_faces,
  public.resource_categories, public.resource_tags, public.resource_tag_links,
  public.resource_import_jobs, public.resource_import_items
TO authenticated;

GRANT SELECT, INSERT, DELETE ON public.resource_favorites TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.resource_recent_uses TO authenticated;

REVOKE INSERT, UPDATE, DELETE ON public.design_documents, public.design_nodes,
  public.design_document_versions, public.design_document_asset_refs,
  public.design_document_font_refs, public.design_templates,
  public.design_template_asset_refs, public.text_presets,
  public.design_resources, public.font_families, public.font_faces,
  public.resource_categories, public.resource_tags, public.resource_tag_links,
  public.resource_import_jobs, public.resource_import_items
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON public.design_creation_requests, public.job_target_finalizations,
  public.design_event_outbox
FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Canonical scene validation, atomic create and compare-and-swap mutation
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.loomic_jsonb_object_has_only_keys(
  p_value jsonb,
  p_allowed_keys text[]
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  present_key text;
BEGIN
  IF jsonb_typeof(p_value) <> 'object' THEN RETURN false; END IF;
  FOR present_key IN SELECT jsonb_object_keys(p_value)
  LOOP
    IF NOT (present_key = ANY(p_allowed_keys)) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION private.loomic_valid_color(p_value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT jsonb_typeof(p_value) = 'string'
    AND char_length(btrim(p_value#>>'{}')) BETWEEN 1 AND 128;
$$;

CREATE OR REPLACE FUNCTION private.loomic_valid_paint(p_value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  stop_value jsonb;
  stop_offset double precision;
  previous_offset double precision;
BEGIN
  IF jsonb_typeof(p_value) <> 'object' THEN RETURN false; END IF;
  IF p_value->>'kind' = 'solid' THEN
    RETURN private.loomic_jsonb_object_has_only_keys(p_value, ARRAY['kind', 'color'])
      AND p_value ?& ARRAY['kind', 'color']
      AND private.loomic_valid_color(p_value->'color');
  END IF;
  IF p_value->>'kind' = 'linear' THEN
    IF NOT private.loomic_jsonb_object_has_only_keys(
        p_value, ARRAY['kind', 'angle', 'stops']
      )
      OR NOT (p_value ?& ARRAY['kind', 'angle', 'stops'])
      OR jsonb_typeof(p_value->'angle') <> 'number'
      OR jsonb_typeof(p_value->'stops') <> 'array'
      OR jsonb_array_length(p_value->'stops') NOT BETWEEN 2 AND 32
    THEN RETURN false; END IF;
  ELSIF p_value->>'kind' = 'radial' THEN
    IF NOT private.loomic_jsonb_object_has_only_keys(
      p_value, ARRAY['kind', 'centerX', 'centerY', 'radius', 'stops']
      )
      OR NOT (p_value ?& ARRAY['kind', 'centerX', 'centerY', 'radius', 'stops'])
      OR jsonb_typeof(p_value->'centerX') <> 'number'
      OR (p_value->>'centerX')::double precision NOT BETWEEN 0 AND 1
      OR jsonb_typeof(p_value->'centerY') <> 'number'
      OR (p_value->>'centerY')::double precision NOT BETWEEN 0 AND 1
      OR jsonb_typeof(p_value->'radius') <> 'number'
      OR (p_value->>'radius')::double precision <= 0
      OR (p_value->>'radius')::double precision > 2
      OR jsonb_typeof(p_value->'stops') <> 'array'
      OR jsonb_array_length(p_value->'stops') NOT BETWEEN 2 AND 32
    THEN RETURN false; END IF;
  ELSE
    RETURN false;
  END IF;

  FOR stop_value IN SELECT value FROM jsonb_array_elements(p_value->'stops')
  LOOP
    IF NOT private.loomic_jsonb_object_has_only_keys(
        stop_value, ARRAY['offset', 'color']
      )
      OR NOT (stop_value ?& ARRAY['offset', 'color'])
      OR jsonb_typeof(stop_value->'offset') <> 'number'
      OR (stop_value->>'offset')::double precision NOT BETWEEN 0 AND 1
      OR NOT private.loomic_valid_color(stop_value->'color')
    THEN RETURN false; END IF;
    stop_offset := (stop_value->>'offset')::double precision;
    IF previous_offset IS NOT NULL AND stop_offset <= previous_offset THEN
      RETURN false;
    END IF;
    previous_offset := stop_offset;
  END LOOP;
  RETURN true;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION private.loomic_valid_shadow(p_value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT private.loomic_jsonb_object_has_only_keys(
      p_value, ARRAY['color', 'blur', 'offsetX', 'offsetY', 'opacity']
    )
    AND p_value ?& ARRAY['color', 'blur', 'offsetX', 'offsetY', 'opacity']
    AND private.loomic_valid_color(p_value->'color')
    AND jsonb_typeof(p_value->'blur') = 'number'
    AND (p_value->>'blur')::double precision >= 0
    AND jsonb_typeof(p_value->'offsetX') = 'number'
    AND jsonb_typeof(p_value->'offsetY') = 'number'
    AND jsonb_typeof(p_value->'opacity') = 'number'
    AND (p_value->>'opacity')::double precision BETWEEN 0 AND 1;
$$;

REVOKE ALL ON FUNCTION private.loomic_jsonb_object_has_only_keys(jsonb, text[])
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_valid_color(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_valid_paint(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_valid_shadow(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.loomic_jsonb_object_has_only_keys(jsonb, text[])
  TO service_role;
GRANT EXECUTE ON FUNCTION private.loomic_valid_color(jsonb),
  private.loomic_valid_paint(jsonb), private.loomic_valid_shadow(jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION private.loomic_validate_design_scene(
  p_scene jsonb,
  p_width integer,
  p_height integer
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  object_count integer;
  object_with_id_count integer;
  distinct_object_id_count integer;
  invalid_object_count integer;
BEGIN
  IF p_scene IS NULL OR p_width IS NULL OR p_height IS NULL
    OR p_width NOT BETWEEN 1 AND 32768 OR p_height NOT BETWEEN 1 AND 32768
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_dimensions_invalid';
  END IF;

  IF jsonb_typeof(p_scene) <> 'object'
    OR NOT private.loomic_jsonb_object_has_only_keys(
      p_scene, ARRAY['schemaVersion', 'engine', 'canvas', 'objects']
    )
    OR p_scene->>'engine' <> 'fabric'
    OR NOT (p_scene ?& ARRAY['schemaVersion', 'engine', 'canvas', 'objects'])
    OR (p_scene->>'schemaVersion')::integer <> 1
    OR jsonb_typeof(p_scene->'canvas') <> 'object'
    OR NOT private.loomic_jsonb_object_has_only_keys(
      p_scene->'canvas', ARRAY['width', 'height', 'background']
    )
    OR NOT (p_scene->'canvas' ?& ARRAY['width', 'height', 'background'])
    OR jsonb_typeof(p_scene->'objects') <> 'array'
    OR (p_scene#>>'{canvas,width}')::integer <> p_width
    OR (p_scene#>>'{canvas,height}')::integer <> p_height
    OR NOT (
      jsonb_typeof(p_scene#>'{canvas,background}') = 'null'
      OR private.loomic_valid_color(p_scene#>'{canvas,background}')
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_scene_invalid';
  END IF;

  IF octet_length(p_scene::text) > 20971520 THEN
    RAISE EXCEPTION USING ERRCODE = '54000', MESSAGE = 'design_scene_too_large';
  END IF;

  IF p_scene::text ~ '"(signedUrl|signed_url|objectPath|object_path)"[[:space:]]*:' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_scene_contains_ephemeral_asset_locator';
  END IF;

  SELECT
    count(*),
    count(*) FILTER (WHERE private.try_parse_uuid(object_data->>'objectId') IS NOT NULL),
    count(DISTINCT object_data->>'objectId'),
    count(*) FILTER (WHERE
      jsonb_typeof(object_data) <> 'object'
      OR
      COALESCE(object_data->>'type', '') NOT IN (
        'image', 'svg', 'text', 'textbox', 'rect', 'circle', 'triangle',
        'line', 'arrow', 'group'
      )
      OR NOT (object_data ?& ARRAY[
        'objectId', 'objectVersion', 'type', 'x', 'y', 'width', 'height',
        'rotation', 'opacity', 'zIndex', 'locked', 'visible'
      ])
      OR NOT private.loomic_jsonb_object_has_only_keys(
        object_data,
        ARRAY[
          'objectId', 'objectVersion', 'type', 'name', 'x', 'y', 'width',
          'height', 'rotation', 'opacity', 'zIndex', 'locked', 'visible', 'role'
        ] || CASE object_data->>'type'
          WHEN 'image' THEN ARRAY['assetObjectId', 'resourceId', 'fit', 'flipX', 'flipY']
          WHEN 'svg' THEN ARRAY['assetObjectId', 'resourceId', 'flipX', 'flipY']
          WHEN 'text' THEN ARRAY[
            'text', 'fontFaceId', 'fontFamily', 'fontSize', 'fontWeight',
            'fontStyle', 'textAlign', 'lineHeight', 'charSpacing', 'fill',
            'stroke', 'strokeWidth', 'shadow'
          ]
          WHEN 'textbox' THEN ARRAY[
            'text', 'fontFaceId', 'fontFamily', 'fontSize', 'fontWeight',
            'fontStyle', 'textAlign', 'lineHeight', 'charSpacing', 'fill',
            'stroke', 'strokeWidth', 'shadow', 'minWidth'
          ]
          WHEN 'rect' THEN ARRAY['fill', 'stroke', 'strokeWidth', 'shadow', 'radiusX', 'radiusY']
          WHEN 'circle' THEN ARRAY['fill', 'stroke', 'strokeWidth', 'shadow']
          WHEN 'triangle' THEN ARRAY['fill', 'stroke', 'strokeWidth', 'shadow']
          WHEN 'line' THEN ARRAY['stroke', 'strokeWidth', 'x1', 'y1', 'x2', 'y2']
          WHEN 'arrow' THEN ARRAY[
            'stroke', 'strokeWidth', 'x1', 'y1', 'x2', 'y2', 'arrowStart', 'arrowEnd'
          ]
          WHEN 'group' THEN ARRAY['childObjectIds']
          ELSE ARRAY[]::text[]
        END
      )
      OR jsonb_typeof(object_data->'objectVersion') <> 'number'
      OR COALESCE((object_data->>'objectVersion')::integer, 0) < 1
      OR (object_data->>'objectVersion')::numeric
        <> trunc((object_data->>'objectVersion')::numeric)
      OR object_data ? 'objects'
      OR jsonb_typeof(object_data->'x') <> 'number'
      OR jsonb_typeof(object_data->'y') <> 'number'
      OR jsonb_typeof(object_data->'width') <> 'number'
      OR jsonb_typeof(object_data->'height') <> 'number'
      OR (object_data->>'width')::double precision <= 0
      OR (object_data->>'height')::double precision <= 0
      OR jsonb_typeof(object_data->'rotation') <> 'number'
      OR jsonb_typeof(object_data->'opacity') <> 'number'
      OR (object_data->>'opacity')::double precision NOT BETWEEN 0 AND 1
      OR jsonb_typeof(object_data->'zIndex') <> 'number'
      OR (object_data->>'zIndex')::numeric
        <> trunc((object_data->>'zIndex')::numeric)
      OR (object_data->>'zIndex')::numeric < 0
      OR jsonb_typeof(object_data->'locked') <> 'boolean'
      OR jsonb_typeof(object_data->'visible') <> 'boolean'
      OR (
        object_data ? 'name' AND (
          jsonb_typeof(object_data->'name') <> 'string'
          OR char_length(btrim(object_data->>'name')) NOT BETWEEN 1 AND 200
        )
      )
      OR (
        object_data ? 'role'
        AND jsonb_typeof(object_data->'role') <> 'null'
        AND (
          jsonb_typeof(object_data->'role') <> 'string'
          OR COALESCE(object_data->>'role', '') NOT IN (
            'background', 'title', 'subtitle', 'logo', 'product', 'decoration'
          )
        )
      )
      OR (
        object_data->>'type' IN ('image', 'svg')
        AND private.try_parse_uuid(object_data->>'assetObjectId') IS NULL
      )
      OR (
        object_data->>'type' = 'image'
        AND NOT (object_data ?& ARRAY['assetObjectId', 'fit'])
      )
      OR (
        object_data->>'type' = 'svg'
        AND NOT (object_data ? 'assetObjectId')
      )
      OR (
        object_data->>'type' IN ('image', 'svg')
        AND object_data ? 'resourceId'
        AND jsonb_typeof(object_data->'resourceId') <> 'null'
        AND private.try_parse_uuid(object_data->>'resourceId') IS NULL
      )
      OR (
        object_data->>'type' IN ('image', 'svg')
        AND object_data ? 'flipX'
        AND jsonb_typeof(object_data->'flipX') <> 'boolean'
      )
      OR (
        object_data->>'type' IN ('image', 'svg')
        AND object_data ? 'flipY'
        AND jsonb_typeof(object_data->'flipY') <> 'boolean'
      )
      OR (
        object_data->>'type' = 'image'
        AND COALESCE(object_data->>'fit', '') NOT IN ('contain', 'cover', 'fill', 'original')
      )
      OR (
        object_data->>'type' IN ('text', 'textbox')
        AND (
          NOT (object_data ?& ARRAY[
            'text', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
            'textAlign', 'lineHeight', 'charSpacing', 'fill'
          ])
          OR
          jsonb_typeof(object_data->'text') <> 'string'
          OR char_length(object_data->>'text') > 100000
          OR jsonb_typeof(object_data->'fontFamily') <> 'string'
          OR char_length(btrim(object_data->>'fontFamily')) NOT BETWEEN 1 AND 200
          OR jsonb_typeof(object_data->'fontSize') <> 'number'
          OR (object_data->>'fontSize')::double precision <= 0
          OR NOT (
            (
              jsonb_typeof(object_data->'fontWeight') = 'number'
              AND (object_data->>'fontWeight')::numeric
                = trunc((object_data->>'fontWeight')::numeric)
              AND (object_data->>'fontWeight')::numeric BETWEEN 1 AND 1000
            )
            OR (
              jsonb_typeof(object_data->'fontWeight') = 'string'
              AND char_length(btrim(object_data->>'fontWeight')) BETWEEN 1 AND 50
            )
          )
          OR COALESCE(object_data->>'fontStyle', '') NOT IN ('normal', 'italic', 'oblique')
          OR COALESCE(object_data->>'textAlign', '') NOT IN ('left', 'center', 'right', 'justify')
          OR jsonb_typeof(object_data->'lineHeight') <> 'number'
          OR (object_data->>'lineHeight')::double precision <= 0
          OR jsonb_typeof(object_data->'charSpacing') <> 'number'
          OR NOT private.loomic_valid_paint(object_data->'fill')
          OR (
            object_data ? 'fontFaceId'
            AND jsonb_typeof(object_data->'fontFaceId') <> 'null'
            AND private.try_parse_uuid(object_data->>'fontFaceId') IS NULL
          )
          OR (
            object_data ? 'stroke'
            AND jsonb_typeof(object_data->'stroke') <> 'null'
            AND NOT private.loomic_valid_paint(object_data->'stroke')
          )
          OR (
            object_data ? 'strokeWidth'
            AND (
              jsonb_typeof(object_data->'strokeWidth') <> 'number'
              OR (object_data->>'strokeWidth')::double precision < 0
            )
          )
          OR (
            object_data ? 'shadow'
            AND jsonb_typeof(object_data->'shadow') <> 'null'
            AND NOT private.loomic_valid_shadow(object_data->'shadow')
          )
          OR (
            object_data->>'type' = 'textbox'
            AND object_data ? 'minWidth'
            AND (
              jsonb_typeof(object_data->'minWidth') <> 'number'
              OR (object_data->>'minWidth')::double precision <= 0
            )
          )
        )
      )
      OR (
        object_data->>'type' IN ('rect', 'circle', 'triangle')
        AND (
          NOT (object_data ?& ARRAY['fill', 'stroke', 'strokeWidth'])
          OR NOT (jsonb_typeof(object_data->'fill') = 'null'
            OR private.loomic_valid_paint(object_data->'fill'))
          OR NOT (jsonb_typeof(object_data->'stroke') = 'null'
            OR private.loomic_valid_paint(object_data->'stroke'))
          OR jsonb_typeof(object_data->'strokeWidth') <> 'number'
          OR (object_data->>'strokeWidth')::double precision < 0
          OR (
            object_data ? 'shadow'
            AND jsonb_typeof(object_data->'shadow') <> 'null'
            AND NOT private.loomic_valid_shadow(object_data->'shadow')
          )
          OR (
            object_data->>'type' = 'rect'
            AND object_data ? 'radiusX'
            AND (
              jsonb_typeof(object_data->'radiusX') <> 'number'
              OR (object_data->>'radiusX')::double precision < 0
            )
          )
          OR (
            object_data->>'type' = 'rect'
            AND object_data ? 'radiusY'
            AND (
              jsonb_typeof(object_data->'radiusY') <> 'number'
              OR (object_data->>'radiusY')::double precision < 0
            )
          )
        )
      )
      OR (
        object_data->>'type' IN ('line', 'arrow')
        AND (
          NOT (object_data ?& ARRAY['stroke', 'strokeWidth', 'x1', 'y1', 'x2', 'y2'])
          OR NOT private.loomic_valid_paint(object_data->'stroke')
          OR jsonb_typeof(object_data->'strokeWidth') <> 'number'
          OR (object_data->>'strokeWidth')::double precision < 0
          OR jsonb_typeof(object_data->'x1') <> 'number'
          OR jsonb_typeof(object_data->'y1') <> 'number'
          OR jsonb_typeof(object_data->'x2') <> 'number'
          OR jsonb_typeof(object_data->'y2') <> 'number'
          OR (
            object_data->>'type' = 'arrow'
            AND NOT (object_data ? 'arrowEnd')
          )
          OR (
            object_data->>'type' = 'arrow'
            AND COALESCE(object_data->>'arrowEnd', '') NOT IN ('none', 'arrow')
          )
          OR (
            object_data->>'type' = 'arrow'
            AND object_data ? 'arrowStart'
            AND COALESCE(object_data->>'arrowStart', '') NOT IN ('none', 'arrow')
          )
        )
      )
      OR (
        object_data->>'type' = 'group'
        AND NOT (object_data ? 'childObjectIds')
      )
    )
  INTO object_count, object_with_id_count, distinct_object_id_count, invalid_object_count
  FROM private.loomic_scene_objects(p_scene);

  IF object_count > 10000 THEN
    RAISE EXCEPTION USING ERRCODE = '54000', MESSAGE = 'design_object_limit_exceeded';
  END IF;
  IF object_count <> object_with_id_count
    OR object_with_id_count <> distinct_object_id_count
    OR invalid_object_count > 0
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_objects_invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_scene->'objects') WITH ORDINALITY
      AS ordered_object(object_data, ordinal)
    WHERE (ordered_object.object_data->>'zIndex')::integer
      IS DISTINCT FROM (ordered_object.ordinal - 1)::integer
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_z_index_order_invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_scene->'objects') group_object
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN group_object->>'type' = 'group'
        AND jsonb_typeof(group_object->'childObjectIds') = 'array'
      THEN group_object->'childObjectIds' ELSE '[]'::jsonb END
    ) child_id
    WHERE child_id#>>'{}' = group_object->>'objectId'
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_scene->'objects') candidate
        WHERE candidate->>'objectId' = child_id#>>'{}'
      )
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_scene->'objects') group_object
    WHERE group_object->>'type' = 'group'
      AND (
        jsonb_typeof(group_object->'childObjectIds') <> 'array'
        OR jsonb_array_length(group_object->'childObjectIds') = 0
        OR jsonb_array_length(group_object->'childObjectIds') <> (
          SELECT count(DISTINCT child_id#>>'{}')
          FROM jsonb_array_elements(group_object->'childObjectIds') child_id
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_group_references_invalid';
  END IF;

  IF EXISTS (
    SELECT child_id#>>'{}'
    FROM jsonb_array_elements(p_scene->'objects') group_object
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN group_object->>'type' = 'group'
        AND jsonb_typeof(group_object->'childObjectIds') = 'array'
      THEN group_object->'childObjectIds' ELSE '[]'::jsonb END
    ) child_id
    GROUP BY child_id#>>'{}'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_group_multiple_parents';
  END IF;

  IF EXISTS (
    WITH RECURSIVE group_edges(parent_id, child_id) AS (
      SELECT group_object->>'objectId', child_id#>>'{}'
      FROM jsonb_array_elements(p_scene->'objects') group_object
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN group_object->>'type' = 'group'
          AND jsonb_typeof(group_object->'childObjectIds') = 'array'
        THEN group_object->'childObjectIds' ELSE '[]'::jsonb END
      ) child_id
    ), group_walk(root_id, node_id, path, cycle) AS (
      SELECT parent_id, child_id, ARRAY[parent_id, child_id], parent_id = child_id
      FROM group_edges
      UNION ALL
      SELECT walk.root_id, edge.child_id, walk.path || edge.child_id,
        edge.child_id = ANY(walk.path)
      FROM group_walk walk
      JOIN group_edges edge ON edge.parent_id = walk.node_id
      WHERE NOT walk.cycle
    )
    SELECT 1 FROM group_walk WHERE cycle
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_group_cycle';
  END IF;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_scene_invalid';
END;
$$;

CREATE OR REPLACE FUNCTION private.loomic_scene_object_by_id(
  p_scene jsonb,
  p_object_id text
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT object_data
  FROM private.loomic_scene_objects(p_scene)
  WHERE object_data->>'objectId' = p_object_id
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION private.loomic_validate_design_scene(jsonb, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_scene_object_by_id(jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.loomic_validate_design_scene(jsonb, integer, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION private.loomic_scene_object_by_id(jsonb, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.loomic_design_create(
  p_request_id uuid,
  p_canvas_id uuid,
  p_expected_canvas_revision bigint,
  p_canvas_element_id text,
  p_name text,
  p_width integer,
  p_height integer,
  p_node_x double precision,
  p_node_y double precision,
  p_node_width double precision,
  p_node_height double precision,
  p_background text DEFAULT '#ffffff',
  p_template_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller_id uuid := auth.uid();
  canvas_row record;
  template_row public.design_templates%ROWTYPE;
  existing_request public.design_creation_requests%ROWTYPE;
  v_design_id uuid := extensions.gen_random_uuid();
  scene jsonb;
  scene_objects jsonb := '[]'::jsonb;
  source_object jsonb;
  cloned_object jsonb;
  object_id_map jsonb := '{}'::jsonb;
  cloned_child_ids jsonb;
  original_object_id text;
  canvas_elements jsonb;
  node_element jsonb;
  next_canvas_revision bigint;
  result jsonb;
  final_width integer := p_width;
  final_height integer := p_height;
  final_name text := NULLIF(btrim(COALESCE(p_name, '')), '');
BEGIN
  IF caller_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authenticated';
  END IF;
  IF p_request_id IS NULL
    OR p_width IS NULL OR p_height IS NULL
    OR p_width NOT BETWEEN 1 AND 32768 OR p_height NOT BETWEEN 1 AND 32768
    OR p_node_x IS NULL OR p_node_y IS NULL
    OR p_node_width IS NULL OR p_node_height IS NULL
    OR NULLIF(btrim(COALESCE(p_canvas_element_id, '')), '') IS NULL
    OR char_length(p_canvas_element_id) > 200
    OR p_node_width <= 0 OR p_node_height <= 0
    OR p_node_width > 10000 OR p_node_height > 10000
    OR p_node_x::text IN ('NaN', 'Infinity', '-Infinity')
    OR p_node_y::text IN ('NaN', 'Infinity', '-Infinity')
    OR p_node_width::text IN ('NaN', 'Infinity', '-Infinity')
    OR p_node_height::text IN ('NaN', 'Infinity', '-Infinity')
    OR (p_background IS NOT NULL AND char_length(p_background) > 128)
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_create_input_invalid';
  END IF;

  SELECT c.id, c.workspace_id, c.project_id, c.content, c.revision
  INTO canvas_row
  FROM public.canvases c
  WHERE c.id = p_canvas_id
  FOR UPDATE;

  IF canvas_row.id IS NULL
    OR NOT private.is_workspace_admin_or_owner(canvas_row.workspace_id)
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'canvas_not_found_or_forbidden';
  END IF;

  SELECT * INTO existing_request
  FROM public.design_creation_requests r
  WHERE r.workspace_id = canvas_row.workspace_id
    AND r.created_by = caller_id
    AND r.request_id = p_request_id;

  IF existing_request.id IS NOT NULL THEN
    IF existing_request.status = 'succeeded' AND existing_request.response IS NOT NULL THEN
      RETURN jsonb_set(existing_request.response, '{replayed}', 'true'::jsonb, true);
    END IF;
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'design_create_request_in_progress';
  END IF;

  IF canvas_row.revision IS DISTINCT FROM p_expected_canvas_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'canvas_revision_conflict',
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

  IF p_template_id IS NOT NULL THEN
    SELECT * INTO template_row
    FROM public.design_templates t
    WHERE t.id = p_template_id
      AND t.deleted_at IS NULL
      AND (
        (t.scope = 'platform' AND t.status = 'published')
        OR (t.scope = 'workspace' AND t.workspace_id = canvas_row.workspace_id
          AND (t.status = 'published' OR private.is_workspace_admin_or_owner(t.workspace_id)))
      );
    IF template_row.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'design_template_not_available';
    END IF;
    final_width := template_row.width;
    final_height := template_row.height;
    final_name := COALESCE(final_name, template_row.name);
    FOR source_object IN SELECT value FROM jsonb_array_elements(template_row.scene->'objects')
    LOOP
      original_object_id := source_object->>'objectId';
      object_id_map := object_id_map || jsonb_build_object(
        original_object_id, extensions.gen_random_uuid()::text
      );
    END LOOP;
    FOR source_object IN SELECT value FROM jsonb_array_elements(template_row.scene->'objects')
    LOOP
      original_object_id := source_object->>'objectId';
      cloned_object := jsonb_set(
        source_object,
        '{objectId}',
        to_jsonb(object_id_map->>original_object_id),
        true
      );
      IF source_object->>'type' = 'group' THEN
        SELECT COALESCE(jsonb_agg(to_jsonb(object_id_map->>(child_id#>>'{}'))), '[]'::jsonb)
        INTO cloned_child_ids
        FROM jsonb_array_elements(source_object->'childObjectIds') child_id;
        cloned_object := jsonb_set(
          cloned_object, '{childObjectIds}', cloned_child_ids, true
        );
      END IF;
      scene_objects := scene_objects || jsonb_build_array(cloned_object);
    END LOOP;
    scene := jsonb_set(template_row.scene, '{objects}', scene_objects, true);
  ELSE
    scene := jsonb_build_object(
      'schemaVersion', 1,
      'engine', 'fabric',
      'canvas', jsonb_build_object(
        'width', final_width,
        'height', final_height,
        'background', p_background
      ),
      'objects', '[]'::jsonb
    );
  END IF;

  final_name := COALESCE(final_name, '未命名设计');
  PERFORM private.loomic_validate_design_scene(scene, final_width, final_height);

  INSERT INTO public.design_creation_requests(
    workspace_id, created_by, request_id, canvas_id, design_id,
    canvas_element_id, status
  ) VALUES (
    canvas_row.workspace_id, caller_id, p_request_id, p_canvas_id, NULL,
    p_canvas_element_id, 'pending'
  );

  INSERT INTO public.design_documents(
    id, workspace_id, project_id, name, scene, width, height,
    revision, created_by, updated_by
  ) VALUES (
    v_design_id, canvas_row.workspace_id, canvas_row.project_id, final_name,
    scene, final_width, final_height, 0, caller_id, caller_id
  );

  PERFORM private.loomic_sync_design_references(v_design_id, canvas_row.workspace_id, scene);

  INSERT INTO public.design_document_versions(
    design_id, workspace_id, revision, parent_revision, command_batch, changed_object_ids,
    snapshot, actor_kind, actor_user_id, idempotency_key
  ) VALUES (
    v_design_id, canvas_row.workspace_id, 0, NULL,
    '[]'::jsonb, ARRAY[]::uuid[], scene, 'user', caller_id, p_request_id
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
      'designId', v_design_id,
      'revision', 0,
      'previewAssetObjectId', NULL,
      'previewRevision', 0
    )
  );

  next_canvas_revision := canvas_row.revision + 1;
  UPDATE public.canvases
  SET content = jsonb_set(
        COALESCE(canvas_row.content, '{}'::jsonb),
        '{elements}',
        canvas_elements || jsonb_build_array(node_element),
        true
      ),
      revision = next_canvas_revision
  WHERE id = p_canvas_id;

  INSERT INTO public.design_nodes(
    canvas_id, element_id, design_id, workspace_id, created_by
  ) VALUES (
    p_canvas_id, p_canvas_element_id, v_design_id, canvas_row.workspace_id, caller_id
  );

  INSERT INTO public.design_event_outbox(
    design_id, workspace_id, revision, event_type, payload
  ) VALUES (
    v_design_id, canvas_row.workspace_id, 0, 'design.sync',
    jsonb_build_object(
      'type', 'design.sync',
      'designId', v_design_id,
      'revision', 0,
      'updateType', 'created',
      'changedObjectIds', '[]'::jsonb,
      'previewAssetObjectId', NULL,
      'previewRevision', 0
    )
  );

  result := jsonb_build_object(
    'design_id', v_design_id,
    'canvas_element_id', p_canvas_element_id,
    'design_revision', 0,
    'canvas_revision', next_canvas_revision,
    'replayed', false
  );

  UPDATE public.design_creation_requests
  SET design_id = v_design_id,
      status = 'succeeded',
      response = result,
      completed_at = now()
  WHERE workspace_id = canvas_row.workspace_id
    AND created_by = caller_id
    AND request_id = p_request_id;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.loomic_design_create(
  uuid, uuid, bigint, text, text, integer, integer,
  double precision, double precision, double precision, double precision, text, uuid
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.loomic_design_create(
  uuid, uuid, bigint, text, text, integer, integer,
  double precision, double precision, double precision, double precision, text, uuid
) TO authenticated;

CREATE OR REPLACE FUNCTION private.loomic_apply_object_patch(
  p_object jsonb,
  p_patch jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  result jsonb := p_object;
  object_type text := p_object->>'type';
  patch_key text;
  target_key text;
  allowed_keys text[] := ARRAY[
    'name', 'x', 'y', 'width', 'height', 'rotation', 'opacity',
    'z_index', 'locked', 'visible'
  ];
BEGIN
  IF jsonb_typeof(p_object) <> 'object'
    OR jsonb_typeof(p_patch) <> 'object'
    OR p_patch->>'object_type' IS DISTINCT FROM object_type
    OR (SELECT count(*) FROM jsonb_object_keys(p_patch)) < 2
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_object_patch_invalid';
  END IF;

  allowed_keys := allowed_keys || CASE object_type
    WHEN 'image' THEN ARRAY['asset_object_id', 'resource_id', 'fit', 'flip_x', 'flip_y']
    WHEN 'svg' THEN ARRAY['asset_object_id', 'resource_id', 'flip_x', 'flip_y']
    WHEN 'text' THEN ARRAY[
      'text', 'font_face_id', 'font_family', 'font_size', 'font_weight',
      'font_style', 'text_align', 'line_height', 'char_spacing', 'fill',
      'stroke', 'stroke_width', 'shadow'
    ]
    WHEN 'textbox' THEN ARRAY[
      'text', 'font_face_id', 'font_family', 'font_size', 'font_weight',
      'font_style', 'text_align', 'line_height', 'char_spacing', 'fill',
      'stroke', 'stroke_width', 'shadow', 'min_width'
    ]
    WHEN 'rect' THEN ARRAY['fill', 'stroke', 'stroke_width', 'shadow', 'radius_x', 'radius_y']
    WHEN 'circle' THEN ARRAY['fill', 'stroke', 'stroke_width', 'shadow']
    WHEN 'triangle' THEN ARRAY['fill', 'stroke', 'stroke_width', 'shadow']
    WHEN 'line' THEN ARRAY['stroke', 'stroke_width', 'x1', 'y1', 'x2', 'y2']
    WHEN 'arrow' THEN ARRAY[
      'stroke', 'stroke_width', 'x1', 'y1', 'x2', 'y2', 'arrow_start', 'arrow_end'
    ]
    WHEN 'group' THEN ARRAY[]::text[]
    ELSE ARRAY[]::text[]
  END;

  FOR patch_key IN SELECT jsonb_object_keys(p_patch - 'object_type')
  LOOP
    IF NOT (patch_key = ANY(allowed_keys)) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_object_patch_field_not_allowed';
    END IF;
    target_key := CASE patch_key
      WHEN 'z_index' THEN 'zIndex'
      WHEN 'asset_object_id' THEN 'assetObjectId'
      WHEN 'resource_id' THEN 'resourceId'
      WHEN 'flip_x' THEN 'flipX'
      WHEN 'flip_y' THEN 'flipY'
      WHEN 'font_face_id' THEN 'fontFaceId'
      WHEN 'font_family' THEN 'fontFamily'
      WHEN 'font_size' THEN 'fontSize'
      WHEN 'font_weight' THEN 'fontWeight'
      WHEN 'font_style' THEN 'fontStyle'
      WHEN 'text_align' THEN 'textAlign'
      WHEN 'line_height' THEN 'lineHeight'
      WHEN 'char_spacing' THEN 'charSpacing'
      WHEN 'stroke_width' THEN 'strokeWidth'
      WHEN 'min_width' THEN 'minWidth'
      WHEN 'radius_x' THEN 'radiusX'
      WHEN 'radius_y' THEN 'radiusY'
      WHEN 'arrow_start' THEN 'arrowStart'
      WHEN 'arrow_end' THEN 'arrowEnd'
      ELSE patch_key
    END;
    result := jsonb_set(result, ARRAY[target_key], p_patch->patch_key, true);
  END LOOP;

  result := jsonb_set(
    result,
    '{objectVersion}',
    to_jsonb((p_object->>'objectVersion')::integer + 1),
    true
  );
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION private.loomic_apply_object_patch(jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.loomic_apply_object_patch(jsonb, jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION private.loomic_text_array_insert(
  p_items text[],
  p_item text,
  p_zero_index integer
)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  result text[] := ARRAY[]::text[];
  item_count integer := COALESCE(array_length(p_items, 1), 0);
BEGIN
  IF p_zero_index < 0 OR p_zero_index > item_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_object_index_invalid';
  END IF;
  FOR item_index IN 0..item_count LOOP
    IF item_index = p_zero_index THEN result := array_append(result, p_item); END IF;
    IF item_index < item_count THEN
      result := array_append(result, p_items[item_index + 1]);
    END IF;
  END LOOP;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION private.loomic_text_array_insert(text[], text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.loomic_text_array_insert(text[], text, integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.loomic_design_mutate(
  p_design_id uuid,
  p_expected_revision bigint,
  p_idempotency_key uuid,
  p_commands jsonb,
  p_next_scene jsonb,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_agent_run_id uuid DEFAULT NULL,
  p_tool_execution_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  design_row public.design_documents%ROWTYPE;
  existing_version public.design_document_versions%ROWTYPE;
  command jsonb;
  action_name text;
  target_object_id text;
  expected_object_version integer;
  current_object jsonb;
  next_object jsonb;
  next_width integer;
  next_height integer;
  next_revision bigint;
  changed_object_ids uuid[];
  object_ref jsonb;
  ref_object_id text;
  ref_expected_version integer;
  result jsonb;
  expected_object_order text[];
  next_object_order text[];
  exact_objects jsonb := '{}'::jsonb;
  geometry_object_ids text[] := ARRAY[]::text[];
  force_version_ids text[] := ARRAY[]::text[];
  expected_canvas jsonb;
  expected_object jsonb;
  expected_index integer;
  scene_replace_requested boolean := false;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF p_idempotency_key IS NULL
    OR p_commands IS NULL
    OR p_next_scene IS NULL
    OR p_actor_kind IS NULL
    OR jsonb_typeof(p_commands) <> 'array'
    OR jsonb_array_length(p_commands) NOT BETWEEN 1 AND 500
    OR p_actor_kind NOT IN ('user', 'agent', 'system', 'job')
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_mutation_invalid';
  END IF;

  SELECT * INTO design_row
  FROM public.design_documents d
  WHERE d.id = p_design_id
  FOR UPDATE;

  IF design_row.id IS NULL OR design_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'design_not_found';
  END IF;

  IF p_actor_kind <> 'system' AND (
    p_actor_user_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.workspace_members wm
      WHERE wm.workspace_id = design_row.workspace_id
        AND wm.user_id = p_actor_user_id
        AND wm.role IN ('owner', 'admin')
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'design_write_forbidden';
  END IF;

  SELECT * INTO existing_version
  FROM public.design_document_versions v
  WHERE v.design_id = p_design_id
    AND v.idempotency_key = p_idempotency_key;

  IF existing_version.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'design_id', p_design_id,
      'revision', existing_version.revision,
      'changed_object_ids', existing_version.changed_object_ids,
      'replayed', true
    );
  END IF;

  IF design_row.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'design_revision_conflict',
      DETAIL = jsonb_build_object(
        'expected_revision', p_expected_revision,
        'latest_revision', design_row.revision,
        'retryable', false
      )::text;
  END IF;

  next_width := (p_next_scene#>>'{canvas,width}')::integer;
  next_height := (p_next_scene#>>'{canvas,height}')::integer;
  PERFORM private.loomic_validate_design_scene(p_next_scene, next_width, next_height);

  SELECT COALESCE(array_agg(object_data->>'objectId' ORDER BY ordinal), ARRAY[]::text[])
  INTO expected_object_order
  FROM jsonb_array_elements(design_row.scene->'objects')
    WITH ORDINALITY AS objects(object_data, ordinal);
  expected_canvas := design_row.scene->'canvas';

  FOR command IN SELECT value FROM jsonb_array_elements(p_commands)
  LOOP
    action_name := command->>'action';
    IF action_name NOT IN (
      'object.add', 'object.update', 'object.remove', 'object.clone',
      'object.reorder', 'objects.group', 'objects.ungroup', 'objects.align',
      'objects.distribute', 'object.set_role', 'canvas.update', 'scene.replace'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_command_not_allowed';
    END IF;

    IF action_name = 'object.add' THEN
      target_object_id := command#>>'{object,objectId}';
      IF NULLIF(btrim(COALESCE(target_object_id, '')), '') IS NULL
        OR private.loomic_scene_object_by_id(design_row.scene, target_object_id) IS NOT NULL
      THEN
        RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'design_object_already_exists';
      END IF;
      next_object := private.loomic_scene_object_by_id(p_next_scene, target_object_id);
      IF next_object IS NULL
        OR (next_object->>'objectVersion')::integer <> 1
        OR next_object IS DISTINCT FROM command->'object'
      THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_added_object_invalid';
      END IF;
      IF exact_objects ? target_object_id THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_object_command_duplicate';
      END IF;
      exact_objects := exact_objects || jsonb_build_object(target_object_id, command->'object');
      expected_object_order := private.loomic_text_array_insert(
        expected_object_order, target_object_id, (command#>>'{object,zIndex}')::integer
      );
    ELSIF action_name IN ('object.update', 'object.remove') THEN
      target_object_id := command->>'object_id';
      expected_object_version := (command->>'expected_object_version')::integer;
      current_object := private.loomic_scene_object_by_id(design_row.scene, target_object_id);

      IF current_object IS NULL AND action_name = 'object.remove' THEN
        IF private.loomic_scene_object_by_id(p_next_scene, target_object_id) IS NULL THEN
          CONTINUE;
        END IF;
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_remove_noop_mismatch';
      END IF;
      IF current_object IS NULL
        OR expected_object_version IS NULL
        OR (current_object->>'objectVersion')::integer <> expected_object_version
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'design_object_version_conflict',
          DETAIL = jsonb_build_object(
            'object_id', target_object_id,
            'expected_object_version', expected_object_version,
            'latest_object_version', current_object->>'objectVersion',
            'retryable', false
          )::text;
      END IF;

      IF action_name = 'object.update' THEN
        IF command#>>'{patch,object_type}' IS DISTINCT FROM current_object->>'type' THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_object_patch_type_mismatch';
        END IF;
        next_object := private.loomic_scene_object_by_id(p_next_scene, target_object_id);
        expected_object := private.loomic_apply_object_patch(current_object, command->'patch');
        IF next_object IS NULL OR next_object IS DISTINCT FROM expected_object
        THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_object_update_mismatch';
        END IF;
        IF exact_objects ? target_object_id
          OR target_object_id = ANY(geometry_object_ids)
        THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_object_command_duplicate';
        END IF;
        exact_objects := exact_objects || jsonb_build_object(target_object_id, expected_object);
        IF command->'patch' ? 'z_index' THEN
          expected_object_order := private.loomic_text_array_insert(
            array_remove(expected_object_order, target_object_id),
            target_object_id,
            (command#>>'{patch,z_index}')::integer
          );
        END IF;
      ELSE
        IF private.loomic_scene_object_by_id(p_next_scene, target_object_id) IS NOT NULL THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_removed_object_still_present';
        END IF;
        expected_object_order := array_remove(expected_object_order, target_object_id);
      END IF;
    ELSIF action_name = 'object.clone' THEN
      target_object_id := command->>'source_object_id';
      expected_object_version := (command->>'expected_object_version')::integer;
      current_object := private.loomic_scene_object_by_id(design_row.scene, target_object_id);
      ref_object_id := command#>>'{object,objectId}';
      IF current_object IS NULL
        OR (current_object->>'objectVersion')::integer <> expected_object_version
      THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'design_object_version_conflict';
      END IF;
      IF ref_object_id = target_object_id
        OR private.loomic_scene_object_by_id(design_row.scene, ref_object_id) IS NOT NULL
        OR private.loomic_scene_object_by_id(p_next_scene, ref_object_id)
          IS DISTINCT FROM command->'object'
        OR (command#>>'{object,objectVersion}')::integer <> 1
      THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_clone_command_invalid';
      END IF;
      IF exact_objects ? ref_object_id THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_object_command_duplicate';
      END IF;
      exact_objects := exact_objects || jsonb_build_object(ref_object_id, command->'object');
      expected_object_order := private.loomic_text_array_insert(
        expected_object_order, ref_object_id, (command#>>'{object,zIndex}')::integer
      );
    ELSIF action_name = 'object.reorder' THEN
      target_object_id := command->>'object_id';
      expected_object_version := (command->>'expected_object_version')::integer;
      current_object := private.loomic_scene_object_by_id(design_row.scene, target_object_id);
      next_object := private.loomic_scene_object_by_id(p_next_scene, target_object_id);
      IF current_object IS NULL OR next_object IS NULL
        OR (current_object->>'objectVersion')::integer <> expected_object_version
        OR (next_object->>'objectVersion')::integer <> expected_object_version + 1
        OR (command->>'to_index')::integer < 0
        OR (command->>'to_index')::integer >= jsonb_array_length(p_next_scene->'objects')
      THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_reorder_invalid';
      END IF;
      IF target_object_id = ANY(force_version_ids)
        OR exact_objects ? target_object_id
        OR target_object_id = ANY(geometry_object_ids)
      THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_object_command_duplicate';
      END IF;
      force_version_ids := array_append(force_version_ids, target_object_id);
      expected_object_order := private.loomic_text_array_insert(
        array_remove(expected_object_order, target_object_id),
        target_object_id,
        (command->>'to_index')::integer
      );
    ELSIF action_name = 'objects.group' THEN
      target_object_id := command#>>'{group,objectId}';
      IF private.loomic_scene_object_by_id(design_row.scene, target_object_id) IS NOT NULL
        OR private.loomic_scene_object_by_id(p_next_scene, target_object_id)
          IS DISTINCT FROM command->'group'
        OR (command#>>'{group,objectVersion}')::integer <> 1
        OR jsonb_typeof(command->'children') <> 'array'
        OR jsonb_typeof(command#>'{group,childObjectIds}') <> 'array'
        OR jsonb_array_length(
          CASE WHEN jsonb_typeof(command->'children') = 'array'
            THEN command->'children' ELSE '[]'::jsonb END
        ) = 0
        OR jsonb_array_length(
          CASE WHEN jsonb_typeof(command->'children') = 'array'
            THEN command->'children' ELSE '[]'::jsonb END
        ) <> jsonb_array_length(
          CASE WHEN jsonb_typeof(command#>'{group,childObjectIds}') = 'array'
            THEN command#>'{group,childObjectIds}' ELSE '[]'::jsonb END
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(command->'children') = 'array'
              THEN command->'children' ELSE '[]'::jsonb END
          ) child_ref
          WHERE NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(command#>'{group,childObjectIds}') = 'array'
                THEN command#>'{group,childObjectIds}' ELSE '[]'::jsonb END
            ) child_id
            WHERE child_id#>>'{}' = child_ref->>'object_id'
          )
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(command#>'{group,childObjectIds}') = 'array'
              THEN command#>'{group,childObjectIds}' ELSE '[]'::jsonb END
          ) child_id
          WHERE NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(command->'children') = 'array'
                THEN command->'children' ELSE '[]'::jsonb END
            ) child_ref
            WHERE child_ref->>'object_id' = child_id#>>'{}'
          )
        )
      THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_group_command_invalid';
      END IF;
      FOR object_ref IN SELECT value FROM jsonb_array_elements(command->'children')
      LOOP
        ref_object_id := object_ref->>'object_id';
        ref_expected_version := (object_ref->>'expected_object_version')::integer;
        current_object := private.loomic_scene_object_by_id(design_row.scene, ref_object_id);
        IF current_object IS NULL
          OR (current_object->>'objectVersion')::integer <> ref_expected_version
        THEN
          RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'design_object_version_conflict';
        END IF;
      END LOOP;
      IF exact_objects ? target_object_id THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_object_command_duplicate';
      END IF;
      exact_objects := exact_objects || jsonb_build_object(target_object_id, command->'group');
      expected_object_order := private.loomic_text_array_insert(
        expected_object_order, target_object_id, (command#>>'{group,zIndex}')::integer
      );
    ELSIF action_name = 'objects.ungroup' THEN
      target_object_id := command->>'group_object_id';
      expected_object_version := (command->>'expected_object_version')::integer;
      current_object := private.loomic_scene_object_by_id(design_row.scene, target_object_id);
      IF current_object IS NULL
        OR current_object->>'type' <> 'group'
        OR (current_object->>'objectVersion')::integer <> expected_object_version
      THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'design_object_version_conflict';
      END IF;
      IF private.loomic_scene_object_by_id(p_next_scene, target_object_id) IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_ungroup_command_invalid';
      END IF;
      expected_object_order := array_remove(expected_object_order, target_object_id);
    ELSIF action_name IN ('objects.align', 'objects.distribute') THEN
      IF jsonb_typeof(command->'objects') <> 'array'
        OR jsonb_array_length(command->'objects') <
          (CASE WHEN action_name = 'objects.align' THEN 2 ELSE 3 END)
      THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_multi_object_command_invalid';
      END IF;
      FOR object_ref IN SELECT value FROM jsonb_array_elements(command->'objects')
      LOOP
        ref_object_id := object_ref->>'object_id';
        ref_expected_version := (object_ref->>'expected_object_version')::integer;
        current_object := private.loomic_scene_object_by_id(design_row.scene, ref_object_id);
        next_object := private.loomic_scene_object_by_id(p_next_scene, ref_object_id);
        IF current_object IS NULL OR next_object IS NULL
          OR (current_object->>'objectVersion')::integer <> ref_expected_version
          OR (next_object->>'objectVersion')::integer <> ref_expected_version + 1
        THEN
          RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'design_object_version_conflict';
        END IF;
        IF exact_objects ? ref_object_id
          OR ref_object_id = ANY(geometry_object_ids)
          OR ref_object_id = ANY(force_version_ids)
        THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_object_command_duplicate';
        END IF;
        IF (next_object - ARRAY['x', 'y', 'objectVersion'])
          IS DISTINCT FROM (current_object - ARRAY['x', 'y', 'objectVersion'])
        THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_geometry_command_mismatch';
        END IF;
        geometry_object_ids := array_append(geometry_object_ids, ref_object_id);
      END LOOP;
    ELSIF action_name = 'object.set_role' THEN
      target_object_id := command->>'object_id';
      expected_object_version := (command->>'expected_object_version')::integer;
      current_object := private.loomic_scene_object_by_id(design_row.scene, target_object_id);
      next_object := private.loomic_scene_object_by_id(p_next_scene, target_object_id);
      IF current_object IS NULL OR next_object IS NULL
        OR (current_object->>'objectVersion')::integer <> expected_object_version
        OR (next_object->>'objectVersion')::integer <> expected_object_version + 1
        OR next_object->'role' IS DISTINCT FROM command->'role'
      THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'design_object_version_conflict';
      END IF;
      expected_object := jsonb_set(
        jsonb_set(current_object, '{role}', command->'role', true),
        '{objectVersion}', to_jsonb(expected_object_version + 1), true
      );
      IF next_object IS DISTINCT FROM expected_object
        OR exact_objects ? target_object_id
        OR target_object_id = ANY(geometry_object_ids)
        OR target_object_id = ANY(force_version_ids)
      THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_set_role_mismatch';
      END IF;
      exact_objects := exact_objects || jsonb_build_object(target_object_id, expected_object);
    ELSIF action_name = 'canvas.update' THEN
      IF (command ? 'width' AND (command->>'width')::integer <> next_width)
        OR (command ? 'height' AND (command->>'height')::integer <> next_height)
        OR (
          command ? 'background'
          AND command->'background' IS DISTINCT FROM p_next_scene#>'{canvas,background}'
        )
      THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_canvas_update_mismatch';
      END IF;
      IF command ? 'width' THEN
        expected_canvas := jsonb_set(expected_canvas, '{width}', command->'width', true);
      END IF;
      IF command ? 'height' THEN
        expected_canvas := jsonb_set(expected_canvas, '{height}', command->'height', true);
      END IF;
      IF command ? 'background' THEN
        expected_canvas := jsonb_set(expected_canvas, '{background}', command->'background', true);
      END IF;
    ELSIF action_name = 'scene.replace' THEN
      IF command->'scene' IS DISTINCT FROM p_next_scene THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_scene_replace_mismatch';
      END IF;
      IF jsonb_array_length(p_commands) <> 1 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_scene_replace_must_be_exclusive';
      END IF;
      scene_replace_requested := true;
    END IF;
  END LOOP;

  -- The caller supplies next_scene for transport efficiency, but commands are
  -- the only mutation authority. Reject every top-level, canvas, ordering or
  -- object change that cannot be reconstructed from the command batch.
  IF NOT scene_replace_requested THEN
    IF (p_next_scene - ARRAY['canvas', 'objects'])
        IS DISTINCT FROM (design_row.scene - ARRAY['canvas', 'objects'])
      OR p_next_scene->'canvas' IS DISTINCT FROM expected_canvas
    THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_scene_uncommanded_change';
    END IF;

    SELECT COALESCE(array_agg(object_data->>'objectId' ORDER BY ordinal), ARRAY[]::text[])
    INTO next_object_order
    FROM jsonb_array_elements(p_next_scene->'objects')
      WITH ORDINALITY AS objects(object_data, ordinal);

    IF next_object_order IS DISTINCT FROM expected_object_order THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_object_order_mismatch';
    END IF;

    FOR object_ref IN
      SELECT object_data
      FROM jsonb_array_elements(p_next_scene->'objects') AS objects(object_data)
    LOOP
      target_object_id := object_ref->>'objectId';
      current_object := private.loomic_scene_object_by_id(
        design_row.scene, target_object_id
      );
      expected_index := array_position(expected_object_order, target_object_id) - 1;

      IF exact_objects ? target_object_id THEN
        expected_object := exact_objects->target_object_id;
      ELSIF target_object_id = ANY(geometry_object_ids) THEN
        -- Alignment/distribution are geometry-only operations. The server's
        -- shared mutator determines coordinates; SQL freezes every other field.
        IF current_object IS NULL
          OR (object_ref - ARRAY['x', 'y', 'objectVersion'])
            IS DISTINCT FROM (current_object - ARRAY['x', 'y', 'objectVersion'])
          OR (object_ref->>'objectVersion')::integer
            <> (current_object->>'objectVersion')::integer + 1
        THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_geometry_command_mismatch';
        END IF;
        CONTINUE;
      ELSIF current_object IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_uncommanded_object_added';
      ELSIF (current_object->>'zIndex')::integer IS DISTINCT FROM expected_index
        OR target_object_id = ANY(force_version_ids)
      THEN
        expected_object := jsonb_set(
          jsonb_set(current_object, '{zIndex}', to_jsonb(expected_index), true),
          '{objectVersion}',
          to_jsonb((current_object->>'objectVersion')::integer + 1),
          true
        );
      ELSE
        expected_object := current_object;
      END IF;

      IF object_ref IS DISTINCT FROM expected_object THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_object_uncommanded_change';
      END IF;
    END LOOP;
  END IF;

  WITH current_objects AS (
    SELECT object_data->>'objectId' AS object_id, object_data
    FROM private.loomic_scene_objects(design_row.scene)
  ), next_objects AS (
    SELECT object_data->>'objectId' AS object_id, object_data
    FROM private.loomic_scene_objects(p_next_scene)
  ), changed AS (
    SELECT COALESCE(current_objects.object_id, next_objects.object_id)::uuid AS object_id
    FROM current_objects
    FULL JOIN next_objects USING (object_id)
    WHERE current_objects.object_data IS DISTINCT FROM next_objects.object_data
  )
  SELECT COALESCE(array_agg(object_id ORDER BY object_id), ARRAY[]::uuid[])
  INTO changed_object_ids
  FROM changed;

  next_revision := design_row.revision + 1;
  UPDATE public.design_documents
  SET scene = p_next_scene,
      width = next_width,
      height = next_height,
      revision = next_revision,
      preview_status = CASE
        WHEN design_row.preview_asset_object_id IS NULL THEN 'missing'
        ELSE 'stale'
      END,
      updated_by = p_actor_user_id
  WHERE id = p_design_id;

  PERFORM private.loomic_sync_design_references(
    p_design_id, design_row.workspace_id, p_next_scene
  );

  INSERT INTO public.design_document_versions(
    design_id, workspace_id, revision, parent_revision, command_batch, changed_object_ids,
    snapshot, actor_kind, actor_user_id, agent_run_id, tool_execution_id,
    idempotency_key
  ) VALUES (
    p_design_id, design_row.workspace_id, next_revision, design_row.revision,
    p_commands, changed_object_ids,
    CASE WHEN next_revision % 50 = 0 THEN p_next_scene ELSE NULL END,
    p_actor_kind, p_actor_user_id, p_agent_run_id, p_tool_execution_id,
    p_idempotency_key
  );

  INSERT INTO public.design_event_outbox(
    design_id, workspace_id, revision, event_type, payload
  ) VALUES (
    p_design_id, design_row.workspace_id, next_revision, 'design.sync',
    jsonb_build_object(
      'type', 'design.sync',
      'designId', p_design_id,
      'revision', next_revision,
      'updateType', 'mutated',
      'changedObjectIds', changed_object_ids
    )
  );

  result := jsonb_build_object(
    'design_id', p_design_id,
    'revision', next_revision,
    'changed_object_ids', changed_object_ids,
    'replayed', false
  );
  RETURN result;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'design_mutation_invalid';
END;
$$;

REVOKE ALL ON FUNCTION public.loomic_design_mutate(
  uuid, bigint, uuid, jsonb, jsonb, text, uuid, uuid, uuid
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.loomic_design_mutate(
  uuid, bigint, uuid, jsonb, jsonb, text, uuid, uuid, uuid
) TO service_role;

ALTER TABLE public.design_document_asset_refs
  ADD CONSTRAINT design_document_asset_refs_resource_fkey
  FOREIGN KEY (resource_id) REFERENCES public.design_resources(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION private.validate_design_catalog_relationship()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  parent_scope text;
  parent_workspace_id uuid;
  asset_scope text;
  asset_workspace_id uuid;
  category_scope text;
  category_workspace_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'font_faces' THEN
    SELECT scope, workspace_id INTO parent_scope, parent_workspace_id
    FROM public.font_families WHERE id = NEW.family_id;
    IF parent_scope IS DISTINCT FROM NEW.scope
      OR parent_workspace_id IS DISTINCT FROM NEW.workspace_id
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'font_family_scope_mismatch';
    END IF;
  ELSIF TG_TABLE_NAME = 'resource_categories' THEN
    IF NEW.parent_id IS NOT NULL THEN
      SELECT scope, workspace_id INTO parent_scope, parent_workspace_id
      FROM public.resource_categories WHERE id = NEW.parent_id;
      IF parent_scope IS DISTINCT FROM NEW.scope
        OR parent_workspace_id IS DISTINCT FROM NEW.workspace_id
      THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'resource_category_scope_mismatch';
      END IF;
    END IF;
  END IF;

  IF TG_TABLE_NAME IN ('font_faces', 'design_resources') THEN
    SELECT scope, workspace_id INTO asset_scope, asset_workspace_id
    FROM public.asset_objects WHERE id = NEW.asset_object_id;
    IF asset_scope IS DISTINCT FROM NEW.scope
      OR asset_workspace_id IS DISTINCT FROM NEW.workspace_id
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'catalog_asset_scope_mismatch';
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'design_resources' THEN
    IF NEW.category_id IS NOT NULL THEN
      SELECT scope, workspace_id INTO category_scope, category_workspace_id
      FROM public.resource_categories WHERE id = NEW.category_id;
      IF category_scope IS DISTINCT FROM NEW.scope
        OR category_workspace_id IS DISTINCT FROM NEW.workspace_id
      THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'resource_category_scope_mismatch';
      END IF;
    END IF;
  END IF;

  IF TG_TABLE_NAME IN ('design_resources', 'design_templates', 'text_presets')
    AND NEW.preview_asset_object_id IS NOT NULL
  THEN
    SELECT scope, workspace_id INTO asset_scope, asset_workspace_id
    FROM public.asset_objects WHERE id = NEW.preview_asset_object_id;
    IF asset_scope IS DISTINCT FROM NEW.scope
      OR asset_workspace_id IS DISTINCT FROM NEW.workspace_id
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'catalog_preview_scope_mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER font_faces_validate_relationship
BEFORE INSERT OR UPDATE ON public.font_faces
FOR EACH ROW EXECUTE FUNCTION private.validate_design_catalog_relationship();
CREATE TRIGGER design_resources_validate_relationship
BEFORE INSERT OR UPDATE ON public.design_resources
FOR EACH ROW EXECUTE FUNCTION private.validate_design_catalog_relationship();
CREATE TRIGGER design_templates_validate_relationship
BEFORE INSERT OR UPDATE ON public.design_templates
FOR EACH ROW EXECUTE FUNCTION private.validate_design_catalog_relationship();
CREATE TRIGGER text_presets_validate_relationship
BEFORE INSERT OR UPDATE ON public.text_presets
FOR EACH ROW EXECUTE FUNCTION private.validate_design_catalog_relationship();
CREATE TRIGGER resource_categories_validate_relationship
BEFORE INSERT OR UPDATE ON public.resource_categories
FOR EACH ROW EXECUTE FUNCTION private.validate_design_catalog_relationship();

CREATE OR REPLACE FUNCTION private.validate_template_asset_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  template_scope text;
  template_workspace_id uuid;
  asset_scope text;
  asset_workspace_id uuid;
BEGIN
  SELECT scope, workspace_id INTO template_scope, template_workspace_id
  FROM public.design_templates WHERE id = NEW.template_id;
  SELECT scope, workspace_id INTO asset_scope, asset_workspace_id
  FROM public.asset_objects WHERE id = NEW.asset_object_id;
  IF template_scope IS DISTINCT FROM asset_scope
    OR template_workspace_id IS DISTINCT FROM asset_workspace_id
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'template_asset_scope_mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER design_template_asset_refs_validate_scope
BEFORE INSERT OR UPDATE ON public.design_template_asset_refs
FOR EACH ROW EXECUTE FUNCTION private.validate_template_asset_reference();

CREATE OR REPLACE FUNCTION private.validate_resource_tag_link_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  resource_scope text;
  resource_workspace_id uuid;
  tag_scope text;
  tag_workspace_id uuid;
BEGIN
  SELECT scope, workspace_id INTO resource_scope, resource_workspace_id
  FROM public.design_resources WHERE id = NEW.resource_id;
  SELECT scope, workspace_id INTO tag_scope, tag_workspace_id
  FROM public.resource_tags WHERE id = NEW.tag_id;
  IF resource_scope IS DISTINCT FROM tag_scope
    OR resource_workspace_id IS DISTINCT FROM tag_workspace_id
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'resource_tag_scope_mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER resource_tag_links_validate_scope
BEFORE INSERT OR UPDATE ON public.resource_tag_links
FOR EACH ROW EXECUTE FUNCTION private.validate_resource_tag_link_scope();

CREATE OR REPLACE FUNCTION private.validate_design_preview_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  asset_scope text;
  asset_workspace_id uuid;
BEGIN
  IF NEW.preview_asset_object_id IS NULL THEN RETURN NEW; END IF;
  SELECT scope, workspace_id INTO asset_scope, asset_workspace_id
  FROM public.asset_objects WHERE id = NEW.preview_asset_object_id;
  IF asset_scope <> 'workspace' OR asset_workspace_id IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'design_preview_workspace_mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER design_documents_validate_preview_scope
BEFORE INSERT OR UPDATE OF preview_asset_object_id, workspace_id ON public.design_documents
FOR EACH ROW EXECUTE FUNCTION private.validate_design_preview_scope();

-- ---------------------------------------------------------------------------
-- Reference-complete, tokenized, service-only garbage collection
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.loomic_jsonb_has_asset_reference(
  p_value jsonb,
  p_asset_id uuid
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  WITH RECURSIVE values_to_visit(value) AS (
    SELECT p_value
    UNION ALL
    SELECT child.value
    FROM values_to_visit parent
    CROSS JOIN LATERAL (
      SELECT array_value AS value
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(parent.value) = 'array'
          THEN parent.value ELSE '[]'::jsonb END
      ) array_entry(array_value)
      UNION ALL
      SELECT object_value AS value
      FROM jsonb_each(
        CASE WHEN jsonb_typeof(parent.value) = 'object'
          THEN parent.value ELSE '{}'::jsonb END
      ) object_entry(key, object_value)
    ) child
  )
  SELECT EXISTS (
    SELECT 1
    FROM values_to_visit item
    WHERE jsonb_typeof(item.value) = 'object'
      AND (
        private.try_parse_uuid(item.value->>'asset_id') = p_asset_id
        OR private.try_parse_uuid(item.value->>'asset_object_id') = p_asset_id
        OR private.try_parse_uuid(item.value->>'assetObjectId') = p_asset_id
      )
  );
$$;

CREATE OR REPLACE FUNCTION private.loomic_asset_has_live_references(p_asset_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.asset_references ar WHERE ar.asset_id = p_asset_id)
    OR EXISTS (
      SELECT 1 FROM public.design_document_asset_refs dr
      WHERE dr.asset_object_id = p_asset_id
    )
    OR EXISTS (
      SELECT 1 FROM public.design_documents d
      WHERE d.preview_asset_object_id = p_asset_id
    )
    OR EXISTS (
      SELECT 1 FROM public.design_template_asset_refs tr
      WHERE tr.asset_object_id = p_asset_id
    )
    OR EXISTS (
      SELECT 1 FROM public.design_templates t
      WHERE t.preview_asset_object_id = p_asset_id
    )
    OR EXISTS (
      SELECT 1 FROM public.text_presets tp
      WHERE tp.preview_asset_object_id = p_asset_id
    )
    OR EXISTS (
      SELECT 1 FROM public.design_resources r
      WHERE r.asset_object_id = p_asset_id OR r.preview_asset_object_id = p_asset_id
    )
    OR EXISTS (
      SELECT 1 FROM public.font_faces ff
      WHERE ff.asset_object_id = p_asset_id
    )
    OR EXISTS (
      SELECT 1 FROM public.resource_import_items ri
      WHERE ri.asset_object_id = p_asset_id
        AND ri.status IN ('pending', 'running', 'imported')
    )
    OR EXISTS (
      SELECT 1 FROM public.background_jobs j
      WHERE private.loomic_jsonb_has_asset_reference(j.result, p_asset_id)
        AND (
          j.status::text NOT IN ('succeeded', 'failed', 'canceled', 'dead_letter')
          OR COALESCE(j.completed_at, j.failed_at, j.canceled_at, j.created_at)
            >= now() - interval '7 days'
        )
    );
$$;

CREATE OR REPLACE FUNCTION private.cancel_asset_gc_on_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  referenced_asset_id uuid;
  referenced_asset_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF TG_TABLE_NAME = 'asset_references' THEN
    referenced_asset_ids := ARRAY[NEW.asset_id];
  ELSIF TG_TABLE_NAME IN ('design_document_asset_refs', 'design_template_asset_refs', 'font_faces') THEN
    referenced_asset_ids := ARRAY[NEW.asset_object_id];
  ELSIF TG_TABLE_NAME = 'design_documents' THEN
    referenced_asset_ids := ARRAY[NEW.preview_asset_object_id];
  ELSIF TG_TABLE_NAME IN ('design_templates', 'text_presets') THEN
    referenced_asset_ids := ARRAY[NEW.preview_asset_object_id];
  ELSIF TG_TABLE_NAME = 'design_resources' THEN
    referenced_asset_ids := ARRAY[NEW.asset_object_id, NEW.preview_asset_object_id];
  ELSIF TG_TABLE_NAME = 'resource_import_items' THEN
    referenced_asset_ids := ARRAY[NEW.asset_object_id];
  END IF;

  FOREACH referenced_asset_id IN ARRAY referenced_asset_ids
  LOOP
    CONTINUE WHEN referenced_asset_id IS NULL;
    IF EXISTS (
      SELECT 1 FROM public.asset_objects ao
      WHERE ao.id = referenced_asset_id AND ao.deletion_pending_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'asset_delete_already_prepared';
    END IF;
    UPDATE public.asset_objects
    SET gc_eligible_at = NULL,
        gc_claim_token = NULL,
        gc_claimed_at = NULL
    WHERE id = referenced_asset_id;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS asset_references_cancel_gc ON public.asset_references;
CREATE TRIGGER asset_references_cancel_gc
BEFORE INSERT OR UPDATE ON public.asset_references
FOR EACH ROW EXECUTE FUNCTION private.cancel_asset_gc_on_reference();
CREATE TRIGGER design_document_asset_refs_cancel_gc
BEFORE INSERT OR UPDATE ON public.design_document_asset_refs
FOR EACH ROW EXECUTE FUNCTION private.cancel_asset_gc_on_reference();
CREATE TRIGGER design_documents_cancel_preview_gc
BEFORE INSERT OR UPDATE OF preview_asset_object_id ON public.design_documents
FOR EACH ROW EXECUTE FUNCTION private.cancel_asset_gc_on_reference();
CREATE TRIGGER design_template_asset_refs_cancel_gc
BEFORE INSERT OR UPDATE ON public.design_template_asset_refs
FOR EACH ROW EXECUTE FUNCTION private.cancel_asset_gc_on_reference();
CREATE TRIGGER design_templates_cancel_preview_gc
BEFORE INSERT OR UPDATE OF preview_asset_object_id ON public.design_templates
FOR EACH ROW EXECUTE FUNCTION private.cancel_asset_gc_on_reference();
CREATE TRIGGER text_presets_cancel_preview_gc
BEFORE INSERT OR UPDATE OF preview_asset_object_id ON public.text_presets
FOR EACH ROW EXECUTE FUNCTION private.cancel_asset_gc_on_reference();
CREATE TRIGGER font_faces_cancel_gc
BEFORE INSERT OR UPDATE ON public.font_faces
FOR EACH ROW EXECUTE FUNCTION private.cancel_asset_gc_on_reference();
CREATE TRIGGER design_resources_cancel_gc
BEFORE INSERT OR UPDATE ON public.design_resources
FOR EACH ROW EXECUTE FUNCTION private.cancel_asset_gc_on_reference();
CREATE TRIGGER resource_import_items_cancel_gc
BEFORE INSERT OR UPDATE ON public.resource_import_items
FOR EACH ROW EXECUTE FUNCTION private.cancel_asset_gc_on_reference();

CREATE OR REPLACE FUNCTION public.loomic_asset_gc_claim(
  p_asset_id uuid,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE(claim_token uuid, bucket text, object_path text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  asset_row public.asset_objects%ROWTYPE;
  next_token uuid := extensions.gen_random_uuid();
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  SELECT * INTO asset_row FROM public.asset_objects
  WHERE id = p_asset_id FOR UPDATE;
  IF asset_row.id IS NULL
    OR asset_row.deletion_pending_at IS NOT NULL
    OR asset_row.gc_eligible_at IS NULL
    OR asset_row.gc_eligible_at > p_now
    OR private.loomic_asset_has_live_references(p_asset_id)
  THEN
    RETURN;
  END IF;
  UPDATE public.asset_objects
  SET gc_claim_token = next_token,
      gc_claimed_at = p_now
  WHERE id = p_asset_id;
  RETURN QUERY SELECT next_token, asset_row.bucket, asset_row.object_path;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_asset_gc_prepare_delete(
  p_asset_id uuid,
  p_claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  prepared_id uuid;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  UPDATE public.asset_objects ao
  SET deletion_pending_at = now()
  WHERE ao.id = p_asset_id
    AND ao.gc_claim_token = p_claim_token
    AND NOT private.loomic_asset_has_live_references(ao.id)
  RETURNING ao.id INTO prepared_id;
  RETURN prepared_id IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_asset_gc_finalize(
  p_asset_id uuid,
  p_claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  deleted_id uuid;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  DELETE FROM public.asset_objects ao
  WHERE ao.id = p_asset_id
    AND ao.gc_claim_token = p_claim_token
    AND ao.deletion_pending_at IS NOT NULL
    AND NOT private.loomic_asset_has_live_references(ao.id)
  RETURNING ao.id INTO deleted_id;
  RETURN deleted_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION private.loomic_asset_has_live_references(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.loomic_jsonb_has_asset_reference(jsonb, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.cancel_asset_gc_on_reference()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loomic_asset_gc_claim(uuid, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.loomic_asset_gc_prepare_delete(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.loomic_asset_gc_finalize(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.loomic_asset_has_live_references(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION private.loomic_jsonb_has_asset_reference(jsonb, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.loomic_asset_gc_claim(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.loomic_asset_gc_prepare_delete(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.loomic_asset_gc_finalize(uuid, uuid) TO service_role;

-- Keep the existing canvas reference API names, but align write authorization
-- with the owner/admin matrix and route their orphan cleanup through the new
-- reference-complete guard.
CREATE OR REPLACE FUNCTION public.loomic_canvas_asset_refs_replace(
  p_canvas_id uuid,
  p_refs jsonb
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_workspace_id uuid;
  ref jsonb;
  ref_asset_id uuid;
  old_asset_ids uuid[];
  orphan_candidates uuid[];
BEGIN
  IF jsonb_typeof(p_refs) <> 'array' OR jsonb_array_length(p_refs) > 10000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'asset_refs_invalid';
  END IF;

  SELECT c.workspace_id INTO target_workspace_id
  FROM public.canvases c
  WHERE c.id = p_canvas_id
  FOR UPDATE;

  IF target_workspace_id IS NULL
    OR (auth.role() <> 'service_role'
      AND NOT private.is_workspace_admin_or_owner(target_workspace_id))
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'canvas_not_found_or_forbidden';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT asset_id), ARRAY[]::uuid[])
  INTO old_asset_ids
  FROM public.asset_references
  WHERE canvas_id = p_canvas_id;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_refs) incoming
    WHERE private.try_parse_uuid(incoming->>'assetId') IS NULL
      OR NULLIF(btrim(COALESCE(incoming->>'elementId', '')), '') IS NULL
      OR char_length(incoming->>'elementId') > 200
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'asset_refs_invalid';
  END IF;

  FOR ref_asset_id IN
    SELECT DISTINCT (value->>'assetId')::uuid
    FROM jsonb_array_elements(p_refs)
    ORDER BY 1
  LOOP
    PERFORM 1 FROM public.asset_objects
    WHERE id = ref_asset_id
      AND scope = 'workspace'
      AND workspace_id = target_workspace_id
      AND deletion_pending_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'asset_ref_not_available';
    END IF;
  END LOOP;

  DELETE FROM public.asset_references WHERE canvas_id = p_canvas_id;
  FOR ref IN SELECT value FROM jsonb_array_elements(p_refs)
  LOOP
    INSERT INTO public.asset_references(asset_id, canvas_id, workspace_id, element_id)
    VALUES (
      (ref->>'assetId')::uuid, p_canvas_id, target_workspace_id, ref->>'elementId'
    )
    ON CONFLICT (canvas_id, element_id) DO UPDATE
    SET asset_id = EXCLUDED.asset_id, workspace_id = EXCLUDED.workspace_id;
  END LOOP;

  SELECT COALESCE(array_agg(candidate), ARRAY[]::uuid[])
  INTO orphan_candidates
  FROM unnest(old_asset_ids) candidate
  WHERE NOT private.loomic_asset_has_live_references(candidate);

  UPDATE public.asset_objects
  SET gc_eligible_at = COALESCE(gc_eligible_at, now())
  WHERE id = ANY(orphan_candidates);

  RETURN orphan_candidates;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_canvas_asset_ref_upsert(
  p_canvas_id uuid,
  p_asset_id uuid,
  p_element_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_workspace_id uuid;
BEGIN
  IF NULLIF(btrim(COALESCE(p_element_id, '')), '') IS NULL
    OR char_length(p_element_id) > 200
  THEN RETURN false; END IF;

  SELECT c.workspace_id INTO target_workspace_id
  FROM public.canvases c
  WHERE c.id = p_canvas_id;

  IF target_workspace_id IS NULL
    OR (auth.role() <> 'service_role'
      AND NOT private.is_workspace_admin_or_owner(target_workspace_id))
  THEN RETURN false; END IF;

  PERFORM 1 FROM public.asset_objects
  WHERE id = p_asset_id
    AND scope = 'workspace'
    AND workspace_id = target_workspace_id
    AND deletion_pending_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  INSERT INTO public.asset_references(asset_id, canvas_id, workspace_id, element_id)
  VALUES (p_asset_id, p_canvas_id, target_workspace_id, p_element_id)
  ON CONFLICT (canvas_id, element_id) DO UPDATE
  SET asset_id = EXCLUDED.asset_id, workspace_id = EXCLUDED.workspace_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_orphan_asset_claim(p_asset_id uuid)
RETURNS TABLE(bucket text, object_path text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  asset_row public.asset_objects%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  SELECT * INTO asset_row FROM public.asset_objects
  WHERE id = p_asset_id FOR UPDATE;
  IF asset_row.id IS NULL OR private.loomic_asset_has_live_references(p_asset_id) THEN
    RETURN;
  END IF;
  UPDATE public.asset_objects
  SET gc_eligible_at = COALESCE(gc_eligible_at, now()),
      gc_claim_token = COALESCE(gc_claim_token, extensions.gen_random_uuid()),
      gc_claimed_at = COALESCE(gc_claimed_at, now()),
      deletion_pending_at = COALESCE(deletion_pending_at, now())
  WHERE id = p_asset_id;
  RETURN QUERY SELECT asset_row.bucket, asset_row.object_path;
END;
$$;

CREATE OR REPLACE FUNCTION public.loomic_orphan_asset_finalize(p_asset_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  deleted_id uuid;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  DELETE FROM public.asset_objects ao
  WHERE ao.id = p_asset_id
    AND ao.deletion_pending_at IS NOT NULL
    AND NOT private.loomic_asset_has_live_references(ao.id)
  RETURNING ao.id INTO deleted_id;
  RETURN deleted_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.loomic_canvas_asset_refs_replace(uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.loomic_canvas_asset_ref_upsert(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.loomic_orphan_asset_claim(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.loomic_orphan_asset_finalize(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.loomic_canvas_asset_refs_replace(uuid, jsonb)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.loomic_canvas_asset_ref_upsert(uuid, uuid, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.loomic_orphan_asset_claim(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.loomic_orphan_asset_finalize(uuid) TO service_role;

-- Private trigger helpers are never client-callable.
REVOKE ALL ON FUNCTION private.set_canvas_workspace_and_revision()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.validate_design_reference_scope()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.validate_design_catalog_relationship()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.validate_template_asset_reference()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.validate_resource_tag_link_scope()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.validate_design_preview_scope()
  FROM PUBLIC, anon, authenticated;

-- A service-role caller still cannot manufacture a cross-workspace frozen
-- target. Target identity and tenancy become immutable after job creation.
CREATE OR REPLACE FUNCTION private.validate_background_job_target()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_workspace_id uuid;
  target_project_id uuid;
BEGIN
  -- Preserve existing canvas-job writers while storing the canonical target.
  IF TG_OP = 'INSERT' AND NEW.target_kind IS NULL AND NEW.canvas_id IS NOT NULL THEN
    NEW.target_kind := 'canvas';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.canvas_id IS DISTINCT FROM OLD.canvas_id
    OR NEW.target_kind IS DISTINCT FROM OLD.target_kind
    OR NEW.design_id IS DISTINCT FROM OLD.design_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'background_job_target_immutable';
  END IF;

  -- A project is always scoped to its workspace, even for chat-only jobs.
  IF NEW.project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = NEW.project_id AND p.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'background_job_project_scope_mismatch';
  END IF;

  IF NEW.target_kind = 'design' THEN
    IF NEW.design_id IS NULL OR NEW.canvas_id IS NOT NULL OR NEW.project_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'background_job_design_target_invalid';
    END IF;
    SELECT d.workspace_id, d.project_id
    INTO target_workspace_id, target_project_id
    FROM public.design_documents d
    WHERE d.id = NEW.design_id
      AND d.deleted_at IS NULL;

    IF target_workspace_id IS NULL
      OR target_workspace_id IS DISTINCT FROM NEW.workspace_id
      OR target_project_id IS DISTINCT FROM NEW.project_id
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'background_job_design_target_mismatch';
    END IF;
  ELSIF NEW.target_kind = 'canvas' THEN
    IF NEW.canvas_id IS NULL OR NEW.design_id IS NOT NULL OR NEW.project_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'background_job_canvas_target_invalid';
    END IF;
    SELECT c.workspace_id, c.project_id
    INTO target_workspace_id, target_project_id
    FROM public.canvases c
    WHERE c.id = NEW.canvas_id;

    IF target_workspace_id IS NULL
      OR target_workspace_id IS DISTINCT FROM NEW.workspace_id
      OR target_project_id IS DISTINCT FROM NEW.project_id
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'background_job_canvas_target_mismatch';
    END IF;
  ELSIF NEW.target_kind IS NULL THEN
    IF NEW.canvas_id IS NOT NULL OR NEW.design_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'background_job_null_target_invalid';
    END IF;
  ELSE
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'background_job_target_kind_invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS background_jobs_validate_frozen_target ON public.background_jobs;
CREATE TRIGGER background_jobs_validate_frozen_target
BEFORE INSERT OR UPDATE OF workspace_id, project_id, canvas_id, target_kind, design_id
ON public.background_jobs
FOR EACH ROW EXECUTE FUNCTION private.validate_background_job_target();

CREATE OR REPLACE FUNCTION private.validate_job_target_finalization()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  job_row public.background_jobs%ROWTYPE;
  expected_target_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.target_kind IS DISTINCT FROM OLD.target_kind
    OR NEW.target_id IS DISTINCT FROM OLD.target_id
    OR NEW.command_id IS DISTINCT FROM OLD.command_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'job_target_finalization_immutable';
  END IF;

  -- Preserve the ledger's stable uniqueness error even when the attempted row
  -- also contains a mismatched target; callers use this key for idempotency.
  IF EXISTS (
    SELECT 1
    FROM public.job_target_finalizations existing
    WHERE existing.command_id = NEW.command_id
      AND existing.id IS DISTINCT FROM NEW.id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'job_target_finalizations_command_key';
  END IF;

  SELECT * INTO job_row
  FROM public.background_jobs j
  WHERE j.id = NEW.job_id
  FOR KEY SHARE;

  IF job_row.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'job_target_finalization_job_not_found';
  END IF;

  expected_target_id := CASE
    WHEN job_row.target_kind = 'design' THEN job_row.design_id
    WHEN job_row.target_kind = 'canvas' THEN job_row.canvas_id
    ELSE NULL
  END;

  IF expected_target_id IS NULL
    OR NEW.workspace_id IS DISTINCT FROM job_row.workspace_id
    OR NEW.target_kind IS DISTINCT FROM job_row.target_kind
    OR NEW.target_id IS DISTINCT FROM expected_target_id
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'job_target_finalization_target_mismatch';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS job_target_finalizations_validate_target
  ON public.job_target_finalizations;
CREATE TRIGGER job_target_finalizations_validate_target
BEFORE INSERT OR UPDATE OF job_id, workspace_id, target_kind, target_id, command_id
ON public.job_target_finalizations
FOR EACH ROW EXECUTE FUNCTION private.validate_job_target_finalization();

REVOKE ALL ON FUNCTION private.validate_background_job_target()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.validate_job_target_finalization()
  FROM PUBLIC, anon, authenticated;
