import { describe, expect, it } from "vitest";

import type {
  DesignDocumentDto,
  ManualCanvasImageImportRequest,
} from "@loomic/shared";

import {
  type ManualCanvasImageImportBuildError,
  buildManualCanvasImageObject,
  manualCanvasImageImportObjectId,
} from "./manual-canvas-image-import.js";

const designId = "10000000-0000-4000-8000-000000000001";
const canvasId = "20000000-0000-4000-8000-000000000002";
const assetId = "30000000-0000-4000-8000-000000000003";
const requestId = "40000000-0000-4000-8000-000000000004";

describe("manual canvas image import", () => {
  it("maps the authoritative scene pose, crop and flips into a native image", () => {
    const object = buildManualCanvasImageObject({
      request: request({ placement: { kind: "preserve" } }),
      design: document(),
      elements: [
        source({
          x: 50,
          y: 25,
          width: 100,
          height: 50,
          angle: Math.PI / 2,
          scale: [-1, -1],
          crop: {
            x: 100,
            y: 50,
            width: 400,
            height: 200,
            naturalWidth: 1000,
            naturalHeight: 500,
          },
        }),
        board(),
      ],
    });

    expect(object).toMatchObject({
      objectId: manualCanvasImageImportObjectId(
        request({ placement: { kind: "preserve" } }),
      ),
      objectVersion: 1,
      type: "image",
      assetObjectId: assetId,
      x: 250,
      y: 125,
      width: 500,
      height: 250,
      rotation: 90,
      flipX: true,
      flipY: true,
      crop: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
      zIndex: 0,
      fit: "fill",
    });
  });

  it("uses a transient copy drop pose while the authoritative source stays put", () => {
    const object = buildManualCanvasImageObject({
      request: request({
        mode: "copy",
        placement: {
          kind: "preserve",
          scene_pose: { x: 100, y: 40, width: 80, height: 40, angle: 0 },
        },
      }),
      design: document(),
      elements: [source({ x: 900, y: 900 }), board()],
    });

    expect(object).toMatchObject({
      x: 500,
      y: 200,
      width: 400,
      height: 200,
    });
  });

  it("fits and centers without distorting the visible image frame", () => {
    const object = buildManualCanvasImageObject({
      request: request({ placement: { kind: "fit" } }),
      design: document(),
      elements: [source({ width: 400, height: 200 }), board()],
    });

    expect(object).toMatchObject({
      x: 0,
      y: 0,
      width: 1000,
      height: 500,
      rotation: 0,
    });
  });

  it("retains relative rotation and fits the rotated bounds", () => {
    const object = buildManualCanvasImageObject({
      request: request({ placement: { kind: "fit" } }),
      design: document(),
      elements: [
        source({ width: 400, height: 200, angle: Math.PI / 2 }),
        board(),
      ],
    });

    expect(object).toMatchObject({
      x: 250,
      y: 125,
      width: 500,
      height: 250,
      rotation: 90,
    });
  });

  it("rejects a stale source version before creating a design command", () => {
    expect(() =>
      buildManualCanvasImageObject({
        request: request({ expected_source_element_version: 8 }),
        design: document(),
        elements: [source(), board()],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ManualCanvasImageImportBuildError>>({
        code: "source_changed",
      }),
    );
  });

  it("binds the operation object ID to the complete immutable request", () => {
    expect(
      manualCanvasImageImportObjectId(request()),
    ).not.toBe(
      manualCanvasImageImportObjectId(
        request({ source_element_id: "another-source" }),
      ),
    );
    expect(manualCanvasImageImportObjectId(request())).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it.each([
    [source({ locked: true }), board(), "source_locked"],
    [source(), { ...board(), locked: true }, "board_locked"],
  ] as const)("rejects locked canvas participants", (image, target, code) => {
    expect(() =>
      buildManualCanvasImageObject({
        request: request(),
        design: document(),
        elements: [image, target],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ManualCanvasImageImportBuildError>>({
        code,
      }),
    );
  });
});

function request(
  overrides: Partial<ManualCanvasImageImportRequest> = {},
): ManualCanvasImageImportRequest {
  return {
    request_id: requestId,
    design_id: designId,
    expected_design_revision: 0,
    canvas_id: canvasId,
    source_element_id: "source",
    expected_source_element_version: 2,
    board_element_id: "board",
    expected_board_element_version: 3,
    mode: "adopt",
    placement: { kind: "preserve" },
    ...overrides,
  };
}

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: "source",
    type: "image",
    version: 2,
    isDeleted: false,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    angle: 0,
    opacity: 100,
    scale: [1, 1],
    customData: { assetId, title: "Original" },
    ...overrides,
  };
}

function board() {
  return {
    id: "board",
    version: 3,
    isDeleted: false,
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    angle: 0,
    customData: {
      kind: "loomic-design",
      schemaVersion: 1,
      designId,
      revision: 0,
      previewAssetObjectId: null,
      previewRevision: 0,
    },
  };
}

function document(): DesignDocumentDto {
  return {
    id: designId,
    workspace_id: "50000000-0000-4000-8000-000000000005",
    project_id: "60000000-0000-4000-8000-000000000006",
    name: "Board",
    width: 1000,
    height: 500,
    revision: 0,
    scene: {
      schemaVersion: 1,
      engine: "fabric",
      canvas: { width: 1000, height: 500, background: "#fff" },
      objects: [],
    },
    preview_asset_object_id: null,
    preview_revision: 0,
    preview_status: "missing",
    deleted_at: null,
    created_at: "2026-09-14T00:00:00.000Z",
    updated_at: "2026-09-14T00:00:00.000Z",
  };
}
