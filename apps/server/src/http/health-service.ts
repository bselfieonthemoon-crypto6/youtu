/**
 * P0 #3 — a health check that can actually fail.
 *
 * The old `/api/health` was a constant: `{ok:true}` was sent even while message
 * writes were failing in the database, so every monitor and every acceptance
 * script that parsed it believed a broken stack was healthy. This endpoint now
 * probes five independent components and derives `ok` from them.
 *
 * Design constraints, in order of importance:
 *
 *  1. READINESS PROBES MUST KEEP WORKING. Playwright's `webServer.url`,
 *     `scripts/start-local-api.ps1` and the acceptance scripts poll this route
 *     while the stack is coming up. So: the route, HTTP 200 for a serving
 *     server, `ok:true` and every existing field stay. `ok` flips to false ONLY
 *     when a CRITICAL component (database, agentRuntime) is `failed` — a state
 *     in which the server genuinely cannot serve. Everything else (an offline
 *     worker on a laptop, a queue backlog, storage trouble) is reported as
 *     `degraded` and keeps `ok:true` + HTTP 200, because treating it is as
 *     fatal would turn a local development start into a 30-second timeout.
 *  2. NO PROBE STAMPEDE. Each check has its own timeout and all five run
 *     concurrently, so the endpoint is bounded by the slowest probe (~900ms),
 *     and a 2s result cache means a polling probe reuses one round of probes.
 *  3. EVERYTHING IS SANITIZED. `detail` is a fixed, short token built from a
 *     stable vocabulary; raw driver/provider text is never returned. Full
 *     detail is logged server-side WITHOUT credentials (see `logProbeFailure`).
 *
 * The database probe is a REAL WRITE: it upserts a single fixed row's
 * `checked_at` in `private.loomic_health_probe` and reads that same row back, so
 * a database that accepts reads but rejects writes (exactly the reported
 * failure) is reported as `failed`. The probe row is a singleton keyed by
 * `singleton`, so it can never grow.
 */
import type { HealthComponent, HealthComponentStatus, HealthComponents } from "@loomic/shared";

import { resolveAgentRuntimeMode } from "../agent/runtime.js";
import { createWorkspaceVisionModel } from "../agent/workspace-vision-model.js";
import type { AdminSupabaseClient } from "../supabase/admin.js";

/**
 * Worker heartbeat read side. The table name and both timings come from the
 * shared contract module, so the writer (`../worker-heartbeat.ts`) and this
 * reader cannot drift apart. The threshold is three missed beats, so a single
 * slow write cannot raise a false alarm.
 */
export {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_STALE_AFTER_MS,
  WORKER_HEARTBEAT_TABLE,
} from "../worker-heartbeat-contract.js";
import { WORKER_HEARTBEAT_STALE_AFTER_MS } from "../worker-heartbeat-contract.js";

/** Singleton row for the read+write database probe. */
export const HEALTH_PROBE_TABLE = "loomic_health_probe";
export const HEALTH_PROBE_KEY = "health";

/**
 * Cache window. A readiness probe polls this route several times per second
 * while it waits for `ok`; without a cache every poll would write to the
 * database. The window is short enough that a real failure surfaces quickly.
 */
export const HEALTH_CACHE_TTL_MS = 2_000;

/** Per-component deadlines. The slowest is the database read+write probe. */
export const HEALTH_TIMEOUTS = {
  agentRuntimeMs: 500,
  databaseMs: 900,
  queueMs: 500,
  storageMs: 700,
  workerMs: 500,
} as const;

/**
 * Only these components can make `ok` false. Both are required to serve a
 * request that matters; the rest degrade the service instead of breaking it.
 */
const CRITICAL_COMPONENTS = new Set(["database", "agentRuntime"]);

export type DatabaseProbe = {
  /** Real write (upsert) plus read-back of the same row. Throws on failure. */
  probeWrite(): Promise<void>;
};

