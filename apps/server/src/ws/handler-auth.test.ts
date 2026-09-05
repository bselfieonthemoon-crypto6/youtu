import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { createAgentRunService } from "../agent/runtime.js";
import type { ServerEnv } from "../config/env.js";
import type { CanvasService } from "../features/canvas/canvas-service.js";
import type { DestructiveConfirmationService } from "../features/agent-actions/destructive-confirmation-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import { ConnectionManager } from "./connection-manager.js";
import { registerWsRoute } from "./handler.js";

const testEnv: ServerEnv = {
  agentBackendMode: "state",
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
