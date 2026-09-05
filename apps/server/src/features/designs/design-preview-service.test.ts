import { describe, expect, it, vi } from "vitest";

import {
  type DesignPreviewRepository,
  DesignPreviewService,
} from "./design-preview-service.js";

const designId = "10000000-0000-4000-8000-000000000001";
const actorUserId = "20000000-0000-4000-8000-000000000001";
const idempotencyKey = "30000000-0000-4000-8000-000000000001";
const assetId = "40000000-0000-4000-8000-000000000001";

function repository(): DesignPreviewRepository {
  return {
    queue: vi.fn(async (input) => ({
      design_id: input.designId,
      revision: input.expectedRevision,
      status: "queued" as const,
      job_id: input.jobId,
      replayed: false,
    })),
    commit: vi.fn(async (input) => ({
      design_id: input.designId,
      revision: input.expectedRevision + 1,
      committed: false,
      replayed: false,
    })),
  };
}

describe("DesignPreviewService", () => {
  it("publishes the durable preview job created by the queue transaction", async () => {
    const repo = repository();
    const publish = vi.fn(async () => undefined);
    const service = new DesignPreviewService(repo, { publish });

    const result = await service.enqueue({
      designId,
      expectedRevision: 7,
      idempotencyKey,
      actorUserId,
    });

    expect(result.job_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(publish).toHaveBeenCalledWith({
      job_id: result.job_id,
      job_type: "design_preview",
      design_id: designId,
    });
  });

  it("does not overwrite the current preview when rendering used an old revision", async () => {
    const repo = repository();
    const service = new DesignPreviewService(repo, { publish: vi.fn() });

    await expect(
      service.finalize(
        {
          design_id: designId,
          expected_revision: 7,
          preview_revision: 7,
          preview_asset_object_id: assetId,
          idempotency_key: idempotencyKey,
        },
        actorUserId,
      ),
    ).resolves.toEqual({
      design_id: designId,
      revision: 8,
      committed: false,
      replayed: false,
    });
    expect(repo.commit).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 7, previewRevision: 7 }),
    );
  });
});
