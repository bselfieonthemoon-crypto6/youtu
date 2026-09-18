import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import type { AgentRunService } from "../agent/runtime.js";
import type { AuthenticatedUser, RequestAuthenticator } from "../supabase/user.js";
import { ConnectionManager } from "./connection-manager.js";
import { registerWsRoute } from "./handler.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function waitForMessage(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
) {
  return new Promise<Record<string, unknown>>((resolve) => {
    const listener = (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (!predicate(message)) return;
      socket.off("message", listener);
      resolve(message);
    };
    socket.on("message", listener);
  });
}

describe("WebSocket connection ownership", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("keeps a delayed receipt on its source socket and an old close cannot remove a colliding socket", async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(websocket);

    const users: Record<string, AuthenticatedUser> = {
      a: {
        id: "user-a",
        email: "a@example.test",
        accessToken: "a",
        userMetadata: {},
      },
      b: {
        id: "user-b",
        email: "b@example.test",
        accessToken: "b",
        userMetadata: {},
      },
    };
    const auth: RequestAuthenticator = {
      async authenticate(request) {
        const token = request.headers.authorization?.replace("Bearer ", "");
        return token ? users[token] ?? null : null;
      },
    };
    const delayedCanvas = deferred<{ id: string }>();
    const getCanvas = vi.fn(
      async (user: AuthenticatedUser, canvasId: string) =>
        user.id === "user-a"
          ? delayedCanvas.promise
          : { id: canvasId },
    );
    await registerWsRoute(app, {
      agentRuns: {
        createRun: vi.fn(),
        async *streamRun() {},
      } as unknown as AgentRunService,
      auth,
      canvasService: { getCanvas } as never,
      connectionManager: new ConnectionManager(),
    });
    await app.ready();

    const knownId = "attacker-chosen-known-id";
    const socketA = await app.injectWS(`/api/ws?token=a&connectionId=${knownId}`);
    sockets.push(socketA);
    const aAck = waitForMessage(
      socketA,
      (message) =>
        message.type === "command.ack" && message.action === "canvas.resume",
    );
    socketA.send(JSON.stringify({
      type: "command",
      action: "canvas.resume",
      requestId: "a-resume",
      payload: { canvasId: "canvas-a", lastSeq: 0 },
    }));
    await vi.waitFor(() => expect(getCanvas).toHaveBeenCalledTimes(1));

    const socketB = await app.injectWS(`/api/ws?token=b&connectionId=${knownId}`);
    sockets.push(socketB);
    const bMessages: Record<string, unknown>[] = [];
    socketB.on("message", (raw) => {
      bMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });

    delayedCanvas.resolve({ id: "canvas-a" });
    await expect(aAck).resolves.toMatchObject({
      type: "command.ack",
      action: "canvas.resume",
    });
    expect(bMessages).not.toContainEqual(expect.objectContaining({
      type: "command.ack",
      action: "canvas.resume",
    }));

    const closed = new Promise<void>((resolve) => socketA.once("close", resolve));
    socketA.close();
    await closed;

    const bAck = waitForMessage(
      socketB,
      (message) =>
        message.type === "command.ack" &&
        message.action === "canvas.resume",
    );
    socketB.send(JSON.stringify({
      type: "command",
      action: "canvas.resume",
      requestId: "b-resume",
      payload: { canvasId: "canvas-b", lastSeq: 0 },
    }));
    await expect(bAck).resolves.toMatchObject({
      type: "command.ack",
      action: "canvas.resume",
    });
  });
});
