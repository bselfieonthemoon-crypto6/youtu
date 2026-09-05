import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRunService } from "../agent/runtime.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import { registerRunRoutes } from "./runs.js";

describe("agent run HTTP execution options", () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("respects the requested model and passes through Thinking mode", async () => {
    const createRun = vi.fn().mockReturnValue({
      conversationId: "conversation-1",
      runId: "run-1",
      sessionId: "session-1",
      status: "accepted",
    });
    const agentRuns = { createRun } as unknown as AgentRunService;
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
    await registerRunRoutes(app, agentRuns, { auth });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/runs",
      payload: {
        conversationId: "conversation-1",
        executionMode: "thinking",
        model: "google:gemini-test",
        prompt: "hello",
        sessionId: "session-1",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({ executionMode: "thinking" }),
      expect.objectContaining({
        accessToken: "token-1",
        model: "google:gemini-test",
        userId: "owner-1",
      }),
    );
  });
});
