/**
 * P0 #3 — the health check must be able to say "not healthy".
 *
 * Each degraded path is exercised with a mocked dependency so the test proves
 * the VERDICT (status, ok, detail), not that a database happened to be up. The
 * reported production failure is the first case: reads fine, writes failing.
 */
import { describe, expect, it, vi } from "vitest";

import {
  type HealthServiceDependencies,
  ProbeTimeoutError,
  createHealthService,
  createMastraRuntimeProbe,
  createPgmqQueueProbe,
  createPostgrestDatabaseProbe,
  createPostgrestWorkerHeartbeatProbe,
  createSupabaseStorageProbe,
  sanitizeProbeFailure,
  withProbeTimeout,
} from "./health-service.js";

const QUEUES = ["image_generation_jobs", "video_generation_jobs"] as const;

function buildHealth(overrides: Partial<HealthServiceDependencies> = {}) {
  const dependencies: HealthServiceDependencies = {
    cacheTtlMs: 0,
    database: { probeWrite: vi.fn(async () => undefined) },
    // Deterministic clock: each read advances 1ms, so latency assertions are
    // exact and a cache window can be tested without sleeping.
    now: (() => {
      let current = 1_000;
      return () => (current += 1);
    })(),
    queue: {
      readDepths: vi.fn(async (queues: readonly string[]) =>
        queues.map((queue) => ({ queue, depth: 0 })),
      ),
    },
    queues: QUEUES,
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
  };
  return { dependencies, service: createHealthService(dependencies) };
}

