import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DesignDocumentDto } from "@loomic/shared";
import {
  canvasRevisionConflictResponseSchema,
  designErrorResponseSchema,
} from "@loomic/shared";

import {
  type DesignService,
  DesignServiceError,
} from "../features/designs/design-service.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";
import { registerDesignRoutes } from "./designs.js";

const designId = "10000000-0000-0000-0000-000000000001";
const otherDesignId = "10000000-0000-0000-0000-000000000002";
const requestId = "20000000-0000-0000-0000-000000000001";
const canvasId = "30000000-0000-0000-0000-000000000001";
const user: AuthenticatedUser = {
  id: "40000000-0000-0000-0000-000000000001",
  email: "member@local.test",
  accessToken: "token",
  userMetadata: {},
};

const document: DesignDocumentDto = {
  id: designId,
  workspace_id: "50000000-0000-0000-0000-000000000001",
  project_id: "60000000-0000-0000-0000-000000000001",
  name: "Readable design",
  width: 1080,
  height: 1080,
  revision: 0,
  scene: {
    schemaVersion: 1,
    engine: "fabric",
    canvas: { width: 1080, height: 1080, background: "#ffffff" },
    objects: [],
  },
  preview_asset_object_id: null,
  preview_revision: 0,
  preview_status: "missing",
  deleted_at: null,
  created_at: "2026-09-04T00:00:00.000Z",
  updated_at: "2026-09-04T00:00:00.000Z",
};

function service(): DesignService {
  return {
    create: vi.fn().mockResolvedValue({
      design_id: designId,
      canvas_element_id: "node-1",
      design_revision: 0,
      canvas_revision: 1,
      replayed: false,
    }),
    get: vi.fn().mockResolvedValue(document),
    mutate: vi.fn().mockResolvedValue({
      design_id: designId,
      revision: 1,
      changed_object_ids: [],
      replayed: false,
    }),
    importCanvasImage: vi.fn().mockResolvedValue({
      operation_id: requestId,
      design_id: designId,
      design_revision: 1,
      object_id: requestId,
      object_version: 1,
      source_canvas_id: canvasId,
      source_canvas_revision: 4,
      source_element_id: "source-image",
      source_element_version: 2,
      mode: "adopt",
      replayed: false,
    }),
    undoCanvasImageImport: vi.fn().mockResolvedValue({
      operation_id: requestId,
      design_id: designId,
      design_revision: 2,
      object_id: requestId,
      removed: true,
      replayed: false,
    }),
    rename: vi.fn(),
    copy: vi.fn(),
    softDelete: vi.fn(),
    restore: vi.fn(),
    references: vi.fn().mockResolvedValue({ assets: [], fonts: [] }),
  };
}

async function appWith(
  designService: DesignService,
  authenticatedUser: AuthenticatedUser | null = user,
) {
  const app = Fastify({ logger: false });
  const auth: RequestAuthenticator = {
    authenticate: vi.fn().mockResolvedValue(authenticatedUser),
  };
  await registerDesignRoutes(app, { auth, designService });
  await app.ready();
  return app;
}

