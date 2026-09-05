import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL(
    "../../../../../supabase/migrations/20260905000001_design_resource_catalog_stage5.sql",
    import.meta.url,
  ),
);
const sql = readFileSync(migrationPath, "utf8");
const hardeningMigrationPath = fileURLToPath(
  new URL(
    "../../../../../supabase/migrations/20260905000002_catalog_import_lease_and_publication_authorization.sql",
    import.meta.url,
  ),
);
const hardeningSql = readFileSync(hardeningMigrationPath, "utf8");
const mixedManifestMigrationPath = fileURLToPath(
  new URL(
    "../../../../../supabase/migrations/20260905000003_mixed_manifest_import_enqueue.sql",
    import.meta.url,
  ),
);
const mixedManifestSql = readFileSync(mixedManifestMigrationPath, "utf8");

function functionBody(name: string, nextMarker: string) {
  return sql.slice(
    sql.indexOf(name),
    sql.indexOf(nextMarker, sql.indexOf(name)),
  );
}

describe("Stage 5 design resource catalog migration", () => {
  it("extends the foundation additively with revisions and normalized references", () => {
    expect(sql).not.toContain("DROP TABLE public.design_");
    expect(sql).toContain("ADD COLUMN revision bigint NOT NULL DEFAULT 0");
    for (const table of [
      "design_template_font_refs",
      "text_preset_font_refs",
      "design_template_tag_links",
      "text_preset_tag_links",
      "catalog_mutation_requests",
    ]) {
      expect(sql).toContain(`CREATE TABLE public.${table}`);
      expect(sql).toContain(
        `ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`,
      );
    }
    expect(sql).toContain("ADD COLUMN resource_id uuid");
    expect(sql).toContain("allow_web_embed boolean NOT NULL DEFAULT false");
    expect(sql).toContain("design_resources_dimensions_pair_check");
    expect(sql).toContain("font_faces_checksum_check");
  });

  it("keeps all catalog writes behind actor-authorized CAS RPCs", () => {
    const create = functionBody(
      "CREATE OR REPLACE FUNCTION public.loomic_catalog_create",
      "CREATE OR REPLACE FUNCTION public.loomic_catalog_update",
    );
    expect(create).toContain("private.loomic_assert_catalog_actor");
    expect(create).toContain("catalog_mutation_requests");
    expect(create).toContain("catalog_idempotency_conflict");
    expect(create).toContain("'{replayed}'");
    expect(create).toContain("private.loomic_sync_catalog_references");

    const update = functionBody(
      "CREATE OR REPLACE FUNCTION public.loomic_catalog_update",
      "CREATE OR REPLACE FUNCTION public.loomic_catalog_set_status",
    );
    expect(update).toContain("p_expected_revision");
    expect(update).toContain("catalog_revision_conflict");
    expect(update).toContain("catalog_patch_unknown_field");
    expect(update).not.toContain("status = CASE WHEN p_patch");

    expect(sql).toContain("TO service_role;");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.loomic_catalog_create",
    );
    expect(sql).not.toContain("GRANT INSERT ON public.design_resources");
  });

  it("enforces publication dependencies and safe soft deletion", () => {
    const publish = functionBody(
      "CREATE OR REPLACE FUNCTION private.loomic_catalog_publishable",
      "CREATE OR REPLACE FUNCTION private.loomic_catalog_transition_allowed",
    );
    expect(publish).toContain("preview_asset_object_id IS NOT NULL");
    expect(publish).toContain("ff.status <> 'published'");
    expect(publish).toContain("NOT ff.allow_web_embed");
    expect(publish).toContain("r.status <> 'published'");
    expect(sql).toContain("catalog_publication_dependencies_unavailable");

    const deleted = functionBody(
      "CREATE OR REPLACE FUNCTION public.loomic_catalog_set_deleted",
      "CREATE OR REPLACE FUNCTION public.loomic_resource_favorite_set",
    );
    expect(deleted).toContain("catalog_entity_in_use");
    expect(deleted).toContain("design_document_asset_refs");
    expect(deleted).toContain("design_template_asset_refs");
    expect(deleted).toContain("design_document_font_refs");
  });

  it("provides scoped taxonomy, favorites, recent-use and import primitives", () => {
    expect(sql).toContain("resource_category_cycle");
    expect(sql).toContain("catalog_reference_scope_mismatch");
    expect(sql).toContain("recent_resource_scope_mismatch");
    expect(sql).toContain("public.loomic_resource_favorite_set");
    expect(sql).toContain("public.loomic_record_resource_recent_use");
    expect(sql).toContain("public.loomic_resource_import_create");
    expect(sql).toContain("public.loomic_resource_import_claim");
    expect(sql).toContain("public.loomic_resource_import_finalize_item");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("attempt_count<3");
  });
});

