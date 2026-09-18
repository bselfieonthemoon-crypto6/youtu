import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "./connection-manager.js";
import { registerWsRoute } from "./handler.js";

describe("explicit Agent model validation", () => {
  it("uses the live published default for an ordinary UI request with no model override", async () => {
    const app = Fastify();
    const id = "workspace:11111111-1111-4111-8111-111111111111";
    const createRun = vi.fn(() => ({conversationId: "c", sessionId: "s", runId: "r", status: "accepted"}));
    await app.register(websocket);
    await registerWsRoute(app, {
      agentRuns: { createRun, async *streamRun() {} } as never,
      auth: { authenticate: async () => ({id: "u", accessToken: "token", email: "", userMetadata: {}}) },
      connectionManager: new ConnectionManager(),
      viewerService: { ensureViewer: async () => ({workspace: {id: "w"}}) } as never,
      settingsService: { getWorkspaceSettings: async () => ({defaultModel: "apiyi:gemini-3.1-flash-lite"}) } as never,
      threadService: { resolveOwnedSessionThread: async () => ({threadId: "thread"}) } as never,
      agentRunMetadataService: { createAcceptedRun: async () => {}, updateRun: async () => {} } as never,
      providerSnapshotService: { createRunSnapshot: async () => {} } as never,
      workspaceModelCatalogService: { listPublished: async () => [{model: {id, modality: "text"}}] } as never,
    });
    await app.ready();
    const socket = await app.injectWS("/api/ws?token=test&connectionId=test");
    try {
      const response = new Promise<any>(resolve => socket.once("message", raw => resolve(JSON.parse(raw.toString()))));
      socket.send(JSON.stringify({type: "command", action: "agent.run", payload: {sessionId: "s", conversationId: "c", prompt: "hello"}}));
      expect((await response).type).toBe("command.ack");
      expect(createRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({model: id}));
    } finally { socket.close(); await app.close(); }
  });
  it.each([
    {model: "audit:unknown", defaultModel: "apiyi:gemini-3.1-flash-lite", accepted: false},
    {model: "apiyi:gemini-3.1-flash-lite", defaultModel: "apiyi:gemini-3.1-flash-lite", accepted: false},
    {model: undefined, defaultModel: "workspace:11111111-1111-4111-8111-111111111111", accepted: false},
    {model: "workspace:11111111-1111-4111-8111-111111111111", defaultModel: "workspace:11111111-1111-4111-8111-111111111111", accepted: false},
  ])("checks $model / $defaultModel without bypassing disabled defaults", async ({model, defaultModel, accepted}) => {
    const app = Fastify();
    const createRun = vi.fn(() => ({conversationId: "c", sessionId: "s", runId: "r", status: "accepted"}));
    await app.register(websocket);
    await registerWsRoute(app, {
      agentRuns: { createRun, async *streamRun() {} } as never,
      auth: { authenticate: async () => ({id: "u", accessToken: "token", email: "audit@example.test", userMetadata: {}}) },
      connectionManager: new ConnectionManager(),
      viewerService: { ensureViewer: async () => ({workspace: {id: "w"}}) } as never,
      settingsService: { getWorkspaceSettings: async () => ({defaultModel}) } as never,
      workspaceModelCatalogService: { resolvePublishedModel: async () => null } as never,
    });
    await app.ready();
    const socket = await app.injectWS("/api/ws?token=test&connectionId=test");
    try {
      const response = new Promise<Record<string, unknown>>(resolve => socket.once("message", raw => resolve(JSON.parse(raw.toString()))));
      socket.send(JSON.stringify({type: "command", action: "agent.run", payload: {sessionId: "s", conversationId: "c", prompt: "hello", model}}));
      expect((await response).type).toBe(accepted ? "command.ack" : "error");
      expect(createRun).toHaveBeenCalledTimes(accepted ? 1 : 0);
    } finally { socket.close(); await app.close(); }
  });
});