describe("design HTTP routes", () => {
  let designService: DesignService;

  beforeEach(() => {
    designService = service();
  });

  it("rejects a missing bearer identity before calling the service", async () => {
    const app = await appWith(designService, null);
    const response = await app.inject({
      method: "GET",
      url: `/api/designs/${designId}`,
    });

    expect(response.statusCode).toBe(401);
    expect(designService.get).not.toHaveBeenCalled();
    await app.close();
  });

  it("wraps a member-readable design and maps a member write refusal", async () => {
    vi.mocked(designService.create).mockRejectedValueOnce(
      new DesignServiceError(
        "design_forbidden",
        "You do not have permission to modify this design.",
        403,
      ),
    );
    const app = await appWith(designService);
    const read = await app.inject({
      method: "GET",
      url: `/api/designs/${designId}`,
    });
    const write = await app.inject({
      method: "POST",
      url: "/api/designs",
      payload: createPayload(),
    });

    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toEqual({ design: document });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.code).toBe("design_forbidden");
    await app.close();
  });

  it("rejects URL/body design ID mismatches and unknown fields", async () => {
    const app = await appWith(designService);
    const mismatch = await app.inject({
      method: "POST",
      url: `/api/designs/${designId}/mutations`,
      payload: mutationPayload(otherDesignId),
    });
    const unknown = await app.inject({
      method: "POST",
      url: "/api/designs",
      payload: { ...createPayload(), unknown: true },
    });

    expect(mismatch.statusCode, mismatch.body).toBe(400);
    expect(mismatch.json().error.code).toBe("design_invalid");
    expect(designService.mutate).not.toHaveBeenCalled();
    expect(unknown.statusCode).toBe(400);
    expect(designService.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns a structured 409 without converting a database conflict to 500", async () => {
    vi.mocked(designService.mutate).mockRejectedValueOnce(
      new DesignServiceError(
        "design_conflict",
        "Design changed while saving.",
        409,
        {
          designId,
          latestRevision: 7,
          conflictObjectIds: [otherDesignId],
          retryable: false,
        },
      ),
    );
    const app = await appWith(designService);
    const response = await app.inject({
      method: "POST",
      url: `/api/designs/${designId}/mutations`,
      payload: mutationPayload(designId),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "DESIGN_CONFLICT",
        message: "Design changed while saving.",
        design_id: designId,
        latest_revision: 7,
        conflict_object_ids: [otherDesignId],
        retryable: false,
      },
    });
    await app.close();
  });

  it("routes a strict canvas image import and guarded undo", async () => {
    const app = await appWith(designService);
    const imported = await app.inject({
      method: "POST",
      url: `/api/designs/${designId}/canvas-image-imports`,
      payload: canvasImageImportPayload(),
    });
    const undone = await app.inject({
      method: "POST",
      url: `/api/designs/${designId}/canvas-image-imports/${requestId}/undo`,
      payload: {
        idempotency_key: otherDesignId,
        expected_design_revision: 1,
        expected_object_version: 1,
      },
    });

    expect(imported.statusCode, imported.body).toBe(200);
    expect(designService.importCanvasImage).toHaveBeenCalledWith(
      user,
      canvasImageImportPayload(),
    );
    expect(undone.statusCode, undone.body).toBe(200);
    expect(designService.undoCanvasImageImport).toHaveBeenCalledWith(
      user,
      designId,
      requestId,
      {
        idempotency_key: otherDesignId,
        expected_design_revision: 1,
        expected_object_version: 1,
      },
    );
    await app.close();
  });

  it("rejects transient scene poses for adopt imports", async () => {
    const app = await appWith(designService);
    const response = await app.inject({
      method: "POST",
      url: `/api/designs/${designId}/canvas-image-imports`,
      payload: {
        ...canvasImageImportPayload(),
        placement: {
          kind: "preserve",
          scene_pose: { x: 1, y: 2, width: 30, height: 40, angle: 0 },
        },
      },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(designService.importCanvasImage).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps a soft-deleted design hidden as 404", async () => {
    vi.mocked(designService.get).mockRejectedValueOnce(
      new DesignServiceError("design_not_found", "Design not found.", 404),
    );
    const app = await appWith(designService);
    const response = await app.inject({
      method: "GET",
      url: `/api/designs/${designId}`,
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json().error.code).toBe("design_not_found");
    await app.close();
  });

  it("returns a strict Canvas CAS conflict for atomic design creation", async () => {
    vi.mocked(designService.create).mockRejectedValueOnce(
      new DesignServiceError(
        "design_conflict",
        "Canvas changed while creating the design.",
        409,
        {
          canvasId,
          latestRevision: 6,
          conflictObjectIds: [],
          retryable: false,
        },
      ),
    );
    const app = await appWith(designService);
    const response = await app.inject({
      method: "POST",
      url: "/api/designs",
      payload: createPayload(),
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(canvasRevisionConflictResponseSchema.parse(response.json())).toEqual(
      {
        error: {
          code: "CANVAS_REVISION_CONFLICT",
          message: "Canvas changed while creating the design.",
          canvas_id: canvasId,
          latest_revision: 6,
          retryable: false,
        },
      },
    );
    await app.close();
  });

  it("uses the strict design error DTO for validation and unexpected failures", async () => {
    const app = await appWith(designService);
    const invalid = await app.inject({
      method: "POST",
      url: "/api/designs",
      payload: { ...createPayload(), unknown: true },
    });
    vi.mocked(designService.get).mockRejectedValueOnce(new Error("database"));
    const failed = await app.inject({
      method: "GET",
      url: `/api/designs/${designId}`,
    });

    expect(invalid.statusCode).toBe(400);
    expect(designErrorResponseSchema.parse(invalid.json()).error.code).toBe(
      "design_invalid",
    );
    expect(failed.statusCode).toBe(500);
    expect(designErrorResponseSchema.parse(failed.json()).error.code).toBe(
      "design_write_failed",
    );
    await app.close();
  });

  it("prioritizes a strict Canvas CAS response for design copy conflicts", async () => {
    vi.mocked(designService.copy).mockRejectedValueOnce(
      new DesignServiceError(
        "design_conflict",
        "Canvas changed while copying the design.",
        409,
        {
          designId,
          canvasId,
          latestRevision: 8,
          conflictObjectIds: [],
          retryable: false,
        },
      ),
    );
    const app = await appWith(designService);
    const response = await app.inject({
      method: "POST",
      url: `/api/designs/${designId}/copy`,
      payload: {
        request_id: requestId,
        source_design_id: designId,
        canvas_id: canvasId,
        expected_canvas_revision: 7,
        canvas_element_id: "copy-node",
        node: { x: 10, y: 20, width: 320, height: 320 },
      },
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(canvasRevisionConflictResponseSchema.parse(response.json())).toEqual(
      {
        error: {
          code: "CANVAS_REVISION_CONFLICT",
          message: "Canvas changed while copying the design.",
          canvas_id: canvasId,
          latest_revision: 8,
          retryable: false,
        },
      },
    );
    await app.close();
  });
});

function createPayload() {
  return {
    request_id: requestId,
    canvas_id: canvasId,
    expected_canvas_revision: 0,
    canvas_element_id: "node-1",
    name: "Design",
    width: 1080,
    height: 1080,
    background: "#ffffff",
    node: { x: 0, y: 0, width: 320, height: 320 },
  };
}

function mutationPayload(id: string) {
  return {
    design_id: id,
    expected_revision: 0,
    idempotency_key: requestId,
    commands: [
      {
        action: "scene.replace",
        scene: {
          schemaVersion: 1,
          engine: "fabric",
          canvas: { width: 1080, height: 1080, background: "#ffffff" },
          objects: [],
        },
      },
    ],
  };
}

function canvasImageImportPayload() {
  return {
    request_id: requestId,
    design_id: designId,
    expected_design_revision: 0,
    canvas_id: canvasId,
    source_element_id: "source-image",
    expected_source_element_version: 2,
    board_element_id: "design-board",
    expected_board_element_version: 3,
    mode: "adopt" as const,
    placement: { kind: "preserve" as const },
  };
}
