import { describe, expect, it } from "vitest";

import {
  agentDesignToolErrorOutputSchema,
  agentDesignToolExecutionContextSchema,
  applyDesignCanvasUpdate,
  applyDesignTemplateToolInputSchema,
  applyDesignTemplateToolOutputSchema,
  canvasRevisionConflictResponseSchema,
  createDesignFontFaceRequestSchema,
  createDesignImportRequestSchema,
  createDesignTextPresetRequestSchema,
  designCatalogListRequestSchema,
  designCatalogMutationResponseSchema,
  designCommandSchema,
  designConflictResponseSchema,
  designDocumentDtoSchema,
  designDocumentVersionDtoSchema,
  designErrorResponseSchema,
  designEventOutboxDtoSchema,
  designExportPayloadSchema,
  designExportRequestSchema,
  designFontFaceDtoSchema,
  designGetResponseSchema,
  designImportItemDtoSchema,
  designLifecycleResponseSchema,
  designMutationRequestSchema,
  designReferencesResponseSchema,
  designResourceCategoryDtoSchema,
  designResourceDtoSchema,
  designResourceFavoriteDtoSchema,
  designResourceRecentUseDtoSchema,
  designResourceTagDtoSchema,
  designSyncEventSchema,
  designTemplateDetailDtoSchema,
  designTextPresetDtoSchema,
  exportDesignToolInputSchema,
  exportDesignToolOutputSchema,
  getDesignObjectsToolInputSchema,
  getDesignObjectsToolOutputSchema,
  inspectDesignToolInputSchema,
  inspectDesignToolOutputSchema,
  jobTargetFinalizationDtoSchema,
  jobTargetSchema,
  loomicDesignNodeMetadataSchema,
  loomicSceneV1Schema,
  manualCanvasImageImportRequestSchema,
  manualCanvasImageImportResponseSchema,
  manipulateDesignToolInputSchema,
  manipulateDesignToolOutputSchema,
  platformAdminDtoSchema,
  queueDesignPreviewRequestSchema,
  queueDesignPreviewResponseSchema,
  searchDesignResourcesToolInputSchema,
  searchDesignResourcesToolOutputSchema,
  setDesignCatalogStatusRequestSchema,
  updateDesignResourceRequestSchema,
  undoManualCanvasImageImportRequestSchema,
} from "./design-contracts.js";
import { wsServerMessageSchema } from "./ws-protocol.js";

const ids = {
  object: "3417e887-ddf1-4e77-957d-2d951986a3ee",
  object2: "74066fc9-7141-475c-b911-886f6262fe00",
  object3: "a202227f-e4e5-4b90-a55c-e8d507e719a4",
  group: "816c03dc-d355-4466-8922-c8929fc00809",
  group2: "87d29501-c414-4616-a147-50deaa19de0a",
  design: "c135316a-d3fa-49ba-872a-49ae9f43d6b6",
  asset: "e05a0bce-d97d-4618-be7d-d65b9a5dd9ca",
  resource: "93c4139f-f095-488e-97d4-60be01f6427d",
  workspace: "b25cc66f-7f3c-43ad-916a-aaab99c8bffb",
  project: "0d2f35aa-89f8-40ec-a929-eb0b31b55ea8",
  request: "4b78daa3-fdc4-4ec7-91b4-6e05cf35c833",
  user: "5ef89135-aab3-4f95-98e9-29c5a20f34a7",
} as const;

const now = "2026-09-04T00:00:00.000Z";
const solid = (color: string) => ({ kind: "solid" as const, color });

const base = (objectId: string, zIndex: number, objectVersion = 1) => ({
  objectId,
  objectVersion,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  opacity: 1,
  zIndex,
  locked: false,
  visible: true,
});

describe("manual canvas image import contracts", () => {
  const valid = {
    request_id: ids.request,
    design_id: ids.design,
    expected_design_revision: 2,
    canvas_id: ids.project,
    source_element_id: "image-1",
    expected_source_element_version: 4,
    board_element_id: "board-1",
    expected_board_element_version: 7,
    mode: "copy" as const,
    placement: {
      kind: "preserve" as const,
      scene_pose: { x: 10, y: 20, width: 300, height: 200, angle: 0.5 },
    },
  };

  it("accepts a strict transient copy pose and bounded replay response", () => {
    expect(manualCanvasImageImportRequestSchema.parse(valid)).toEqual(valid);
    expect(
      manualCanvasImageImportResponseSchema.parse({
        operation_id: ids.request,
        design_id: ids.design,
        design_revision: 3,
        object_id: ids.request,
        object_version: 1,
        source_canvas_id: ids.project,
        source_canvas_revision: 9,
        source_element_id: "image-1",
        source_element_version: 4,
        mode: "copy",
        replayed: true,
      }),
    ).toMatchObject({ operation_id: ids.request, replayed: true });
  });

  it("rejects transient adopt poses and unknown asset authority fields", () => {
    expect(() =>
      manualCanvasImageImportRequestSchema.parse({
        ...valid,
        mode: "adopt",
      }),
    ).toThrow();
    expect(() =>
      manualCanvasImageImportRequestSchema.parse({
        ...valid,
        asset_object_id: ids.asset,
      }),
    ).toThrow();
  });

  it("requires an explicit object version guard for undo", () => {
    expect(
      undoManualCanvasImageImportRequestSchema.parse({
        idempotency_key: ids.object2,
        expected_design_revision: 3,
        expected_object_version: 1,
      }),
    ).toMatchObject({ expected_object_version: 1 });
    expect(() =>
      undoManualCanvasImageImportRequestSchema.parse({
        idempotency_key: ids.object2,
        expected_design_revision: 3,
      }),
    ).toThrow();
  });
});

