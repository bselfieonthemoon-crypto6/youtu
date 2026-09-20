/**
 * The queues the worker process polls.
 *
 * This lives outside `worker.ts` so the health probe can name the queues WITHOUT
 * importing the worker entry point, which starts polling loops at import time.
 * The worker and the health check must agree on this list, or health would
 * report the depth of queues nobody consumes.
 */
export const WORKER_QUEUES = [
  "image_generation_jobs",
  "video_generation_jobs",
  "design_preview_jobs",
  "design_export_jobs",
] as const;

export type WorkerQueue = (typeof WORKER_QUEUES)[number];
