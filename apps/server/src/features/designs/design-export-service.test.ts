import { describe, expect, it, vi } from "vitest";

import type { BackgroundJob } from "@loomic/shared";

import type { AuthenticatedUser } from "../../supabase/user.js";
import {
  type DesignExportError,
  DesignExportService,
  assertDesignExportBudget,
} from "./design-export-service.js";

const ids = {
  user: "10000000-0000-4000-8000-000000000001",
  workspace: "20000000-0000-4000-8000-000000000001",
  project: "30000000-0000-4000-8000-000000000001",
  design: "40000000-0000-4000-8000-000000000001",
  request: "50000000-0000-4000-8000-000000000001",
  job: "60000000-0000-4000-8000-000000000001",
};

const user: AuthenticatedUser = {
  id: ids.user,
  email: "member@local.test",
  accessToken: "token",
  userMetadata: {},
};

const request = {
  design_id: ids.design,
  revision: 4,
  idempotency_key: ids.request,
  format: "png" as const,
  multiplier: 1 as const,
  transparent: true,
};

function backgroundJob(
  payload = { ...request, requested_by: ids.user },
): BackgroundJob {
  return {
    id: ids.job,
    workspace_id: ids.workspace,
    project_id: ids.project,
    canvas_id: null,
    target_kind: "design",
    design_id: ids.design,
    session_id: null,
    thread_id: null,
    queue_name: "design_export_jobs",
    job_type: "design_export",
    status: "queued",
    payload,
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 0,
    max_attempts: 3,
    created_by: ids.user,
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
    canceled_at: null,
  };
}

function setup(existing: BackgroundJob | null = null) {
  const get = vi.fn().mockResolvedValue({
    id: ids.design,
    workspace_id: ids.workspace,
    project_id: ids.project,
    revision: 4,
    width: 1080,
    height: 1080,
  });
  const findDesignExportJob = vi.fn().mockResolvedValue(existing);
  const createJob = vi.fn().mockResolvedValue(backgroundJob());
  return {
    createJob,
    findDesignExportJob,
    get,
    service: new DesignExportService({ get } as never, {
      createJob,
      findDesignExportJob,
    }),
  };
}

describe("DesignExportService", () => {
  it("rejects output whose conservative working-set estimate exceeds the worker budget", () => {
    expect(() =>
      assertDesignExportBudget({
        width: 10_000,
        height: 10_000,
        multiplier: 1,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "design_export_unsupported" }),
    );
  });

  it("returns the same durable job for an idempotent replay", async () => {
    const replay = backgroundJob();
    const { createJob, service } = setup(replay);

    await expect(service.enqueue(user, request)).resolves.toEqual(replay);
    expect(createJob).not.toHaveBeenCalled();
  });

  it("rejects reusing an idempotency key with different export options", async () => {
    const replay = backgroundJob({
      ...request,
      requested_by: ids.user,
      transparent: false,
    });
    const { createJob, service } = setup(replay);

    await expect(service.enqueue(user, request)).rejects.toMatchObject({
      code: "design_export_idempotency_conflict",
      statusCode: 409,
    } satisfies Partial<DesignExportError>);
    expect(createJob).not.toHaveBeenCalled();
  });

  it("rejects an exact target frame that exceeds the render budget before creating a job", async () => {
    const { createJob, service } = setup();

    await expect(
      service.enqueue(user, {
        ...request,
        target_size: { width: 40_000, height: 40_000 },
      }),
    ).rejects.toMatchObject({
      code: "design_export_unsupported",
      statusCode: 422,
    } satisfies Partial<DesignExportError>);
    expect(createJob).not.toHaveBeenCalled();
  });

  it("accepts an exact target frame the canvas itself could not reach", async () => {
    const { createJob, service } = setup();

    // The design is 1080x1080; the request asks for 320x70. That is ① a frame
    // the canvas never had, and it is well inside the budget.
    await expect(
      service.enqueue(user, {
        ...request,
        target_size: { width: 320, height: 70 },
      }),
    ).resolves.toMatchObject({ id: ids.job });
    expect(createJob).toHaveBeenCalledWith(
      user,
      expect.objectContaining({
        payload: expect.objectContaining({ target_size: { width: 320, height: 70 } }),
      }),
    );
  });

  it("freezes the current revision and canonical design target", async () => {
    const { createJob, service } = setup();

    await expect(service.enqueue(user, request)).resolves.toMatchObject({
      id: ids.job,
    });
    expect(createJob).toHaveBeenCalledWith(
      user,
      expect.objectContaining({
        workspaceId: ids.workspace,
        projectId: ids.project,
        jobType: "design_export",
        target: {
          kind: "design",
          design_id: ids.design,
          expected_revision: 4,
          idempotency_key: ids.request,
        },
      }),
    );
  });

  it("rejects a stale revision before looking for or creating a job", async () => {
    const { createJob, findDesignExportJob, get, service } = setup();
    get.mockResolvedValueOnce({
      id: ids.design,
      workspace_id: ids.workspace,
      project_id: ids.project,
      revision: 5,
      width: 1080,
      height: 1080,
    });

    await expect(service.enqueue(user, request)).rejects.toMatchObject({
      code: "design_export_revision_conflict",
      statusCode: 409,
    } satisfies Partial<DesignExportError>);
    expect(findDesignExportJob).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });
});
