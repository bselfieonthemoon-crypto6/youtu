import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRunService } from "../agent/runtime.js";
import {
  AgentRunPersistenceError,
  type AgentRunMetadataService,
} from "../features/agent-runs/agent-run-service.js";
import type { ThreadService } from "../features/chat/thread-service.js";
import { ThreadServiceError } from "../features/chat/thread-service.js";
import type { AuthenticatedUser, RequestAuthenticator } from "../supabase/user.js";
import { registerRunRoutes } from "./runs.js";

const owner: AuthenticatedUser = {
  accessToken: "token-owner",
  email: "owner@example.test",
  id: "owner-1",
  userMetadata: {},
};

function auth(user: AuthenticatedUser | null): RequestAuthenticator {
  return { authenticate: vi.fn(async () => user) };
}

const runSummary = {
  runId: "run-1",
  sessionId: "session-1",
  status: "completed" as const,
  executionMode: "thinking" as const,
  model: "model-1",
  createdAt: "2026-09-01T01:00:00.000Z",
  startedAt: "2026-09-01T01:00:01.000Z",
  completedAt: "2026-09-01T01:00:02.000Z",
  durationMs: 1000,
  error: null,
  toolCounts: { total: 1, running: 0, completed: 1, failed: 0, canceled: 0 },
};

