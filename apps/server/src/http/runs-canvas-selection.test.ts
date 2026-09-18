import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerRunRoutes } from "./runs.js";
import { registerWsRoute } from "../ws/handler.js";
import { ConnectionManager } from "../ws/connection-manager.js";

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const user = { id: "owner", accessToken: "synthetic-token", email: "owner@local.test", userMetadata: {} };
const accepted = { conversationId: "conversation", sessionId: "session", runId: "run", status: "accepted" };
const payload = { canvasId: "canvas", conversationId: "conversation", sessionId: "session", prompt: "点评选中的文字", canvasSelection: { elementIds: ["text-element"] } };

describe("send-time canvas selection transport (not execution authority)", () => {
  it("preserves selection in HTTP without preparing a design task", async () => {
    const app = Fastify(); apps.push(app);
    const createRun = vi.fn(() => accepted);
    const prepareDesignTask = vi.fn();
    await registerRunRoutes(app, { createRun, prepareDesignTask } as never, {
      auth: { authenticate: async () => user } as never,
      threadService: { resolveOwnedSessionThread: async () => ({ threadId: "thread", sessionId: "session" }) } as never,
      viewerService: { ensureViewer: async () => ({ workspace: { id: "workspace" } }) } as never,
    });
    const response = await app.inject({ method: "POST", url: "/api/agent/runs", payload });
    expect(response.statusCode).toBe(202);
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ canvasSelection: payload.canvasSelection }), expect.objectContaining({ userId: user.id, workspaceId: "workspace" }));
    expect(prepareDesignTask).not.toHaveBeenCalled();
  });

  it.each([
    { selection: { elementIds: ["text-element"] }, valid: true },
    { selection: { elementIds: [] }, valid: true },
    { selection: { elementIds: Array.from({ length: 101 }, (_, i) => `element-${i}`) }, valid: false },
  ])("preserves or rejects WebSocket selection before dispatch: $valid", async ({ selection, valid }) => {
    const app = Fastify(); apps.push(app);
    const createRun = vi.fn(() => accepted);
    const prepareDesignTask = vi.fn();
    await app.register(websocket);
    await registerWsRoute(app, {
      agentRuns: { createRun, prepareDesignTask, streamRun: async function* () {} } as never,
      auth: { authenticate: async () => user }, connectionManager: new ConnectionManager(),
      canvasService: { getCanvas: async () => ({}), getCanvasWorkspaceId: async () => "workspace" } as never,
      threadService: { resolveOwnedSessionThread: async () => ({ threadId: "thread", sessionId: "session" }) } as never,
    });
    await app.ready();
    const socket = await app.injectWS("/api/ws?token=synthetic-token&connectionId=selection-transport-test");
    try {
      const response = new Promise<Record<string, unknown>>(resolve => socket.once("message", raw => resolve(JSON.parse(raw.toString()))));
      socket.send(JSON.stringify({ type: "command", action: "agent.run", requestId: "request", payload: { ...payload, canvasSelection: selection } }));
      expect(await response).toMatchObject({ type: valid ? "command.ack" : "error" });
      if (valid) {
        expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ canvasSelection: selection }), expect.objectContaining({ userId: user.id, workspaceId: "workspace" }));
      } else {
        expect(createRun).not.toHaveBeenCalled();
      }
      expect(prepareDesignTask).not.toHaveBeenCalled();
    } finally { socket.close(); }
  });
});