describe("design HTTP response DTOs", () => {
  const document = {
    id: ids.design,
    workspace_id: ids.workspace,
    project_id: ids.project,
    name: "Design",
    width: 1080,
    height: 1080,
    revision: 0,
    scene: {
      schemaVersion: 1 as const,
      engine: "fabric" as const,
      canvas: { width: 1080, height: 1080, background: "#ffffff" },
      objects: [],
    },
    preview_asset_object_id: null,
    preview_revision: 0,
    preview_status: "missing" as const,
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };

  it("keeps get, lifecycle, reference, and error responses closed", () => {
    expect(designGetResponseSchema.parse({ design: document }).design.id).toBe(
      ids.design,
    );
    expect(
      designLifecycleResponseSchema.parse({
        design_id: ids.design,
        revision: 1,
        replayed: false,
      }).revision,
    ).toBe(1);
    expect(
      designReferencesResponseSchema.parse({ assets: [], fonts: [] }).assets,
    ).toEqual([]);
    expect(
      designErrorResponseSchema.parse({
        error: { code: "design_not_found", message: "Design not found." },
      }).error.code,
    ).toBe("design_not_found");

    expect(() =>
      designGetResponseSchema.parse({ design: document, leaked: true }),
    ).toThrow();
    expect(() =>
      designErrorResponseSchema.parse({
        error: { code: "unknown", message: "no" },
      }),
    ).toThrow();
  });

  it("keeps preview queue requests and queued/ready responses strict", () => {
    expect(
      queueDesignPreviewRequestSchema.parse({
        design_id: ids.design,
        expected_revision: 4,
        idempotency_key: ids.request,
      }).expected_revision,
    ).toBe(4);
    expect(
      queueDesignPreviewResponseSchema.parse({
        status: "queued",
        job_id: ids.object3,
        design_id: ids.design,
        revision: 4,
        replayed: false,
      }).status,
    ).toBe("queued");
    expect(
      queueDesignPreviewResponseSchema.parse({
        status: "ready",
        job_id: null,
        design_id: ids.design,
        revision: 4,
        replayed: true,
      }).status,
    ).toBe("ready");

    expect(() =>
      queueDesignPreviewRequestSchema.parse({
        design_id: ids.design,
        expected_revision: 4,
        idempotency_key: ids.request,
        unknown: true,
      }),
    ).toThrow();
    expect(() =>
      queueDesignPreviewResponseSchema.parse({
        status: "queued",
        job_id: null,
        design_id: ids.design,
        revision: 4,
        replayed: false,
      }),
    ).toThrow();
    expect(() =>
      queueDesignPreviewResponseSchema.parse({
        status: "ready",
        job_id: ids.object3,
        design_id: ids.design,
        revision: 4,
        replayed: false,
      }),
    ).toThrow();
  });

  it("keeps Canvas creation conflicts closed and distinct from design CAS", () => {
    const conflict = canvasRevisionConflictResponseSchema.parse({
      error: {
        code: "CANVAS_REVISION_CONFLICT",
        message: "Canvas changed.",
        canvas_id: ids.object3,
        latest_revision: 9,
        retryable: false,
      },
    });
    expect(conflict.error.canvas_id).toBe(ids.object3);
    expect(() =>
      canvasRevisionConflictResponseSchema.parse({
        ...conflict,
        leaked: true,
      }),
    ).toThrow();
  });
});

const rect = (objectId = ids.object, zIndex = 0, objectVersion = 1) => ({
  ...base(objectId, zIndex, objectVersion),
  type: "rect" as const,
  fill: solid("#ffffff"),
  stroke: null,
  strokeWidth: 0,
});

const scene = (objects: unknown[] = [rect()]) => ({
  schemaVersion: 1 as const,
  engine: "fabric" as const,
  canvas: { width: 1080, height: 1080, background: "#ffffff" },
  objects,
});

const commandRef = (object_id: string, expected_object_version = 1) => ({
  object_id,
  expected_object_version,
});

const attribution = {
  source_url: null,
  author: null,
  license_name: null,
  license_url: null,
  attribution: null,
  usage_restrictions: null,
};

