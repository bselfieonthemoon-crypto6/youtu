"use client";

import { useCallback, useRef } from "react";

import type { StreamEvent } from "@loomic/shared";

import type { BackgroundJob } from "@loomic/shared";
import { fetchJob } from "../lib/server-api";

// --- Constants ---

/** Interval between polling attempts (ms) */
const POLL_INTERVAL_MS = 5_000;
/** Maximum total polling duration before giving up (ms) */
const MAX_POLL_DURATION_MS = 10 * 60 * 1_000; // 10 minutes
/** Terminal job statuses that should stop polling */
const TERMINAL_FAILURE_STATUSES = new Set(["dead_letter", "canceled"]);

// --- Types ---

type UseJobFallbackPollingOptions = {
  /** Called only when the successful job already has a canvas element. */
  onJobSucceeded: (jobId: string, jobType: string, elementId: string) => void;
  /** Ref to the current access token — avoids stale closure issues */
  accessTokenRef: React.RefObject<string | undefined>;
};

type SharedPoll = { promise: Promise<BackgroundJob> };

const sharedPolls = new Map<string, SharedPoll>();

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function readGenerationJobElementId(job: BackgroundJob): string | null {
  const row = job as BackgroundJob & { canvas_element_id?: unknown };
  if (typeof row.canvas_element_id === "string" && row.canvas_element_id) {
    return row.canvas_element_id;
  }
  const result = job.result;
  if (!result) return null;
  const value =
    result.canvas_element_id ?? result.elementId ?? result.element_id;
  return typeof value === "string" && value ? value : null;
}

/**
 * Wait for one existing server job. Calls sharing a jobId reuse the same poll;
 * this function never creates, enqueues, debits, or retries generation work.
 */
export function waitForGenerationJob(
  accessToken: string,
  jobId: string,
): Promise<BackgroundJob> {
  const pollKey = `${accessToken}:${jobId}`;
  const existing = sharedPolls.get(pollKey);
  if (existing) return existing.promise;

  const promise = (async () => {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= MAX_POLL_DURATION_MS) {
      const { job } = await fetchJob(accessToken, jobId);
      if (
        (job.status === "succeeded" &&
          (job.target_kind === "canvas"
            ? Boolean(readGenerationJobElementId(job))
            : job.target_kind === "design"
              ? Boolean(job.result?.chat_finalized_at)
              : true)) ||
        TERMINAL_FAILURE_STATUSES.has(job.status) ||
        job.error_code === "submission_failed" ||
        (job.status === "failed" && job.attempt_count >= job.max_attempts)
      ) {
        return job;
      }
      await delay(POLL_INTERVAL_MS);
    }
    throw new Error("等待生成结果超时，请稍后再试。");
  })().finally(() => {
    sharedPolls.delete(pollKey);
  });

  sharedPolls.set(pollKey, { promise });
  return promise;
}

// --- Hook ---

/**
 * Fallback polling for timed-out generation jobs.
 *
 * When the agent's generate_image/generate_video tool times out on the server
 * (poll timeout), the worker may still succeed later. This hook detects the
 * timeout from the `tool.completed` stream event and starts polling the job
 * API until the worker finishes, then notifies the caller to re-fetch the canvas.
 *
 * This prevents users from losing both their result and credits when the
 * backend times out but the worker eventually succeeds.
 *
 * A successful worker job is not necessarily inserted into the canvas. The
 * canvas is refreshed only when the authoritative job record contains an
 * element id; otherwise the tool card offers the explicit restore action.
 */
export function useJobFallbackPolling({
  onJobSucceeded,
  accessTokenRef,
}: UseJobFallbackPollingOptions) {
  // Keep callback ref current to avoid stale closures in intervals
  const onJobSucceededRef = useRef(onJobSucceeded);
  onJobSucceededRef.current = onJobSucceeded;

  /**
   * Start polling a specific job until it reaches a terminal state.
   */
  const startPolling = useCallback(
    (jobId: string, jobType: string) => {
      const token = accessTokenRef.current;
      if (!token) return;
      void waitForGenerationJob(token, jobId)
        .then((job) => {
          if (job.status !== "succeeded") return;
          const elementId =
            readGenerationJobElementId(job) ??
            (job.target_kind === "design" && job.result?.chat_finalized_at
              ? job.design_id
              : null);
          if (elementId) {
            onJobSucceededRef.current(jobId, jobType, elementId);
          }
        })
        .catch((error) => {
          console.warn(`[job-fallback] Poll error for job ${jobId}:`, error);
        });
    },
    [accessTokenRef],
  );

  /**
   * Check a stream event for timed-out generation jobs.
   * Call this for every stream event received from the WebSocket.
   */
  const checkForTimedOutJobs = useCallback(
    (event: StreamEvent) => {
      if (event.type !== "tool.completed") return;

      const output = event.output;
      if (!output) return;

      const error = output.error;
      const jobId = output.jobId;
      const jobType = output.jobType;

      // Only trigger fallback for timeout errors with a valid jobId
      if (
        (!(
          typeof error === "string" && error.toLowerCase().includes("timed out")
        ) &&
          output.status !== "processing" &&
          output.status !== "queued") ||
        typeof jobId !== "string" ||
        !jobId
      ) {
        return;
      }

      const resolvedJobType = typeof jobType === "string" ? jobType : "unknown";
      startPolling(jobId, resolvedJobType);
    },
    [startPolling],
  );

  return { checkForTimedOutJobs };
}
