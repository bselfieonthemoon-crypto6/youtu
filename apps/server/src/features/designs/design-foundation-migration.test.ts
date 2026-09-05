import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL(
    "../../../../../supabase/migrations/20260903000001_native_design_board_foundation.sql",
    import.meta.url,
  ),
);
const sql = readFileSync(migrationPath, "utf8");

function functionBody(name: string, nextMarker: string) {
  return sql.slice(
    sql.indexOf(name),
    sql.indexOf(nextMarker, sql.indexOf(name)),
  );
}

describe("native design board foundation migration", () => {
  it("adds the durable design, catalog, import, finalization and outbox records", () => {
    for (const table of [
      "platform_admins",
      "design_creation_requests",
      "design_documents",
      "design_nodes",
      "design_document_versions",
      "design_document_asset_refs",
      "design_document_font_refs",
      "design_templates",
      "design_template_asset_refs",
      "text_presets",
      "design_resources",
      "font_families",
      "font_faces",
      "resource_categories",
      "resource_tags",
      "resource_tag_links",
      "resource_favorites",
      "resource_recent_uses",
      "resource_import_jobs",
      "resource_import_items",
      "job_target_finalizations",
      "design_event_outbox",
    ]) {
      expect(sql).toContain(`CREATE TABLE public.${table}`);
    }
    expect(sql).toContain(
      "ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0",
    );
    expect(sql).toContain("design_nodes_one_live_node_per_design_key");
    expect(sql).toContain("design_document_versions_idempotency_key");
    expect(sql).toContain("command_id uuid NOT NULL");
    expect(sql).not.toContain("command_id text NOT NULL");
  });

  it("extends assets without invalidating existing workspace rows", () => {
    expect(sql).toContain(
      "UPDATE public.asset_objects\nSET scope = 'workspace'",
    );
    expect(sql).toContain("ALTER COLUMN workspace_id DROP NOT NULL");
    expect(sql).toContain("scope = 'platform' AND workspace_id IS NULL");
    expect(sql).toContain("scope = 'workspace' AND workspace_id IS NOT NULL");
    expect(sql).toContain(
      "VALUES ('platform-assets', 'platform-assets', false)",
    );
    expect(sql).toContain("bucket <> 'platform-assets'");
  });

  it("keeps writes server-controlled and applies the member/admin/platform matrix", () => {
    expect(sql).toContain('CREATE POLICY "design_documents_select_member"');
    expect(sql).toContain("private.is_workspace_member(workspace_id)");
    expect(sql).toContain("private.is_workspace_admin_or_owner");
    expect(sql).toContain("private.is_platform_admin");
    expect(sql).toContain("private.can_read_design_catalog_record");
    expect(sql).toContain("status = 'published'");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain(
      "REVOKE INSERT, UPDATE, DELETE ON public.design_documents, public.design_nodes",
    );
    expect(sql).toContain(
      "REVOKE ALL ON public.design_creation_requests, public.job_target_finalizations",
    );
    expect(sql).not.toContain("'unpublished'");
    expect(sql).toContain(
      "'draft', 'pending_review', 'published', 'rejected', 'disabled'",
    );
  });

  it("creates a design and its canvas node atomically and replayably", () => {
    const createFunction = functionBody(
      "CREATE OR REPLACE FUNCTION public.loomic_design_create",
      "CREATE OR REPLACE FUNCTION public.loomic_design_mutate",
    );
    expect(createFunction).toContain("FOR UPDATE");
    expect(createFunction).toContain("design_creation_requests");
    expect(createFunction).toContain("p_expected_canvas_revision");
    expect(createFunction).toContain("canvas_revision_conflict");
    expect(createFunction).toContain("'previewRevision', 0");
    expect(createFunction).toContain("'{replayed}', 'true'::jsonb");
    expect(createFunction).toContain("'replayed', false");
    expect(createFunction).toContain("object_id_map");
    expect(createFunction).toContain("'{childObjectIds}'");
    expect(createFunction).toContain("INSERT INTO public.design_nodes");
    expect(createFunction).toContain("INSERT INTO public.design_event_outbox");
    expect(createFunction).toContain("'type', 'design.sync'");
    expect(createFunction).toContain("'updateType', 'created'");
    expect(createFunction).toContain("'previewAssetObjectId', NULL");
    expect(createFunction).toContain("'previewRevision', 0");
    expect(createFunction).toContain("TO authenticated;");
  });

  it("uses the shared command action names and enforces CAS/object versions", () => {
    const mutateFunction = functionBody(
      "CREATE OR REPLACE FUNCTION public.loomic_design_mutate",
      "ALTER TABLE public.design_document_asset_refs",
    );
    for (const action of [
      "object.add",
      "object.update",
      "object.remove",
      "object.clone",
      "object.reorder",
      "objects.group",
      "objects.ungroup",
      "objects.align",
      "objects.distribute",
      "object.set_role",
      "canvas.update",
      "scene.replace",
    ]) {
      expect(mutateFunction).toContain(`'${action}'`);
    }
    expect(mutateFunction).not.toContain("object.add_text");
    expect(mutateFunction).toContain("design_revision_conflict");
    expect(mutateFunction).toContain("design_object_version_conflict");
    expect(mutateFunction).toContain("expected_object_version");
    expect(mutateFunction).toContain("command->>'source_object_id'");
    expect(mutateFunction).toContain("command->'children'");
    expect(mutateFunction).toContain("command->'objects'");
    expect(mutateFunction).toContain("command->>'to_index'");
    expect(mutateFunction).toContain("command->'role'");
    expect(mutateFunction).toContain("command#>>'{patch,object_type}'");
    expect(mutateFunction).toContain("design_object_patch_type_mismatch");
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION private.loomic_apply_object_patch",
    );
    expect(mutateFunction).toContain("design_object_update_mismatch");
    expect(mutateFunction).toContain("design_scene_uncommanded_change");
    expect(mutateFunction).toContain("design_object_order_mismatch");
    expect(mutateFunction).toContain("design_object_uncommanded_change");
    expect(mutateFunction).toContain("exact_objects ? target_object_id");
    expect(mutateFunction).toContain(
      "(command#>>'{group,objectVersion}')::integer <> 1",
    );
    expect(mutateFunction).toContain("command#>'{group,childObjectIds}'");
    expect(mutateFunction).toContain(
      "child_id#>>'{}' = child_ref->>'object_id'",
    );
    expect(mutateFunction).toContain(
      "child_ref->>'object_id' = child_id#>>'{}'",
    );
    expect(mutateFunction).toContain(
      "jsonb_array_length(p_commands) NOT BETWEEN 1 AND 500",
    );
    expect(mutateFunction).toContain(
      "next_revision := design_row.revision + 1",
    );
    expect(mutateFunction).toContain("next_revision % 50 = 0");
    expect(mutateFunction).toContain(
      "'changed_object_ids', changed_object_ids",
    );
    expect(mutateFunction).toContain("'replayed', true");
    expect(mutateFunction).toContain("'type', 'design.sync'");
    expect(mutateFunction).toContain("'updateType', 'mutated'");
    expect(mutateFunction).not.toContain("'changeType'");
    expect(mutateFunction).not.toContain("'commands_applied'");
    expect(mutateFunction).toContain("TO service_role;");
  });

  it("enforces canonical preview states and scene z-index ordering", () => {
    expect(sql).not.toContain("changeType");
    expect(sql).not.toContain("commands_applied");
    expect(sql).toContain("design_documents_preview_state_check");
    expect(sql).toContain("preview_status = 'missing'");
    expect(sql).toContain(
      "preview_asset_object_id IS NULL AND preview_revision = 0",
    );
    expect(sql).toContain("preview_status = 'ready'");
    expect(sql).toContain("preview_asset_object_id IS NOT NULL");
    expect(sql).toContain("preview_revision = revision");
    expect(sql).toContain("preview_status = 'stale'");
    expect(sql).toContain("preview_revision < revision");
    expect(sql).toContain("preview_status IN ('queued', 'error')");
    expect(sql).toContain("WITH ORDINALITY");
    expect(sql).toContain("design_z_index_order_invalid");
    expect(sql).toContain("(ordered_object.ordinal - 1)::integer");
    expect(sql).toContain("design_group_multiple_parents");
    expect(sql).toContain("design_group_cycle");
    expect(sql).toContain("WITH RECURSIVE group_edges");
  });

  it("validates every persisted object type with strict keys and typed styles", () => {
    const validator = functionBody(
      "CREATE OR REPLACE FUNCTION private.loomic_validate_design_scene",
      "CREATE OR REPLACE FUNCTION private.loomic_scene_object_by_id",
    );
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION private.loomic_jsonb_object_has_only_keys",
    );
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION private.loomic_valid_paint",
    );
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION private.loomic_valid_shadow",
    );
    for (const objectType of [
      "image",
      "svg",
      "text",
      "textbox",
      "rect",
      "circle",
      "triangle",
      "line",
      "arrow",
      "group",
    ]) {
      expect(validator).toContain(`WHEN '${objectType}'`);
    }
    expect(validator).toContain("'assetObjectId', 'resourceId', 'fit'");
    expect(validator).toContain("'fontFamily', 'fontSize', 'fontWeight'");
    expect(validator).toContain("'fill', 'stroke', 'strokeWidth'");
    expect(validator).toContain("'arrowStart', 'arrowEnd'");
    expect(validator).toContain("ARRAY['childObjectIds']");
    expect(validator).toContain("NOT private.loomic_valid_paint");
    expect(validator).toContain("NOT private.loomic_valid_shadow");
    expect(validator).toContain("design_objects_invalid");
  });

  it("rejects cross-workspace references and keeps GC reference-complete", () => {
    expect(sql).toContain("design_asset_workspace_mismatch");
    expect(sql).toContain("design_font_workspace_mismatch");
    expect(sql).toContain("template_asset_scope_mismatch");
    expect(sql).toContain("resource_tag_scope_mismatch");
    expect(sql).toContain("design_preview_workspace_mismatch");

    const liveReferenceFunction = functionBody(
      "CREATE OR REPLACE FUNCTION private.loomic_asset_has_live_references",
      "CREATE OR REPLACE FUNCTION private.cancel_asset_gc_on_reference",
    );
    for (const reference of [
      "public.asset_references",
      "public.design_document_asset_refs",
      "public.design_documents",
      "public.design_template_asset_refs",
      "public.design_templates",
      "public.text_presets",
      "public.design_resources",
      "public.font_faces",
      "public.resource_import_items",
      "public.background_jobs",
    ]) {
      expect(liveReferenceFunction).toContain(reference);
    }
    expect(sql).toContain("loomic_asset_gc_claim");
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION private.loomic_jsonb_has_asset_reference",
    );
    expect(sql).toContain(
      "private.loomic_jsonb_has_asset_reference(j.result, p_asset_id)",
    );
    expect(sql).toContain("loomic_asset_gc_prepare_delete");
    expect(sql).toContain("loomic_asset_gc_finalize");
    expect(sql).toContain("gc_claim_token = p_claim_token");
    expect(sql).toContain("MESSAGE = 'service_role_required'");
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.loomic_orphan_asset_claim(uuid) TO service_role",
    );
  });

  it("freezes design job targets and protects idempotent finalization", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS target_kind text");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS design_id uuid");
    expect(sql).toContain("background_jobs_target_kind_check");
    expect(sql).toContain("ALTER COLUMN target_kind DROP DEFAULT");
    expect(sql).toContain(
      "target_kind IS NULL AND canvas_id IS NULL AND design_id IS NULL",
    );
    expect(sql).toContain(
      "target_kind = 'canvas' AND canvas_id IS NOT NULL AND design_id IS NULL",
    );
    expect(sql).toContain(
      "target_kind = 'design' AND design_id IS NOT NULL AND canvas_id IS NULL",
    );
    expect(sql).toContain("job_target_finalizations_target_key");
    expect(sql).toContain("job_target_finalizations_command_key");
    expect(sql).toContain(
      "ALTER TYPE public.background_job_type ADD VALUE IF NOT EXISTS 'design_preview'",
    );
    expect(sql).toContain(
      "ALTER TYPE public.background_job_type ADD VALUE IF NOT EXISTS 'design_export'",
    );
  });

  it("rejects cross-tenant job targets even for service-role writers", () => {
    const jobTargetGuard = functionBody(
      "CREATE OR REPLACE FUNCTION private.validate_background_job_target",
      "DROP TRIGGER IF EXISTS background_jobs_validate_frozen_target",
    );
    expect(jobTargetGuard).toContain("background_job_target_immutable");
    expect(jobTargetGuard).toContain("background_job_design_target_mismatch");
    expect(jobTargetGuard).toContain("background_job_canvas_target_mismatch");
    expect(jobTargetGuard).toContain("background_job_project_scope_mismatch");
    expect(jobTargetGuard).toContain("background_job_canvas_target_invalid");
    expect(jobTargetGuard).toContain("background_job_design_target_invalid");
    expect(jobTargetGuard).toContain("background_job_null_target_invalid");
    expect(jobTargetGuard).toContain(
      "target_workspace_id IS DISTINCT FROM NEW.workspace_id",
    );
    expect(jobTargetGuard).toContain(
      "target_project_id IS DISTINCT FROM NEW.project_id",
    );
    expect(sql).toContain(
      "CREATE TRIGGER background_jobs_validate_frozen_target",
    );

    const finalizationGuard = functionBody(
      "CREATE OR REPLACE FUNCTION private.validate_job_target_finalization",
      "DROP TRIGGER IF EXISTS job_target_finalizations_validate_target",
    );
    expect(finalizationGuard).toContain("job_target_finalization_immutable");
    expect(finalizationGuard).toContain(
      "MESSAGE = 'job_target_finalizations_command_key'",
    );
    expect(finalizationGuard).toContain(
      "job_target_finalization_target_mismatch",
    );
    expect(finalizationGuard).toContain(
      "NEW.workspace_id IS DISTINCT FROM job_row.workspace_id",
    );
    expect(finalizationGuard).toContain(
      "NEW.target_kind IS DISTINCT FROM job_row.target_kind",
    );
    expect(finalizationGuard).toContain(
      "NEW.target_id IS DISTINCT FROM expected_target_id",
    );
    expect(sql).toContain(
      "CREATE TRIGGER job_target_finalizations_validate_target",
    );
  });

  it("hides soft-deleted designs and draft platform asset metadata", () => {
    expect(sql).toContain(
      "USING (deleted_at IS NULL AND private.is_workspace_member(workspace_id))",
    );
    expect(sql).toContain("WHERE d.id = design_id AND d.deleted_at IS NULL");
    const assetPolicy = functionBody(
      'CREATE POLICY "asset_objects_select_authorized"',
      'DROP POLICY IF EXISTS "asset_objects_insert_admin"',
    );
    expect(assetPolicy).toContain("private.is_platform_admin(auth.uid())");
    expect(assetPolicy).toContain("r.status = 'published'");
    expect(assetPolicy).toContain("t.status = 'published'");
    expect(assetPolicy).toContain("tp.status = 'published'");
    expect(assetPolicy).toContain("ff.status = 'published'");
    expect(assetPolicy).not.toContain("OR scope = 'platform'");
  });
});