describe("Loomic scene v1", () => {
  it("accepts every frozen MVP object type", () => {
    const objects = [
      {
        ...base(ids.object, 0),
        type: "image",
        assetObjectId: ids.asset,
        resourceId: ids.resource,
        fit: "cover",
      },
      { ...base(ids.object2, 1), type: "svg", assetObjectId: ids.asset },
      {
        ...base(ids.object3, 2),
        type: "text",
        text: "Loomic",
        fontFamily: "Inter",
        fontSize: 48,
        fontWeight: 700,
        fontStyle: "normal",
        textAlign: "left",
        lineHeight: 1.2,
        charSpacing: 0,
        fill: solid("#111111"),
      },
      {
        ...base("88ae7c8d-fccf-42b2-947f-580d8427e334", 3),
        type: "textbox",
        text: "A",
        fontFamily: "Inter",
        fontSize: 20,
        fontWeight: "normal",
        fontStyle: "normal",
        textAlign: "center",
        lineHeight: 1.2,
        charSpacing: 0,
        fill: solid("#111111"),
      },
      rect("bb84036d-20f4-4ac3-842b-9cf2432b3f93", 4),
      {
        ...base("324b4829-996c-47de-805d-3242ebf168f5", 5),
        type: "circle",
        fill: null,
        stroke: solid("#000000"),
        strokeWidth: 1,
      },
      {
        ...base("77076df7-9f1c-41df-8733-5d53a21c2ba2", 6),
        type: "triangle",
        fill: solid("#ff0000"),
        stroke: null,
        strokeWidth: 0,
      },
      {
        ...base("259d5e46-7f6c-4b3d-979d-571094207f21", 7),
        type: "line",
        stroke: solid("#000000"),
        strokeWidth: 2,
        x1: 0,
        y1: 0,
        x2: 100,
        y2: 100,
      },
      {
        ...base("b7b73c4f-5d13-424e-b0a7-f3331c161c49", 8),
        type: "arrow",
        stroke: solid("#000000"),
        strokeWidth: 2,
        x1: 0,
        y1: 0,
        x2: 100,
        y2: 100,
        arrowEnd: "arrow",
      },
      {
        ...base(ids.group, 9),
        type: "group",
        childObjectIds: [ids.object, ids.object2],
      },
    ];
    expect(
      loomicSceneV1Schema
        .parse(scene(objects))
        .objects.map((item) => item.type),
    ).toEqual([
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
    ]);
  });

  it("rejects engine-private fields, duplicate ids, and missing versions", () => {
    expect(() =>
      loomicSceneV1Schema.parse(
        scene([{ ...rect(), cacheKey: "fabric-private" }]),
      ),
    ).toThrow();
    expect(() =>
      loomicSceneV1Schema.parse(
        scene([rect(ids.object, 0), rect(ids.object, 1)]),
      ),
    ).toThrow();
    const { objectVersion: _version, ...withoutVersion } = rect();
    expect(() => loomicSceneV1Schema.parse(scene([withoutVersion]))).toThrow();
  });

  it("requires zIndex to match object array order", () => {
    expect(() =>
      loomicSceneV1Schema.parse(
        scene([rect(ids.object, 1), rect(ids.object2, 0)]),
      ),
    ).toThrow();
  });

  it("persists gradients and shadows while rejecting unordered stops", () => {
    const gradientRect = {
      ...rect(),
      fill: {
        kind: "linear" as const,
        angle: 45,
        stops: [
          { offset: 0, color: "#000000" },
          { offset: 1, color: "#ffffff" },
        ],
      },
      shadow: {
        color: "rgba(0,0,0,0.25)",
        blur: 16,
        offsetX: 0,
        offsetY: 8,
        opacity: 0.25,
      },
    };
    expect(
      loomicSceneV1Schema.parse(scene([gradientRect])).objects,
    ).toHaveLength(1);
    expect(() =>
      loomicSceneV1Schema.parse(
        scene([
          {
            ...gradientRect,
            fill: {
              ...gradientRect.fill,
              stops: [
                { offset: 0.7, color: "#000000" },
                { offset: 0.7, color: "#ffffff" },
              ],
            },
          },
        ]),
      ),
    ).toThrow();
  });

  it("accepts bounded image crop, mask, filters, stroke and shadow", () => {
    const image = {
      ...base(ids.object, 0),
      type: "image" as const,
      assetObjectId: ids.asset,
      fit: "cover" as const,
      crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
      mask: {
        shape: "rounded_rect" as const,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        radius: 0.12,
      },
      filters: {
        brightness: 0.15,
        contrast: -0.1,
        saturation: 0.25,
        blur: 0.05,
        grayscale: true,
      },
      stroke: solid("#ffffff"),
      strokeWidth: 4,
      shadow: {
        color: "#000000",
        blur: 12,
        offsetX: 2,
        offsetY: 6,
        opacity: 0.3,
      },
    };
    expect(loomicSceneV1Schema.parse(scene([image])).objects[0]).toMatchObject({
      type: "image",
      crop: image.crop,
      mask: image.mask,
      filters: image.filters,
    });
    expect(
      designCommandSchema.parse({
        action: "object.update",
        ...commandRef(ids.object),
        patch: {
          object_type: "image",
          crop: null,
          mask: { shape: "ellipse", x: 0, y: 0, width: 1, height: 1 },
          filters: { sepia: true },
          stroke_width: 2,
        },
      }).action,
    ).toBe("object.update");
  });

  it("rejects image effects outside normalized bounds", () => {
    const image = {
      ...base(ids.object, 0),
      type: "image" as const,
      assetObjectId: ids.asset,
      fit: "cover" as const,
    };
    expect(() =>
      loomicSceneV1Schema.parse(
        scene([{ ...image, crop: { x: 0.7, y: 0, width: 0.5, height: 1 } }]),
      ),
    ).toThrow();
    expect(() =>
      loomicSceneV1Schema.parse(
        scene([
          {
            ...image,
            mask: {
              shape: "ellipse",
              x: 0,
              y: 0,
              width: 1,
              height: 1,
              radius: 0.2,
            },
          },
        ]),
      ),
    ).toThrow();
    expect(() =>
      loomicSceneV1Schema.parse(
        scene([{ ...image, filters: { contrast: 1.5 } }]),
      ),
    ).toThrow();
  });

  it("rejects group cycles and multiple parents", () => {
    const cycle = scene([
      {
        ...base(ids.group, 0),
        type: "group",
        childObjectIds: [ids.group2],
      },
      {
        ...base(ids.group2, 1),
        type: "group",
        childObjectIds: [ids.group],
      },
    ]);
    expect(() => loomicSceneV1Schema.parse(cycle)).toThrow();
    expect(() =>
      loomicSceneV1Schema.parse(
        scene([
          rect(),
          {
            ...base(ids.group, 1),
            type: "group",
            childObjectIds: [ids.object],
          },
          {
            ...base(ids.group2, 2),
            type: "group",
            childObjectIds: [ids.object],
          },
        ]),
      ),
    ).toThrow();
  });
});

