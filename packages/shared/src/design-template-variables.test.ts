import { describe, expect, it } from "vitest";

import {
  designTemplateReplacePreviewRequestSchema,
  designTemplateVariablesSchema,
} from "./design-contracts.js";

const objectId = "11111111-1111-4111-8111-111111111111";

describe("design template variable contracts", () => {
  it("accepts typed text, image, color and font variables", () => {
    expect(
      designTemplateVariablesSchema.parse([
        {
          key: "headline",
          label: "Headline",
          type: "text",
          required: true,
          target: { object_id: objectId, property: "text" },
        },
        {
          key: "hero",
          label: "Hero",
          type: "image",
          required: false,
          target: { object_id: objectId, property: "asset_object_id" },
        },
        {
          key: "brand",
          label: "Brand",
          type: "color",
          required: false,
          target: { object_id: objectId, property: "fill" },
          default_value: "#fff",
        },
        {
          key: "brand_font",
          label: "Font",
          type: "font",
          required: false,
          target: { object_id: objectId, property: "font_face_id" },
          default_value: { font_face_id: objectId, font_family: "Inter" },
        },
      ]),
    ).toHaveLength(4);
  });

  it("rejects duplicate keys, mismatched properties and empty smart selectors", () => {
    const duplicate = {
      key: "headline",
      label: "Headline",
      type: "text",
      required: true,
      target: { object_id: objectId, property: "text" },
    };
    expect(() =>
      designTemplateVariablesSchema.parse([duplicate, duplicate]),
    ).toThrow();
    expect(() =>
      designTemplateVariablesSchema.parse([
        { ...duplicate, target: { object_id: objectId, property: "fill" } },
      ]),
    ).toThrow();
    expect(() =>
      designTemplateReplacePreviewRequestSchema.parse({
        design_id: objectId,
        template_id: objectId,
        expected_revision: 0,
        expected_template_revision: 0,
        smart_bindings: [{ type: "text", selector: {}, value: "Hello" }],
      }),
    ).toThrow();
  });
});
