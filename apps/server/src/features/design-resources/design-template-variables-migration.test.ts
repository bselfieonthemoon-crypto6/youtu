import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../../supabase/migrations/20260907000002_design_template_variables.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("design template variables migration", () => {
  it("stores variables and validates strict typed targets", () => {
    expect(sql).toContain(
      "ADD COLUMN variables jsonb NOT NULL DEFAULT '[]'::jsonb",
    );
    expect(sql).toContain("private.loomic_validate_template_variables");
    expect(sql).toContain(
      "ARRAY['key','label','type','target','required','default_value']",
    );
    expect(sql).toContain(
      "variable->>'type' NOT IN ('text','image','color','font')",
    );
    expect(sql).toContain("template_variable_target_missing");
    expect(sql).toContain("target_object->>'type' NOT IN ('text','textbox')");
    expect(sql).toContain("target_object->>'type' <> 'image'");
  });

  it("updates variables with authorization, CAS and idempotency", () => {
    expect(sql).toContain("public.loomic_template_variables_update");
    expect(sql).toContain("private.loomic_assert_catalog_actor");
    expect(sql).toContain("catalog_idempotency_conflict");
    expect(sql).toContain("template_row.revision <> p_expected_revision");
    expect(sql).toContain("variables=p_variables,revision=revision+1");
    expect(sql).toContain("TO service_role");
    expect(sql).not.toContain("TO authenticated");
  });
});