describe("canonical design commands", () => {
  it("scales content uniformly and centers letterboxed axes", () => {
    const input = scene([
      {
        ...rect(ids.object, 0, 4),
        x: 50,
        y: 50,
        width: 100,
        height: 100,
      },
    ]);
    input.canvas.width = 400;
    input.canvas.height = 400;

    const result = applyDesignCanvasUpdate(input, {
      action: "canvas.update",
      width: 800,
      height: 400,
      resize_mode: "scale",
    });

    expect(result.canvas).toMatchObject({ width: 800, height: 400 });
    expect(result.objects[0]).toMatchObject({
      x: 250,
      y: 50,
      width: 100,
      height: 100,
      objectVersion: 5,
    });
  });

  it("accepts every frozen command with exact fields", () => {
    const commands = [
      { action: "object.add", object: rect() },
      {
        action: "object.update",
        ...commandRef(ids.object),
        patch: { object_type: "rect", fill: solid("#000000") },
      },
      { action: "object.remove", ...commandRef(ids.object) },
      {
        action: "object.clone",
        source_object_id: ids.object,
        expected_object_version: 1,
        object: rect(ids.object2, 1),
      },
      { action: "object.reorder", ...commandRef(ids.object), to_index: 2 },
      {
        action: "objects.group",
        group: {
          ...base(ids.group, 2),
          type: "group",
          childObjectIds: [ids.object, ids.object2],
        },
        children: [commandRef(ids.object), commandRef(ids.object2)],
      },
      {
        action: "objects.ungroup",
        group_object_id: ids.group,
        expected_object_version: 1,
      },
      {
        action: "objects.align",
        alignment: "left",
        objects: [commandRef(ids.object), commandRef(ids.object2)],
      },
      {
        action: "objects.distribute",
        direction: "horizontal",
        objects: [
          commandRef(ids.object),
          commandRef(ids.object2),
          commandRef(ids.object3),
        ],
      },
      {
        action: "object.set_role",
        ...commandRef(ids.object),
        role: "logo",
      },
      { action: "canvas.update", width: 1200, resize_mode: "expand" },
      { action: "scene.replace", scene: scene() },
    ];
    expect(
      commands.map((command) => designCommandSchema.parse(command).action),
    ).toEqual(commands.map((command) => command.action));
  });

  it("requires objectVersion 1 for add, clone, and group", () => {
    expect(() =>
      designCommandSchema.parse({
        action: "object.add",
        object: rect(ids.object, 0, 2),
      }),
    ).toThrow();
    expect(() =>
      designCommandSchema.parse({
        action: "object.clone",
        source_object_id: ids.object,
        expected_object_version: 1,
        object: rect(ids.object2, 1, 2),
      }),
    ).toThrow();
  });

  it("uses typed patches and rejects properties illegal for the object type", () => {
    expect(
      designCommandSchema.parse({
        action: "object.update",
        ...commandRef(ids.object),
        patch: { object_type: "text", text: "Changed" },
      }).action,
    ).toBe("object.update");
    expect(() =>
      designCommandSchema.parse({
        action: "object.update",
        ...commandRef(ids.object),
        patch: { object_type: "rect", text: "not legal" },
      }),
    ).toThrow();
  });

  it("requires UUID idempotency and object versions", () => {
    expect(
      designMutationRequestSchema.parse({
        design_id: ids.design,
        expected_revision: 4,
        idempotency_key: ids.request,
        commands: [
          {
            action: "object.update",
            ...commandRef(ids.object, 2),
            patch: { object_type: "rect", x: 24 },
          },
        ],
      }).commands,
    ).toHaveLength(1);
    expect(() =>
      designMutationRequestSchema.parse({
        design_id: ids.design,
        expected_revision: 4,
        idempotency_key: "retry-me",
        commands: [{ action: "object.remove", ...commandRef(ids.object) }],
      }),
    ).toThrow();
  });
});

