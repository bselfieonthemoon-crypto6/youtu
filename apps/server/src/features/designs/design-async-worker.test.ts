import { describe, expect, it, vi } from "vitest";

import {
  createDesignExportExecutor,
  createDesignPreviewExecutor,
  createSupabaseDesignPreviewFailureRepository,
  requeueQueuedDesignExportJobs,
  requeueQueuedDesignPreviewJobs,
} from "./design-async-worker.js";

const ids = {
  job: "10000000-0000-4000-8000-000000000001",
  design: "20000000-0000-4000-8000-000000000001",
  workspace: "30000000-0000-4000-8000-000000000001",
  project: "40000000-0000-4000-8000-000000000001",
  user: "50000000-0000-4000-8000-000000000001",
  request: "60000000-0000-4000-8000-000000000001",
  asset: "70000000-0000-4000-8000-000000000001",
} as const;

describe("design async worker ports", () => {
  it("fails explicitly when no preview renderer is installed", async () => {
    const executor = createDesignPreviewExecutor({
      repository: { commit: vi.fn() },
    });

    await expect(
      executor(ids.job, {}, executorContext(previewJob())),
    ).rejects.toMatchObject({ code: "design_renderer_unavailable" });
  });

  it("commits a rendered preview with the durable job id as idempotency key", async () => {
    const commit = vi.fn(async (input) => ({
      design_id: input.designId,
      revision: input.expectedRevision,
      committed: true,
      replayed: false,
    }));
    const executor = createDesignPreviewExecutor({
      repository: { commit },
      renderer: {
        render: vi.fn(async () => ({
          preview_asset_object_id: ids.asset,
        })),
      },
    });

    await expect(
      executor(ids.job, {}, executorContext(previewJob())),
    ).resolves.toMatchObject({
      design_id: ids.design,
      preview_asset_object_id: ids.asset,
      committed: true,
    });
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: ids.job,
        expectedRevision: 7,
        previewRevision: 7,
      }),
    );
  });

  it("validates a replaceable export renderer result", async () => {
    const job = exportJob();
    const executor = createDesignExportExecutor({
      renderer: {
        render: vi.fn(async () => ({
          asset_object_id: ids.asset,
          design_id: ids.design,
          revision: 7,
          format: "png" as const,
          width: 1080,
          height: 1080,
          byte_size: 42,
          expires_at: "2026-09-11T00:00:00.000Z",
        })),
      },
    });

    await expect(executor(ids.job, {}, executorContext(job))).resolves.toEqual(
      expect.objectContaining({ asset_object_id: ids.asset, revision: 7 }),
    );
  });

  it("republishes durable queued preview jobs and tolerates one failed send", async () => {
    const rows = [
      queuedRow(ids.job),
      queuedRow("10000000-0000-4000-8000-000000000002"),
    ];
    const query = listQuery(rows);
    const send = vi
      .fn()
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error("queue unavailable"));

    await expect(
      requeueQueuedDesignPreviewJobs(
        { from: vi.fn(() => query) } as never,
        { send } as never,
        25,
      ),
    ).resolves.toEqual({ checked: 2, published: 1, failed: 1 });
    expect(send).toHaveBeenCalledWith(
      "design_preview_jobs",
      expect.objectContaining({
        job_id: ids.job,
        job_type: "design_preview",
        target_kind: "design",
      }),
    );
    expect(query.limit).toHaveBeenCalledWith(25);
  });

  it("republishes durable queued export jobs", async () => {
    const query = listQuery([
      {
        id: ids.job,
        workspace_id: ids.workspace,
        design_id: ids.design,
        queue_name: "design_export_jobs",
        job_type: "design_export",
        status: "queued",
      },
    ]);
    const send = vi.fn(async () => 1);
    await expect(
      requeueQueuedDesignExportJobs(
        { from: vi.fn(() => query) } as never,
        { send } as never,
      ),
    ).resolves.toEqual({ checked: 1, published: 1, failed: 0 });
    expect(send).toHaveBeenCalledWith(
      "design_export_jobs",
      expect.objectContaining({ job_id: ids.job, job_type: "design_export" }),
    );
  });

  it("persists terminal preview state through the service-only RPC", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        job_id: ids.job,
        design_id: ids.design,
        revision: 7,
        updated: true,
        error_code: "design_renderer_unavailable",
        error_message: "unavailable",
      },
      error: null,
    }));
    const repository = createSupabaseDesignPreviewFailureRepository(
      () => ({ rpc }) as never,
    );

    await expect(
      repository.markError({
        jobId: ids.job,
        errorCode: "design_renderer_unavailable",
        errorMessage: "unavailable",
      }),
    ).resolves.toMatchObject({ updated: true });
    expect(rpc).toHaveBeenCalledWith("loomic_design_preview_mark_error", {
      p_job_id: ids.job,
      p_error_code: "design_renderer_unavailable",
      p_error_message: "unavailable",
    });
  });
});

function previewJob() {
  return job({
    queue_name: "design_preview_jobs",
    job_type: "design_preview",
    payload: {
      design_id: ids.design,
      revision: 7,
      idempotency_key: ids.request,
      requested_by: ids.user,
    },
  });
}

function exportJob() {
  return job({
    queue_name: "design_export_jobs",
    job_type: "design_export",
    payload: {
      design_id: ids.design,
      revision: 7,
      idempotency_key: ids.request,
      requested_by: ids.user,
      format: "png",
      multiplier: 1,
      transparent: true,
    },
  });
}

function job(overrides: Record<string, unknown>) {
  return {
    id: ids.job,
    workspace_id: ids.workspace,
    project_id: ids.project,
    canvas_id: null,
    target_kind: "design",
    design_id: ids.design,
    session_id: null,
    thread_id: null,
    status: "running",
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 1,
    max_attempts: 3,
    created_by: ids.user,
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z",
    started_at: "2026-09-04T00:00:01.000Z",
    completed_at: null,
    failed_at: null,
    canceled_at: null,
    ...overrides,
  };
}

function executorContext(backgroundJob: ReturnType<typeof job>) {
  return {
    jobService: { getJobAdmin: vi.fn(async () => backgroundJob) },
    getAdminClient: vi.fn(),
    renewVt: vi.fn(),
    env: {},
  } as never;
}

function queuedRow(id: string) {
  return {
    id,
    workspace_id: ids.workspace,
    design_id: ids.design,
    queue_name: "design_preview_jobs",
    job_type: "design_preview",
    status: "queued",
  };
}

function listQuery(data: unknown[]) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(async () => ({ data, error: null })),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.order.mockReturnValue(query);
  return query;
}
