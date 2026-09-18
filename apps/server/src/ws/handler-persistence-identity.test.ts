import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { AgentRunService } from "../agent/runtime.js";
import type { StreamEvent } from "@loomic/shared";
import { ConnectionManager } from "./connection-manager.js";
import { registerWsRoute } from "./handler.js";

describe("WebSocket assistant persistence identity", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("uses the run id when persisting a streamed assistant response", async () => {
    const runId = "33333333-3333-4333-8333-333333333333";
    const createMessage = vi.fn(async () => ({ id: runId }));
    const agentRuns = {
      createRun: vi.fn(() => ({ conversationId: "canvas", runId, sessionId: "session", status: "accepted" })),
      async *streamRun() {
        yield { type: "run.started", runId, conversationId: "canvas", sessionId: "session", timestamp: new Date().toISOString() } as StreamEvent;
        yield { type: "message.delta", runId, messageId: runId, delta: "需要补充品牌名称。", timestamp: new Date().toISOString() } as StreamEvent;
        yield { type: "run.completed", runId, timestamp: new Date().toISOString() } as StreamEvent;
      },
    } as unknown as AgentRunService;
    const app = Fastify();
    apps.push(app);
    await app.register(websocket);
    await registerWsRoute(app, {
      agentRuns,
      chatService: { createMessage } as never,
      connectionManager: new ConnectionManager(),
      canvasService: {
        getCanvas: vi.fn(async () => ({ id: "canvas" })),
        getCanvasWorkspaceId: vi.fn(async () => "workspace"),
      } as never,
      auth: { async authenticate() {
        return { id: "owner", accessToken: "test", email: "owner@example.test", userMetadata: {} };
      } },
    });
    await app.ready();
    const socket = await app.injectWS("/api/ws?token=test&connectionId=persistence-identity");
    sockets.push(socket);
    socket.send(JSON.stringify({ type: "command", action: "agent.run", payload: {
      canvasId: "canvas", conversationId: "canvas", sessionId: "session", prompt: "帮我设计一个Logo。", model: "apiyi:offline",
    } }));

    await vi.waitFor(() => expect(createMessage).toHaveBeenCalledOnce());
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "owner" }),
      "session",
      expect.objectContaining({ id: runId, role: "assistant", content: "需要补充品牌名称。" }),
    );
  });
});