describe("preview, document, conflict, and sync invariants", () => {
  it("keeps node preview revisions bounded and consistent", () => {
    expect(
      loomicDesignNodeMetadataSchema.parse({
        kind: "loomic-design",
        schemaVersion: 1,
        designId: ids.design,
        revision: 12,
        previewAssetObjectId: ids.asset,
        previewRevision: 11,
      }).previewRevision,
    ).toBe(11);
    expect(() =>
      loomicDesignNodeMetadataSchema.parse({
        kind: "loomic-design",
        schemaVersion: 1,
        designId: ids.design,
        revision: 1,
        previewAssetObjectId: null,
        previewRevision: 1,
      }),
    ).toThrow();
    expect(() =>
      loomicDesignNodeMetadataSchema.parse({
        kind: "loomic-design",
        schemaVersion: 1,
        designId: ids.design,
        revision: 1,
        previewAssetObjectId: ids.asset,
        previewRevision: 2,
      }),
    ).toThrow();
  });

  it("requires document dimensions to match its scene", () => {
    const document = {
      id: ids.design,
      workspace_id: ids.workspace,
      project_id: ids.project,
      name: "Square",
      width: 1080,
      height: 1080,
      revision: 2,
      scene: scene(),
      preview_asset_object_id: ids.asset,
      preview_revision: 2,
      preview_status: "ready",
      deleted_at: null,
      created_at: now,
      updated_at: now,
    };
    expect(designDocumentDtoSchema.parse(document).width).toBe(1080);
    expect(() =>
      designDocumentDtoSchema.parse({ ...document, width: 1200 }),
    ).toThrow();
  });

  it("enforces every persisted preview status combination", () => {
    const document = {
      id: ids.design,
      workspace_id: ids.workspace,
      project_id: ids.project,
      name: "Preview states",
      width: 1080,
      height: 1080,
      revision: 2,
      scene: scene(),
      deleted_at: null,
      created_at: now,
      updated_at: now,
    };
    const validStates = [
      {
        preview_status: "missing",
        preview_asset_object_id: null,
        preview_revision: 0,
      },
      {
        preview_status: "ready",
        preview_asset_object_id: ids.asset,
        preview_revision: 2,
      },
      {
        preview_status: "stale",
        preview_asset_object_id: ids.asset,
        preview_revision: 1,
      },
      {
        preview_status: "queued",
        preview_asset_object_id: null,
        preview_revision: 0,
      },
      {
        preview_status: "error",
        preview_asset_object_id: ids.asset,
        preview_revision: 1,
      },
    ];
    for (const preview of validStates) {
      expect(
        designDocumentDtoSchema.safeParse({ ...document, ...preview }).success,
      ).toBe(true);
    }
    for (const preview of [
      {
        preview_status: "missing",
        preview_asset_object_id: ids.asset,
        preview_revision: 1,
      },
      {
        preview_status: "ready",
        preview_asset_object_id: ids.asset,
        preview_revision: 1,
      },
      {
        preview_status: "stale",
        preview_asset_object_id: ids.asset,
        preview_revision: 2,
      },
      {
        preview_status: "queued",
        preview_asset_object_id: ids.asset,
        preview_revision: 2,
      },
    ]) {
      expect(
        designDocumentDtoSchema.safeParse({ ...document, ...preview }).success,
      ).toBe(false);
    }
  });

  it("parses the 409 response and a strict design.sync message", () => {
    expect(
      designConflictResponseSchema.parse({
        error: {
          code: "DESIGN_CONFLICT",
          message: "The object changed",
          design_id: ids.design,
          latest_revision: 5,
          conflict_object_ids: [ids.object],
          retryable: false,
        },
      }).error.latest_revision,
    ).toBe(5);
    const sync = {
      type: "design.sync",
      designId: ids.design,
      revision: 6,
      updateType: "preview",
      previewAssetObjectId: ids.asset,
      previewRevision: 6,
    } as const;
    expect(designSyncEventSchema.parse(sync).type).toBe("design.sync");
    expect(wsServerMessageSchema.parse(sync).type).toBe("design.sync");
    expect(() =>
      designSyncEventSchema.parse({ ...sync, previewRevision: 7 }),
    ).toThrow();
  });
});

