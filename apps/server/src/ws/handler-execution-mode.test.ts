import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import type { AgentRunService } from "../agent/runtime.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import { ConnectionManager } from "./connection-manager.js";
import { registerWsRoute } from "./handler.js";

describe("agent.run WebSocket execution mode", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("normalizes legacy executionMode and preserves the bound image confirmation", async () => {
    const createRun = vi.fn().mockReturnValue({
      conversationId: "conversation-1",
      runId: "run-1",
      sessionId: "session-1",
      status: "accepted",
    });
    const agentRuns = {
      createRun,
      async *streamRun() {
        // No stream content is needed for payload projection coverage.
      },
    } as unknown as AgentRunService;
    const auth: RequestAuthenticator = {
      async authenticate() {
        return {
          accessToken: "token-1",
          email: "owner@example.test",
          id: "owner-1",
          userMetadata: {},
        };
      },
    };
    const app = Fastify();
    apps.push(app);
    await app.register(websocket);
    await registerWsRoute(app, {
      agentRuns,
      auth,
      connectionManager: new ConnectionManager(),
    });
    await app.ready();

    const socket = await app.injectWS(
      "/api/ws?token=valid-token&connectionId=connection-1",
    );
    sockets.push(socket);
    const ack = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (raw) => resolve(JSON.parse(raw.toString())));
    });
    socket.send(
      JSON.stringify({
        type: "command",
        action: "agent.run",
        payload: {
          conversationId: "conversation-1",
          executionMode: "fast",
          model: "google:gemini-test",
          prompt: "hello",
          activeDesignId: "20000000-0000-4000-8000-000000000001",
          imageConfirmation: {
            confirmationId: "10000000-0000-4000-8000-000000000001",
            decision: "confirm",
          },
          sessionId: "session-1",
        },
      }),
    );

    await expect(ack).resolves.toMatchObject({
      type: "command.ack",
      action: "agent.run",
    });
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: "thinking",
        activeDesignId: "20000000-0000-4000-8000-000000000001",
        imageConfirmation: {
          confirmationId: "10000000-0000-4000-8000-000000000001",
          decision: "confirm",
        },
        model: "google:gemini-test",
      }),
      expect.objectContaining({
        accessToken: "token-1",
        model: "google:gemini-test",
        userId: "owner-1",
      }),
    );
  });
});
