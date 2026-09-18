import { describe, expect, it, vi } from "vitest";

import { getExecutor, registerExecutor } from "./features/jobs/job-executor.js";
import { processMessage } from "./worker.js";

const message = (msgId: number, jobId: string, jobType: "video_generation" | "image_generation") => ({
  msg_id: msgId,
  read_ct: 1,
  enqueued_at: "",
  vt: "",
  message: { job_id: jobId, job_type: jobType },
});

describe("worker recovery boundaries", () => {
  it("shows that an expired lease lets the generic worker re-enter an executor (potential risk)", async () => {
    let now = 0;
    let startedAt = 0;
    let running = false;
    const executorEntries: number[] = [];
    const release: Array<() => void> = [];
    const execute = vi.fn(async () => {
      executorEntries.push(now);
      await new Promise<void>((resolve) => release.push(resolve));
      return { executorEntry: executorEntries.length };
    });
    const prior = getExecutor("video_generation");
    registerExecutor("video_generation", execute);

    const jobService = {
      markRunning: vi.fn(async () => {
        if (!running || now - startedAt >= 30 * 60_000) {
          running = true;
          startedAt = now;
          return true;
        }
        return false;
      }),
      getJobAdmin: vi.fn(async () => ({ id: "lease-job", status: "running", workspace_id: "workspace-1", payload: {} })),
      incrementAttempt: vi.fn(async () => ({ attempt_count: 1, max_attempts: 3 })),
      markSucceeded: vi.fn(async () => true),
    };
    const setVt = vi.fn(async () => undefined);
    const deleteMsg = vi.fn(async () => undefined);
    const ctx = { jobService, pgmq: { setVt, deleteMsg } };

    try {
      const first = processMessage("video_generation_jobs", message(1, "lease-job", "video_generation"), ctx as never, {} as never, "[worker:test]");
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));

      // A duplicate delivery while the original worker is healthy is deferred.
      await processMessage("video_generation_jobs", message(2, "lease-job", "video_generation"), ctx as never, {} as never, "[worker:test]");
      expect(execute).toHaveBeenCalledTimes(1);
      expect(setVt).toHaveBeenCalledWith("video_generation_jobs", 2, 300);

      // Once the durable lease is older than 30 minutes, a second worker is
      // allowed to enter while the first executor call is still in flight.
      // This only demonstrates generic executor re-entry, not a real provider
      // duplicate or a billing outcome.
      now = 31 * 60_000;
      const second = processMessage("video_generation_jobs", message(3, "lease-job", "video_generation"), ctx as never, {} as never, "[worker:test]");
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
      expect(executorEntries).toEqual([0, 31 * 60_000]);

      release.splice(0).forEach((resolve) => resolve());
      await Promise.all([first, second]);
      expect(deleteMsg).toHaveBeenCalledTimes(2);
    } finally {
      if (prior) registerExecutor("video_generation", prior);
    }
  });

  it("does not retry an unknown provider outcome after the provider has been called", async () => {
    const prior = getExecutor("image_generation");
    const controlledExecutor = vi.fn(async () => {
      throw Object.assign(new Error("request accepted, result unavailable"), {
        code: "image_generation_result_unknown",
      });
    });
    registerExecutor("image_generation", controlledExecutor);
    const archive = vi.fn(async () => undefined);
    const markDeadLetter = vi.fn(async () => true);
    const terminalize = vi.fn(async () => true);
    const billingQuery = {
      select: vi.fn(() => billingQuery),
      eq: vi.fn(() => billingQuery),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
      single: vi.fn(async () => ({ data: { status: "dead_letter", credits_cost: 0, workspace_id: "workspace-1", created_by: "user-1" }, error: null })),
    };
    const ctx = {
      jobService: {
        markRunning: vi.fn(async () => true),
        incrementAttempt: vi.fn(async () => ({ attempt_count: 1, max_attempts: 3 })),
        markDeadLetter,
        getJobAdmin: vi.fn(async () => ({ id: "unknown-job", status: "dead_letter" })),
      },
      pgmq: { archive },
      getAdminClient: () => ({ from: vi.fn(() => billingQuery) }),
    };
    try {
      await processMessage(
        "image_generation_jobs",
        message(4, "unknown-job", "image_generation"),
        ctx as never,
        {} as never,
        "[worker:test]",
        undefined,
        undefined,
        undefined,
        terminalize,
      );
      expect(controlledExecutor).toHaveBeenCalledOnce();
      expect(markDeadLetter).toHaveBeenCalledWith("unknown-job", "image_generation_result_unknown", expect.any(String));
      expect(archive).toHaveBeenCalledWith("image_generation_jobs", 4);
    } finally {
      if (prior) registerExecutor("image_generation", prior);
    }
  });
});
