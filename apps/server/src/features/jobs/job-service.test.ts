import { describe, expect, it, vi } from "vitest";

import { createJobService } from "./job-service.js";

function createAdminQuery(
  result: { data: unknown; error: unknown } = {
    data: { id: "job-1" },
    error: null,
  },
) {
  const calls: Array<[string, unknown]> = [];
  const query = {
    update: vi.fn((value: unknown) => {
      calls.push(["update", value]);
      return query;
    }),
    eq: vi.fn((column: string, value: unknown) => {
      calls.push([`eq:${column}`, value]);
      return query;
    }),
    in: vi.fn((column: string, value: unknown) => {
      calls.push([`in:${column}`, value]);
      return query;
    }),
    is: vi.fn((column: string, value: unknown) => {
      calls.push([`is:${column}`, value]);
      return query;
    }),
    contains: vi.fn((column: string, value: unknown) => {
      calls.push([`contains:${column}`, value]);
      return query;
    }),
    lt: vi.fn((column: string, value: unknown) => {
      calls.push([`lt:${column}`, value]);
      return query;
    }),
    select: vi.fn((value: string) => {
      calls.push(["select", value]);
      return query;
    }),
    maybeSingle: vi.fn(async () => result),
  };
  return { query, calls };
}

function createService(query: ReturnType<typeof createAdminQuery>["query"]) {
  return createJobService({
    createUserClient: vi.fn() as never,
    getAdminClient: () => ({ from: vi.fn(() => query) }) as never,
    pgmq: {} as never,
  });
}

describe("JobService terminal state guards", () => {
  it("atomically claims only queued or retryable failed jobs", async () => {
    const { query, calls } = createAdminQuery();
    const service = createService(query);

    await expect(service.markRunning("job-1")).resolves.toBe(true);
    expect(calls).toContainEqual(["eq:id", "job-1"]);
    expect(calls).toContainEqual(["in:status", ["queued", "failed"]]);
  });

  it("returns false when cancellation wins the claim race", async () => {
    const { query, calls } = createAdminQuery({ data: null, error: null });
    const service = createService(query);

    await expect(service.markRunning("job-1")).resolves.toBe(false);
    expect(calls.some(([operation]) => operation === "lt:started_at")).toBe(
      true,
    );
  });

  it.each([
    ["markSucceeded", ["job-1", { url: "result" }]],
    ["markFailed", ["job-1", "provider_error", "failed"]],
    ["markDeadLetter", ["job-1", "provider_error", "failed"]],
  ] as const)("%s only transitions a running job", async (method, args) => {
    const { query, calls } = createAdminQuery({ data: null, error: null });
    const service = createService(query);

    const transitioned = await (
      service[method] as (...values: unknown[]) => Promise<boolean>
    )(...args);

    expect(transitioned).toBe(false);
    expect(calls).toContainEqual(["eq:status", "running"]);
  });
});

describe("JobService attempt recording", () => {
  it.each([
    ["an RPC error", { data: null, error: { message: "database unavailable" } }],
    ["an empty RPC result", { data: [], error: null }],
    ["a malformed RPC result", { data: { attempt_count: 1.5, max_attempts: 3 }, error: null }],
  ])("fails closed for %s", async (_label, result) => {
    const rpc = vi.fn(async () => result);
    const service = createJobService({
      createUserClient: vi.fn() as never,
      getAdminClient: () => ({ rpc }) as never,
      pgmq: {} as never,
    });

    await expect(service.incrementAttempt("job-1")).rejects.toMatchObject({
      code: "job_attempt_increment_failed",
      statusCode: 503,
    });
  });

  it("normalizes a thrown RPC failure to the retryable attempt error", async () => {
    const rpc = vi.fn(async () => { throw new Error("connection reset"); });
    const service = createJobService({
      createUserClient: vi.fn() as never,
      getAdminClient: () => ({ rpc }) as never,
      pgmq: {} as never,
    });

    await expect(service.incrementAttempt("job-1")).rejects.toMatchObject({
      code: "job_attempt_increment_failed",
      statusCode: 503,
    });
  });
});

