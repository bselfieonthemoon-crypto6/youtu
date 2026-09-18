import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedUser } from "../../supabase/user.js";
import { createDesignService } from "./design-service.js";
import { manualCanvasImageImportObjectId } from "./manual-canvas-image-import.js";

const ids = {
  design: "10000000-0000-4000-8000-000000000001",
  request: "20000000-0000-4000-8000-000000000002",
  undo: "30000000-0000-4000-8000-000000000003",
  canvas: "40000000-0000-4000-8000-000000000004",
  asset: "50000000-0000-4000-8000-000000000005",
  workspace: "60000000-0000-4000-8000-000000000006",
  project: "70000000-0000-4000-8000-000000000007",
  user: "80000000-0000-4000-8000-000000000008",
} as const;

const user: AuthenticatedUser = {
  id: ids.user,
  email: "owner@local.test",
  accessToken: "token",
  userMetadata: {},
};
const operationId = manualCanvasImageImportObjectId(importRequest());

describe("manual canvas image import service", () => {
  it("replays a committed import before requiring the adopted source again", async () => {
    const image = nativeImage(1);
    const design = designRow(1, [image]);
    const canvas = canvasRow([]);
    const receipt = queryResult({
      revision: 1,
      parent_revision: 0,
      command_batch: [{ action: "object.add", object: image }],
      changed_object_ids: [operationId],
      actor_kind: "user",
      actor_user_id: ids.user,
    });
    const rpc = vi.fn();
    const service = createDesignService({
      createUserClient: () =>
        ({
          from: vi.fn((table: string) =>
            table === "canvases" ? queryResult(canvas) : queryResult(design),
          ),
        }) as never,
      getAdminClient: () => ({ from: vi.fn(() => receipt), rpc }) as never,
    });

    await expect(service.importCanvasImage(user, importRequest())).resolves.toMatchObject({
      operation_id: operationId,
      object_id: operationId,
      design_revision: 1,
      source_canvas_revision: 11,
      replayed: true,
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses undo after the imported layer has been edited", async () => {
    const rpc = vi.fn();
    const service = createDesignService({
      createUserClient: () =>
        ({ from: vi.fn(() => queryResult(designRow(2, [nativeImage(2)]))) }) as never,
      getAdminClient: () => ({ rpc }) as never,
    });

    await expect(
      service.undoCanvasImageImport(user, ids.design, operationId, {
        idempotency_key: ids.undo,
        expected_design_revision: 2,
        expected_object_version: 1,
      }),
    ).rejects.toMatchObject({
      code: "design_conflict",
      conflict: { conflictObjectIds: [operationId] },
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a reused request ID when any immutable import binding changes", async () => {
    const receipt = queryResult({
      revision: 1,
      parent_revision: 0,
      command_batch: [{ action: "object.add", object: nativeImage(1) }],
      changed_object_ids: [operationId],
      actor_kind: "user",
      actor_user_id: ids.user,
    });
    const service = createDesignService({
      createUserClient: () =>
        ({ from: vi.fn(() => queryResult(designRow(1, [nativeImage(1)]))) }) as never,
      getAdminClient: () => ({ from: vi.fn(() => receipt), rpc: vi.fn() }) as never,
    });

    await expect(
      service.importCanvasImage(user, {
        ...importRequest(),
        mode: "copy",
        placement: { kind: "fit" },
      }),
    ).rejects.toMatchObject({
      code: "design_conflict",
      message: expect.stringContaining("different design mutation"),
    });
  });
});

function importRequest() {
  return {
    request_id: ids.request,
    design_id: ids.design,
    expected_design_revision: 0,
    canvas_id: ids.canvas,
    source_element_id: "source",
    expected_source_element_version: 3,
    board_element_id: "board",
    expected_board_element_version: 4,
    mode: "adopt" as const,
    placement: { kind: "preserve" as const },
  };
}

function nativeImage(objectVersion: number) {
  return {
    objectId: operationId,
    objectVersion,
    type: "image" as const,
    assetObjectId: ids.asset,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    zIndex: 0,
    locked: false,
    visible: true,
    fit: "fill" as const,
  };
}

function designRow(revision: number, objects: ReturnType<typeof nativeImage>[]) {
  return {
    id: ids.design,
    workspace_id: ids.workspace,
    project_id: ids.project,
    name: "Design",
    width: 100,
    height: 100,
    revision,
    scene: {
      schemaVersion: 1,
      engine: "fabric",
      canvas: { width: 100, height: 100, background: "#fff" },
      objects,
    },
    preview_asset_object_id: null,
    preview_revision: 0,
    preview_status: "missing",
    deleted_at: null,
    created_at: "2026-09-14T00:00:00.000Z",
    updated_at: "2026-09-14T00:00:00.000Z",
  };
}

function canvasRow(elements: unknown[]) {
  return {
    id: ids.canvas,
    project_id: ids.project,
    revision: 11,
    content: { elements, appState: {} },
  };
}

function queryResult<T>(data: T) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    is: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data, error: null })),
  };
  return query;
}