describe("catalog and import DTOs", () => {
  const resource = {
    id: ids.resource,
    scope: "workspace" as const,
    workspace_id: ids.workspace,
    kind: "illustration" as const,
    name: "Hero",
    description: null,
    asset_object_id: ids.asset,
    preview_asset_object_id: null,
    width: 1080,
    height: 1080,
    checksum_sha256: "a".repeat(64),
    revision: 0,
    status: "pending_review" as const,
    category_id: null,
    tag_ids: [ids.object],
    ...attribution,
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };

  it("aligns catalog states, kinds, scopes, and unique taxonomy ids", () => {
    expect(designResourceDtoSchema.parse(resource).kind).toBe("illustration");
    expect(() =>
      designResourceDtoSchema.parse({
        ...resource,
        scope: "platform",
        workspace_id: ids.workspace,
      }),
    ).toThrow();
    expect(() =>
      designResourceDtoSchema.parse({
        ...resource,
        status: "unpublished",
      }),
    ).toThrow();
    expect(() =>
      designResourceDtoSchema.parse({
        ...resource,
        tag_ids: [ids.object, ids.object],
      }),
    ).toThrow();
  });

  it("validates template details and supporting catalog DTOs", () => {
    const template = {
      id: ids.resource,
      scope: "platform" as const,
      workspace_id: null,
      name: "Square",
      description: null,
      width: 1080,
      height: 1080,
      schema_version: 1 as const,
      engine_version: "fabric@7.4.0" as const,
      revision: 2,
      status: "published" as const,
      preview_asset_object_id: ids.asset,
      category_id: null,
      tag_ids: [],
      ...attribution,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    };
    expect(
      designTemplateDetailDtoSchema.parse({
        template,
        scene: scene(),
        asset_refs: [],
        font_face_ids: [],
      }).template.name,
    ).toBe("Square");
    expect(
      designFontFaceDtoSchema.parse({
        id: ids.resource,
        family_id: ids.object,
        family_name: "Inter",
        scope: "workspace",
        workspace_id: ids.workspace,
        style: "normal",
        weight: 400,
        format: "woff2",
        asset_object_id: ids.asset,
        status: "draft",
        checksum_sha256: null,
        allow_web_embed: false,
        revision: 0,
        deleted_at: null,
        created_at: now,
        updated_at: now,
      }).format,
    ).toBe("woff2");
    expect(
      designTextPresetDtoSchema.parse({
        id: ids.resource,
        scope: "workspace",
        workspace_id: ids.workspace,
        name: "Headline",
        style: {
          schemaVersion: 1,
          objects: [
            {
              ...base(ids.object, 0),
              type: "text",
              text: "Headline",
              fontFamily: "Inter",
              fontSize: 48,
              fontWeight: 700,
              fontStyle: "normal",
              textAlign: "left",
              lineHeight: 1.2,
              charSpacing: 0,
              fill: {
                kind: "radial",
                centerX: 0.5,
                centerY: 0.5,
                radius: 0.7,
                stops: [
                  { offset: 0, color: "#ffffff" },
                  { offset: 1, color: "#000000" },
                ],
              },
              stroke: null,
              strokeWidth: 0,
              shadow: {
                color: "#000000",
                blur: 4,
                offsetX: 0,
                offsetY: 2,
                opacity: 0.2,
              },
            },
          ],
        },
        preview_asset_object_id: null,
        revision: 0,
        status: "draft",
        category_id: null,
        tag_ids: [],
        ...attribution,
        deleted_at: null,
        created_at: now,
        updated_at: now,
      }).name,
    ).toBe("Headline");
    expect(() =>
      designTextPresetDtoSchema.parse({
        id: ids.resource,
        scope: "workspace",
        workspace_id: ids.workspace,
        name: "Empty",
        style: { schemaVersion: 1, objects: [] },
        preview_asset_object_id: null,
        revision: 0,
        status: "draft",
        category_id: null,
        tag_ids: [],
        ...attribution,
        deleted_at: null,
        created_at: now,
        updated_at: now,
      }),
    ).toThrow();
  });

  it("parses categories, tags, favorites, and recent uses", () => {
    expect(
      designResourceCategoryDtoSchema.parse({
        id: ids.resource,
        scope: "workspace",
        workspace_id: ids.workspace,
        parent_id: null,
        name: "Hero",
        slug: "hero",
        sort_order: 1,
        revision: 0,
        status: "published",
        deleted_at: null,
        created_at: now,
        updated_at: now,
      }).slug,
    ).toBe("hero");
    expect(
      designResourceTagDtoSchema.parse({
        id: ids.resource,
        scope: "platform",
        workspace_id: null,
        name: "Gold",
        slug: "gold",
        revision: 0,
        status: "published",
        deleted_at: null,
        created_at: now,
        updated_at: now,
      }).slug,
    ).toBe("gold");
    expect(
      designResourceFavoriteDtoSchema.parse({
        user_id: ids.user,
        resource_id: ids.resource,
        created_at: now,
      }).resource_id,
    ).toBe(ids.resource);
    expect(
      designResourceRecentUseDtoSchema.parse({
        user_id: ids.user,
        resource_id: ids.resource,
        workspace_id: ids.workspace,
        used_at: now,
        use_count: 2,
      }).use_count,
    ).toBe(2);
  });

  it("makes import sources mutually exclusive and arrays unique", () => {
    expect(
      createDesignImportRequestSchema.parse({
        request_id: ids.request,
        scope: "workspace",
        workspace_id: ids.workspace,
        source_kind: "url",
        source_urls: ["https://example.com/asset.svg"],
      }).source_kind,
    ).toBe("url");
    expect(() =>
      createDesignImportRequestSchema.parse({
        request_id: ids.request,
        scope: "workspace",
        workspace_id: ids.workspace,
        source_kind: "url",
        source_urls: ["https://example.com/a", "https://example.com/a"],
        asset_object_ids: [ids.asset],
      }),
    ).toThrow();
    expect(
      createDesignImportRequestSchema.parse({
        request_id: ids.request,
        scope: "workspace",
        workspace_id: ids.workspace,
        source_kind: "manifest_inline",
        manifest: {
          version: 1,
          items: [
            {
              source_key: "category/hero",
              entity_kind: "category",
              payload: { name: "Hero" },
            },
          ],
        },
      }).source_kind,
    ).toBe("manifest_inline");
    expect(() =>
      createDesignImportRequestSchema.parse({
        request_id: ids.request,
        scope: "workspace",
        workspace_id: ids.workspace,
        source_kind: "manifest_inline",
        manifest: {
          version: 1,
          items: [{ source_key: "missing.png", entity_kind: "resource" }],
        },
      }),
    ).toThrow();
  });

  it("keeps Stage 5 catalog writes CAS-protected and status changes separate", () => {
    expect(
      updateDesignResourceRequestSchema.parse({
        request_id: ids.request,
        resource_id: ids.resource,
        expected_revision: 3,
        name: "Updated",
      }).expected_revision,
    ).toBe(3);
    expect(() =>
      updateDesignResourceRequestSchema.parse({
        request_id: ids.request,
        resource_id: ids.resource,
        expected_revision: 3,
        status: "published",
      }),
    ).toThrow();
    expect(
      setDesignCatalogStatusRequestSchema.parse({
        request_id: ids.request,
        entity_kind: "resource",
        entity_id: ids.resource,
        expected_revision: 3,
        status: "pending_review",
      }).status,
    ).toBe("pending_review");
    expect(
      designCatalogMutationResponseSchema.parse({
        entity_kind: "resource",
        entity_id: ids.resource,
        revision: 4,
        status: "pending_review",
        replayed: false,
      }).revision,
    ).toBe(4);
  });

  it("strictly validates Stage 5 text, font, and list inputs", () => {
    const textObject = {
      ...base(ids.object, 0),
      type: "text" as const,
      text: "Title",
      fontFamily: "Inter",
      fontSize: 32,
      fontWeight: 600,
      fontStyle: "normal" as const,
      textAlign: "left" as const,
      lineHeight: 1.2,
      charSpacing: 0,
      fill: solid("#000000"),
      stroke: null,
      strokeWidth: 0,
      shadow: null,
    };
    expect(
      createDesignTextPresetRequestSchema.parse({
        request_id: ids.request,
        scope: "workspace",
        workspace_id: ids.workspace,
        name: "Title",
        style: { schemaVersion: 1, objects: [textObject] },
        preview_asset_object_id: null,
        category_id: null,
        tag_ids: [],
        ...attribution,
      }).name,
    ).toBe("Title");
    expect(() =>
      createDesignFontFaceRequestSchema.parse({
        request_id: ids.request,
        scope: "workspace",
        workspace_id: ids.workspace,
        family_id: ids.object,
        asset_object_id: ids.asset,
        style: "normal",
        weight: 400,
        format: "woff2",
        checksum_sha256: "bad",
        allow_web_embed: true,
      }),
    ).toThrow();
    expect(
      designCatalogListRequestSchema.parse({
        entity_kind: "template",
        limit: 50,
      }).limit,
    ).toBe(50);
    expect(() =>
      designCatalogListRequestSchema.parse({
        entity_kind: "template",
        limit: 50,
        offset: 10,
      }),
    ).toThrow();
  });
});

