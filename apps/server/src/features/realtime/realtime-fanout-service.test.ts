import { describe, expect, it, vi } from "vitest";

import {
  RealtimeFanoutService,
  type RealtimeFanoutEvent,
  type RealtimeFanoutRepository,
} from "./realtime-fanout-service.js";

const designId = "10000000-0000-4000-8000-000000000001";
const workspaceId = "20000000-0000-4000-8000-000000000001";
const userId = "30000000-0000-4000-8000-000000000001";

function designEvent(id: string): RealtimeFanoutEvent {
  return {
    event_id: id,
    event_type: "design.sync",
    aggregate_id: designId,
    workspace_id: workspaceId,
    payload: {
      type: "design.sync",
      designId,
      revision: 4,
      updateType: "mutated",
      changedObjectIds: [],
    },
    created_at: "2026-09-11T00:00:00.000Z",
  };
}

function sharedRepository() {
  const events: RealtimeFanoutEvent[] = [];
  const cursors = new Map<string, bigint>();
  const repo: RealtimeFanoutRepository = {
    register: vi.fn(async (id) => { if (!cursors.has(id)) cursors.set(id, BigInt(events.length)); }),
    poll: vi.fn(async (id, limit) => events.filter((row) => BigInt(row.event_id) > (cursors.get(id) ?? 0n)).slice(0, limit)),
    acknowledge: vi.fn(async (id, eventId) => {
      if (!cursors.has(id)) return false;
      cursors.set(id, BigInt(eventId));
      return true;
    }),
    unregister: vi.fn(async (id) => { cursors.delete(id); }),
  };
  return { events, repo };
}

describe("RealtimeFanoutService", () => {
  it("delivers one durable design event independently to every registered instance", async () => {
    const shared = sharedRepository();
    const a = vi.fn(async () => undefined);
    const b = vi.fn(async () => undefined);
    const serviceA = new RealtimeFanoutService(shared.repo, { broadcast: a }, { revokeWorkspaceUser: vi.fn() } as never, "40000000-0000-4000-8000-000000000001");
    const serviceB = new RealtimeFanoutService(shared.repo, { broadcast: b }, { revokeWorkspaceUser: vi.fn() } as never, "50000000-0000-4000-8000-000000000001");
    await Promise.all([serviceA.initialize(), serviceB.initialize()]);
    shared.events.push(designEvent("1"));

    await expect(serviceA.publishBatch()).resolves.toEqual({ delivered: 1, failed: 0 });
    await expect(serviceB.publishBatch()).resolves.toEqual({ delivered: 1, failed: 0 });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it("does not advance past a failed event and retries it before later rows", async () => {
    const shared = sharedRepository();
    const broadcast = vi.fn()
      .mockRejectedValueOnce(new Error("temporary lookup failure"))
      .mockResolvedValue(undefined);
    const service = new RealtimeFanoutService(shared.repo, { broadcast }, { revokeWorkspaceUser: vi.fn() } as never, "40000000-0000-4000-8000-000000000001");
    await service.initialize();
    shared.events.push(designEvent("1"), designEvent("2"));

    await expect(service.publishBatch()).resolves.toEqual({ delivered: 0, failed: 1 });
    await expect(service.publishBatch()).resolves.toEqual({ delivered: 2, failed: 0 });
    expect(broadcast.mock.calls.map(([, event]) => event.revision)).toEqual([4, 4, 4]);
  });

  it("revokes the matching workspace user and rejects mismatched design scope", async () => {
    const shared = sharedRepository();
    const revokeWorkspaceUser = vi.fn();
    const broadcast = vi.fn(async () => undefined);
    const service = new RealtimeFanoutService(shared.repo, { broadcast }, { revokeWorkspaceUser } as never, "40000000-0000-4000-8000-000000000001");
    await service.initialize();
    shared.events.push({
      event_id: "1",
      event_type: "workspace.membership.changed",
      aggregate_id: workspaceId,
      workspace_id: workspaceId,
      payload: { type: "workspace.membership.changed", workspaceId, userId, change: "removed" },
      created_at: "2026-09-11T00:00:00.000Z",
    });
    await service.publishBatch();
    expect(revokeWorkspaceUser).toHaveBeenCalledWith(workspaceId, userId);

    shared.events.push({ ...designEvent("2"), aggregate_id: userId });
    await expect(service.publishBatch()).resolves.toEqual({ delivered: 0, failed: 1 });
    expect(broadcast).not.toHaveBeenCalled();
  });
});
