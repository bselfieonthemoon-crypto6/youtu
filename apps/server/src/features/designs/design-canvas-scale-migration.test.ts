import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL(
    "../../../../../supabase/migrations/20260904000004_design_canvas_scale_semantics.sql",
    import.meta.url,
  ),
);
const sql = readFileSync(migrationPath, "utf8");

describe("design canvas scale semantics migration", () => {
  it("installs a fail-closed canonical scale helper", () => {
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION private.loomic_apply_canvas_update",
    );
    expect(sql).toContain("LEAST(next_width / previous_width");
    expect(sql).toContain("offset_x := (next_width - previous_width");
    expect(sql).toContain("offset_y := (next_height - previous_height");
    expect(sql).toContain("'{objectVersion}'");
    expect(sql).toContain("+ 1), true");
    expect(sql).toContain("unexpected loomic_design_mutate predecessor");
    expect(sql).toContain("EXECUTE function_definition");
  });

  it("makes scale command-authoritative and preserves service-only RPC access", () => {
    expect(sql).toContain("design_canvas_scale_must_be_exclusive");
    expect(sql).toContain("design_canvas_scale_mismatch");
    expect(sql).toContain(
      "p_next_scene IS DISTINCT FROM expected_scaled_scene",
    );
    expect(sql).toContain("exact_objects := exact_objects ||");
    expect(sql).toContain("FROM PUBLIC, anon, authenticated, service_role");
    expect(sql).toContain("TO service_role;");
  });
});
