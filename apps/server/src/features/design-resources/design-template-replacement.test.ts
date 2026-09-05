import { describe, expect, it } from "vitest";

import {
  designDocumentDtoSchema,
  designTemplateDetailDtoSchema,
  designTemplateReplacePreviewRequestSchema,
} from "@loomic/shared";

import { buildDesignTemplateReplacementPreview } from "./design-template-service.js";

const templateId = "11111111-1111-4111-8111-111111111111";
const designId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const textId = "44444444-4444-4444-8444-444444444444";
const imageId = "55555555-5555-4555-8555-555555555555";
const assetId = "66666666-6666-4666-8666-666666666666";
const replacementAssetId = "77777777-7777-4777-8777-777777777777";
const timestamp = "2026-09-04T00:00:00.000Z";

function scene() {
  return {
    schemaVersion: 1 as const,
    engine: "fabric" as const,
    canvas: { width: 400, height: 300, background: null },
    objects: [
      {
        objectId: textId,
        objectVersion: 3,
        type: "text" as const,
        name: "Main headline",
        role: "title" as const,
        x: 10,
        y: 10,
        width: 200,
        height: 50,
        rotation: 0,
        opacity: 1,
        zIndex: 0,
        locked: false,
        visible: true,
        text: "Old",
        fontFamily: "Inter",
        fontSize: 32,
        fontWeight: 700,
        fontStyle: "normal" as const,
        textAlign: "left" as const,
        lineHeight: 1.2,
        charSpacing: 0,
        fill: { kind: "solid" as const, color: "#000" },
      },
      {
        objectId: imageId,
        objectVersion: 2,
        type: "image" as const,
        name: "Hero",
        role: "product" as const,
        x: 0,
        y: 70,
        width: 300,
        height: 200,
        rotation: 0,
        opacity: 1,
        zIndex: 1,
        locked: false,
        visible: true,
        assetObjectId: assetId,
        fit: "cover" as const,
      },
    ],
  };
}

function detail() {
  return designTemplateDetailDtoSchema.parse({
    template: {
      id: templateId,
      scope: "workspace",
      workspace_id: workspaceId,
      name: "Campaign",
      description: null,
      width: 400,
      height: 300,
      schema_version: 1,
      engine_version: "fabric@7.4.0",
      revision: 4,
      status: "published",
      preview_asset_object_id: null,
      category_id: null,
      tag_ids: [],
      source_url: null,
      author: null,
      license_name: null,
      license_url: null,
      attribution: null,
      usage_restrictions: null,
      deleted_at: null,
      created_at: timestamp,
      updated_at: timestamp,
      variables: [
        {
          key: "headline",
          label: "Headline",
          type: "text",
          required: true,
          target: { object_id: textId, property: "text" },
        },
        {
          key: "headline_color",
          label: "Color",
          type: "color",
          required: false,
          target: { object_id: textId, property: "fill" },
          default_value: "#f00",
        },
        {
          key: "hero",
          label: "Hero",
          type: "image",
          required: true,
          target: { object_id: imageId, property: "asset_object_id" },
        },
      ],
    },
    scene: scene(),
    asset_refs: [],
    font_face_ids: [],
  });
}

function design() {
  return designDocumentDtoSchema.parse({
    id: designId,
    workspace_id: workspaceId,
    project_id: "88888888-8888-4888-8888-888888888888",
    name: "Design",
    width: 400,
    height: 300,
    scene: scene(),
    revision: 8,
    preview_asset_object_id: null,
    preview_revision: 0,
    preview_status: "missing",
    deleted_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  });
}

describe("template smart replacement", () => {
  it("rejects platform drafts and cross-workspace templates", () => {
    const request = designTemplateReplacePreviewRequestSchema.parse({
      design_id: designId,
      template_id: templateId,
      expected_revision: 8,
      expected_template_revision: 4,
    });
    const platformDraft = detail();
    platformDraft.template.scope = "platform";
    platformDraft.template.workspace_id = null;
    platformDraft.template.status = "draft";
    expect(() =>
      buildDesignTemplateReplacementPreview(platformDraft, design(), request),
    ).toThrow(/permission/i);

    const otherWorkspace = detail();
    otherWorkspace.template.workspace_id =
      "99999999-9999-4999-8999-999999999999";
    expect(() =>
      buildDesignTemplateReplacementPreview(otherWorkspace, design(), request),
    ).toThrow(/permission/i);
  });

  it("merges variables per object into CAS commands and exposes every difference", () => {
    const preview = buildDesignTemplateReplacementPreview(
      detail(),
      design(),
      designTemplateReplacePreviewRequestSchema.parse({
        design_id: designId,
        template_id: templateId,
        expected_revision: 8,
        expected_template_revision: 4,
        bindings: [
          {
            key: "hero",
            type: "image",
            value: { asset_object_id: replacementAssetId },
          },
        ],
        smart_bindings: [
          {
            type: "text",
            selector: { role: "title", name: "headline" },
            value: "New headline",
          },
        ],
      }),
    );
    expect(preview.commands).toHaveLength(2);
    expect(preview.commands).not.toContainEqual(
      expect.objectContaining({ action: "scene.replace" }),
    );
    expect(preview.commands[0]).toMatchObject({
      action: "object.update",
      object_id: textId,
      expected_object_version: 3,
      patch: {
        object_type: "text",
        text: "New headline",
        fill: { kind: "solid", color: "#f00" },
      },
    });
    expect(preview.commands).toContainEqual(
      expect.objectContaining({
        action: "object.update",
        object_id: imageId,
        patch: expect.objectContaining({
          asset_object_id: replacementAssetId,
          resource_id: null,
        }),
      }),
    );
    expect(preview.differences.map((item) => item.source)).toEqual([
      "smart",
      "default",
      "binding",
    ]);
    expect(preview.unresolved_keys).toEqual([]);
  });

  it("returns required unresolved keys instead of silently changing the scene", () => {
    const preview = buildDesignTemplateReplacementPreview(
      detail(),
      design(),
      designTemplateReplacePreviewRequestSchema.parse({
        design_id: designId,
        template_id: templateId,
        expected_revision: 8,
        expected_template_revision: 4,
      }),
    );
    expect(preview.unresolved_keys).toEqual(["headline", "hero"]);
    expect(preview.commands).toHaveLength(1);
  });
});