describe("JobService Mastra image commit", () => {
  const user = { id: "10000000-0000-4000-8000-000000000001", accessToken: "token" } as never;
  const jobId = "10000000-0000-4000-8000-000000000002";
  const runId = "10000000-0000-4000-8000-000000000003";
  const submissionKey = `${runId}:${"a".repeat(64)}`;

  it("calls only the atomic server RPC with the bound run identity and price", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const service = createJobService({
      createUserClient: vi.fn() as never,
      getAdminClient: () => ({ rpc }) as never,
      pgmq: {} as never,
    });
    await expect(service.commitMastraImageJob(user, {
      jobId, runId, submissionKey, creditsCost: 3,
    })).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("loomic_commit_mastra_image_job", {
      p_job: jobId, p_user: "10000000-0000-4000-8000-000000000001",
      p_run: runId, p_submission_key: submissionKey, p_cost: 3,
    });
  });

  it("rejects an invalid price before calling the database", async () => {
    const rpc = vi.fn();
    const service = createJobService({
      createUserClient: vi.fn() as never,
      getAdminClient: () => ({ rpc }) as never,
      pgmq: {} as never,
    });
    await expect(service.commitMastraImageJob(user, {
      jobId, runId, submissionKey, creditsCost: 0.5,
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("classifies a returned database error as a definitive commit rejection", async () => {
    const rpc = vi.fn(async () => ({ data: null,
      error: { code: "P0001", message: "mastra_image_submission_forbidden" } }));
    const service = createJobService({ createUserClient: vi.fn() as never,
      getAdminClient: () => ({ rpc }) as never, pgmq: {} as never });
    await expect(service.commitMastraImageJob(user, { jobId, runId, submissionKey, creditsCost: 3 }))
      .rejects.toMatchObject({ code: "mastra_commit_rejected", statusCode: 409 });
  });

  it("keeps an SDK-returned fetch error in the unknown-outcome class", async () => {
    const rpc = vi.fn(async () => ({ data: null,
      error: { code: "", message: "TypeError: fetch failed" } }));
    const service = createJobService({ createUserClient: vi.fn() as never,
      getAdminClient: () => ({ rpc }) as never, pgmq: {} as never });
    await expect(service.commitMastraImageJob(user, { jobId, runId, submissionKey, creditsCost: 3 }))
      .rejects.toMatchObject({ code: "mastra_commit_unknown", statusCode: 503 });
  });

  it("classifies a thrown transport failure as an unknown commit outcome", async () => {
    const rpc = vi.fn(async () => { throw new Error("connection reset"); });
    const service = createJobService({ createUserClient: vi.fn() as never,
      getAdminClient: () => ({ rpc }) as never, pgmq: {} as never });
    await expect(service.commitMastraImageJob(user, { jobId, runId, submissionKey, creditsCost: 3 }))
      .rejects.toMatchObject({ code: "mastra_commit_unknown", statusCode: 503 });
  });

  it("compensates only a matching queued job that has not been published", async () => {
    const { query, calls } = createAdminQuery({ data: { id: jobId }, error: null });
    const service = createService(query);
    await expect(service.cancelUncommittedMastraImageJob(user, {
      jobId, runId, submissionKey,
    })).resolves.toBe(true);
    expect(calls).toContainEqual(["eq:id", jobId]);
    expect(calls).toContainEqual(["eq:created_by", "10000000-0000-4000-8000-000000000001"]);
    expect(calls).toContainEqual(["eq:status", "queued"]);
    expect(calls).toContainEqual(["is:image_enqueued_at", null]);
    expect(calls).toContainEqual(["contains:payload", {
      mastra_origin_run_id: runId, mastra_submission_key: submissionKey,
    }]);
  });

  it("does not compensate after publication wins the CAS", async () => {
    const { query } = createAdminQuery({ data: null, error: null });
    const service = createService(query);
    await expect(service.cancelUncommittedMastraImageJob(user, {
      jobId, runId, submissionKey,
    })).resolves.toBe(false);
  });
});

describe("JobService durable video commit", () => {
  const user = { id: "10000000-0000-4000-8000-000000000001", accessToken: "token" } as never;
  const jobId = "10000000-0000-4000-8000-000000000002";
  const runId = "10000000-0000-4000-8000-000000000003";
  const submissionKey = `${runId}:${"c".repeat(64)}`;

  it("uses the atomic RPC with the stable submission identity", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const service = createJobService({ createUserClient: vi.fn() as never,
      getAdminClient: () => ({ rpc }) as never, pgmq: {} as never });
    await expect(service.commitVideoJob(user, {
      jobId, runId, submissionKey, creditsCost: 12,
    })).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("loomic_commit_video_job", {
      p_job: jobId, p_user: "10000000-0000-4000-8000-000000000001", p_submission_key: submissionKey,
      p_cost: 12, p_run: runId,
    });
  });

  it("keeps transport and snapshot races in the unknown-outcome class", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: "P0001",
        message: "video_provider_snapshot_missing" } })
      .mockRejectedValueOnce(new Error("response lost"));
    const service = createJobService({ createUserClient: vi.fn() as never,
      getAdminClient: () => ({ rpc }) as never, pgmq: {} as never });
    await expect(service.commitVideoJob(user, {
      jobId, runId, submissionKey, creditsCost: 12,
    })).rejects.toMatchObject({ code: "video_commit_unknown", statusCode: 503 });
    await expect(service.commitVideoJob(user, {
      jobId, runId, submissionKey, creditsCost: 12,
    })).rejects.toMatchObject({ code: "video_commit_unknown", statusCode: 503 });
  });

  it("classifies only explicit submission validation as a definitive rejection", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "P0001",
      message: "video_submission_run_forbidden" } }));
    const service = createJobService({ createUserClient: vi.fn() as never,
      getAdminClient: () => ({ rpc }) as never, pgmq: {} as never });
    await expect(service.commitVideoJob(user, {
      jobId, runId, submissionKey, creditsCost: 12,
    })).rejects.toMatchObject({ code: "video_commit_rejected", statusCode: 409 });
  });

  it("preserves the insufficient-credit product error from the atomic RPC", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "P0001",
      message: "INSUFFICIENT_CREDITS" } }));
    const service = createJobService({ createUserClient: vi.fn() as never,
      getAdminClient: () => ({ rpc }) as never, pgmq: {} as never });
    await expect(service.commitVideoJob(user, {
      jobId, runId, submissionKey, creditsCost: 12,
    })).rejects.toMatchObject({ code: "insufficient_credits", statusCode: 402 });
  });

  it("compensates only a matching queued job without a video enqueue receipt", async () => {
    const { query, calls } = createAdminQuery({ data: { id: jobId }, error: null });
    const service = createService(query);
    await expect(service.cancelUncommittedVideoJob(user, {
      jobId, submissionKey,
    })).resolves.toBe(true);
    expect(calls).toContainEqual(["eq:status", "queued"]);
    expect(calls).toContainEqual(["is:video_enqueued_at", null]);
    expect(calls).toContainEqual(["contains:payload", {
      video_submission_key: submissionKey,
    }]);
  });
});

