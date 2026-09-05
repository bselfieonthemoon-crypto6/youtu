import { describe, expect, it, vi } from "vitest";

import type { DesignDocumentDto } from "@loomic/shared";

import { DesignApiError } from "../src/lib/design-api";
import {
  StableIdempotencyKeys,
  createDesignDocumentController,
  deriveDesignPreviewPresentation,
} from "../src/lib/design-document-controller";

const ids = {
  design: "10000000-0000-4000-8000-000000000001",
  request1: "20000000-0000-4000-8000-000000000001",
  request2: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000001",
  asset: "40000000-0000-4000-8000-000000000001",
  workspace: "50000000-0000-4000-8000-000000000001",
  project: "60000000-0000-4000-8000-000000000001",
} as const;

describe("DesignDocumentController", () => {
  it("reuses one frozen idempotency key across a network retry", async () => {
    const mutateDesign = vi
      .fn()
      .mockRejectedValueOnce(new DesignApiError("network_error", "offline", 0))
      .mockResolvedValueOnce({
        design_id: ids.design,
        revision: 5,
        changed_object_ids: [],
        replayed: false,
      });
    const getDesign = vi.fn(async () => document(5));
    const controller = controllerWith(
      { mutateDesign, getDesign, queueDesignPreview: vi.fn() },
      [ids.request1],
    );
    controller.stage([{ action: "scene.replace", scene: scene() }]);

    await expect(controller.save()).rejects.toThrow("offline");
    const frozen = controller.getState();
    expect(frozen).toMatchObject({
      status: "error",
      mutationIdempotencyKey: ids.request1,
      mutationExpectedRevision: 4,
    });
    await expect(controller.save()).resolves.toMatchObject({ revision: 5 });

    const first = mutateDesign.mock.calls[0]?.[1];
    const second = mutateDesign.mock.calls[1]?.[1];
    expect(second).toEqual(first);
    expect(controller.getState()).toMatchObject({
      status: "ready",
      authoritativeRevision: 5,
      mutationIdempotencyKey: null,
      pendingCommands: [],
    });
  });

  it("holds a conflict until an explicit authoritative reload and rebase", async () => {
    const mutateDesign = vi.fn().mockRejectedValue(
      new DesignApiError("DESIGN_CONFLICT", "changed", 409, {
        designId: ids.design,
        latestRevision: 6,
        conflictObjectIds: [],
        retryable: false,
      }),
    );
    const getDesign = vi.fn(async () => document(6));
    const controller = controllerWith(
      { mutateDesign, getDesign, queueDesignPreview: vi.fn() },
      [ids.request1, ids.request2],
    );
    controller.stage([{ action: "scene.replace", scene: scene() }]);

    await expect(controller.save()).rejects.toThrow("changed");
    expect(controller.getState()).toMatchObject({
      status: "conflict",
      authoritativeRevision: 6,
      mutationIdempotencyKey: ids.request1,
    });
    await controller.reload({ pending: "rebase" });
    expect(controller.getState()).toMatchObject({
      status: "dirty",
      authoritativeRevision: 6,
      mutationIdempotencyKey: ids.request2,
      mutationExpectedRevision: null,
    });
  });

  it("reuses the preview request key when initial publication fails", async () => {
    const queueDesignPreview = vi
      .fn()
      .mockRejectedValueOnce(new DesignApiError("network_error", "offline", 0))
      .mockResolvedValueOnce({
        design_id: ids.design,
        revision: 4,
        status: "queued",
        job_id: ids.job,
        replayed: true,
      });
    const controller = controllerWith(
      { mutateDesign: vi.fn(), getDesign: vi.fn(), queueDesignPreview },
      [ids.request1],
    );

    await expect(controller.requestPreview()).rejects.toThrow("offline");
    expect(controller.getState().preview.status).toBe("error");
    await controller.requestPreview();
    expect(queueDesignPreview.mock.calls[1]?.[1]).toEqual(
      queueDesignPreview.mock.calls[0]?.[1],
    );
    expect(controller.getState()).toMatchObject({
      previewJobId: ids.job,
      preview: { status: "generating" },
    });
  });

  it("keeps the previous preview visible in stale and error states", () => {
    expect(
      deriveDesignPreviewPresentation({
        ...document(5),
        preview_asset_object_id: ids.asset,
        preview_revision: 4,
        preview_status: "error",
      }),
    ).toMatchObject({
      status: "error",
      assetObjectId: ids.asset,
      previewRevision: 4,
      placeholder: "error",
      canRetry: true,
    });
    expect(
      deriveDesignPreviewPresentation({
        ...document(5),
        preview_asset_object_id: ids.asset,
        preview_revision: 4,
        preview_status: "stale",
      }),
    ).toMatchObject({
      status: "preview_stale",
      assetObjectId: ids.asset,
      placeholder: "stale",
    });
  });
});

function controllerWith(
  client: {
    mutateDesign: ReturnType<typeof vi.fn>;
    getDesign: ReturnType<typeof vi.fn>;
    queueDesignPreview: ReturnType<typeof vi.fn>;
  },
  generatedIds: string[],
) {
  let index = 0;
  return createDesignDocumentController({
    client: client as never,
    accessToken: "token",
    designId: ids.design,
    initialDocument: document(4),
    idempotencyKeys: new StableIdempotencyKeys(
      () => generatedIds[index++] ?? ids.request2,
    ),
  });
}

function document(revision: number): DesignDocumentDto {
  return {
    id: ids.design,
    workspace_id: ids.workspace,
    project_id: ids.project,
    name: "Design",
    width: 1080,
    height: 1080,
    revision,
    scene: scene(),
    preview_asset_object_id: null,
    preview_revision: 0,
    preview_status: "missing",
    deleted_at: null,
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z",
  };
}

function scene() {
  return {
    schemaVersion: 1 as const,
    engine: "fabric" as const,
    canvas: { width: 1080, height: 1080, background: "#ffffff" },
    objects: [],
  };
}
