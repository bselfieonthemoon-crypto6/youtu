import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerRunRoutes } from "./runs.js";

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("agent run provider snapshots", () => {
  it("persists the run and creates its immutable snapshot before acknowledging", async () => {
    const order: string[] = [];
    const app = Fastify();
    apps.push(app);
    await registerRunRoutes(app, {
      createRun: vi.fn(() => ({
        conversationId: "conversation-1",
        runId: "run-1",
        sessionId: "session-1",
        status: "accepted",
      })),
      cancelRun: vi.fn(),
    } as never, {
      auth: { authenticate: async () => ({ id: "user-1", accessToken: "token", email: "user@example.test", userMetadata: {} }) } as never,
      viewerService: { ensureViewer: async () => ({ workspace: { id: "workspace-1" } }) } as never,
      threadService: { resolveOwnedSessionThread: async () => ({ threadId: "thread-1" }) } as never,
      agentRunMetadataService: {
        createAcceptedRun: vi.fn(async () => { order.push("persist"); }),
      } as never,
      providerSnapshotService: {
        createRunSnapshot: vi.fn(async () => { order.push("snapshot"); return "snapshot-1"; }),
      } as never,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/runs",
      payload: {
        conversationId: "conversation-1",
        sessionId: "session-1",
        prompt: "hello",
        model: "workspace:11111111-1111-4111-8111-111111111111",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(order).toEqual(["persist", "snapshot"]);
  });

  it("cancels and fails closed when snapshot creation fails", async () => {
    const cancelRun = vi.fn();
    const updateRun = vi.fn(async () => undefined);
    const app = Fastify();
    apps.push(app);
    await registerRunRoutes(app, {
      createRun: () => ({ conversationId: "conversation-1", runId: "run-1", sessionId: "session-1", status: "accepted" }),
      cancelRun,
    } as never, {
      auth: { authenticate: async () => ({ id: "user-1", accessToken: "token", email: "user@example.test", userMetadata: {} }) } as never,
      viewerService: { ensureViewer: async () => ({ workspace: { id: "workspace-1" } }) } as never,
      threadService: { resolveOwnedSessionThread: async () => ({ threadId: "thread-1" }) } as never,
      agentRunMetadataService: { createAcceptedRun: async () => undefined, updateRun } as never,
      providerSnapshotService: { createRunSnapshot: async () => { throw new Error("secret detail"); } } as never,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/runs",
      payload: {
        conversationId: "conversation-1",
        sessionId: "session-1",
        prompt: "hello",
        model: "workspace:11111111-1111-4111-8111-111111111111",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain("secret detail");
    expect(cancelRun).toHaveBeenCalledWith("run-1", "user-1");
    expect(updateRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      status: "failed",
      errorCode: "provider_snapshot_invalid",
    }));
  });
});
