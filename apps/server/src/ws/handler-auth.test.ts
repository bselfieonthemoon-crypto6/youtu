import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { StreamEvent } from "@loomic/shared";

import { createAgentRunService, type AgentRunService } from "../agent/runtime.js";
import type { ServerEnv } from "../config/env.js";
import type { CanvasService } from "../features/canvas/canvas-service.js";
import type { DestructiveConfirmationService } from "../features/agent-actions/destructive-confirmation-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import { ConnectionManager } from "./connection-manager.js";
import { registerWsRoute } from "./handler.js";

const testEnv: ServerEnv = {
  agentModel: "test-model",
  port: 3001,
  version: "test",
  webOrigin: "http://localhost:3002",
};

describe("canvas.resume authorization", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("replays an immediate first frame after delayed authentication", async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(websocket);

    let finishAuthentication!: (user: Awaited<ReturnType<RequestAuthenticator["authenticate"]>>) => void;
    const authentication = new Promise<Awaited<ReturnType<RequestAuthenticator["authenticate"]>>>((resolve) => {
      finishAuthentication = resolve;
    });
    const auth: RequestAuthenticator = {
      authenticate: vi.fn(async () => authentication),
    };
    const canvasService = {
      getCanvas: vi.fn().mockResolvedValue({ id: "canvas-1" }),
    } as unknown as CanvasService;
    const connectionManager = new ConnectionManager();
    await registerWsRoute(app, {
      agentRuns: createAgentRunService({ env: testEnv }),
      auth,
      canvasService,
      connectionManager,
    });
    await app.ready();

    const socket = await app.injectWS(
      "/api/ws?token=valid-token&connectionId=immediate-first-frame",
    );
    sockets.push(socket);
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (raw) => resolve(JSON.parse(raw.toString())));
    });
    socket.send(JSON.stringify({
      type: "command",
      action: "canvas.resume",
      payload: { canvasId: "canvas-1", lastSeq: 0 },
    }));

    expect(canvasService.getCanvas).not.toHaveBeenCalled();
    finishAuthentication({
      accessToken: "valid-token",
      email: "owner@example.test",
      id: "owner-1",
      userMetadata: {},
    });

    await expect(response).resolves.toMatchObject({
      type: "command.ack",
      action: "canvas.resume",
      payload: { canvasId: "canvas-1" },
    });
    expect(canvasService.getCanvas).toHaveBeenCalledOnce();

    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(16_000);
      expect(socket.readyState).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an in-flight run block a later cancel frame", async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(websocket);
    let finishAuthentication!: (user: Awaited<ReturnType<RequestAuthenticator["authenticate"]>>) => void;
    const authentication = new Promise<Awaited<ReturnType<RequestAuthenticator["authenticate"]>>>((resolve) => {
      finishAuthentication = resolve;
    });
    let finishRun!: () => void;
    const runGate = new Promise<void>((resolve) => { finishRun = resolve; });
    const cancelRun = vi.fn(() => ({ runId: "run-1", status: "canceled" as const }));
    const agentRuns = {
      createRun: vi.fn(() => ({
        conversationId: "conversation-1",
        runId: "run-1",
        sessionId: "session-1",
        status: "accepted",
      })),
      cancelRun,
      async *streamRun() {
        yield {
          type: "run.started",
          runId: "run-1",
          conversationId: "conversation-1",
          sessionId: "session-1",
          timestamp: new Date().toISOString(),
        } as StreamEvent;
        await runGate;
        yield {
          type: "run.canceled",
          runId: "run-1",
          timestamp: new Date().toISOString(),
        } as StreamEvent;
      },
    } as unknown as AgentRunService;
    await registerWsRoute(app, {
      agentRuns,
      auth: { authenticate: vi.fn(async () => authentication) },
      connectionManager: new ConnectionManager(),
    });
    await app.ready();

    const socket = await app.injectWS("/api/ws?token=valid-token");
    sockets.push(socket);
    socket.on("message", () => undefined);
    socket.send(JSON.stringify({
      type: "command",
      action: "agent.run",
      payload: {
        conversationId: "conversation-1",
        sessionId: "session-1",
        prompt: "long run",
      },
    }));
    finishAuthentication({
      accessToken: "valid-token",
      email: "owner@example.test",
      id: "owner-1",
      userMetadata: {},
    });
    await vi.waitFor(() => expect(agentRuns.createRun).toHaveBeenCalledOnce());

    socket.send(JSON.stringify({
      type: "command",
      action: "agent.cancel",
      payload: { runId: "run-1" },
    }));
    await vi.waitFor(() => expect(cancelRun).toHaveBeenCalledWith("run-1", "owner-1"));
    finishRun();
  });

  it("discards buffered commands when delayed authentication fails", async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(websocket);

    let rejectAuthentication!: () => void;
    const authentication = new Promise<null>((resolve) => {
      rejectAuthentication = () => resolve(null);
    });
    const auth: RequestAuthenticator = {
      authenticate: vi.fn(async () => authentication),
    };
    const canvasService = {
      getCanvas: vi.fn().mockResolvedValue({ id: "canvas-1" }),
    } as unknown as CanvasService;
    await registerWsRoute(app, {
      agentRuns: createAgentRunService({ env: testEnv }),
      auth,
      canvasService,
      connectionManager: new ConnectionManager(),
    });
    await app.ready();

    const socket = await app.injectWS("/api/ws?token=invalid-token");
    sockets.push(socket);
    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => resolve(code));
    });
    socket.send(JSON.stringify({
      type: "command",
      action: "canvas.resume",
      payload: { canvasId: "canvas-1", lastSeq: 0 },
    }));
    rejectAuthentication();

    await expect(closed).resolves.toBe(4001);
    expect(canvasService.getCanvas).not.toHaveBeenCalled();
  });

  it("closes and clears a pre-authentication buffer that exceeds its bound", async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(websocket);

    let finishAuthentication!: () => void;
    const authentication = new Promise<null>((resolve) => {
      finishAuthentication = () => resolve(null);
    });
    const connectionManager = new ConnectionManager();
    const register = vi.spyOn(connectionManager, "register");
    await registerWsRoute(app, {
      agentRuns: createAgentRunService({ env: testEnv }),
      auth: { authenticate: vi.fn(async () => authentication) },
      canvasService: { getCanvas: vi.fn() } as unknown as CanvasService,
      connectionManager,
    });
    await app.ready();

    const socket = await app.injectWS("/api/ws?token=valid-token");
    sockets.push(socket);
    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => resolve(code));
    });
    for (let index = 0; index <= 32; index += 1) {
      socket.send(JSON.stringify({ type: "probe", index }));
    }

    await expect(closed).resolves.toBe(1009);
    finishAuthentication();
    await Promise.resolve();
    expect(register).not.toHaveBeenCalled();
  });

  it("rejects a canvas the connected user does not own before binding it", async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(websocket);

    const auth: RequestAuthenticator = {
      async authenticate() {
        return {
          accessToken: "valid-token",
          email: "attacker@example.test",
          id: "attacker",
          userMetadata: {},
        };
      },
    };
    const canvasService = {
      getCanvas: vi.fn().mockRejectedValue(new Error("not found")),
    } as unknown as CanvasService;
    const connectionManager = new ConnectionManager();
    const bindCanvas = vi.spyOn(connectionManager, "bindCanvas");

    await registerWsRoute(app, {
      agentRuns: createAgentRunService({ env: testEnv }),
      auth,
      canvasService,
      connectionManager,
    });
    await app.ready();

    const socket = await app.injectWS(
      "/api/ws?token=valid-token&connectionId=connection-1",
    );
    sockets.push(socket);

    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (raw) => resolve(JSON.parse(raw.toString())));
    });
    socket.send(
      JSON.stringify({
        type: "command",
        action: "canvas.resume",
        payload: { canvasId: "someone-elses-canvas", lastSeq: 0 },
      }),
    );

    await expect(response).resolves.toEqual({
      type: "error",
      message: "Canvas not found or access denied",
    });
    expect(canvasService.getCanvas).toHaveBeenCalledWith(
      expect.objectContaining({ id: "attacker" }),
      "someone-elses-canvas",
    );
    expect(bindCanvas).not.toHaveBeenCalled();
  });

  it("executes a frozen confirmation only for the authenticated bound canvas", async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(websocket);

    const auth: RequestAuthenticator = {
      async authenticate() {
        return {
          accessToken: "valid-token",
          email: "owner@example.test",
          id: "owner-1",
          userMetadata: {},
        };
      },
    };
    const canvasService = {
      getCanvas: vi.fn().mockResolvedValue({ id: "canvas-1" }),
    } as unknown as CanvasService;
    const confirm = vi.fn().mockResolvedValue({ success: true, applied: 1 });
    const destructiveConfirmationService = {
      confirm,
      cancel: vi.fn(),
      propose: vi.fn(),
    } as unknown as DestructiveConfirmationService;
    const connectionManager = new ConnectionManager();

    await registerWsRoute(app, {
      agentRuns: createAgentRunService({ env: testEnv }),
      auth,
      canvasService,
      connectionManager,
      destructiveConfirmationService,
    });
    await app.ready();

    const socket = await app.injectWS(
      "/api/ws?token=valid-token&connectionId=connection-2",
    );
    sockets.push(socket);

    const resumeAck = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (raw) => resolve(JSON.parse(raw.toString())));
    });
    socket.send(JSON.stringify({
      type: "command",
      action: "canvas.resume",
      payload: { canvasId: "canvas-1", lastSeq: 0 },
    }));
    await expect(resumeAck).resolves.toMatchObject({
      type: "command.ack",
      action: "canvas.resume",
    });

    const messages: Record<string, unknown>[] = [];
    const received = new Promise<void>((resolve) => {
      const listener = (raw: Buffer) => {
        messages.push(JSON.parse(raw.toString()));
        if (messages.length === 2) {
          socket.off("message", listener);
          resolve();
        }
      };
      socket.on("message", listener);
    });
    const confirmationId = "00000000-0000-4000-8000-000000000001";
    socket.send(JSON.stringify({
      type: "command",
      action: "agent.confirm_action",
      payload: { confirmationId, decision: "confirm" },
    }));
    await received;

    expect(confirm).toHaveBeenCalledWith({
      confirmationId,
      userId: "owner-1",
      canvasId: "canvas-1",
      context: {
        user: expect.objectContaining({
          id: "owner-1",
          accessToken: "valid-token",
        }),
      },
    });
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "event",
        event: expect.objectContaining({ type: "canvas.sync" }),
      }),
      expect.objectContaining({
        type: "command.ack",
        action: "agent.confirm_action",
        payload: expect.objectContaining({ status: "applied", confirmationId }),
      }),
    ]));
  });
});
