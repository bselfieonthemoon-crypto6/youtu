import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { registerDesignAsyncExecutors } from "./features/designs/design-async-worker.js";
import { getExecutor, registerExecutor } from "./features/jobs/job-executor.js";
import { JobServiceError } from "./features/jobs/job-service.js";
import { WORKER_QUEUES, processMessage, reconcileTerminalJobRefunds, refundTerminalJob } from "./worker.js";

describe("worker claim gate", () => {
  it("defers a job when its retry attempt cannot be recorded before execution", async () => {
    const prior = getExecutor("image_generation");
    const execute = vi.fn(async () => ({ url: "should-not-run" }));
    const markFailed = vi.fn(async () => true);
    const deleteMsg = vi.fn(async () => undefined);
    const archive = vi.fn(async () => undefined);
    registerExecutor("image_generation", execute);
    const ctx = {
      jobService: {
        markRunning: vi.fn(async () => true),
        incrementAttempt: vi.fn(async () => {
          throw new JobServiceError(
            "job_attempt_increment_failed",
            "Job attempt could not be recorded.",
            503,
          );
        }),
        markFailed,
      },
      pgmq: { deleteMsg, archive },
    };

    try {
      await processMessage(
        "image_generation_jobs",
        {
          msg_id: 82,
          read_ct: 1,
          enqueued_at: "",
          vt: "",
          message: { job_id: "attempt-job", job_type: "image_generation" },
        },
        ctx as never,
        {} as never,
        "[worker:test]",
      );
    } finally {
      if (prior) registerExecutor("image_generation", prior);
    }

    expect(execute).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(
      "attempt-job",
      "attempt_increment_failed",
      "Job attempt could not be recorded; execution deferred.",
    );
    expect(deleteMsg).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
  });

  it("requires exact gpt-image-2 for explicit background removal before entering an executor", async () => {
    const id = "10000000-0000-4000-8000-000000000009";
    const model = "workspace:70000000-0000-4000-8000-000000000009";
    const backgroundJob = { ...designAsyncJob(id, "design_preview"), job_type: "image_generation",
      payload: { operation: "remove_background", model } };
    const archive = vi.fn(async () => true);
    const markDeadLetter = vi.fn(async () => true);
    const ctx = terminalContext(backgroundJob as never, { archive, markDeadLetter });
    const prior = getExecutor("image_generation");
    const execute = vi.fn();
    registerExecutor("image_generation", execute);
    const resolve = vi.fn(async () => { throw Object.assign(new Error("Wrong upstream model"), { code: "provider_snapshot_invalid" }); });
    try {
      await processMessage("image_generation_jobs", {
        msg_id: 90, read_ct: 1, enqueued_at: "", vt: "",
        message: { job_id: id, job_type: "image_generation" },
      }, ctx as never, {} as never, "[worker:test]", { resolve, resolveImageGenerationPlan: resolve } as never);
      expect(resolve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ modelId: model, requiredUpstreamModel: ["gpt-image-2", "gpt-image-2.5-flare"] }));
      expect(execute).not.toHaveBeenCalled();
      expect(markDeadLetter).toHaveBeenCalledWith(id, "provider_snapshot_invalid", expect.any(String));
    } finally {
      if (prior) registerExecutor("image_generation", prior);
    }
  });
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
    const executeLocal = vi.fn(async () => ({ operation: "region_matting" }));
    const resolve = vi.fn();
    const deleteMsg = vi.fn(async () => undefined);
    registerExecutor("image_generation", executeLocal);

    const job = {
      id: "job-local",
      status: "running",
      workspace_id: "workspace-1",
      payload: { operation: "region_matting", model: "local:feynobg" },
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

  it("resolves a frozen published provider for explicitly semantic split_layers", async () => {
    const originalExecutor = getExecutor("image_generation");
    const executeSemantic = vi.fn(async () => ({ operation: "split_layers" }));
    const resolveImageGenerationPlan = vi.fn(async () => ({ scope: {} }));
    const deleteMsg = vi.fn(async () => undefined);
    registerExecutor("image_generation", executeSemantic);
    const job = { id: "job-semantic", status: "running", workspace_id: "workspace-1",
      payload: { operation: "split_layers", layer_backend: "semantic",
        model: "workspace:published-flare" } };
    const ctx = { jobService: { markRunning: vi.fn(async () => true),
      getJobAdmin: vi.fn(async () => job), incrementAttempt: vi.fn(async () => ({
        attempt_count: 1, max_attempts: 3 })), markSucceeded: vi.fn(async () => false) },
      pgmq: { deleteMsg } };
    try {
      await processMessage("image_generation_jobs", { msg_id: 12, read_ct: 1,
        enqueued_at: new Date().toISOString(), vt: new Date().toISOString(),
        message: { job_id: "job-semantic", job_type: "image_generation" } },
        ctx as never, {} as never, "[worker:test]",
        { resolveImageGenerationPlan } as never);
    } finally {
      if (originalExecutor) registerExecutor("image_generation", originalExecutor);
    }
    expect(resolveImageGenerationPlan).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1", jobId: "job-semantic",
      modelId: "workspace:published-flare" }));
    expect(executeSemantic).toHaveBeenCalledOnce();
    expect(deleteMsg).toHaveBeenCalledWith("image_generation_jobs", 12);
  });

  // A payload that violates its schema fails the same way every time, and the raw
  // ZodError message is a JSON issue dump. It must dead-letter immediately with a
  // message a person can act on — the acceptance run for the box-selection split
  // hit exactly this and was retried once instead of failing fast.
  const schemaViolation = z.object({ layer_names: z.array(z.string()).min(2) })
    .safeParse({ layer_names: ["框选元素"] });
  if (schemaViolation.success) throw new Error("fixture must violate the schema");
  const schemaIssue = schemaViolation.error.issues[0]!;
  const schemaMessage = `任务参数校验失败：${(schemaIssue.path ?? []).join(".") || "参数"} ${schemaIssue.message ?? ""}`.trim();
  it.each([
    ["an unknown image provider outcome", "image_generation_result_unknown", "provider result is unknown", "job-unknown",
      () => Object.assign(new Error("provider result is unknown"), { code: "image_generation_result_unknown" })],
    ["an image aspect-ratio mismatch", "image_aspect_ratio_mismatch", "generated 2:3 instead of 4:5", "job-ratio",
      () => Object.assign(new Error("generated 2:3 instead of 4:5"), { code: "image_aspect_ratio_mismatch" })],
    ["overlapping semantic layers", "layer_output_overlap", "generated layers overlap", "job-layer-overlap",
      () => Object.assign(new Error("generated layers overlap"), { code: "layer_output_overlap" })],
    ["a payload schema violation", "invalid_input", schemaMessage, "job-schema",
      () => schemaViolation.error],
  ])("dead-letters %s without another attempt", async (_label, errorCode, errorMessage, jobId, makeError) => {
    const originalExecutor = getExecutor("image_generation");
    registerExecutor("image_generation", vi.fn(async () => { throw makeError(); }));
    const archive = vi.fn(async () => undefined);
    const markDeadLetter = vi.fn(async () => true);
    const settleTerminal = vi.fn(async () => true);
    const terminalJob = {
      id: jobId, workspace_id: "workspace-1", canvas_id: "canvas-1", target_kind: "canvas",
      design_id: null, session_id: null, job_type: "image_generation", status: "dead_letter",
      payload: { placeholder_element_id: "placeholder-1" }, result: null,
    };
    const billingQuery = {
      select: vi.fn(),
      eq: vi.fn(),
      single: vi.fn(async () => ({
        data: {
          status: "dead_letter",
          credits_cost: 0,
          workspace_id: "workspace-1",
          created_by: "user-1",
        },
      })),
    };
    billingQuery.select.mockReturnValue(billingQuery);
    billingQuery.eq.mockReturnValue(billingQuery);
    const ctx = {
      jobService: {
        markRunning: vi.fn(async () => true),
        incrementAttempt: vi.fn(async () => ({ attempt_count: 1, max_attempts: 3 })),
        markDeadLetter,
        getJobAdmin: vi.fn(async () => terminalJob),
      },
      pgmq: { archive },
      getAdminClient: () => ({ from: vi.fn(() => billingQuery) }),
    };

    try {
      await processMessage(
        "image_generation_jobs",
        {
          msg_id: 12,
          read_ct: 1,
          enqueued_at: new Date().toISOString(),
          vt: new Date().toISOString(),
          message: { job_id: jobId, job_type: "image_generation" },
        },
        ctx as never,
        {} as never,
        "[worker:test]",
        undefined,
        undefined,
        undefined,
        settleTerminal,
      );
    } finally {
      if (originalExecutor) registerExecutor("image_generation", originalExecutor);
    }

    expect(markDeadLetter).toHaveBeenCalledWith(
      jobId,
      errorCode,
      errorMessage,
    );
    expect(archive).toHaveBeenCalledWith("image_generation_jobs", 12);
    expect(settleTerminal).toHaveBeenCalledWith(expect.anything(), terminalJob);
  });

  it("never invokes execution work when a canceled job cannot be claimed", async () => {
    const incrementAttempt = vi.fn();
    const archive = vi.fn(async () => undefined);
    const refundCredits = vi.fn();
    const settleTerminal = vi.fn(async () => true);
    const terminalJob = {
      id: "job-1", workspace_id: "workspace-1", canvas_id: "canvas-1", target_kind: "canvas",
      design_id: null, session_id: null, job_type: "image_generation", status: "canceled",
      payload: { placeholder_element_id: "placeholder-1" }, result: null,
    };
    const ctx = {
      jobService: {
        markRunning: vi.fn(async () => false),
        getJobAdmin: vi.fn(async () => terminalJob),
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
      undefined,
      undefined,
      undefined,
      settleTerminal,
    );

    expect(incrementAttempt).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
    expect(archive).toHaveBeenCalledWith("image_generation_jobs", 9);
    expect(settleTerminal).toHaveBeenCalledWith(expect.anything(), terminalJob);
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

  it("exposes the check-then-refund race for a non-zero terminal job", async () => {
    const refundCredits = vi.fn(async () => "refund-1");
    let refundChecks = 0;
    let releaseChecks!: () => void;
    const bothChecks = new Promise<void>((resolve) => { releaseChecks = resolve; });
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
      maybeSingle: vi.fn(async () => {
        refundChecks += 1;
        if (refundChecks === 2) releaseChecks();
        await bothChecks;
        return { data: null, error: null };
      }),
    };
    const admin = { from: vi.fn(() => query) };
    const ctx = { getAdminClient: () => admin } as never;
    await Promise.all([
      refundTerminalJob("job-1", "dead_letter", ctx, { refundCredits } as never, "[worker:test]"),
      refundTerminalJob("job-1", "dead_letter", ctx, { refundCredits } as never, "[worker:test]"),
    ]);

    // This is a controlled finding, not a desired assertion: both workers pass
    // the preflight check and invoke the refund RPC. The DB RPC/unique index must
    // reject one transaction; the worker itself does not serialize this path.
    expect(refundCredits).toHaveBeenCalledTimes(2);
  });
});

