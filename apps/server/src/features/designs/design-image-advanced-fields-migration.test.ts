import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL(
    "../../../../../supabase/migrations/20260907000001_design_image_advanced_fields.sql",
    import.meta.url,
  ),
);
const sql = readFileSync(migrationPath, "utf8");

describe("advanced design image fields migration", () => {
  it("preserves the strict Stage 6 validator and wraps it", () => {
    expect(sql).toContain("RENAME TO loomic_validate_design_scene_stage6");
    expect(sql).toContain(
      "private.loomic_validate_design_scene_stage6(base_scene, p_width, p_height)",
    );
    expect(sql).toContain("CASE WHEN object_data->>'type' = 'image'");
    expect(sql).toContain(
      "object_data - ARRAY['crop', 'mask', 'filters', 'stroke', 'strokeWidth', 'shadow']",
    );
  });

  it("validates crop, mask and filters with the shared bounds", () => {
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION private.loomic_valid_finite_json_number",
    );
    expect(sql).toContain("<= 1.7976931348623157e308::numeric");
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION private.loomic_valid_image_crop",
    );
    expect(sql).toContain("crop_x + crop_width <= 1");
    expect(sql).toContain("crop_y + crop_height <= 1");
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION private.loomic_valid_image_mask",
    );
    expect(sql).toContain(
      "mask_shape NOT IN ('rect', 'ellipse', 'rounded_rect')",
    );
    expect(sql).toContain(
      "mask_shape <> 'rounded_rect' AND p_value ? 'radius'",
    );
    expect(sql).toContain("mask_radius NOT BETWEEN 0 AND 0.5");
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION private.loomic_valid_image_filters",
    );
    expect(sql).toContain("p_value = '{}'::jsonb");
    expect(sql).toContain("filter_value NOT BETWEEN -1 AND 1");
    expect(sql).toContain("filter_value NOT BETWEEN 0 AND 1");
    expect(sql).toContain(
      "private.loomic_valid_image_paint(object_data->'stroke')",
    );
    expect(sql).toContain(
      "private.loomic_valid_image_shadow(object_data->'shadow')",
    );
  });

  it("adds only the six advanced fields to image patching", () => {
    expect(sql).toContain(
      "'crop', 'mask', 'filters', 'stroke', 'stroke_width', 'shadow'",
    );
    expect(sql).toContain("WHEN 'stroke_width' THEN 'strokeWidth'");
    expect(sql).toContain("MESSAGE = 'design_object_patch_field_not_allowed'");
  });
});