export type QueueProbe = {
  /** Depth of every worker queue; reachability is proven by the query itself. */
  readDepths(queues: readonly string[]): Promise<{ queue: string; depth: number }[]>;
};

export type StorageProbe = {
  /** Authenticated, cheap object-count call for the bucket the app writes to. */
  probeBucket(bucket: string): Promise<void>;
};

export type RuntimeProbe = {
  /**
   * Loads and validates the runtime ONCE at startup, so the health probe itself
   * stays fast. Resolves the sanitized verdict.
   */
  warmup(): Promise<RuntimeProbeResult>;
  /** The verdict from `warmup`; never loads anything itself. */
  probeRuntime(): Promise<RuntimeProbeResult>;
};

export type HealthServiceDependencies = {
  cacheTtlMs?: number;
  database: DatabaseProbe;
  now?: () => number;
  queue?: QueueProbe;
  queues: readonly string[];
  runtime: RuntimeProbe;
  storage?: StorageProbe;
  storageBucket?: string;
  /**
   * Per-component deadline overrides. Values are plain milliseconds, so a test
   * (or a deployment) may tighten one probe without restating the others.
   */
  timeouts?: Partial<Record<keyof typeof HEALTH_TIMEOUTS, number>>;
  /** Resolves the newest worker heartbeat; `undefined` when none is fresh. */
  workerHeartbeat: () => Promise<WorkerHeartbeatSnapshot | undefined>;
};

export type WorkerHeartbeatSnapshot = {
  workerId: string;
  lastSeenAt: string;
  onlineCount: number;
};

export type HealthSnapshot = {
  ok: boolean;
  status: number;
  components: HealthComponents;
};

export type HealthSnapshotWithCache = HealthSnapshot & { cached: boolean };

export type HealthService = {
  check(): Promise<HealthSnapshotWithCache>;
};

/**
 * Sanitize an unknown failure into the fixed vocabulary used by `detail`.
 * The raw text is logged separately through `logProbeFailure`; it must never
 * reach the response, because driver errors can carry a DSN or a key.
 */
export function sanitizeProbeFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  if (name === "ProbeTimeoutError") return "timeout";
  const code = readStringProperty(error, "code");
  if (code) return `error:${code}`;
  // A plain message is only used when it looks like a short machine token; free
  // text (provider bodies, SQL) is replaced by a generic token.
  const message = error instanceof Error ? error.message : undefined;
  if (message && /^[a-z0-9_]{1,40}$/i.test(message)) return `error:${message}`;
  return "probe_failed";
}

/**
 * Log the full failure server-side with the fields that are safe: name, code
 * and PostgreSQL/PostgREST identifiers. The message is deliberately NOT logged
 * for transport errors, which routinely embed `postgresql://user:pass@host`.
 */
export function logProbeFailure(component: string, error: unknown): void {
  console.error(`[health] ${component} probe failed`, {
    code: readStringProperty(error, "code") ?? null,
    name: error instanceof Error ? error.name : typeof error,
    pgCode: readStringProperty(error, "pgCode") ?? null,
    safeMessage: safeMessageForLog(error),
  });
}

function safeMessageForLog(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  if (error.name === "ProbeTimeoutError") return error.message;
  // Only an identifier-shaped message is safe to echo; SQL text and provider
  // bodies are not.
  return /^[a-z0-9_: .()-]{1,80}$/i.test(error.message) &&
    !/:\/\//.test(error.message)
    ? error.message
    : null;
}

function readStringProperty(error: unknown, key: string): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 && value.length <= 64
    ? value
    : undefined;
}

export class ProbeTimeoutError extends Error {
  constructor(component: string, timeoutMs: number) {
    super(`${component} probe exceeded ${timeoutMs}ms`);
    this.name = "ProbeTimeoutError";
  }
}

/**
 * Bound one probe. The losing promise's rejection is swallowed so a late
 * failure cannot become an unhandled rejection after the response was sent.
 */