describe("JobService Mastra image replay", () => {
  const user = { id: "10000000-0000-4000-8000-000000000001", accessToken: "token" } as never;
  const workspaceId = "10000000-0000-4000-8000-000000000002";
  const sessionId = "10000000-0000-4000-8000-000000000003";
  const runId = "10000000-0000-4000-8000-000000000004";
  const designId = "10000000-0000-4000-8000-000000000005";
  const commandId = "10000000-0000-5000-8000-000000000006";
  const submissionKey = `${runId}:${"b".repeat(64)}`;
  const target = { kind: "design" as const, design_id: designId, expected_revision: 2,
    idempotency_key: commandId, placement: { x: 10, y: 20, role: "background" as const } };

  function lookupService(nodeLinked = true) {
    const job = {
      id: "10000000-0000-4000-8000-000000000007", workspace_id: workspaceId,
      project_id: "project-1", canvas_id: null, target_kind: "design", design_id: designId,
      session_id: sessionId, thread_id: null, queue_name: "image_generation_jobs",
      job_type: "image_generation", status: "succeeded",
      payload: { prompt: "new logo", target, mastra_submission_key: submissionKey,
        mastra_origin_run_id: runId, mastra_credits_cost: 0 }, result: { asset_id: "asset" },
      error_code: null, error_message: null, attempt_count: 1, max_attempts: 3,
      credits_transaction_id: null, created_by: "10000000-0000-4000-8000-000000000001",
      created_at: "now", updated_at: "now", started_at: "now", completed_at: "now",
      failed_at: null, canceled_at: null,
    };
    const rows: Record<string, Record<string, unknown> | null> = {
      background_jobs: job,
      design_documents: { workspace_id: workspaceId, deleted_at: null },
      design_nodes: nodeLinked ? { design_id: designId, canvas_id: "canvas-1",
        workspace_id: workspaceId, deleted_at: null } : null,
    };
    const from = vi.fn((table: string) => {
      const query: any = { select: vi.fn(() => query), eq: vi.fn(() => query),
        contains: vi.fn(() => query), is: vi.fn(() => query),
        maybeSingle: vi.fn(async () => ({ data: rows[table] ?? null, error: null })) };
      return query;
    });
    return createJobService({ createUserClient: () => ({ from }) as never,
      getAdminClient: vi.fn() as never, pgmq: {} as never });
  }

  function serviceWithReplay(storedPrompt: string) {
    const existing = {
      id: "10000000-0000-4000-8000-000000000007", workspace_id: workspaceId,
      project_id: "project-1", canvas_id: null, target_kind: "design", design_id: designId,
      session_id: sessionId, thread_id: null, queue_name: "image_generation_jobs",
      job_type: "image_generation", status: "queued",
      payload: { prompt: storedPrompt, target, mastra_submission_key: submissionKey,
        mastra_origin_run_id: runId, mastra_credits_cost: 0 }, result: null,
      error_code: null, error_message: null, attempt_count: 0, max_attempts: 3,
      credits_transaction_id: null, created_by: "10000000-0000-4000-8000-000000000001",
      created_at: "now", updated_at: "now",
      started_at: null, completed_at: null, failed_at: null, canceled_at: null,
    };
    const replayQuery: any = { select: vi.fn(() => replayQuery), eq: vi.fn(() => replayQuery),
      contains: vi.fn(() => replayQuery), maybeSingle: vi.fn(async () => ({ data: existing, error: null })) };
    const designQuery: any = { select: vi.fn(() => designQuery), eq: vi.fn(() => designQuery),
      maybeSingle: vi.fn(async () => ({ data: { workspace_id: workspaceId,
        project_id: "project-1", deleted_at: null }, error: null })) };
    const insert = vi.fn();
    const service = createJobService({
      createUserClient: () => ({ from: vi.fn(() => ({ ...replayQuery, insert })) }) as never,
      getAdminClient: () => ({ from: vi.fn(() => designQuery) }) as never,
      pgmq: { send: vi.fn() } as never,
    });
    return { service, insert };
  }

  it("replays the same server-bound design request without another insert", async () => {
    const { service, insert } = serviceWithReplay("new logo");
    await expect(service.createJobWithReplay(user, {
      workspaceId, sessionId, target, jobType: "image_generation", payload: { prompt: "new logo" },
      deferEnqueue: true, providerBilling: { creditsCost: 0, pricingVersion: "credits-v1", unit: "image" },
      mastraSubmission: { runId, key: submissionKey },
    })).resolves.toMatchObject({ replayed: true, job: { design_id: designId } });
    expect(insert).not.toHaveBeenCalled();
  });

  it("fails closed when a submission key resolves to different persisted input", async () => {
    const { service, insert } = serviceWithReplay("different prompt");
    await expect(service.createJobWithReplay(user, {
      workspaceId, sessionId, target, jobType: "image_generation", payload: { prompt: "new logo" },
      deferEnqueue: true, providerBilling: { creditsCost: 0, pricingVersion: "credits-v1", unit: "image" },
      mastraSubmission: { runId, key: submissionKey },
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(insert).not.toHaveBeenCalled();
  });

  it("reads a prior design job through the current canvas link without rechecking old revision", async () => {
    await expect(lookupService().findMastraImageSubmission(user, {
      workspaceId, sessionId, canvasId: "canvas-1", runId, submissionKey, designId,
    })).resolves.toMatchObject({ id: "10000000-0000-4000-8000-000000000007", design_id: designId });
  });

  it("denies a prior design job no longer linked to the current canvas", async () => {
    await expect(lookupService(false).findMastraImageSubmission(user, {
      workspaceId, sessionId, canvasId: "canvas-1", runId, submissionKey, designId,
    })).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("JobService Mastra run scope", () => {
  const user = { id: "10000000-0000-4000-8000-000000000001", accessToken: "token" } as never;
  const runId = "10000000-0000-4000-8000-000000000002";
  const sessionId = "10000000-0000-4000-8000-000000000003";
  const requestMessageId = "10000000-0000-4000-8000-000000000004";

  it("uses the server client to bind an active run to its owner and session", async () => {
    const { query, calls } = createAdminQuery({ data: { request_message_id: requestMessageId }, error: null });
    const service = createService(query);
    await expect(service.assertMastraImageRun(user, { runId, sessionId }))
      .resolves.toEqual({ requestMessageId });
    expect(calls).toContainEqual(["select", "request_message_id"]);
    expect(calls).toContainEqual(["eq:id", runId]);
    expect(calls).toContainEqual(["eq:session_id", sessionId]);
    expect(calls).toContainEqual(["eq:created_by", "10000000-0000-4000-8000-000000000001"]);
    expect(calls).toContainEqual(["in:status", ["accepted", "running"]]);
  });

  it("fails closed when the bound active run is unavailable", async () => {
    const { query } = createAdminQuery({ data: null, error: null });
    const service = createService(query);
    await expect(service.assertMastraImageRun(user, { runId, sessionId }))
      .rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("JobService canvas outpaint replay", () => {
  it("reuses the matching placeholder job and binds the lookup to outpaint", async () => {
    const user = {
      id: "81000000-0000-4000-8000-000000000001",
      accessToken: "token",
    } as never;
    const workspaceId = "81000000-0000-4000-8000-000000000002";
    const projectId = "81000000-0000-4000-8000-000000000003";
    const canvasId = "81000000-0000-4000-8000-000000000004";
    const jobId = "81000000-0000-4000-8000-000000000005";
    const target = {
      kind: "canvas" as const,
      canvas_id: canvasId,
      element_id: "outpaint-placeholder-1",
    };
    const payload = {
      prompt: "Continue the horizon",
      operation: "outpaint" as const,
      input_images: ["data:image/png;base64,aW1hZ2U="],
      outpaint_margins: { top: 0, right: 120, bottom: 40, left: 0 },
      target,
    };
    const existing = {
      id: jobId,
      workspace_id: workspaceId,
      project_id: projectId,
      canvas_id: canvasId,
      target_kind: "canvas",
      design_id: null,
      session_id: null,
      thread_id: null,
      queue_name: "image_generation_jobs",
      job_type: "image_generation",
      status: "queued",
      payload,
      result: null,
      error_code: null,
      error_message: null,
      attempt_count: 0,
      max_attempts: 3,
      credits_transaction_id: null,
      created_by: "81000000-0000-4000-8000-000000000001",
      created_at: "2026-09-14T00:00:00.000Z",
      updated_at: "2026-09-14T00:00:00.000Z",
      started_at: null,
      completed_at: null,
      failed_at: null,
      canceled_at: null,
    };
    const replayQuery: any = {
      select: vi.fn(() => replayQuery),
      eq: vi.fn(() => replayQuery),
      contains: vi.fn(() => replayQuery),
      maybeSingle: vi.fn(async () => ({ data: existing, error: null })),
    };
    const insert = vi.fn();
    const canvasQuery: any = {
      select: vi.fn(() => canvasQuery),
      eq: vi.fn(() => canvasQuery),
      maybeSingle: vi.fn(async () => ({
        data: { workspace_id: workspaceId, project_id: projectId },
        error: null,
      })),
    };
    const service = createJobService({
      createUserClient: () =>
        ({ from: vi.fn(() => ({ ...replayQuery, insert })) }) as never,
      getAdminClient: () => ({ from: vi.fn(() => canvasQuery) }) as never,
      pgmq: { send: vi.fn() } as never,
    });

    await expect(
      service.createJobWithReplay(user, {
        workspaceId,
        target,
        jobType: "image_generation",
        payload: {
          prompt: payload.prompt,
          operation: payload.operation,
          input_images: payload.input_images,
          outpaint_margins: payload.outpaint_margins,
        },
        deferEnqueue: true,
      }),
    ).resolves.toMatchObject({ replayed: true, job: { id: jobId } });
    expect(replayQuery.contains).toHaveBeenCalledWith("payload", {
      operation: "outpaint",
      target: { element_id: "outpaint-placeholder-1" },
    });
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("JobService Mastra design target scope", () => {
  const user = { id: "10000000-0000-4000-8000-000000000001", accessToken: "token" } as never;
  const workspaceId = "10000000-0000-4000-8000-000000000002";
  const canvasId = "10000000-0000-4000-8000-000000000003";
  const designId = "10000000-0000-4000-8000-000000000004";
  const commandId = "10000000-0000-5000-8000-000000000005";

  function serviceFor(rows: Record<string, Record<string, unknown> | null>) {
    const from = vi.fn((table: string) => {
      const filters: Array<[string, unknown]> = [];
      const query: any = {
        select: vi.fn(() => query),
        eq: vi.fn((column: string, value: unknown) => { filters.push([column, value]); return query; }),
        is: vi.fn((column: string, value: unknown) => { filters.push([column, value]); return query; }),
        maybeSingle: vi.fn(async () => {
          const row = rows[table] ?? null;
          return { data: row && filters.every(([column, value]) => row[column] === value) ? row : null, error: null };
        }),
      };
      return query;
    });
    return createJobService({ createUserClient: () => ({ from }) as never,
      getAdminClient: vi.fn() as never, pgmq: {} as never });
  }

  const target = { kind: "design" as const, design_id: designId, expected_revision: 7,
    idempotency_key: commandId, placement: { x: 10, y: 20, role: "background" as const } };

  it("accepts only a live design node on the current canvas at the exact revision", async () => {
    const service = serviceFor({
      design_documents: { id: designId, workspace_id: workspaceId, project_id: "project", revision: 7, deleted_at: null },
      design_nodes: { design_id: designId, canvas_id: canvasId, workspace_id: workspaceId, deleted_at: null },
    });
    await expect(service.assertMastraDesignImageTarget(user, { workspaceId, canvasId, target }))
      .resolves.toEqual(target);
  });

  it("rejects a stale design revision before job creation", async () => {
    const service = serviceFor({
      design_documents: { id: designId, workspace_id: workspaceId, project_id: "project", revision: 8, deleted_at: null },
      design_nodes: { design_id: designId, canvas_id: canvasId, workspace_id: workspaceId, deleted_at: null },
    });
    await expect(service.assertMastraDesignImageTarget(user, { workspaceId, canvasId, target }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects a design that is not linked to the current canvas", async () => {
    const service = serviceFor({
      design_documents: { id: designId, workspace_id: workspaceId, project_id: "project", revision: 7, deleted_at: null },
      design_nodes: null,
    });
    await expect(service.assertMastraDesignImageTarget(user, { workspaceId, canvasId, target }))
      .rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("JobService deferred enqueue", () => {
  it("resolves repeated design replacements and normalizes an object id supplied as the asset id", async () => {
    const designId = "10000000-0000-4000-8000-000000000021";
    const objectId = "10000000-0000-4000-8000-000000000022";
    const assetId = "10000000-0000-4000-8000-000000000023";
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({
        data: {
          workspace_id: "team-workspace",
          project_id: "team-project",
          revision: 4,
          deleted_at: null,
          scene: {
            schemaVersion: 1,
            engine: "fabric",
            canvas: { width: 100, height: 100, background: null },
            objects: [
              {
                objectId,
                objectVersion: 3,
                type: "image",
                x: 5,
                y: 6,
                width: 50,
                height: 40,
                rotation: 0,
                opacity: 1,
                zIndex: 0,
                locked: false,
                visible: true,
                assetObjectId: assetId,
                fit: "cover",
              },
            ],
          },
        },
        error: null,
      })),
    };
    const service = createJobService({
      createUserClient: () => ({ from: vi.fn(() => query) }) as never,
      getAdminClient: vi.fn() as never,
      pgmq: {} as never,
    });
    for (const [idempotencyKey, suppliedAssetId] of [
      ["10000000-0000-4000-8000-000000000024", assetId],
      ["10000000-0000-4000-8000-000000000025", objectId],
    ] as const) {
      await expect(service.resolveDesignOperationTarget(
        { id: "user-1", accessToken: "token" } as never,
        { kind: "design", design_id: designId, expected_revision: 4,
          idempotency_key: idempotencyKey, source_object_id: objectId,
          expected_object_version: 3, source_asset_object_id: suppliedAssetId,
          placement: { x: 5, y: 6, replace_object_id: objectId } },
      )).resolves.toMatchObject({ workspaceId: "team-workspace", projectId: "team-project",
        target: { source_object_id: objectId, expected_object_version: 3,
          source_asset_object_id: assetId, placement: { replace_object_id: objectId } } });
    }

    await expect(service.resolveDesignOperationTarget(
      { id: "user-1", accessToken: "token" } as never,
      { kind: "design", design_id: designId, expected_revision: 4,
        idempotency_key: "10000000-0000-4000-8000-000000000026",
        source_object_id: objectId,
        source_asset_object_id: "10000000-0000-4000-8000-000000000099",
        placement: { x: 5, y: 6, replace_object_id: objectId } },
    )).rejects.toMatchObject({ statusCode: 409 });
  });

  it("does not resolve a design operation hidden by workspace RLS", async () => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    };
    const service = createJobService({
      createUserClient: () => ({ from: vi.fn(() => query) }) as never,
      getAdminClient: vi.fn() as never,
      pgmq: {} as never,
    });
    await expect(
      service.resolveDesignOperationTarget(
        { id: "user-1", accessToken: "token" } as never,
        {
          kind: "design",
          design_id: "10000000-0000-4000-8000-000000000025",
          expected_revision: 1,
          idempotency_key: "10000000-0000-4000-8000-000000000026",
          placement: {
            x: 0,
            y: 0,
            replace_object_id: "10000000-0000-4000-8000-000000000027",
          },
        },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("replays one design image job before billing or queue publication", async () => {
    const designId = "10000000-0000-4000-8000-000000000010";
    const requestId = "10000000-0000-4000-8000-000000000011";
    const target = {
      kind: "design" as const,
      design_id: designId,
      expected_revision: 3,
      idempotency_key: requestId,
      placement: { x: 10, y: 20 },
    };
    const payload = { prompt: "logo", target };
    const existing = {
      id: "10000000-0000-4000-8000-000000000012",
      workspace_id: "workspace-1",
      project_id: "project-1",
      canvas_id: null,
      target_kind: "design",
      design_id: designId,
      session_id: null,
      thread_id: null,
      queue_name: "image_generation_jobs",
      job_type: "image_generation",
      status: "queued",
      payload,
      result: null,
      error_code: null,
      error_message: null,
      attempt_count: 0,
      max_attempts: 3,
      credits_transaction_id: "10000000-0000-4000-8000-000000000013",
      created_by: "user-1",
      created_at: "now",
      updated_at: "now",
      started_at: null,
      completed_at: null,
      failed_at: null,
      canceled_at: null,
    };
    const replayQuery = {
      select: vi.fn(() => replayQuery),
      eq: vi.fn(() => replayQuery),
      contains: vi.fn(() => replayQuery),
      maybeSingle: vi.fn(async () => ({ data: existing, error: null })),
    };
    const insert = vi.fn();
    const designQuery = {
      select: vi.fn(() => designQuery),
      eq: vi.fn(() => designQuery),
      maybeSingle: vi.fn(async () => ({
        data: { workspace_id: "workspace-1", project_id: "project-1" },
        error: null,
      })),
    };
    const send = vi.fn();
    const service = createJobService({
      createUserClient: () =>
        ({
          from: vi.fn(() => ({ ...replayQuery, insert })),
        }) as never,
      getAdminClient: () => ({ from: vi.fn(() => designQuery) }) as never,
      pgmq: { send } as never,
    });

    await expect(
      service.createJobWithReplay(
        { id: "user-1", accessToken: "token" } as never,
        {
          workspaceId: "workspace-1",
          target,
          jobType: "image_generation",
          payload: { prompt: "logo" },
          deferEnqueue: true,
        },
      ),
    ).resolves.toMatchObject({
      replayed: true,
      billingCommitted: true,
      job: { id: existing.id },
    });
    expect(insert).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not publish a deferred job until enqueueJob is called", async () => {
    const canvasId = "10000000-0000-4000-8000-000000000001";
    const projectId = "20000000-0000-4000-8000-000000000001";
    const send = vi.fn(async () => 1);
    const job = {
      id: "job-1",
      workspace_id: "workspace-1",
      project_id: projectId,
      canvas_id: canvasId,
      target_kind: "canvas",
      design_id: null,
      session_id: "session-1",
      thread_id: null,
      queue_name: "image_generation_jobs",
      job_type: "image_generation",
      status: "queued",
      payload: {
        prompt: "Create a test image",
        target: { kind: "canvas", canvas_id: canvasId },
      },
      result: null,
      error_code: null,
      error_message: null,
      attempt_count: 0,
      max_attempts: 3,
      created_by: "user-1",
      created_at: "now",
      updated_at: "now",
      started_at: null,
      completed_at: null,
      failed_at: null,
      canceled_at: null,
    };
    const insertChain = {
      select: vi.fn(() => ({
        single: vi.fn(async () => ({ data: job, error: null })),
      })),
    };
    const selectChain = {
      eq: vi.fn(() => selectChain),
      maybeSingle: vi.fn(async () => ({ data: job, error: null })),
    };
    const table = {
      insert: vi.fn(() => insertChain),
      select: vi.fn(() => selectChain),
    };
    const targetQuery = {
      select: vi.fn(() => targetQuery),
      eq: vi.fn(() => targetQuery),
      maybeSingle: vi.fn(async () => ({
        data: { workspace_id: "workspace-1", project_id: projectId },
        error: null,
      })),
    };
    const service = createJobService({
      createUserClient: () => ({ from: vi.fn(() => table) }) as never,
      getAdminClient: () => ({ from: vi.fn(() => targetQuery) }) as never,
      pgmq: { send } as never,
    });
    const user = { id: "user-1", accessToken: "token" } as never;

    await service.createJob(user, {
      workspaceId: "workspace-1",
      canvasId,
      sessionId: "session-1",
      jobType: "image_generation",
      payload: { prompt: "Create a test image" },
      deferEnqueue: true,
    });
    expect(send).not.toHaveBeenCalled();

    await service.enqueueJob(user, "job-1");
    expect(send).toHaveBeenCalledWith("image_generation_jobs", {
      job_id: "job-1",
      job_type: "image_generation",
      workspace_id: "workspace-1",
      target_kind: "canvas",
      canvas_id: canvasId,
      session_id: "session-1",
    });
  });
});

describe("JobService workspace provider snapshots", () => {
  const workspaceModel = "workspace:10000000-0000-4000-8000-000000000001";

  function setup(options?: {
    snapshotError?: Error;
    enqueueError?: Error;
  }) {
    const job = {
      id: "job-1",
      workspace_id: "workspace-1",
      project_id: null,
      canvas_id: null,
      session_id: null,
      thread_id: null,
      queue_name: "image_generation_jobs",
      job_type: "image_generation" as const,
      status: "queued" as const,
      payload: {
        model: workspaceModel,
        prompt: "Create a test image",
        target: null,
      },
      result: null,
      error_code: null,
      error_message: null,
      attempt_count: 0,
      max_attempts: 3,
      created_by: "user-1",
      created_at: "now",
      updated_at: "now",
      started_at: null,
      completed_at: null,
      failed_at: null,
      canceled_at: null,
    };
    const deleteEq = vi.fn(async () => ({ data: null, error: null }));
    const table = {
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(async () => ({ data: job, error: null })),
        })),
      })),
      delete: vi.fn(() => ({ eq: deleteEq })),
    };
    const createJobSnapshot = options?.snapshotError
      ? vi.fn(async () => {
          throw options.snapshotError;
        })
      : vi.fn(async () => "snapshot-1");
    const send = options?.enqueueError
      ? vi.fn(async () => {
          throw options.enqueueError;
        })
      : vi.fn(async () => 1);
    const service = createJobService({
      createUserClient: () => ({ from: vi.fn(() => table) }) as never,
      getAdminClient: vi.fn() as never,
      pgmq: { send } as never,
      providerSnapshotService: { createJobSnapshot } as never,
    });
    return { createJobSnapshot, deleteEq, send, service };
  }

  it("creates the snapshot before returning a deferred workspace job", async () => {
    const { createJobSnapshot, send, service } = setup();

    await service.createJob({ id: "user-1", accessToken: "token" } as never, {
      workspaceId: "workspace-1",
      jobType: "image_generation",
      payload: { model: workspaceModel, prompt: "Create a test image" },
      deferEnqueue: true,
    });

    expect(createJobSnapshot).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      jobId: "job-1",
      modelRef: workspaceModel,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("creates the snapshot before immediate enqueue", async () => {
    const { createJobSnapshot, send, service } = setup();

    await service.createJob({ id: "user-1", accessToken: "token" } as never, {
      workspaceId: "workspace-1",
      jobType: "image_generation",
      payload: { model: workspaceModel, prompt: "Create a test image" },
    });

    expect(createJobSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      send.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("deletes the job and returns a stable error when snapshot creation fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deleteEq, send, service } = setup({
      snapshotError: new Error("database internals"),
    });

    await expect(
      service.createJob({ id: "user-1", accessToken: "token" } as never, {
        workspaceId: "workspace-1",
        jobType: "image_generation",
        payload: { model: workspaceModel, prompt: "Create a test image" },
      }),
    ).rejects.toMatchObject({
      code: "job_create_failed",
      message: "Failed to create job record.",
    });
    expect(deleteEq).toHaveBeenCalledWith("id", "job-1");
    expect(send).not.toHaveBeenCalled();
  });

  it("deletes the bound job when enqueue fails so snapshot cleanup cascades", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { createJobSnapshot, deleteEq, service } = setup({
      enqueueError: new Error("queue down"),
    });

    await expect(
      service.createJob({ id: "user-1", accessToken: "token" } as never, {
        workspaceId: "workspace-1",
        jobType: "image_generation",
        payload: { model: workspaceModel, prompt: "Create a test image" },
      }),
    ).rejects.toMatchObject({ code: "job_create_failed" });
    expect(createJobSnapshot).toHaveBeenCalledTimes(1);
    expect(deleteEq).toHaveBeenCalledWith("id", "job-1");
  });

  it("does not snapshot legacy environment models", async () => {
    const { createJobSnapshot, service } = setup();

    await service.createJob({ id: "user-1", accessToken: "token" } as never, {
      workspaceId: "workspace-1",
      jobType: "image_generation",
      payload: { model: "gpt-image-2", prompt: "Create a test image" },
      deferEnqueue: true,
    });

    expect(createJobSnapshot).not.toHaveBeenCalled();
  });
});

describe("JobService image commit snapshot recovery", () => {
  const workspaceModel = "workspace:10000000-0000-4000-8000-000000000041";
  const mattingModel = "workspace:10000000-0000-4000-8000-000000000042";

  function setupCommit(input: {
    foregroundPolicy?: Record<string, unknown>;
    approvedCost?: number;
  }) {
    const job = {
      id: "job-commit-1",
      workspace_id: "workspace-1",
      project_id: "project-1",
      canvas_id: null,
      target_kind: "design",
      design_id: "design-1",
      session_id: "session-1",
      thread_id: null,
      queue_name: "image_generation_jobs",
      job_type: "image_generation",
      status: "queued",
      payload: {
        model: workspaceModel,
        prompt: "Create a foreground image",
        ...(input.foregroundPolicy
          ? { foreground_policy: input.foregroundPolicy }
          : {}),
      },
      result: null,
      error_code: null,
      error_message: null,
      attempt_count: 0,
      max_attempts: 3,
      created_by: "user-1",
      created_at: "2026-09-09T00:00:00.000Z",
      updated_at: "2026-09-09T00:00:00.000Z",
      started_at: null,
      completed_at: null,
      failed_at: null,
      canceled_at: null,
    };
    const userQuery = {
      select: vi.fn(() => userQuery),
      eq: vi.fn(() => userQuery),
      maybeSingle: vi.fn(async () => ({ data: job, error: null })),
    };
    const proposalQuery = {
      select: vi.fn(() => proposalQuery),
      eq: vi.fn(() => proposalQuery),
      maybeSingle: vi.fn(async () => ({
        data:
          input.approvedCost === undefined
            ? null
            : { approved_cost: input.approvedCost },
        error: null,
      })),
    };
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const createJobSnapshot = vi.fn(async () => "primary-snapshot");
    const createForegroundSnapshot = vi.fn(async () => "helper-snapshot");
    const service = createJobService({
      createUserClient: () => ({ from: vi.fn(() => userQuery) }) as never,
      getAdminClient: () => ({
        from: vi.fn(() => proposalQuery),
        rpc,
      }) as never,
      pgmq: {} as never,
      providerSnapshotService: {
        createJobSnapshot,
        createForegroundSnapshot,
      } as never,
    });
    return { service, createJobSnapshot, createForegroundSnapshot, rpc };
  }

  it("ensures both quoted stages before atomically committing a recovered foreground job", async () => {
    const foregroundPolicy = {
      version: 1,
      mode: "api_matting",
      generationModel: workspaceModel,
      mattingModel,
      generationCredits: 7,
      mattingCredits: 20,
      totalCredits: 27,
      pricingVersion: "credits-v1",
    };
    const { service, createJobSnapshot, createForegroundSnapshot, rpc } =
      setupCommit({ foregroundPolicy });

    await service.commitImageJob(
      { id: "user-1", accessToken: "token" } as never,
      "job-commit-1",
    );

    expect(createJobSnapshot).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      jobId: "job-commit-1",
      modelRef: workspaceModel,
      billing: {
        creditsCost: 7,
        pricingVersion: "credits-v1",
        unit: "image",
      },
    });
    expect(createForegroundSnapshot).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      jobId: "job-commit-1",
    });
    expect(createJobSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      createForegroundSnapshot.mock.invocationCallOrder[0]!,
    );
    expect(createForegroundSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      rpc.mock.invocationCallOrder[0]!,
    );
  });

  it("recovers an ordinary workspace job with its confirmed proposal price", async () => {
    const { service, createJobSnapshot, createForegroundSnapshot, rpc } =
      setupCommit({ approvedCost: 9 });

    await service.commitImageJob(
      { id: "user-1", accessToken: "token" } as never,
      "job-commit-1",
    );

    expect(createJobSnapshot).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      jobId: "job-commit-1",
      modelRef: workspaceModel,
      billing: {
        creditsCost: 9,
        pricingVersion: "credits-v1",
        unit: "image",
      },
    });
    expect(createForegroundSnapshot).not.toHaveBeenCalled();
    expect(createJobSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      rpc.mock.invocationCallOrder[0]!,
    );
  });
});
