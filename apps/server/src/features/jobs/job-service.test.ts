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

describe("JobService deferred enqueue", () => {
  it("resolves a design operation from the authorized design workspace", async () => {
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
    await expect(
      service.resolveDesignOperationTarget(
        { id: "user-1", accessToken: "token" } as never,
        {
          kind: "design",
          design_id: designId,
          expected_revision: 4,
          idempotency_key: "10000000-0000-4000-8000-000000000024",
          placement: { x: 5, y: 6, replace_object_id: objectId },
        },
      ),
    ).resolves.toMatchObject({
      workspaceId: "team-workspace",
      projectId: "team-project",
      target: {
        source_object_id: objectId,
        expected_object_version: 3,
        source_asset_object_id: assetId,
      },
    });
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
