import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedUser } from "../supabase/user.js";
import { registerJobRoutes } from "./jobs.js";

const { insertImageElementMock, insertVideoElementMock } = vi.hoisted(() => ({
  insertImageElementMock: vi.fn(),
  insertVideoElementMock: vi.fn(),
}));

vi.mock("../features/canvas/canvas-element-writer.js", () => ({
  insertImageElement: insertImageElementMock,
  insertVideoElement: insertVideoElementMock,
}));

const ids = {
  user: "00000000-0000-4000-8000-000000000001",
  otherUser: "00000000-0000-4000-8000-000000000009",
  workspace: "00000000-0000-4000-8000-000000000002",
  job: "00000000-0000-4000-8000-000000000003",
  canvas: "00000000-0000-4000-8000-000000000004",
};

const user: AuthenticatedUser = {
  id: ids.user,
  accessToken: "token",
  email: "user@example.test",
  userMetadata: {},
};

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.job,
    workspace_id: ids.workspace,
    project_id: null,
    canvas_id: ids.canvas,
    session_id: null,
    thread_id: null,
    queue_name: "image_generation_jobs",
    job_type: "image_generation",
    status: "succeeded",
    payload: { prompt: "生成海报", title: "海报" },
    result: {
      asset_id: "asset-1",
      signed_url: "https://example.com/image.png",
      object_path: "workspace/generated/image.png",
      width: 1024,
      height: 1024,
      mime_type: "image/png",
    },
    error_code: null,
    error_message: null,
    attempt_count: 1,
    max_attempts: 3,
    created_by: ids.user,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    started_at: null,
    completed_at: new Date().toISOString(),
    failed_at: null,
    canceled_at: null,
    ...overrides,
  };
}

async function createApp(job: ReturnType<typeof makeJob>) {
  const app = Fastify();
  const assetId =
    (job.result as Record<string, unknown> | null)?.asset_id ??
    (job.result as Record<string, unknown> | null)?.asset_object_id;
  const objectPath = (job.result as Record<string, unknown> | null)
    ?.object_path;
  const assetQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(async () => ({
      data:
        assetId && objectPath
          ? {
              id: assetId,
              bucket: "project-assets",
              object_path: objectPath,
              deletion_pending_at: null,
            }
          : null,
      error: null,
    })),
  };
  const client = {
    from: vi.fn(() => assetQuery),
    storage: {
      from: vi.fn(() => ({
        createSignedUrl: vi.fn(async () => ({
          data: { signedUrl: "https://signed.example/video.mp4" },
          error: null,
        })),
      })),
    },
  };
  await registerJobRoutes(app, {
    auth: { authenticate: async () => user },
    viewerService: { ensureViewer: vi.fn() } as never,
    jobService: {
      getJob: vi.fn(async () => job),
      getTargetFinalization: vi.fn(async () => null),
    } as never,
    createUserClient: vi.fn(() => client as never),
  });
  return app;
}

describe("POST /api/jobs/:jobId/restore-to-canvas", () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    insertImageElementMock.mockResolvedValue({
      elementId: "image-element",
      inserted: true,
    });
    insertVideoElementMock.mockResolvedValue({
      elementId: "video-element",
      inserted: true,
    });
  });

  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it("refreshes the signed media URL when a completed job is read", async () => {
    const app = await createApp(makeJob());
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: `/api/jobs/${ids.job}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().job.result.signed_url).toBe(
      "https://signed.example/video.mp4",
    );
  });

  it("refreshes an authorized design export asset_object_id URL", async () => {
    const app = await createApp(
      makeJob({
        canvas_id: null,
        target_kind: "design",
        design_id: "00000000-0000-4000-8000-000000000005",
        queue_name: "design_export_jobs",
        job_type: "design_export",
        payload: {
          design_id: "00000000-0000-4000-8000-000000000005",
          revision: 3,
          idempotency_key: "00000000-0000-4000-8000-000000000006",
          requested_by: ids.user,
          format: "png",
          multiplier: 1,
          transparent: true,
        },
        result: {
          asset_object_id: "00000000-0000-4000-8000-000000000007",
          object_path: "workspace/design-exports/export.png",
          design_id: "00000000-0000-4000-8000-000000000005",
          revision: 3,
          format: "png",
          width: 100,
          height: 100,
          byte_size: 100,
          expires_at: "2026-09-11T00:00:00.000Z",
        },
      }),
    );
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/jobs/${ids.job}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().job.result.signed_url).toBe(
      "https://signed.example/video.mp4",
    );
  });

  it("restores an image with the job id as the idempotency source", async () => {
    const app = await createApp(makeJob());
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/jobs/${ids.job}/restore-to-canvas`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      jobId: ids.job,
      canvasId: ids.canvas,
      elementId: "image-element",
      inserted: true,
    });
    expect(insertImageElementMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        canvasId: ids.canvas,
        sourceJobId: ids.job,
        objectPath: "workspace/generated/image.png",
      }),
    );
  });

  it("restores video results and preserves an idempotent duplicate response", async () => {
    insertVideoElementMock
      .mockResolvedValueOnce({ elementId: "video-element", inserted: true })
      .mockResolvedValueOnce({ elementId: "video-element", inserted: false });
    const app = await createApp(
      makeJob({
        job_type: "video_generation",
        queue_name: "video_generation_jobs",
        result: {
          asset_id: "asset-video",
          signed_url: "https://example.com/video.mp4",
          object_path: "workspace/generated/video.mp4",
          width: 1280,
          height: 720,
          duration_seconds: 8,
          mime_type: "video/mp4",
        },
      }),
    );
    apps.push(app);

    const first = await app.inject({
      method: "POST",
      url: `/api/jobs/${ids.job}/restore-to-canvas`,
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/jobs/${ids.job}/restore-to-canvas`,
    });

    expect(first.json().inserted).toBe(true);
    expect(second.json()).toMatchObject({
      elementId: "video-element",
      inserted: false,
    });
    expect(insertVideoElementMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceJobId: ids.job, durationSeconds: 8 }),
    );
  });

  it("does not reveal or restore a job owned by another user", async () => {
    const app = await createApp(makeJob({ created_by: ids.otherUser }));
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/jobs/${ids.job}/restore-to-canvas`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "job_not_found", message: "未找到该生成任务。" },
    });
    expect(insertImageElementMock).not.toHaveBeenCalled();
  });

  it.each([
    ["running", makeJob({ status: "running" }), 409, "job_not_succeeded"],
    ["missing canvas", makeJob({ canvas_id: null }), 422, "job_canvas_missing"],
    [
      "invalid result",
      makeJob({ result: { object_path: "image.png" } }),
      422,
      "job_result_invalid",
    ],
  ])("rejects %s jobs", async (_label, job, status, code) => {
    const app = await createApp(job);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/jobs/${ids.job}/restore-to-canvas`,
    });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
    expect(insertImageElementMock).not.toHaveBeenCalled();
    expect(insertVideoElementMock).not.toHaveBeenCalled();
  });
});
