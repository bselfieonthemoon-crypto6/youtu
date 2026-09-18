import type { FastifyInstance } from "fastify";

import { healthResponseSchema } from "@loomic/shared";

import type { ServerEnv } from "../config/env.js";

export async function registerHealthRoutes(
  app: FastifyInstance,
  env: ServerEnv,
  agentRuntime: "mastra",
) {
  app.get("/api/health", async (_request, reply) => {
    const payload = healthResponseSchema.parse({
      ok: true,
      service: "loomic-server",
      version: env.version,
      agentRuntime,
    });

    return reply.code(200).send(payload);
  });
}
