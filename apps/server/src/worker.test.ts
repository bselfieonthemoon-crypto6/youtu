import { describe, expect, it, vi } from "vitest";

import { registerDesignAsyncExecutors } from "./features/designs/design-async-worker.js";
import { getExecutor, registerExecutor } from "./features/jobs/job-executor.js";
import { JobServiceError } from "./features/jobs/job-service.js";
import { WORKER_QUEUES, processMessage, refundTerminalJob } from "./worker.js";

describe("worker claim gate", () => {
  it.each(["job_not_found", "job_query_failed"] as const)("distinguishes orphan messages from %s lookup errors", async (code) => {
    const archive = vi.fn(async () => true);
    const incrementAttempt = vi.fn();
    const error = new JobServiceError(code, 'lookup error', code === 'job_not_found' ? 404 : 500);
    const ctx = { jobService: {
      markRunning: vi.fn(async () => false),
      getJobAdmin: vi.fn(async () => { throw error; }),
      incrementAttempt,
    }, pgmq: { archive } };
    const pending = processMessage('image_generation_jobs', {
      msg_id: 81, read_ct: 1, enqueued_at: '', vt: '',
      message: { job_id: 'deleted-job', job_type: 'image_generation' },
    }, ctx as never, {} as never, '[worker:test]');
    if (code === 'job_not_found') {
      await expect(pending).resolves.toBeUndefined();
      expect(archive).toHaveBeenCalledWith('image_generation_jobs', 81);
    } else {
      await expect(pending).rejects.toBe(error);
      expect(archive).not.toHaveBeenCalled();
    }
    expect(incrementAttempt).not.toHaveBeenCalled();
  });
  it("consumes preview and export queues and makes unavailable renderers terminal", async () => {
    expect(WORKER_QUEUES).toEqual(
      expect.arrayContaining(["design_preview_jobs", "design_export_jobs"]),
    );
    registerDesignAsyncExecutors({
      previewRepository: { commit: vi.fn() },
    });
    const markError = vi.fn(async () => ({ updated: true }));

    for (const jobType of ["design_preview", "design_export"] as const) {
      const queue = `${jobType}_jobs`;
      const jobId =
        jobType === "design_preview"
          ? "10000000-0000-4000-8000-000000000001"
          : "10000000-0000-4000-8000-000000000002";
      const backgroundJob = designAsyncJob(jobId, jobType);
      const archive = vi.fn(async () => undefined);
      const markDeadLetter = vi.fn(async () => true);
      const ctx = terminalContext(backgroundJob, { archive, markDeadLetter });

      await processMessage(
        queue,
        {
          msg_id: jobType === "design_preview" ? 21 : 22,
          read_ct: 1,
          enqueued_at: new Date().toISOString(),
          vt: new Date().toISOString(),
          message: { job_id: jobId, job_type: jobType },
        },
        ctx as never,
        {} as never,
        "[worker:test]",
        undefined,
        undefined,
        { markError },
      );

      expect(markDeadLetter).toHaveBeenCalledWith(
        jobId,
        "design_renderer_unavailable",
        expect.stringContaining("renderer is not available"),
      );
      expect(archive).toHaveBeenCalledWith(
        queue,
        jobType === "design_preview" ? 21 : 22,
      );
    }

    expect(markError).toHaveBeenCalledTimes(1);
    expect(markError).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "10000000-0000-4000-8000-000000000001",
        errorCode: "design_renderer_unavailable",
      }),
    );
  });

  it("runs local image operations without resolving a third-party provider", async () => {
    const originalExecutor = getExecutor("image_generation");
    const executeLocal = vi.fn(async () => ({ operation: "split_layers" }));
    const resolve = vi.fn();
    const deleteMsg = vi.fn(async () => undefined);
    registerExecutor("image_generation", executeLocal);

    const job = {
      id: "job-local",
      status: "running",
      workspace_id: "workspace-1",
      payload: { operation: "split_layers", model: "local:feynobg" },
    };
    const ctx = {
      jobService: {
        markRunning: vi.fn(async () => true),
        getJobAdmin: vi.fn(async () => job),
        incrementAttempt: vi.fn(async () => ({
          attempt_count: 1,
          max_attempts: 3,
        })),
        markSucceeded: vi.fn(async () => false),
      },
      pgmq: { deleteMsg },
    };

    try {
      await processMessage(
        "image_generation_jobs",
        {
          msg_id: 11,
          read_ct: 1,
          enqueued_at: new Date().toISOString(),
          vt: new Date().toISOString(),
          message: { job_id: "job-local", job_type: "image_generation" },
        },
        ctx as never,
        {} as never,
        "[worker:test]",
        { resolve } as never,
      );
    } finally {
      if (originalExecutor)
        registerExecutor("image_generation", originalExecutor);
    }

    expect(resolve).not.toHaveBeenCalled();
    expect(executeLocal).toHaveBeenCalledOnce();
    expect(deleteMsg).toHaveBeenCalledWith("image_generation_jobs", 11);
  });

  it("never invokes execution work when a canceled job cannot be claimed", async () => {
    const incrementAttempt = vi.fn();
    const archive = vi.fn(async () => undefined);
    const refundCredits = vi.fn();
    const ctx = {
      jobService: {
        markRunning: vi.fn(async () => false),
        getJobAdmin: vi.fn(async () => ({ id: "job-1", status: "canceled" })),
        incrementAttempt,
      },
      pgmq: { archive },
      getAdminClient: () => ({
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn(async () => ({
            data: {
              status: "canceled",
              credits_cost: 0,
              workspace_id: "workspace-1",
              created_by: "user-1",
            },
          })),
        })),
      }),
    };

    await processMessage(
      "image_generation_jobs",
      {
        msg_id: 9,
        read_ct: 1,
        enqueued_at: new Date().toISOString(),
        vt: new Date().toISOString(),
        message: { job_id: "job-1", job_type: "image_generation" },
      },
      ctx as never,
      { refundCredits } as never,
      "[worker:test]",
    );

    expect(incrementAttempt).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
    expect(archive).toHaveBeenCalledWith("image_generation_jobs", 9);
  });

  it("keeps a message recoverable while another worker still owns the job", async () => {
    const archive = vi.fn(async () => undefined);
    const setVt = vi.fn(async () => undefined);
    const incrementAttempt = vi.fn();
    const ctx = {
      jobService: {
        markRunning: vi.fn(async () => false),
        getJobAdmin: vi.fn(async () => ({ id: "job-1", status: "running" })),
        incrementAttempt,
      },
      pgmq: { archive, setVt },
    };

    await processMessage(
      "image_generation_jobs",
      {
        msg_id: 10,
        read_ct: 2,
        enqueued_at: new Date().toISOString(),
        vt: new Date().toISOString(),
        message: { job_id: "job-1", job_type: "image_generation" },
      },
      ctx as never,
      {} as never,
      "[worker:test]",
    );

    expect(setVt).toHaveBeenCalledWith("image_generation_jobs", 10, 120);
    expect(archive).not.toHaveBeenCalled();
    expect(incrementAttempt).not.toHaveBeenCalled();
  });

  it("does not refund a terminal job twice", async () => {
    const refundCredits = vi.fn();
    const chain = (terminal: "single" | "maybeSingle") => {
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        limit: vi.fn(() => query),
        single: vi.fn(async () => ({
          data: {
            status: "dead_letter",
            credits_cost: 5,
            workspace_id: "workspace-1",
            created_by: "user-1",
          },
        })),
        maybeSingle: vi.fn(async () => ({
          data: { id: "refund-1" },
          error: null,
        })),
      };
      return query[terminal] ? query : query;
    };
    const admin = {
      from: vi.fn((table: string) =>
        table === "background_jobs" ? chain("single") : chain("maybeSingle"),
      ),
    };

    await refundTerminalJob(
      "job-1",
      "dead_letter",
      { getAdminClient: () => admin } as never,
      { refundCredits } as never,
      "[worker:test]",
    );

    expect(refundCredits).not.toHaveBeenCalled();
  });
});