describe("worker refund reconciliation", () => {
  it("retries a missing refund for a charged terminal job", async () => {
    const refundCredits = vi.fn(async () => "refund-tx");
    let backgroundReads = 0;
    let refundReads = 0;
    const admin = { from: vi.fn((table: string) => {
      const query: any = {
        select: vi.fn(() => query), eq: vi.fn(() => query), in: vi.fn(() => query),
        gt: vi.fn(() => query), order: vi.fn(() => query),
        limit: vi.fn((value: number) => {
          if (table === "background_jobs" && backgroundReads++ === 0)
            return Promise.resolve({ data: [{ id: "job-1", status: "dead_letter" }], error: null });
          return query;
        }),
        single: vi.fn(async () => ({ data: { status: "dead_letter", credits_cost: 5,
          workspace_id: "workspace-1", created_by: "user-1" }, error: null })),
        maybeSingle: vi.fn(async () => ({ data: ++refundReads === 3 ? { id: "refund-tx" } : null, error: null })),
      };
      return query;
    }) };

    await expect(reconcileTerminalJobRefunds(
      { getAdminClient: () => admin } as never,
      { refundCredits } as never,
      "[worker:test]",
    )).resolves.toEqual({ refunded: 1, failed: 0 });
    expect(refundCredits).toHaveBeenCalledOnce();
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