describe("truthful health verdict", () => {
  it("reports ok:true and HTTP 200 when every component answers", async () => {
    const { service } = buildHealth();
    const snapshot = await service.check();
    expect(snapshot.ok).toBe(true);
    expect(snapshot.status).toBe(200);
    expect(snapshot.components.database.status).toBe("ok");
    expect(snapshot.components.agentRuntime.status).toBe("ok");
    expect(snapshot.components.queue.status).toBe("ok");
    expect(snapshot.components.storage.status).toBe("ok");
    expect(snapshot.components.worker.status).toBe("ok");
    expect(snapshot.components.worker.detail).toContain("1 online");
  });

  it("flips ok to false and answers 503 when the database rejects a real WRITE", async () => {
    const { service } = buildHealth({
      database: {
        probeWrite: vi.fn(async () => {
          // The reported failure: the row cannot be persisted.
          throw Object.assign(new Error("permission denied for table loomic_health_probe"), {
            code: "42501",
          });
        }),
      },
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let snapshot;
    try {
      snapshot = await service.check();
    } finally {
      log.mockRestore();
    }
    expect(snapshot.ok).toBe(false);
    expect(snapshot.status).toBe(503);
    expect(snapshot.components.database).toMatchObject({
      status: "failed",
      detail: "error:42501",
    });
  });

  it("fails the agent runtime from its probe reason without making a provider call", async () => {
    const { service } = buildHealth({
      runtime: {
        probeRuntime: vi.fn(async () => ({
          detail: "runtime agent_runtime_mode_invalid",
          reason: "agent_runtime_mode_invalid",
        })),
        warmup: vi.fn(async () => ({
          detail: "runtime agent_runtime_mode_invalid",
          reason: "agent_runtime_mode_invalid",
        })),
      },
    });
    const snapshot = await service.check();
    expect(snapshot.ok).toBe(false);
    expect(snapshot.status).toBe(503);
    expect(snapshot.components.agentRuntime).toEqual({
      status: "failed",
      detail: "runtime agent_runtime_mode_invalid",
      latencyMs: expect.any(Number),
    });
  });

  it("keeps serving when an unreachable queue is the only problem", async () => {
    const { service } = buildHealth({
      queue: {
        readDepths: vi.fn(async () => {
          throw new Error("ECONNREFUSED 127.0.0.1:5432");
        }),
      },
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let snapshot;
    try {
      snapshot = await service.check();
    } finally {
      log.mockRestore();
    }
    expect(snapshot.ok).toBe(true);
    expect(snapshot.status).toBe(200);
    expect(snapshot.components.queue.status).toBe("failed");
  });

  it("reports a queue backlog as degraded but not fatal", async () => {
    const { service } = buildHealth({
      queue: {
        readDepths: vi.fn(async () => [
          { queue: "image_generation_jobs", depth: 1 },
          { queue: "video_generation_jobs", depth: 0 },
        ]),
      },
    });
    const snapshot = await service.check();
    expect(snapshot.ok).toBe(true);
    expect(snapshot.components.queue).toMatchObject({
      status: "degraded",
      detail: "backlog 1 on image_generation_jobs",
    });
  });

  it("fails storage when the authenticated bucket probe fails", async () => {
    const { service } = buildHealth({
      storage: {
        probeBucket: vi.fn(async () => {
          throw Object.assign(new Error("Bucket not found"), { code: "404" });
        }),
      },
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let snapshot;
    try {
      snapshot = await service.check();
    } finally {
      log.mockRestore();
    }
    expect(snapshot.ok).toBe(true);
    expect(snapshot.components.storage).toMatchObject({
      status: "failed",
      detail: "error:404",
    });
  });

  it("calls the worker offline when no heartbeat is fresher than the threshold", async () => {
    const { service } = buildHealth({ workerHeartbeat: vi.fn(async () => undefined) });
    const snapshot = await service.check();
    expect(snapshot.ok).toBe(true);
    expect(snapshot.components.worker).toMatchObject({
      status: "degraded",
      detail: "offline: no heartbeat within 30s",
    });
  });

  it("marks storage and queue degraded (not failed) when they are not configured", async () => {
    // Both are optional in the dependency contract: a deployment without the
    // queue pool or a storage client must still answer, and must say so.
    const service = createHealthService({
      cacheTtlMs: 0,
      database: { probeWrite: vi.fn(async () => undefined) },
      queues: QUEUES,
      runtime: {
        probeRuntime: vi.fn(async () => ({ detail: "mastra configured" })),
        warmup: vi.fn(async () => ({ detail: "mastra configured" })),
      },
      workerHeartbeat: vi.fn(async () => undefined),
    });
    const snapshot = await service.check();
    expect(snapshot.components.queue).toMatchObject({ status: "degraded" });
    expect(snapshot.components.storage).toMatchObject({ status: "degraded" });
    expect(snapshot.ok).toBe(true);
  });

  it("bounds a wedged component with its own timeout instead of hanging the endpoint", async () => {
    const { service } = buildHealth({
      // A short deadline for the wedged probe; others keep their defaults.
      timeouts: { databaseMs: 10 },
      database: {
        probeWrite: vi.fn(
          () => new Promise<void>(() => {
            /* never settles, like a connection stuck in the pool */
          }),
        ),
      },
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const startedAt = Date.now();
    let snapshot;
    try {
      snapshot = await service.check();
    } finally {
      log.mockRestore();
    }
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(snapshot.components.database).toMatchObject({
      status: "failed",
      detail: "timeout",
    });
    // A timeout is a critical failure: the database did not answer.
    expect(snapshot.status).toBe(503);
  });

  it("reuses one round of probes inside the cache window so polling cannot stampede", async () => {
    const probeWrite = vi.fn(async () => undefined);
    let current = 1_000;
    const { service } = buildHealth({
      cacheTtlMs: 2_000,
      database: { probeWrite },
      now: () => (current += 1),
    });

    expect((await service.check()).cached).toBe(false);
    expect((await service.check()).cached).toBe(true);
    expect(probeWrite).toHaveBeenCalledTimes(1);

    // Past the window the probe runs again.
    current += 5_000;
    expect((await service.check()).cached).toBe(false);
    expect(probeWrite).toHaveBeenCalledTimes(2);
  });

  it("never leaks a DSN, a key or a stack trace into a component detail", async () => {
    const secret = "postgresql://postgres:sup3r-secret-pw@10.0.0.5:5432/loomic";
    const { service } = buildHealth({
      database: {
        probeWrite: vi.fn(async () => {
          throw new Error(`connect failed to ${secret}`);
        }),
      },
      queue: {
        readDepths: vi.fn(async () => {
          throw new Error(`Authorization: Bearer sk-live-DO-NOT-EXPOSE`);
        }),
      },
      storage: {
        probeBucket: vi.fn(async () => {
          throw new Error("at Object.<anonymous> (/srv/app/dist/health.js:41:11)");
        }),
      },
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let payload: string;
    try {
      payload = JSON.stringify((await service.check()).components);
    } finally {
      log.mockRestore();
    }
    expect(payload).not.toContain("sup3r-secret-pw");
    expect(payload).not.toContain("sk-live-DO-NOT-EXPOSE");
    expect(payload).not.toContain("/srv/app/dist");
    expect(payload).toContain("probe_failed");
  });

  it("keeps short machine-token messages, which are safe and useful", () => {
    expect(sanitizeProbeFailure(Object.assign(new Error("x"), { code: "PGRST202" })))
      .toBe("error:PGRST202");
    expect(sanitizeProbeFailure(new Error("health_probe_write_not_visible")))
      .toBe("error:health_probe_write_not_visible");
    expect(sanitizeProbeFailure(new ProbeTimeoutError("database", 900))).toBe("timeout");
  });

  it("rejects a probe that overruns its deadline", async () => {
    await expect(
      withProbeTimeout("storage", 5, () => new Promise<void>(() => {})),
    ).rejects.toBeInstanceOf(ProbeTimeoutError);
  });
});

function fakeAdminClient(overrides: Record<string, unknown> = {}) {
  return {
    rpc: vi.fn(async () => ({ data: null, error: null })),
    storage: { getBucket: vi.fn(async () => ({ data: { name: "workspace-assets" }, error: null })) },
    from: vi.fn(),
    ...overrides,
  };
}

describe("health probes", () => {
  it("fails the database probe when the write RPC returns no persisted row", async () => {
    const client = fakeAdminClient({
      rpc: vi.fn(async () => ({ data: { writtenAt: null }, error: null })),
    });
    const probe = createPostgrestDatabaseProbe({
      getAdminClient: () => client as never,
    });
    await expect(probe.probeWrite()).rejects.toThrow("health_probe_write_not_visible");
    expect(client.rpc).toHaveBeenCalledWith(
      "loomic_health_probe_write",
      expect.objectContaining({ p_singleton: "health" }),
    );
  });

  it("fails the database probe when a write is accepted but the stored value never advances", async () => {
    // The reported failure mode: the call succeeds, the row does not change.
    const frozen = "2026-09-21T00:00:00.000Z";
    const client = fakeAdminClient({
      rpc: vi.fn(async () => ({ data: { writtenAt: frozen }, error: null })),
    });
    const probe = createPostgrestDatabaseProbe({
      getAdminClient: () => client as never,
    });
    await expect(probe.probeWrite()).rejects.toThrow("health_probe_write_not_visible");
    expect(client.rpc).toHaveBeenCalledTimes(2);
  });

  it("surfaces a write rejection from the RPC instead of treating it as healthy", async () => {
    const client = fakeAdminClient({
      rpc: vi.fn(async () => ({
        data: null,
        error: { code: "42501", message: "permission denied for table loomic_health_probe" },
      })),
    });
    const probe = createPostgrestDatabaseProbe({
      getAdminClient: () => client as never,
    });
    await expect(probe.probeWrite()).rejects.toMatchObject({ code: "42501" });
  });

  it("accepts the database probe when each write advances the stored timestamp", async () => {
    let tick = 0;
    const client = fakeAdminClient({
      rpc: vi.fn(async () => ({
        data: { writtenAt: new Date(Date.UTC(2026, 8, 21, 0, 0, tick++)).toISOString() },
        error: null,
      })),
    });
    const probe = createPostgrestDatabaseProbe({
      getAdminClient: () => client as never,
    });
    await expect(probe.probeWrite()).resolves.toBeUndefined();
    expect(client.rpc).toHaveBeenCalledTimes(2);
  });

  it("turns a heartbeat snapshot with no fresh row into an offline worker", async () => {
    const client = fakeAdminClient({
      rpc: vi.fn(async () => ({ data: { freshest: null, onlineCount: 0 }, error: null })),
    });
    const read = createPostgrestWorkerHeartbeatProbe({
      getAdminClient: () => client as never,
    });
    await expect(read()).resolves.toBeUndefined();
    expect(client.rpc).toHaveBeenCalledWith("loomic_worker_heartbeat_snapshot", {
      p_stale_after_seconds: 30,
    });
  });

  it("names the freshest worker and counts the online ones", async () => {
    const client = fakeAdminClient({
      rpc: vi.fn(async () => ({
        data: {
          freshest: { lastSeenAt: "2026-09-21T00:00:05.000Z", workerId: "w2" },
          onlineCount: 2,
        },
        error: null,
      })),
    });
    const read = createPostgrestWorkerHeartbeatProbe({
      getAdminClient: () => client as never,
    });
    await expect(read()).resolves.toEqual({
      lastSeenAt: "2026-09-21T00:00:05.000Z",
      onlineCount: 2,
      workerId: "w2",
    });
  });

  it("surfaces a storage failure instead of assuming the bucket exists", async () => {
    const client = fakeAdminClient({
      storage: {
        getBucket: vi.fn(async () => ({ data: null, error: { message: "not found" } })),
      },
    });
    const probe = createSupabaseStorageProbe({
      getAdminClient: () => client as never,
    });
    await expect(probe.probeBucket("workspace-assets")).rejects.toMatchObject({
      message: "not found",
    });
  });

  it("reads queue depth through pgmq and passes an abort signal with the probe deadline", async () => {
    const read = vi.fn(async () => [{ msg_id: 1 }]);
    const probe = createPgmqQueueProbe({ read });
    await expect(probe.readDepths(["image_generation_jobs"])).resolves.toEqual([
      { depth: 1, queue: "image_generation_jobs" },
    ]);
    expect(read).toHaveBeenCalledWith(
      "image_generation_jobs",
      0,
      1,
      expect.any(AbortSignal),
    );
  });
});

describe("mastra runtime probe", () => {
  const healthyEntry = {
    createMastraRunFactory: () => undefined,
    agentClass: class {},
  };

  it("passes for the configured runtime without any provider request", async () => {
    const createModel = vi.fn(() => ({}));
    const probe = createMastraRuntimeProbe({
      agentModel: "gemini-3.1-flash-lite",
      bindingProbe: { apiKey: "workspace-resolved", baseUrl: "https://api.example.com/v1" },
      createModel,
      loadMastraEntry: vi.fn(async () => healthyEntry),
    });
    await expect(probe.warmup()).resolves.toEqual({ detail: "mastra configured" });
    await expect(probe.probeRuntime()).resolves.toEqual({ detail: "mastra configured" });
    expect(createModel).toHaveBeenCalledWith(
      expect.objectContaining({ upstreamModelId: "gemini-3.1-flash-lite" }),
    );
  });

  it("reports the binding as unverified when no real provider endpoint is configured", async () => {
    // Inventing a URL would make the safe-fetch wrapper refuse it, which would
    // report `failed` for a healthy deployment. Say "unverified" instead.
    const createModel = vi.fn(() => ({}));
    const probe = createMastraRuntimeProbe({
      agentModel: "gemini-3.1-flash-lite",
      createModel,
      loadMastraEntry: vi.fn(async () => healthyEntry),
    });
    await expect(probe.warmup()).resolves.toEqual({
      detail: "mastra configured (binding unverified)",
    });
    expect(createModel).not.toHaveBeenCalled();
  });

  it("fails when the runtime entry module cannot be loaded", async () => {
    const probe = createMastraRuntimeProbe({
      agentModel: "gemini-3.1-flash-lite",
      createModel: vi.fn(() => ({})),
      loadMastraEntry: vi.fn(async () => {
        throw new Error("Cannot find module @mastra/core");
      }),
    });
    await expect(probe.warmup()).resolves.toEqual({
      detail: "runtime runtime_unavailable",
      reason: "runtime_unavailable",
    });
  });

  it("fails when the entry module has lost its factory export", async () => {
    const probe = createMastraRuntimeProbe({
      agentModel: "gemini-3.1-flash-lite",
      createModel: vi.fn(() => ({})),
      loadMastraEntry: vi.fn(async () => ({ createMastraRunFactory: undefined, agentClass: class {} })),
    });
    await expect(probe.warmup()).resolves.toEqual({
      detail: "runtime mastra_entry_incomplete",
      reason: "mastra_entry_incomplete",
    });
  });

  it("fails when no agent model is configured", async () => {
    const probe = createMastraRuntimeProbe({
      createModel: vi.fn(() => ({})),
      loadMastraEntry: vi.fn(async () => healthyEntry),
    });
    await expect(probe.warmup()).resolves.toEqual({
      detail: "runtime agent_model_unconfigured",
      reason: "agent_model_unconfigured",
    });
  });

  it("fails when the model binding cannot be constructed against a real endpoint", async () => {
    const probe = createMastraRuntimeProbe({
      agentModel: "gemini-3.1-flash-lite",
      bindingProbe: { apiKey: "workspace-resolved", baseUrl: "https://api.example.com/v1" },
      createModel: vi.fn(() => {
        throw new Error("unsupported model");
      }),
      loadMastraEntry: vi.fn(async () => healthyEntry),
    });
    await expect(probe.warmup()).resolves.toEqual({
      detail: "runtime model_binding_failed",
      reason: "model_binding_failed",
    });
  });

  it("does not report healthy on no evidence before startup warmed it", async () => {
    const probe = createMastraRuntimeProbe({
      agentModel: "gemini-3.1-flash-lite",
      createModel: vi.fn(() => ({})),
      loadMastraEntry: vi.fn(async () => healthyEntry),
    });
    await expect(probe.probeRuntime()).resolves.toEqual({
      detail: "runtime runtime_not_warmed",
      reason: "runtime_not_warmed",
    });
  });

  it("loads the runtime once and reuses that verdict for every probe", async () => {
    const loadMastraEntry = vi.fn(async () => healthyEntry);
    const probe = createMastraRuntimeProbe({
      agentModel: "gemini-3.1-flash-lite",
      createModel: vi.fn(() => ({})),
      loadMastraEntry,
    });
    await probe.warmup();
    await probe.warmup();
    await probe.probeRuntime();
    await probe.probeRuntime();
    expect(loadMastraEntry).toHaveBeenCalledTimes(1);
  });
});