function designAsyncJob(
  id: string,
  jobType: "design_preview" | "design_export",
) {
  const designId = "20000000-0000-4000-8000-000000000001";
  const userId = "30000000-0000-4000-8000-000000000001";
  const requestId = "40000000-0000-4000-8000-000000000001";
  return {
    id,
    workspace_id: "50000000-0000-4000-8000-000000000001",
    project_id: "60000000-0000-4000-8000-000000000001",
    canvas_id: null,
    target_kind: "design",
    design_id: designId,
    session_id: null,
    thread_id: null,
    queue_name: `${jobType}_jobs`,
    job_type: jobType,
    status: "running",
    payload:
      jobType === "design_preview"
        ? {
            design_id: designId,
            revision: 3,
            idempotency_key: requestId,
            requested_by: userId,
          }
        : {
            design_id: designId,
            revision: 3,
            idempotency_key: requestId,
            requested_by: userId,
            format: "png",
            multiplier: 1,
            transparent: true,
          },
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 0,
    max_attempts: 3,
    created_by: userId,
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z",
    started_at: "2026-09-04T00:00:01.000Z",
    completed_at: null,
    failed_at: null,
    canceled_at: null,
  };
}

function terminalContext(
  backgroundJob: ReturnType<typeof designAsyncJob>,
  methods: {
    archive: ReturnType<typeof vi.fn>;
    markDeadLetter: ReturnType<typeof vi.fn>;
  },
) {
  const billingQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    single: vi.fn(async () => ({
      data: {
        status: "dead_letter",
        credits_cost: 0,
        workspace_id: backgroundJob.workspace_id,
        created_by: backgroundJob.created_by,
      },
    })),
  };
  billingQuery.select.mockReturnValue(billingQuery);
  billingQuery.eq.mockReturnValue(billingQuery);
  return {
    jobService: {
      markRunning: vi.fn(async () => true),
      getJobAdmin: vi.fn(async () => backgroundJob),
      incrementAttempt: vi.fn(async () => ({
        attempt_count: 1,
        max_attempts: 3,
      })),
      markDeadLetter: methods.markDeadLetter,
    },
    pgmq: { archive: methods.archive },
    getAdminClient: () => ({ from: vi.fn(() => billingQuery) }),
    env: {},
    renewVt: vi.fn(),
  };
}
