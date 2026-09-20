import type { FastifyInstance } from "fastify";

import { healthResponseSchema } from "@loomic/shared";

import type { HealthService } from "./health-service.js";

/**
 * `GET /api/health`.
 *
 * CONTRACT (must not change — startup/readiness probes depend on it):
 *   - the route stays at `/api/health`;
 *   - a serving server answers HTTP 200 with `ok:true`, `service:"loomic-server"`,
 *     `version` and `agentRuntime:"mastra"`.
 *
 * What is new: `components` carries one truthful entry per probed dependency and
 * `ok` is DERIVED — HTTP 503 + `ok:false` only when a critical component
 * (`database`, `agentRuntime`) is `failed`. See `health-service.ts` for why a
 * degraded worker/queue/storage must not break readiness.
 */
export async function registerHealthRoutes(
  app: FastifyInstance,
  options: {
    agentRuntime: "mastra";
    healthService: HealthService;
    version: string;
  },
) {
  app.get("/api/health", async (_request, reply) => {
    const snapshot = await options.healthService.check();
    const payload = healthResponseSchema.parse({
      ok: snapshot.ok,
      service: "loomic-server",
      version: options.version,
      agentRuntime: options.agentRuntime,
      components: snapshot.components,
      cached: snapshot.cached,
      checkedAt: new Date().toISOString(),
    });

    return reply.code(snapshot.status).send(payload);
  });
}