describe("Stage 5 catalog import and publication hardening migration", () => {
  it("fences every import terminal transition with the current job and item token", () => {
    expect(hardeningSql).toContain("ADD COLUMN claim_token uuid");
    expect(hardeningSql).toContain(
      "SET status = 'running', claim_token = p_claim_token",
    );
    expect(hardeningSql).toContain(
      "job_row.claim_token IS DISTINCT FROM p_claim_token",
    );
    expect(hardeningSql).toContain(
      "item_row.claim_token IS DISTINCT FROM p_claim_token",
    );
    expect(hardeningSql).toContain("resource_import_lost_lease");
    for (const routine of [
      "loomic_resource_import_finalize_item",
      "loomic_resource_import_defer",
      "loomic_resource_import_complete",
    ]) {
      const start = hardeningSql.indexOf(`FUNCTION public.${routine}`);
      expect(start).toBeGreaterThan(-1);
      expect(hardeningSql.slice(start, start + 1_000)).toContain(
        "p_claim_token uuid",
      );
    }
    expect(hardeningSql).toContain(
      "DROP FUNCTION public.loomic_resource_import_finalize_item",
    );
  });

  it("requires verifiable authorization for every publishable catalog kind", () => {
    expect(hardeningSql).toContain(
      "private.loomic_catalog_license_is_verifiable",
    );
    expect(hardeningSql).toContain("NULLIF(btrim(p_license_name), '')");
    expect(hardeningSql).toContain("p_license_url ~* '^https?://");
    expect(hardeningSql).toContain("p_usage_restrictions");
    for (const kind of [
      "resource",
      "template",
      "text_preset",
      "font_face",
      "font_family",
    ]) {
      expect(hardeningSql).toContain(`WHEN '${kind}' THEN`);
    }
    expect(hardeningSql).toContain("font_faces_validate_publication_license");
    expect(hardeningSql).toContain(
      "font_families_protect_published_face_license",
    );
    expect(hardeningSql).toContain("SET status = 'disabled'");
  });
});

describe("Stage 5 mixed manifest import migration", () => {
  it("widens terminal entity kinds without weakening the item constraint", () => {
    expect(mixedManifestSql).toContain(
      "DROP CONSTRAINT IF EXISTS resource_import_items_result_entity_kind_check",
    );
    for (const kind of [
      "resource",
      "template",
      "text_preset",
      "font_family",
      "font_face",
      "category",
      "tag",
    ]) {
      expect(mixedManifestSql).toContain(`'${kind}'`);
    }
  });

  it("atomically normalizes and enqueues a strict bounded manifest", () => {
    expect(mixedManifestSql).toContain(
      "public.loomic_resource_import_manifest_enqueue",
    );
    expect(mixedManifestSql).toContain("item_count NOT BETWEEN 1 AND 100");
    expect(mixedManifestSql).toContain(
      "private.loomic_jsonb_object_has_only_keys",
    );
    expect(mixedManifestSql).toContain(
      "count(DISTINCT btrim(entry.item->>'source_key'))",
    );
    expect(mixedManifestSql).toContain(
      "resource_import_manifest_source_key_duplicate",
    );
    expect(mixedManifestSql).toContain("jsonb_typeof(entry.item->'metadata')");
    expect(mixedManifestSql).toContain(
      "'entity_kind', entry.item->>'entity_kind'",
    );
    expect(mixedManifestSql).toContain(
      "'manifest_index', entry.ordinality - 1",
    );
    expect(mixedManifestSql).toContain(
      "INSERT INTO public.resource_import_jobs",
    );
    expect(mixedManifestSql).toContain(
      "INSERT INTO public.resource_import_items",
    );
  });

  it("uses actor-scoped input-hash idempotency and remains service-only", () => {
    expect(mixedManifestSql).toContain("private.loomic_assert_catalog_actor");
    expect(mixedManifestSql).toContain("catalog_mutation_requests");
    expect(mixedManifestSql).toContain("catalog_idempotency_conflict");
    expect(mixedManifestSql).toContain("'{replayed}'");
    expect(mixedManifestSql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.loomic_resource_import_manifest_enqueue\([\s\S]*?\) TO service_role;/,
    );
    expect(mixedManifestSql).not.toMatch(
      /GRANT EXECUTE[\s\S]*loomic_resource_import_manifest_enqueue[\s\S]*TO authenticated/,
    );
  });
});
