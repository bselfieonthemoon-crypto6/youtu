import { describe, expect, it, vi } from "vitest";

import {
  type DesignEventOutboxDto,
  designSyncEventSchema,
} from "@loomic/shared";

import {
  type DesignOutboxRepository,
  DesignOutboxService,
  createConnectionManagerDesignBroadcaster,
} from "./design-outbox-service.js";

const designId = "10000000-0000-4000-8000-000000000001";
const workspaceId = "20000000-0000-4000-8000-000000000001";
const eventId = "30000000-0000-4000-8000-000000000001";

function event(attemptCount = 1): DesignEventOutboxDto {
  return {
    id: eventId,
    design_id: designId,
    workspace_id: workspaceId,
    revision: 4,
    event_type: "design.sync",
    payload: {
      type: "design.sync",
      designId,
      revision: 4,
      updateType: "mutated",
      changedObjectIds: [],
    },
    status: "publishing",
    attempt_count: attemptCount,
    available_at: "2026-09-04T00:00:00.000Z",
    claimed_at: "2026-09-04T00:00:00.000Z",
    claim_token: "40000000-0000-4000-8000-000000000001",
    published_at: null,
    last_error: null,
    created_at: "2026-09-04T00:00:00.000Z",
  };
}

function repository(rows: DesignEventOutboxDto[]): DesignOutboxRepository {
  return {
    claim: vi.fn(async () => rows.splice(0, 1)),
    markPublished: vi.fn(async () => true),
    markFailed: vi.fn(async () => true),
    reconcile: vi.fn(async () => 0),
  };
}

describe("DesignOutboxService", () => {
  it("keeps a failed publish retryable and marks only a later success published", async () => {
    const repo = repository([event(1), event(2)]);
    const broadcast = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket unavailable"))
      .mockResolvedValueOnce(undefined);
    const service = new DesignOutboxService(repo, { broadcast });

    await expect(service.publishBatch()).resolves.toEqual({
      claimed: 1,
      published: 0,
      failed: 1,
    });
    expect(repo.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ eventId, error: "socket unavailable" }),
    );
    expect(repo.markPublished).not.toHaveBeenCalled();

    await expect(service.publishBatch()).resolves.toEqual({
      claimed: 1,
      published: 1,
      failed: 0,
    });
    expect(repo.markPublished).toHaveBeenCalledTimes(1);
  });

  it("rejects a durable payload that is not a top-level design.sync event", async () => {
    const malformed = {
      ...event(),
      event_type: "design.deleted",
      payload: { type: "design.deleted", designId, revision: 4 },
    } as DesignEventOutboxDto;
    const repo = repository([malformed]);
    const broadcast = vi.fn();

    await expect(
      new DesignOutboxService(repo, { broadcast }).publishBatch(),
    ).resolves.toMatchObject({ failed: 1, published: 0 });
    expect(broadcast).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledTimes(1);
  });

  it("runs the stale-lease reconciler", async () => {
    const repo = repository([]);
    vi.mocked(repo.reconcile).mockResolvedValue(3);
    const service = new DesignOutboxService(repo, { broadcast: vi.fn() });

    await expect(service.reconcile()).resolves.toBe(3);
  });

  it("broadcasts the unchanged strict event only to authoritative bound canvases", async () => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(async () => ({
        data: [{ canvas_id: "canvas-a" }, { canvas_id: "canvas-a" }],
        error: null,
      })),
    };
    const sendToCanvas = vi.fn();
    const broadcaster = createConnectionManagerDesignBroadcaster({
      getAdminClient: () => ({ from: vi.fn(() => query) }) as never,
      connections: { sendToCanvas } as never,
    });
    const message = designSyncEventSchema.parse(event().payload);

    await broadcaster.broadcast(designId, message);

    expect(sendToCanvas).toHaveBeenCalledOnce();
    expect(sendToCanvas).toHaveBeenCalledWith("canvas-a", message);
  });
});
