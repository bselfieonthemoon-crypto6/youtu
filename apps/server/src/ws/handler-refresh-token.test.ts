import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "./connection-manager.js";
import { registerWsRoute } from "./handler.js";

describe("long-lived Agent connection", () => {
  it.each(["fresh", "foreign", "invalid", "old", "explode"])(
    "revalidates %s command credentials and correlates replies",
    async (token) => {
      const app = Fastify();
      await app.register(websocket);
      const createRun = vi.fn(() => ({
        conversationId: "c",
        sessionId: "s",
        runId: "r",
        status: "accepted",
      }));
      const canvas = vi.fn(async (user: { accessToken: string }) => {
        if (user.accessToken !== "fresh") throw new Error("JWT expired");
        return { id: "c" };
      });
      await registerWsRoute(app, {
        agentRuns: { createRun, async *streamRun() {} } as never,
        connectionManager: new ConnectionManager(),
        auth: {
          authenticate: async (request) => {
            const value = request.headers.authorization?.replace("Bearer ", "");
            if (value === "explode")
              throw new Error("Auth temporarily unavailable");
            return value === "invalid"
              ? null
              : {
                  id: value === "foreign" ? "other" : "owner",
                  email: "test@example.test",
                  accessToken: value!,
                  userMetadata: {},
                };
          },
        },
        canvasService: {
          getCanvas: canvas,
          getCanvasWorkspaceId: async () => "w",
        } as never,
      });
      await app.ready();
      const socket = await app.injectWS("/api/ws?token=old&connectionId=test");
      try {
        const response = new Promise<any>((resolve) =>
          socket.once("message", (raw) => resolve(JSON.parse(raw.toString()))),
        );
        socket.send(
          JSON.stringify({
            type: "command",
            action: "agent.run",
            requestId: "request-1",
            accessToken: token,
            payload: {
              sessionId: "s",
              conversationId: "c",
              canvasId: "c",
              prompt: "test",
            },
          }),
        );
        expect(await response).toMatchObject({
          type: token === "fresh" ? "command.ack" : "error",
          requestId: "request-1",
          action: "agent.run",
        });
        expect(createRun).toHaveBeenCalledTimes(token === "fresh" ? 1 : 0);
        if (token === "fresh")
          expect(createRun).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accessToken: "fresh" }),
          );
      } finally {
        socket.close();
        await app.close();
      }
    },
  );
});
