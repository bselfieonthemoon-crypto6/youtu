import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentRunService } from "../agent/runtime.js";
import type { ServerEnv } from "../config/env.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";
import { registerRunRoutes } from "./runs.js";

const testEnv: ServerEnv = {
  agentBackendMode: "state",
  agentModel: "test-model",
  port: 3001,
  version: "test",
  webOrigin: "http://localhost:3002",
};

function user(id: string): AuthenticatedUser {
  return {
    accessToken: `token-${id}`,
    email: `${id}@example.test`,
    id,
    userMetadata: {},
  };
}

function fixedAuth(authenticatedUser: AuthenticatedUser | null): RequestAuthenticator {
  return {
    async authenticate() {
      return authenticatedUser;
    },
  };
}

describe("agent run HTTP authorization", () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("rejects POST /api/agent/runs without an authenticated user", async () => {
    const app = Fastify();
    apps.push(app);
    const agentRuns = createAgentRunService({ env: testEnv });
    await registerRunRoutes(app, agentRuns, { auth: fixedAuth(null) });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/runs",
      payload: {
        conversationId: "conversation-1",
        prompt: "hello",
        sessionId: "session-1",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "unauthorized" },
    });
  });

  it("does not let another user cancel an owned run", async () => {
    const owner = user("owner");
    const attacker = user("attacker");
    const agentRuns = createAgentRunService({
      env: testEnv,
      runIdFactory: () => "owned-run",
    });
    agentRuns.createRun(
      {
        conversationId: "conversation-1",
        prompt: "hello",
        sessionId: "session-1",
      },
      { accessToken: owner.accessToken, userId: owner.id },
    );

    const app = Fastify();
    apps.push(app);
    await registerRunRoutes(app, agentRuns, { auth: fixedAuth(attacker) });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/runs/owned-run/cancel",
    });

    // Deliberately indistinguishable from an unknown run to avoid leaking IDs.
    expect(response.statusCode).toBe(404);
    expect(agentRuns.cancelRun("owned-run", owner.id)).toEqual({
      runId: "owned-run",
      status: "canceled",
    });
  });
});