describe("job targets, export, and stage-one persistence DTOs", () => {
  it("keeps canvas element ids opaque and design placement separate", () => {
    expect(
      jobTargetSchema.parse({
        kind: "canvas",
        canvas_id: ids.project,
        element_id: "placeholder:generated-image/1",
        placement: { x: 1, y: 2 },
      }).kind,
    ).toBe("canvas");
    expect(
      jobTargetSchema.parse({
        kind: "design",
        design_id: ids.design,
        expected_revision: 7,
        idempotency_key: ids.request,
        placement: { x: 10, y: 20, fit: "cover", role: "product" },
      }).kind,
    ).toBe("design");
  });

  it("validates export payloads and results", () => {
    const request = {
      design_id: ids.design,
      revision: 2,
      idempotency_key: ids.request,
      format: "png" as const,
      multiplier: 2 as const,
      transparent: true,
    };
    expect(designExportRequestSchema.parse(request).multiplier).toBe(2);
    expect(
      designExportPayloadSchema.parse({ ...request, requested_by: ids.user })
        .format,
    ).toBe("png");
    expect(() =>
      designExportRequestSchema.parse({
        ...request,
        format: "jpeg",
        transparent: true,
      }),
    ).toThrow();
  });

  it("parses versions, import items, finalizations, outbox, and admins", () => {
    expect(
      designDocumentVersionDtoSchema.parse({
        id: ids.object2,
        design_id: ids.design,
        workspace_id: ids.workspace,
        revision: 1,
        parent_revision: 0,
        command_batch: [{ action: "object.add", object: rect() }],
        changed_object_ids: [ids.object],
        snapshot: null,
        actor_kind: "job",
        actor_user_id: null,
        agent_run_id: null,
        tool_execution_id: null,
        idempotency_key: ids.request,
        created_at: now,
      }).revision,
    ).toBe(1);
    expect(
      designImportItemDtoSchema.parse({
        id: ids.object2,
        import_job_id: ids.object3,
        source_key: "asset.svg",
        status: "imported",
        result_entity_kind: "resource",
        result_entity_id: ids.resource,
        resource_id: ids.resource,
        asset_object_id: ids.asset,
        error_code: null,
        error_message: null,
        metadata: {},
        created_at: now,
        completed_at: now,
      }).status,
    ).toBe("imported");
    expect(
      jobTargetFinalizationDtoSchema.parse({
        id: ids.object2,
        job_id: ids.object3,
        workspace_id: ids.workspace,
        target_kind: "design",
        target_id: ids.design,
        status: "completed",
        command_id: ids.request,
        result: {},
        error_code: null,
        error_message: null,
        attempt_count: 1,
        created_at: now,
        updated_at: now,
        completed_at: now,
      }).command_id,
    ).toBe(ids.request);
    const payload = {
      type: "design.sync" as const,
      designId: ids.design,
      revision: 1,
      updateType: "mutated" as const,
    };
    expect(
      designEventOutboxDtoSchema.parse({
        id: ids.object2,
        design_id: ids.design,
        workspace_id: ids.workspace,
        revision: 1,
        event_type: "design.sync",
        payload,
        status: "pending",
        attempt_count: 0,
        available_at: now,
        claimed_at: null,
        claim_token: null,
        published_at: null,
        last_error: null,
        created_at: now,
      }).payload.designId,
    ).toBe(ids.design);
    expect(() =>
      designEventOutboxDtoSchema.parse({
        id: ids.object2,
        design_id: ids.design,
        workspace_id: ids.workspace,
        revision: 1,
        event_type: "design.deleted",
        payload,
        status: "pending",
        attempt_count: 0,
        available_at: now,
        claimed_at: null,
        claim_token: null,
        published_at: null,
        last_error: null,
        created_at: now,
      }),
    ).toThrow();
    expect(
      designEventOutboxDtoSchema.parse({
        id: ids.object2,
        design_id: ids.design,
        workspace_id: ids.workspace,
        revision: 1,
        event_type: "design.deleted",
        payload: {
          type: "design.deleted",
          designId: ids.design,
          revision: 1,
        },
        status: "published",
        attempt_count: 1,
        available_at: now,
        claimed_at: now,
        claim_token: ids.request,
        published_at: now,
        last_error: null,
        created_at: now,
      }).event_type,
    ).toBe("design.deleted");
    expect(
      platformAdminDtoSchema.parse({
        user_id: ids.user,
        is_active: true,
        granted_by: null,
        granted_at: now,
        revoked_at: null,
      }).user_id,
    ).toBe(ids.user);
  });
});

