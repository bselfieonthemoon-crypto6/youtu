/**
 * Worker liveness heartbeat.
 *
 * `/api/health` cannot know whether a worker process is alive from the API
 * process, and a queue depth of zero is indistinguishable from "nobody is
 * consuming". So the worker writes a heartbeat row and health calls the worker
 * OFFLINE when no row is fresher than `WORKER_HEARTBEAT_STALE_AFTER_MS`.
 *
 * The table is `private.loomic_worker_heartbeats` (see
 * `supabase/migrations/20260921000001_truthful_health_probe.sql`) so it is never
 * exposed through PostgREST. The row is upserted on `worker_id`, so it cannot
 * grow with uptime — one row per worker process identity.
 *
 * The heartbeat must never take the worker down: a failed beat is logged and the
 * next interval retries. Health is a report, not a supervisor.
 */
import type { AdminSupabaseClient } from "./supabase/admin.js";
import { WORKER_QUEUES } from "./queue/queues.js";
import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_STALE_AFTER_MS,
  WORKER_HEARTBEAT_TABLE,
} from "./worker-heartbeat-contract.js";

export {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_STALE_AFTER_MS,
  WORKER_HEARTBEAT_TABLE,
};

export type WorkerHeartbeatOptions = {
  getAdminClient: () => AdminSupabaseClient;
  intervalMs?: number;
  onError?: (error: unknown) => void;
  queues?: readonly string[];
  version: string;
  workerId: string;
};

export type WorkerHeartbeatWriter = {
  /** Write one heartbeat now; resolves false when the write failed. */
  beat(): Promise<boolean>;
  stop(): void;
};

export function writeWorkerHeartbeat(
  client: AdminSupabaseClient,
  input: { queues: readonly string[]; version: string; workerId: string },
): Promise<boolean> {
  // Through the RPC, not a table upsert: PostgREST exposes only
  // `public,storage,graphql_public` here, so a REST write to the `private`
  // heartbeat table answers PGRST205. The RPC also stamps `last_seen_at` with
  // server time, so a worker with a skewed clock cannot report itself fresh.
  const write = client.rpc(
    "loomic_worker_heartbeat_write" as never,
    {
      p_queues: [...input.queues],
      p_version: input.version || null,
      p_worker_id: input.workerId,
    } as never,
  );
  // The Supabase builder is a PromiseLike; wrap it so callers get a real Promise
  // and so a transport rejection resolves `false` instead of throwing.
  return Promise.resolve(write).then(
    ({ error }) => error === null,
    () => false,
  );
}

/**
 * Start the periodic heartbeat. One immediate beat runs first so a freshly
 * started worker is visible to health without waiting a full interval.
 */
export function startWorkerHeartbeat(
  options: WorkerHeartbeatOptions,
): WorkerHeartbeatWriter {
  const intervalMs = options.intervalMs ?? WORKER_HEARTBEAT_INTERVAL_MS;
  const queues = options.queues ?? WORKER_QUEUES;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const beat = async (): Promise<boolean> => {
    const written = await writeWorkerHeartbeat(options.getAdminClient(), {
      queues,
      version: options.version,
      workerId: options.workerId,
    });
    if (!written) {
      // A failed beat is a health-reporting problem, never a worker-fatal one.
      options.onError?.(new Error("worker_heartbeat_write_failed"));
    }
    return written;
  };

  const schedule = () => {
    if (stopped) return;
    timer = setInterval(() => {
      void beat().catch((error) => options.onError?.(error));
    }, intervalMs);
    // Do not keep the process alive for the heartbeat alone.
    timer.unref?.();
  };

  void beat()
    .catch((error) => options.onError?.(error))
    .finally(schedule);

  return {
    beat,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
