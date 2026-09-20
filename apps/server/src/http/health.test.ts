/**
 * The route-level contract startup/readiness probes depend on.
 *
 * `apps/web/playwright.config.ts` (webServer.url), `scripts/start-local-api.ps1`
 * and the acceptance scripts parse this response and expect a serving server to
 * answer 200 with `ok`/`service`/`version`/`agentRuntime`. These tests pin that
 * shape AND the new depth, so a future edit cannot silently break readiness.
 */
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { healthResponseSchema } from "@loomic/shared";

import { registerHealthRoutes } from "./health.js";
import {
  createHealthService,
  createMastraRuntimeProbe,
  type HealthServiceDependencies,
} from "./health-service.js";

const queues = ["image_generation_jobs"] as const;

function buildHealthService(overrides: Partial<HealthServiceDependencies> = {}) {
  return createHealthService({
    cacheTtlMs: 0,
    database: { probeWrite: vi.fn(async () => undefined) },
    queue: { readDepths: vi.fn(async () => [{ depth: 0, queue: queues[0] }]) },
    queues,
    runtime: {
      probeRuntime: vi.fn(async () => ({ detail: "mastra configured" })),
      warmup: vi.fn(async () => ({ detail: "mastra configured" })),
    },
    storage: { probeBucket: vi.fn(async () => undefined) },
    storageBucket: "workspace-assets",
    workerHeartbeat: vi.fn(async () => ({
      lastSeenAt: "2026-09-21T00:00:00.000Z",
      onlineCount: 1,
      workerId: "w1",
    })),
    ...overrides,
  });
}

async function buildRoute(healthService: ReturnType<typeof buildHealthService>) {
  const app = Fastify();
  await registerHealthRoutes(app, {
    agentRuntime: "mastra",
    healthService,
    version: "9.9.9-test",
  });
  return app;
}

describe("GET /api/health", () => {
  it("keeps the readiness contract and HTTP 200 on a healthy server", async () => {
    const app = await buildRoute(buildHealthService());
    try {
      const response = await app.inject({ method: "GET", url: "/api/health" });
      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload).toMatchObject({
        agentRuntime: "mastra",
        ok: true,
        service: "loomic-server",
        version: "9.9.9-test",
      });
      expect(Object.keys(payload.components).sort()).toEqual([
        "agentRuntime",
        "database",
        "queue",
        "storage",
        "worker",
      ]);
      for (const component of Object.values(payload.components)) {
        expect(component).toMatchObject({
          detail: expect.any(String),
          latencyMs: expect.any(Number),
          status: "ok",
        });
      }
      expect(healthResponseSchema.safeParse(payload).success).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("answers 503 with ok:false when the database cannot write", async () => {
    const app = await buildRoute(
      buildHealthService({
        database: {
          probeWrite: vi.fn(async () => {
            throw Object.assign(new Error("write rejected"), { code: "42501" });
          }),
        },
      }),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await app.inject({ method: "GET", url: "/api/health" });
      expect(response.statusCode).toBe(503);
      const payload = response.json();
      expect(payload.ok).toBe(false);
      expect(payload.components.database.status).toBe("failed");
      expect(healthResponseSchema.safeParse(payload).success).toBe(true);
    } finally {
      log.mockRestore();
      await app.close();
    }
  });

  it("keeps ok:true and HTTP 200 while an offline worker degrades the report", async () => {
    const app = await buildRoute(
      buildHealthService({ workerHeartbeat: vi.fn(async () => undefined) }),
    );
    try {
      const response = await app.inject({ method: "GET", url: "/api/health" });
      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload.ok).toBe(true);
      expect(payload.components.worker.status).toBe("degraded");
      expect(payload.components.worker.detail).toContain("offline");
    } finally {
      await app.close();
    }
  });

  it("answers 200 on a fresh boot whose lazy agent runtime is not constructed yet", async () => {
    // The production defect: the runtime is built on first use, so a freshly
    // booted API reported 503 for a server that demonstrably works. The route must
    // judge configuration, not the existence of a lazily-created instance.
    const runtimeProbe = createMastraRuntimeProbe({
      agentModel: "apiyi:gemini-3.1-flash-lite",
      createModel: vi.fn(() => ({})),
      loadMastraEntry: vi.fn(async () => ({
        createMastraRunFactory: () => undefined,
        agentClass: class {},
      })),
    });
    const app = await buildRoute(buildHealthService({ runtime: runtimeProbe }));
    try {
      const response = await app.inject({ method: "GET", url: "/api/health" });
      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload.ok).toBe(true);
      expect(payload.components.agentRuntime).toMatchObject({
        status: "ok",
        detail: "mastra configured (lazy, not yet constructed)",
      });
    } finally {
      await app.close();
    }
  });

  it("answers 503 when the agent runtime is genuinely unavailable", async () => {
    const runtimeProbe = createMastraRuntimeProbe({
      agentModel: "apiyi:gemini-3.1-flash-lite",
      createModel: vi.fn(() => ({})),
      loadMastraEntry: vi.fn(async () => {
        throw new Error("Cannot find module @mastra/core");
      }),
    });
    await runtimeProbe.warmup();
    const app = await buildRoute(buildHealthService({ runtime: runtimeProbe }));
    try {
      const response = await app.inject({ method: "GET", url: "/api/health" });
      expect(response.statusCode).toBe(503);
      const payload = response.json();
      expect(payload.ok).toBe(false);
      expect(payload.components.agentRuntime).toMatchObject({
        status: "failed",
        detail: "runtime runtime_unavailable",
      });
    } finally {
      await app.close();
    }
  });

  it("reports the cache flag so a caller can tell a fresh probe from a reused one", async () => {
    const app = await buildRoute(buildHealthService({ cacheTtlMs: 2_000 }));
    try {
      const first = (await app.inject({ method: "GET", url: "/api/health" })).json();
      const second = (await app.inject({ method: "GET", url: "/api/health" })).json();
      expect(first.cached).toBe(false);
      expect(second.cached).toBe(true);
    } finally {
      await app.close();
    }
  });
});