describe("Stage 6 agent design tool contracts", () => {
  const audit = {
    actor_kind: "agent" as const,
    actor_user_id: ids.user,
    agent_run_id: ids.object2,
    tool_execution_id: ids.object3,
  };

  it("bounds inspect summaries and object detail reads", () => {
    expect(agentDesignToolExecutionContextSchema.parse(audit).actor_kind).toBe(
      "agent",
    );
    expect(
      inspectDesignToolInputSchema.parse({ design_id: ids.design }),
    ).toMatchObject({
      object_limit: 50,
      text_limit: 160,
      selection_object_ids: [],
    });
    expect(() =>
      inspectDesignToolInputSchema.parse({
        design_id: ids.design,
        object_limit: 101,
      }),
    ).toThrow();
    expect(
      inspectDesignToolOutputSchema.parse({
        design_id: ids.design,
        name: "Agent design",
        width: 800,
        height: 600,
        revision: 2,
        object_count: 1,
        objects: [
          {
            object_id: ids.object,
            object_version: 1,
            type: "rect",
            role: null,
            x: 0,
            y: 0,
            width: 100,
            height: 100,
          },
        ],
        selection_object_ids: [ids.object],
        truncated: false,
      }),
    ).toMatchObject({ revision: 2 });
    expect(
      getDesignObjectsToolInputSchema.parse({
        design_id: ids.design,
        expected_revision: 2,
        object_ids: [ids.object],
      }).expected_revision,
    ).toBe(2);
    expect(
      getDesignObjectsToolOutputSchema.parse({
        design_id: ids.design,
        revision: 2,
        objects: [rect()],
        missing_object_ids: [],
      }),
    ).toMatchObject({ objects: [expect.objectContaining({ type: "rect" })] });
  });

  it("keeps CAS strict while allowing destructive confirmation proposals", () => {
    expect(
      manipulateDesignToolInputSchema.parse({
        design_id: ids.design,
        expected_revision: 2,
        idempotency_key: ids.request,
        commands: [
          {
            action: "object.update",
            object_id: ids.object,
            expected_object_version: 1,
            patch: { object_type: "rect", opacity: 0.5 },
          },
        ],
      }).commands,
    ).toHaveLength(1);
    const destructive = {
      design_id: ids.design,
      expected_revision: 2,
      idempotency_key: ids.request,
      commands: [
        {
          action: "object.remove" as const,
          object_id: ids.object,
          expected_object_version: 1,
        },
      ],
    };
    expect(
      manipulateDesignToolInputSchema.parse(destructive).commands[0]?.action,
    ).toBe("object.remove");
    expect(
      manipulateDesignToolOutputSchema.parse({
        status: "confirmation_required",
        design_id: ids.design,
        expected_revision: 2,
        confirmation_id: ids.object2,
        summary: "Remove one design object",
        affected_object_ids: [ids.object],
        expires_at: now,
      }).status,
    ).toBe("confirmation_required");
    expect(
      manipulateDesignToolOutputSchema.parse({
        status: "applied",
        design_id: ids.design,
        revision: 3,
        changed_object_ids: [ids.object],
        replayed: false,
      }).status,
    ).toBe("applied");
    expect(
      agentDesignToolErrorOutputSchema.parse({
        status: "error",
        code: "design_revision_conflict",
        message: "The design changed while the tool was running.",
        retryable: true,
        current_revision: 3,
      }).current_revision,
    ).toBe(3);
    expect(() =>
      agentDesignToolErrorOutputSchema.parse({
        status: "error",
        code: "design_revision_conflict",
        message: "Missing authoritative revision",
        retryable: true,
      }),
    ).toThrow();
  });

  it("requires confirmed replacement when applying a template", () => {
    const input = {
      design_id: ids.design,
      expected_revision: 2,
      idempotency_key: ids.request,
      template_id: ids.resource,
      expected_template_revision: 4,
      mode: "replace" as const,
    };
    expect(applyDesignTemplateToolInputSchema.parse(input).mode).toBe(
      "replace",
    );
    expect(
      applyDesignTemplateToolOutputSchema.parse({
        status: "confirmation_required",
        design_id: ids.design,
        expected_revision: 2,
        confirmation_id: ids.object2,
        summary: "Replace the design with a template",
        affected_object_ids: [ids.object],
        expires_at: now,
        template_id: ids.resource,
      }).status,
    ).toBe("confirmation_required");
    expect(
      applyDesignTemplateToolOutputSchema.parse({
        status: "applied",
        design_id: ids.design,
        revision: 3,
        changed_object_ids: [ids.object],
        replayed: false,
        template_id: ids.resource,
      }),
    ).toMatchObject({ template_id: ids.resource });
  });

  it("bounds resource search pages and summaries", () => {
    expect(
      searchDesignResourcesToolInputSchema.parse({
        workspace_id: ids.workspace,
      }),
    ).toMatchObject({ limit: 20, summary_max_chars: 240 });
    expect(() =>
      searchDesignResourcesToolInputSchema.parse({
        workspace_id: ids.workspace,
        limit: 31,
      }),
    ).toThrow();
    expect(
      searchDesignResourcesToolOutputSchema.parse({
        items: [
          {
            id: ids.resource,
            scope: "workspace",
            workspace_id: ids.workspace,
            kind: "image",
            name: "Hero",
            summary: "Short catalog summary",
            width: 800,
            height: 600,
            preview_asset_object_id: ids.asset,
            category_id: null,
            tag_ids: [],
          },
        ],
        next_cursor: null,
        truncated: false,
      }),
    ).toMatchObject({ items: [expect.objectContaining({ id: ids.resource })] });
  });

  it("exports an exact revision with a bounded strict response", () => {
    expect(
      exportDesignToolInputSchema.parse({
        design_id: ids.design,
        expected_revision: 2,
        idempotency_key: ids.request,
        format: "png",
        multiplier: 2,
        transparent: true,
      }).expected_revision,
    ).toBe(2);
    expect(() =>
      exportDesignToolInputSchema.parse({
        design_id: ids.design,
        expected_revision: 2,
        idempotency_key: ids.request,
        format: "jpeg",
        multiplier: 1,
        transparent: true,
      }),
    ).toThrow();
    expect(
      exportDesignToolOutputSchema.parse({
        design_id: ids.design,
        revision: 2,
        job_id: ids.object,
        status: "queued",
        replayed: false,
      }),
    ).toMatchObject({ job_id: ids.object });
  });
});
