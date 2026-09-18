import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { createAgentRunService } from "../agent/runtime.js";
import { ConnectionManager } from "./connection-manager.js";
import { registerWsRoute } from "./handler.js";

it("checks WS cancellation against real registered run ownership and keeps the session reusable", async () => {
  let sequence = 0;
  const runs = createAgentRunService({
    env: { agentModel: "test", port: 3001, version: "test", webOrigin: "http://localhost:3020" },
    runIdFactory: () => `registered-${++sequence}`,
  });
  const input = { conversationId: "qa-conversation", sessionId: "qa-session", prompt: "test" };
  const first = runs.createRun(input, { userId: "owner" });
  const cancel = vi.spyOn(runs, "cancelRun"); // Calls the real runtime registry, not a stub.
  const app = Fastify();
  const manager = new ConnectionManager();
  await app.register(websocket);
  await registerWsRoute(app, {
    agentRuns: runs, connectionManager: manager,
    auth: { authenticate: async request => {
      const token = request.headers.authorization?.replace("Bearer ", "");
      return token === "owner" || token === "other"
        ? { id: token, accessToken: token, email: `${token}@qa.invalid`, userMetadata: {} } : null;
    } },
  });
  await app.ready();
  const owner = await app.injectWS("/api/ws?token=owner&connectionId=qa-owner");
  const other = await app.injectWS("/api/ws?token=other&connectionId=qa-other");
  const send = (socket: typeof owner, runId: string) => socket.send(JSON.stringify({ type: "command", action: "agent.cancel", payload: { runId } }));
  try {
    send(other, first.runId);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(cancel.mock.results[0]?.value).toBeNull();
    send(owner, first.runId);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(2));
    expect(cancel.mock.results[1]?.value).toEqual({ runId: first.runId, status: "canceled" });
    const terminal = await runs.streamRun(first.runId).next();
    expect(terminal.value).toMatchObject({ type: "run.canceled", runId: first.runId });
    const next = runs.createRun(input, { userId: "owner" });
    expect(next).toMatchObject({ status: "accepted", sessionId: input.sessionId });
    expect(next.runId).not.toBe(first.runId);
    send(other, next.runId);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(3));
    expect(cancel.mock.results[2]?.value).toBeNull();
    send(owner, next.runId);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(4));
    expect(cancel.mock.results[3]?.value).toEqual({ runId: next.runId, status: "canceled" });
  } finally {
    owner.close(); other.close();
    await app.close(); manager.dispose();
  }
});
