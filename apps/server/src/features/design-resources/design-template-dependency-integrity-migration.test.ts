import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../../supabase/migrations/20260907000004_design_template_dependency_integrity.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("Stage 7 template dependency integrity migration", () => {
  it("binds a design resource to its exact asset object", () => {
    expect(sql).toContain("source_resource_asset_object_id");
    expect(sql).toContain(
      "source_resource_asset_object_id IS DISTINCT FROM NEW.asset_object_id",
    );
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION private.validate_design_reference_scope",
    );
  });

  it("authoritatively validates typed variable defaults", () => {
    expect(sql).toContain(
      "private.loomic_validate_template_variable_dependencies",
    );
    expect(sql).toContain("r.asset_object_id = ao.id");
    expect(sql).toContain("family.name = default_value->>'font_family'");
    expect(sql).toContain("r.status = 'published'");
    expect(sql).toContain("ff.status = 'published'");
    expect(sql).toContain("family.status = 'published'");
  });

  it("keeps image and font defaults alive through normalized refs", () => {
    expect(sql).toContain("private.loomic_sync_template_variable_references");
    expect(sql).toContain("'variable:' || (variable->>'key')");
    expect(sql).toContain("public.design_template_font_refs");
    expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED");
  });
});
