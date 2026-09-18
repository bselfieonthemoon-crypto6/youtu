import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerRunRoutes } from "./runs.js";

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("agent run provider snapshots", () => {
  it("cancels the in-memory run when its durable request cannot be persisted", async () => {
    const app = Fastify(); apps.push(app);
    const cancelRun = vi.fn();
    const snapshot = vi.fn();
    await registerRunRoutes(app, {
      createRun: vi.fn(() => ({ conversationId: "c", runId: "r", sessionId: "s", status: "accepted" })), cancelRun,
    } as never, {
      auth: { authenticate: async () => ({ id: "u", accessToken: "token" }) } as never,
      threadService: { resolveOwnedSessionThread: async () => ({ threadId: "t" }) } as never,
      agentRunMetadataService: { createAcceptedRun: vi.fn().mockRejectedValue(new Error("request persistence failed")) } as never,
      providerSnapshotService: { createRunSnapshot: snapshot } as never,
    });
    const response = await app.inject({ method: "POST", url: "/api/agent/runs", payload: { sessionId: "s", conversationId: "c", prompt: "确认生成" } });
    expect(response.statusCode).toBe(500);
    expect(cancelRun).toHaveBeenCalledWith("r", "u");
    expect(snapshot).not.toHaveBeenCalled();
  });
  it.each([
    { defaultModel: "apiyi:gemini-3.1-flash-lite", explicit: undefined, expected: 422 },
    { defaultModel: "apiyi:gemini-3.1-flash-lite", explicit: "audit:unknown", expected: 422 },
    { defaultModel: "workspace:11111111-1111-4111-8111-111111111111", explicit: undefined, expected: 422 },
    { defaultModel: "workspace:11111111-1111-4111-8111-111111111111", explicit: "workspace:11111111-1111-4111-8111-111111111111", expected: 422 },
  ])("handles an empty catalog without bypassing disabled defaults ($defaultModel / $explicit)", async ({defaultModel, explicit, expected}) => {
    const app = Fastify(); apps.push(app);
    const createRun = vi.fn(() => ({ conversationId: "c", runId: "r", sessionId: "s", status: "accepted" }));
    await registerRunRoutes(app, { createRun, cancelRun: vi.fn() } as never, {
      auth: { authenticate: async () => ({ id: "u", accessToken: "token" }) } as never,
      viewerService: { ensureViewer: async () => ({ workspace: { id: "w" } }) } as never,
      settingsService: { getWorkspaceSettings: async () => ({ defaultModel }) } as never,
      workspaceModelCatalogService: { listPublished: async () => [], resolvePublishedModel: async () => null } as never,
    });
    const response = await app.inject({method: "POST", url: "/api/agent/runs", payload: {sessionId: "s", conversationId: "c", prompt: "hello", ...(explicit ? {model: explicit} : {})}});
    expect(response.statusCode).toBe(expected);
    expect(createRun).toHaveBeenCalledTimes(expected === 202 ? 1 : 0);
    if (expected === 202) expect(createRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({model: defaultModel}));
  });
  it.each(["audit:unknown", "apiyi:gemini-3.1-flash-lite"])("validates explicit model %s before accepting", async (model) => {
    const app = Fastify(); apps.push(app);
    const createRun = vi.fn(() => ({ conversationId: "c", runId: "r", sessionId: "s", status: "accepted" }));
    await registerRunRoutes(app, { createRun, cancelRun: vi.fn() } as never, {
      auth: { authenticate: async () => ({ id: "u", accessToken: "token" }) } as never,
      viewerService: { ensureViewer: async () => ({ workspace: { id: "w" } }) } as never,
      settingsService: { getWorkspaceSettings: async () => ({ defaultModel: "apiyi:gemini-3.1-flash-lite" }) } as never,
      workspaceModelCatalogService: { listPublished: async () => [], resolvePublishedModel: async () => null } as never,
    });
    const response = await app.inject({method: "POST", url: "/api/agent/runs", payload: {sessionId: "s", conversationId: "c", prompt: "hello", model}});
    expect(response.statusCode).toBe(422);
    expect(createRun).not.toHaveBeenCalled();
  });
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
