import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { createAgentRunService } from "../agent/runtime.js";
import type { ServerEnv } from "../config/env.js";
import type { CanvasService } from "../features/canvas/canvas-service.js";
import type { ChatService } from "../features/chat/chat-service.js";
import type { ToolExecutionService } from "../features/agent-runs/tool-execution-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import { ConnectionManager } from "./connection-manager.js";
import { registerWsRoute } from "./handler.js";

const env: ServerEnv = {
  agentModel: "test-model",
  port: 3001,
  version: "test",
  webOrigin: "http://localhost:3002",
};

describe("agent.retry_tool", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("replays only the server-resolved tool input and persists its block", async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(websocket);
    const execution = {
      id: "00000000-0000-4000-8000-000000000002",
      runId: "00000000-0000-4000-8000-000000000010",
      toolCallId: "retry-call-1",
      toolName: "get_design_objects",
      status: "running" as const,
      input: { detail_level: "summary" },
      output: null,
      outputSummary: null,
      artifacts: null,
      retryable: true,
      attempt: 2,
      retryOf: "00000000-0000-4000-8000-000000000001",
      requestedBy: "owner-1",
      retryRequestId: "00000000-0000-4000-8000-000000000050",
    };
    const toolExecutionService = {
      prepareRetry: vi.fn().mockResolvedValue({
        execution,
        canvasId: "canvas-1",
        sessionId: "session-1",
        threadId: "thread-1",
        isNew: true,
      }),
      recordCompleted: vi.fn().mockResolvedValue({ ...execution, status: "completed" }),
      recordFailed: vi.fn(),
      recordStarted: vi.fn(),
      finishRunningForRun: vi.fn(),
    } as unknown as ToolExecutionService;
    const retryReadTool = vi.fn().mockResolvedValue({ matchedCount: 2 });
    const createMessage = vi.fn().mockResolvedValue({ id: "message-1" });
    const connectionManager = new ConnectionManager();

    await registerWsRoute(app, {
      agentRuns: createAgentRunService({ env }),
      auth: {
        authenticate: async () => ({
          accessToken: "token",
          email: "owner@example.test",
          id: "owner-1",
          userMetadata: {},
        }),
      } as RequestAuthenticator,
      canvasService: {
        getCanvas: vi.fn().mockResolvedValue({ id: "canvas-1" }),
      } as unknown as CanvasService,
      chatService: { createMessage } as unknown as ChatService,
      connectionManager,
      retryReadTool,
      toolExecutionService,
    });
    await app.ready();

    const socket = await app.injectWS("/api/ws?token=token&connectionId=retry-1");
    sockets.push(socket);
    const resume = new Promise<void>((resolve) => socket.once("message", () => resolve()));
    socket.send(JSON.stringify({
      type: "command",
      action: "canvas.resume",
      payload: { canvasId: "canvas-1", lastSeq: 0 },
    }));
    await resume;

    const messages: Array<Record<string, unknown>> = [];
    const done = new Promise<void>((resolve) => {
      const listener = (raw: Buffer) => {
        messages.push(JSON.parse(raw.toString()));
        if (messages.length === 3) {
          socket.off("message", listener);
          resolve();
        }
      };
      socket.on("message", listener);
    });
    socket.send(JSON.stringify({
      type: "command",
      action: "agent.retry_tool",
      payload: {
        toolExecutionId: "00000000-0000-4000-8000-000000000001",
        requestId: "00000000-0000-4000-8000-000000000050",
      },
    }));
    await done;

    expect(retryReadTool).toHaveBeenCalledWith({
      accessToken: "token",
      canvasId: "canvas-1",
      input: { detail_level: "summary" },
      threadId: "thread-1",
      toolName: "get_design_objects",
      userId: "owner-1",
    });
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "event",
        event: expect.objectContaining({ type: "tool.started", toolExecutionId: execution.id }),
      }),
      expect.objectContaining({
        type: "event",
        event: expect.objectContaining({ type: "tool.completed", toolExecutionId: execution.id }),
      }),
      expect.objectContaining({ type: "command.ack", action: "agent.retry_tool" }),
    ]));
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "owner-1" }),
      "session-1",
      expect.objectContaining({
        contentBlocks: [expect.objectContaining({
          toolExecutionId: execution.id,
          toolName: "get_design_objects",
          status: "completed",
          outputSummary: "Retried get_design_objects successfully.",
        })],
      }),
    );
  });
});