describe("agent run history authorization", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  async function build(
    user: AuthenticatedUser | null,
    options: { allowSession?: boolean; runSessionId?: string | null } = {},
  ) {
    const app = Fastify();
    apps.push(app);
    const metadata = {
      createAcceptedRun: vi.fn(),
      updateRun: vi.fn(),
      listSessionRuns: vi.fn(async () => ({ runs: [runSummary], nextCursor: null })),
      getRunSessionId: vi.fn(async () =>
        options.runSessionId === undefined ? "session-1" : options.runSessionId,
      ),
      getRunDetail: vi.fn(async () => ({ ...runSummary, tools: [] })),
    } as AgentRunMetadataService;
    const threadService = {
      createThreadId: vi.fn(),
      resolveOwnedSessionThread: vi.fn(async (_user, sessionId) => {
        if (options.allowSession === false || sessionId !== "session-1") {
          throw new ThreadServiceError("Session not found.", 404);
        }
        return { sessionId, threadId: "thread-1" };
      }),
    } as ThreadService;
    const agentRuns = {
      createRun: vi.fn(),
      cancelRun: vi.fn(),
      hasRun: vi.fn(),
      streamRun: vi.fn(),
    } as unknown as AgentRunService;
    await registerRunRoutes(app, agentRuns, {
      agentRunMetadataService: metadata,
      auth: auth(user),
      threadService,
    });
    return { app, metadata };
  }

  it("returns session history only after RLS-backed session authorization", async () => {
    const { app, metadata } = await build(owner);
    const response = await app.inject({
      method: "GET",
      url: "/api/chat/sessions/session-1/runs?limit=10",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ runs: [runSummary], nextCursor: null });
    expect(metadata.listSessionRuns).toHaveBeenCalledWith("session-1", { limit: 10 });
  });

  it("makes a foreign run indistinguishable from an unknown run", async () => {
    const { app, metadata } = await build(owner, { allowSession: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/chat/sessions/session-1/runs/run-1",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: "session_not_found",
        message: "Run not found or access denied.",
      },
    });
    expect(metadata.getRunSessionId).not.toHaveBeenCalled();
    expect(metadata.getRunDetail).not.toHaveBeenCalled();
  });

  it("does not query tool detail when the run belongs to another session", async () => {
    const { app, metadata } = await build(owner, { runSessionId: "session-2" });
    const response = await app.inject({
      method: "GET",
      url: "/api/chat/sessions/session-1/runs/run-1",
    });
    expect(response.statusCode).toBe(404);
    expect(metadata.getRunSessionId).toHaveBeenCalledWith("run-1");
    expect(metadata.getRunDetail).not.toHaveBeenCalled();
  });

  it("does not query tool detail for an unknown run", async () => {
    const { app, metadata } = await build(owner, { runSessionId: null });
    const response = await app.inject({
      method: "GET",
      url: "/api/chat/sessions/session-1/runs/unknown-run",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: "session_not_found",
        message: "Run not found or access denied.",
      },
    });
    expect(metadata.getRunDetail).not.toHaveBeenCalled();
  });

  it("returns detail only after the requested session and run match", async () => {
    const { app, metadata } = await build(owner);
    const response = await app.inject({
      method: "GET",
      url: "/api/chat/sessions/session-1/runs/run-1",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ run: { ...runSummary, tools: [] } });
    expect(metadata.getRunDetail).toHaveBeenCalledWith("run-1", "session-1");
  });

  it("requires authentication for run history", async () => {
    const { app } = await build(null);
    const response = await app.inject({
      method: "GET",
      url: "/api/chat/sessions/session-1/runs",
    });
    expect(response.statusCode).toBe(401);
  });

  it.each([
    ["0", "Invalid limit."],
    ["51", "Invalid limit."],
    ["1.5", "Invalid limit."],
    ["", "Invalid limit."],
  ])("rejects invalid limit %j with the stable error shape", async (limit, message) => {
    const { app, metadata } = await build(owner);
    const response = await app.inject({
      method: "GET",
      url: `/api/chat/sessions/session-1/runs?limit=${encodeURIComponent(limit)}`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: "application_error", message },
    });
    expect(metadata.listSessionRuns).not.toHaveBeenCalled();
  });

  it.each(["", "not-a-cursor"])(
    "rejects malformed cursor %j with the stable error shape",
    async (cursor) => {
      const { app, metadata } = await build(owner);
      if (cursor === "not-a-cursor") {
        metadata.listSessionRuns = vi.fn(async () => {
          throw new AgentRunPersistenceError("Invalid run history cursor.", 400);
        });
      }
      const response = await app.inject({
        method: "GET",
        url: `/api/chat/sessions/session-1/runs?cursor=${encodeURIComponent(cursor)}`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          code: "application_error",
          message: "Invalid run history cursor.",
        },
      });
    },
  );

  it("returns unexpected history failures in the stable 500 shape", async () => {
    const { app, metadata } = await build(owner);
    metadata.listSessionRuns = vi.fn(async () => {
      throw new Error("internal detail must stay server-side");
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/chat/sessions/session-1/runs",
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "application_error",
        message: "Run history request failed.",
      },
    });
    expect(response.body).not.toContain("internal detail");
  });

  it("persists the authoritative execution mode and creator on create", async () => {
    const app = Fastify();
    apps.push(app);
    const createAcceptedRun = vi.fn(async () => undefined);
    const metadata = {
      createAcceptedRun,
      updateRun: vi.fn(),
      listSessionRuns: vi.fn(),
      getRunSessionId: vi.fn(),
      getRunDetail: vi.fn(),
    } as AgentRunMetadataService;
    const agentRuns = {
      createRun: vi.fn(() => ({
        conversationId: "conversation-1",
        runId: "run-1",
        sessionId: "session-1",
        status: "accepted",
      })),
    } as unknown as AgentRunService;
    const threadService = {
      createThreadId: vi.fn(),
      resolveOwnedSessionThread: vi.fn(async () => ({
        sessionId: "session-1",
        threadId: "thread-1",
      })),
    } as ThreadService;
    await registerRunRoutes(app, agentRuns, {
      agentRunMetadataService: metadata,
      auth: auth(owner),
      threadService,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/runs",
      payload: {
        conversationId: "conversation-1",
        executionMode: "thinking",
        prompt: "hello",
        sessionId: "session-1",
      },
    });
    expect(response.statusCode).toBe(202);
    expect(createAcceptedRun).toHaveBeenCalledWith(expect.objectContaining({
      createdBy: "owner-1",
      executionMode: "thinking",
      runId: "run-1",
    }));
  });
});