export async function withProbeTimeout<T>(
  component: string,
  timeoutMs: number,
  task: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new ProbeTimeoutError(component, timeoutMs)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([task(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function component(
  status: HealthComponentStatus,
  detail: string,
  latencyMs: number,
): HealthComponent {
  return { status, detail, latencyMs: Math.max(0, Math.round(latencyMs)) };
}

function isCriticalFailure(components: HealthComponents): boolean {
  return Object.entries(components).some(
    ([name, value]) => CRITICAL_COMPONENTS.has(name) && value.status === "failed",
  );
}

export function createHealthService(
  dependencies: HealthServiceDependencies,
): HealthService {
  const now = dependencies.now ?? (() => Date.now());
  const cacheTtlMs = dependencies.cacheTtlMs ?? HEALTH_CACHE_TTL_MS;
  const timeouts = { ...HEALTH_TIMEOUTS, ...dependencies.timeouts };
  let cached: { at: number; components: HealthComponents } | undefined;

  async function timed(
    name: keyof HealthComponents,
    timeoutMs: number,
    task: () => Promise<HealthComponent>,
  ): Promise<HealthComponent> {
    const startedAt = now();
    try {
      return await withProbeTimeout(name, timeoutMs, task);
    } catch (error) {
      logProbeFailure(name, error);
      return component("failed", sanitizeProbeFailure(error), now() - startedAt);
    }
  }

  async function probeDatabase(): Promise<HealthComponent> {
    const startedAt = now();
    await dependencies.database.probeWrite();
    return component("ok", "write+read ok", now() - startedAt);
  }

  async function probeRuntime(): Promise<HealthComponent> {
    const startedAt = now();
    const result = await dependencies.runtime.probeRuntime();
    return result.reason === undefined
      ? component("ok", result.detail, now() - startedAt)
      : component("failed", result.detail, now() - startedAt);
  }

  async function probeQueue(): Promise<HealthComponent> {
    const startedAt = now();
    if (!dependencies.queue) {
      return component("degraded", "queue not configured", now() - startedAt);
    }
    const depths = await dependencies.queue.readDepths(dependencies.queues);
    const total = depths.reduce((sum, entry) => sum + entry.depth, 0);
    const backlogged = depths.filter((entry) => entry.depth > 0);
    return backlogged.length === 0
      ? component("ok", `${depths.length} queues empty`, now() - startedAt)
      : component(
          "degraded",
          `backlog ${total} on ${backlogged.map((entry) => entry.queue).join(",")}`,
          now() - startedAt,
        );
  }

  async function probeStorage(): Promise<HealthComponent> {
    const startedAt = now();
    const bucket = dependencies.storageBucket;
    if (!dependencies.storage || !bucket) {
      return component("degraded", "storage not configured", now() - startedAt);
    }
    await dependencies.storage.probeBucket(bucket);
    return component("ok", "bucket reachable", now() - startedAt);
  }

  async function probeWorker(): Promise<HealthComponent> {
    const startedAt = now();
    const snapshot = await dependencies.workerHeartbeat();
    if (!snapshot) {
      return component(
        "degraded",
        `offline: no heartbeat within ${Math.round(WORKER_HEARTBEAT_STALE_AFTER_MS / 1000)}s`,
        now() - startedAt,
      );
    }
    return component(
      "ok",
      `${snapshot.onlineCount} online (${snapshot.workerId})`,
      now() - startedAt,
    );
  }

  async function runProbes(): Promise<HealthComponents> {
    const [database, agentRuntime, queue, storage, worker] = await Promise.all([
      timed("database", timeouts.databaseMs, probeDatabase),
      timed("agentRuntime", timeouts.agentRuntimeMs, probeRuntime),
      timed("queue", timeouts.queueMs, probeQueue),
      timed("storage", timeouts.storageMs, probeStorage),
      timed("worker", timeouts.workerMs, probeWorker),
    ]);
    return { database, agentRuntime, queue, storage, worker };
  }

  return {
    /** Probe with a short cache; returns the derived readiness verdict. */
    async check(): Promise<HealthSnapshotWithCache> {
      const reused = readCache();
      const components = reused ?? (await runProbes());
      if (!reused) writeCache(components);
      const criticalFailure = isCriticalFailure(components);
      return {
        ok: !criticalFailure,
        // 503 only for a genuinely unservable stack; a degraded component keeps
        // the ready status the startup probes depend on.
        status: criticalFailure ? 503 : 200,
        components,
        cached: reused !== undefined,
      };
    },
  };

  function readCache(): HealthComponents | undefined {
    if (cacheTtlMs <= 0 || !cached) return undefined;
    return now() - cached.at < cacheTtlMs ? cached.components : undefined;
  }

  function writeCache(components: HealthComponents) {
    if (cacheTtlMs > 0) cached = { at: now(), components };
  }
}

/**
 * Database probe through the service-role Supabase client, i.e. the SAME
 * HTTP/PostgREST path that message writes take on this server. A probe using a
 * different transport (a raw `select 1` over the pool) would not have caught the
 * reported failure, where reads succeeded and writes did not.
 *
 * The write is `public.loomic_health_probe_write`, a SECURITY DEFINER RPC that
 * upserts the singleton row with a SERVER-SIDE timestamp and returns the row it
 * persisted. The RPC itself already re-reads the row and raises when the write
 * is not visible; the probe additionally writes TWICE and requires the visible
 * timestamp to advance. A write that is accepted but not persisted (the exact
 * reported failure: reads fine, writes go nowhere) leaves the stored value
 * unchanged, so the second call returns the first timestamp and the probe fails.
 * The row is a singleton keyed by a constant, so this cannot grow.
 *
 * The comparison is deliberately server-time vs server-time: comparing against
 * the client's clock would fail on ordinary clock skew instead of on a real
 * write failure.
 */
export function createPostgrestDatabaseProbe(options: {
  getAdminClient: () => AdminSupabaseClient;
}): DatabaseProbe {
  async function write(): Promise<number> {
    const { data, error } = await options.getAdminClient().rpc(
      "loomic_health_probe_write" as never,
      { p_checked_by: "health", p_singleton: HEALTH_PROBE_KEY } as never,
    );
    if (error) throw error;
    const writtenAt = (data as { writtenAt?: string } | null)?.writtenAt;
    const parsed = writtenAt === undefined ? Number.NaN : Date.parse(writtenAt);
    if (!Number.isFinite(parsed)) throw new Error("health_probe_write_not_visible");
    return parsed;
  }

  return {
    async probeWrite() {
      const first = await write();
      const second = await write();
      if (!(second > first)) throw new Error("health_probe_write_not_visible");
    },
  };
}

/**
 * Worker liveness from the heartbeat table, read through
 * `public.loomic_worker_heartbeat_snapshot` so the staleness threshold lives in
 * the database rather than in a second copy on the client. `onlineCount` counts
 * workers fresher than the threshold; the snapshot names the freshest worker so
 * an operator can tell WHICH worker answered.
 */
export function createPostgrestWorkerHeartbeatProbe(options: {
  getAdminClient: () => AdminSupabaseClient;
  staleAfterMs?: number;
}): () => Promise<WorkerHeartbeatSnapshot | undefined> {
  const staleAfterMs = options.staleAfterMs ?? WORKER_HEARTBEAT_STALE_AFTER_MS;
  return async () => {
    const { data, error } = await options.getAdminClient().rpc(
      "loomic_worker_heartbeat_snapshot" as never,
      { p_stale_after_seconds: Math.ceil(staleAfterMs / 1000) } as never,
    );
    if (error) throw error;
    const snapshot = data as
      | {
          freshest?: { workerId?: string; lastSeenAt?: string } | null;
          onlineCount?: number;
        }
      | null;
    const freshest = snapshot?.freshest;
    if (!freshest?.workerId || !freshest.lastSeenAt) return undefined;
    return {
      workerId: freshest.workerId,
      lastSeenAt: freshest.lastSeenAt,
      onlineCount: Math.max(1, snapshot?.onlineCount ?? 1),
    };
  };
}

/**
 * Agent-runtime probe: judges the runtime by what is knowable at CHECK TIME —
 * that it is properly CONFIGURED and constructible — never by whether a
 * lazily-initialised instance already exists.
 *
 * Why that distinction is the whole point: the Mastra runtime is built on first
 * use, so a freshly booted process has no instance. A probe that failed on "not
 * built yet" would answer 503 on a healthy server whose agent runs demonstrably
 * succeed — the mirror image of the original `ok:true` lie, and still untruthful.
 * `latencyMs: 0` next to `runtime_unavailable` was exactly that false alarm.
 *
 * The probe therefore answers in two tiers:
 *   1. CHEAP CONFIGURATION (runs on every check, always available):
 *      `LOOMIC_AGENT_RUNTIME` parses to `mastra` through the same resolver the
 *      server boot uses, and a default agent model reference is configured. Both
 *      are pure decisions the code already makes, and both fail fast — a typo,
 *      the retired `legacy` value, or no model is a genuine misconfiguration.
 *   2. RUNTIME CONSTRUCTION (`warmup()`, awaited from Fastify's `onReady`):
 *      the Mastra entry module loads, still exports `createMastraRunFactory`,
 *      `@mastra/core`'s `Agent` class resolves, and the model binding constructs.
 *      An EXPENSIVE first import belongs at startup, not on the polling path.
 *      Once this has run, its verdict is authoritative — including a failure.
 *      While it has not run yet, "not constructed yet" is reported as `ok` with
 *      that wording, because an unbuilt lazy runtime is not a defect.
 *
 * No provider request is ever made, so health polling can never spend credits.
 * The model BINDING is only constructed when the caller supplies a real provider
 * endpoint (`bindingProbe`): the safe-provider-fetch wrapper refuses a synthetic
 * URL, so validating against one would report `failed` for a perfectly good
 * deployment — a health check that cries wolf is worse than none.
 *
 * What it deliberately does NOT do: call a provider, resolve a workspace
 * snapshot, or create a run. Those are per-turn paid/authorized operations.
 */
export type RuntimeProbeResult = {
  /** Sanitized failure token, or undefined when the runtime is usable. */
  reason?: string;
  /** Human-readable sanitized detail for the component report. */
  detail: string;
};

export function createMastraRuntimeProbe(options: {
  agentModel?: string;
  /**
   * Real provider endpoint to construct the model binding against. Omit when the
   * deployment resolves models per workspace and no static endpoint exists.
   */
  bindingProbe?: { apiKey: string; baseUrl: string };
  createModel?: (snapshot: {
    apiKey: string;
    baseUrl: string;
    upstreamModelId: string;
  }) => unknown;
  loadMastraEntry?: () => Promise<{
    createMastraRunFactory?: unknown;
    agentClass?: unknown;
  }>;
}): RuntimeProbe {
  const createModel = options.createModel ?? defaultCreateModel;
  const loadMastraEntry = options.loadMastraEntry ?? defaultLoadMastraEntry;
  let verdict: RuntimeProbeResult | undefined;
  let warmed: Promise<RuntimeProbeResult> | undefined;

  /**
   * Tier 1. Pure and synchronous, so it is available even before `warmup`, and
   * cheap enough to run on every probe.
   */
  function configurationFailure(): RuntimeProbeResult | undefined {
    try {
      if (resolveAgentRuntimeMode() !== "mastra") {
        return { detail: "runtime agent_runtime_mode_invalid", reason: "agent_runtime_mode_invalid" };
      }
    } catch {
      // The resolver throws for a retired or misspelled mode; that is a real
      // misconfiguration, not a missing instance.
      return { detail: "runtime agent_runtime_mode_invalid", reason: "agent_runtime_mode_invalid" };
    }
    if (!options.agentModel) {
      return { detail: "runtime agent_model_unconfigured", reason: "agent_model_unconfigured" };
    }
    return undefined;
  }

  async function warmRuntime(): Promise<RuntimeProbeResult> {
    const configured = configurationFailure();
    if (configured) return configured;
    try {
      const entry = await loadMastraEntry();
      if (
        typeof entry.createMastraRunFactory !== "function" ||
        typeof entry.agentClass !== "function"
      ) {
        return { detail: "runtime mastra_entry_incomplete", reason: "mastra_entry_incomplete" };
      }
      if (options.bindingProbe) {
        try {
          createModel({
            apiKey: options.bindingProbe.apiKey,
            baseUrl: options.bindingProbe.baseUrl,
            upstreamModelId: options.agentModel!,
          });
        } catch {
          return { detail: "runtime model_binding_failed", reason: "model_binding_failed" };
        }
        return { detail: "mastra configured" };
      }
      return { detail: "mastra configured (binding unverified)" };
    } catch {
      // Reached only when the runtime module genuinely cannot be loaded.
      return { detail: "runtime runtime_unavailable", reason: "runtime_unavailable" };
    }
  }

  return {
    async warmup() {
      warmed ??= warmRuntime().then((result) => {
        verdict = result;
        return result;
      });
      return warmed;
    },
    async probeRuntime() {
      // A constructed runtime's verdict wins, including its failures.
      if (verdict) return verdict;
      const configured = configurationFailure();
      if (configured) return configured;
      // Configured and correct, but the lazy instance has not been constructed
      // yet. That is a healthy boot state, not a failure.
      return { detail: "mastra configured (lazy, not yet constructed)" };
    },
  };
}

function defaultCreateModel(snapshot: {
  apiKey: string;
  baseUrl: string;
  upstreamModelId: string;
}) {
  return createWorkspaceVisionModel(snapshot);
}

async function defaultLoadMastraEntry() {
  const [runtimeModule, agentModule] = await Promise.all([
    import("../agent/mastra-runtime.js"),
    import("@mastra/core/agent"),
  ]);
  return {
    createMastraRunFactory: (runtimeModule as { createMastraRunFactory?: unknown })
      .createMastraRunFactory,
    agentClass: (agentModule as { Agent?: unknown }).Agent,
  };
}

/** Storage probe through the existing Supabase storage client, with its own timeout. */
export function createSupabaseStorageProbe(options: {
  getAdminClient: () => AdminSupabaseClient;
}): StorageProbe {
  return {
    async probeBucket(bucket: string) {
      const { data, error } = await options.getAdminClient().storage.getBucket(bucket);
      if (error) throw error;
      if (!data) throw new Error("storage_bucket_not_found");
    },
  };
}

/**
 * Queue probe over the existing pgmq pool. Reachability is proven by the query
 * itself; `read` is the only depth primitive this pgmq version exposes (there is
 * no `metrics`/`queue_length` here), and it is called with quantity 1 so it
 * cannot claim work that a worker needs.
 */
export function createPgmqQueueProbe(options: {
  read: (
    queue: string,
    vt: number,
    qty: number,
    signal?: AbortSignal,
  ) => Promise<unknown[]>;
}): QueueProbe {
  return {
    async readDepths(queues) {
      return Promise.all(
        queues.map(async (queue) => {
          const signal = AbortSignal.timeout(HEALTH_TIMEOUTS.queueMs);
          const messages = await options.read(queue, 0, 1, signal);
          return { queue, depth: Array.isArray(messages) ? messages.length : 0 };
        }),
      );
    },
  };
}
