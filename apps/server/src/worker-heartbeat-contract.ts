/**
 * Worker liveness contract shared by the worker process (writer) and
 * `/api/health` (reader).
 *
 * The table name and both timings live here so the writer and reader can never
 * drift apart: a threshold that disagreed with the beat interval would either
 * flap or hide a dead worker.
 *
 * `private.loomic_worker_heartbeats` is in the `private` schema on purpose — it
 * is operational state and must never be reachable through PostgREST.
 */
export const WORKER_HEARTBEAT_TABLE = "loomic_worker_heartbeats";

/** How often a worker upserts its heartbeat row. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * How old the freshest heartbeat may be before health calls the worker OFFLINE.
 * Three missed beats, so one slow write cannot raise a false alarm.
 */
export const WORKER_HEARTBEAT_STALE_AFTER_MS = 30_000;
