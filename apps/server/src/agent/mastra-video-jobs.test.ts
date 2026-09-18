import { describe, expect, it, vi } from "vitest";

import { insertVideoElement } from "../features/canvas/canvas-element-writer.js";
import type { JobService } from "../features/jobs/job-service.js";
import { createMastraVideoJobSubmitter, mastraVideoSubmissionKey,
  type MastraVideoJobContext, type MastraVideoJobDependencies } from "./mastra-video-jobs.js";

vi.mock("../features/canvas/canvas-element-writer.js", () => ({
  insertVideoElement: vi.fn(async () => ({ elementId: "video-element", inserted: true })),
}));

const ids = {
  user: "10000000-0000-4000-8000-000000000001",
  workspace: "10000000-0000-4000-8000-000000000002",
  session: "10000000-0000-4000-8000-000000000003",
  canvas: "10000000-0000-4000-8000-000000000004",
  run: "10000000-0000-4000-8000-000000000005",
  message: "10000000-0000-4000-8000-000000000006",
  job: "10000000-0000-4000-8000-000000000007",
};

function context(signal = new AbortController().signal): MastraVideoJobContext {
  return { userId: ids.user, accessToken: "token", workspaceId: ids.workspace,
    sessionId: ids.session, canvasId: ids.canvas, runId: ids.run, signal };
}

function videoInput() {
  return { title: "Launch", prompt: "A camera orbit around the product",
    model: "workspace:video", duration: 8, resolution: "720p" as const,
    aspectRatio: "16:9" };
}

function userClient(valid = true) {
  const rows: Record<string, Record<string, unknown> | null> = {
    chat_sessions: { id: ids.session, canvas_id: ids.canvas },
    canvases: valid ? { id: ids.canvas, workspace_id: ids.workspace } : null,
    workspace_members: { workspace_id: ids.workspace, user_id: ids.user, role: "owner" },
    chat_messages: { id: ids.message, session_id: ids.session, role: "user" },
  };
  return { from: vi.fn((table: string) => {
    const query: any = { select: vi.fn(() => query), eq: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: rows[table] ?? null, error: null })) };
    return query;
  }) };
}

function queuedJob() {
  return { id: ids.job, workspace_id: ids.workspace, project_id: "project",
    canvas_id: ids.canvas, target_kind: "canvas", design_id: null, session_id: ids.session,
    thread_id: null, queue_name: "video_generation_jobs", job_type: "video_generation",
    status: "queued", payload: { video_credits_cost: 12,
      video_submission_key: mastraVideoSubmissionKey(ids.run, videoInput()),
      video_submission_kind: "mastra", video_origin_run_id: ids.run },
    result: null, error_code: null, error_message: null,
    attempt_count: 0, max_attempts: 3, created_by: ids.user, created_at: "now",
    updated_at: "now", started_at: null, completed_at: null, failed_at: null,
    canceled_at: null } as const;
}

function dependencies(overrides: Partial<MastraVideoJobDependencies> = {}) {
  const createJobWithReplay = vi.fn(async () => ({ job: queuedJob(), replayed: false,
    billingCommitted: false }));
  const findVideoSubmission = vi.fn(async () => null);
  const commitVideoJob = vi.fn(async () => undefined);
  const cancelUncommittedVideoJob = vi.fn(async () => true);
  const getJob = vi.fn(async () => ({ ...queuedJob(), status: "succeeded" as const,
    result: { asset_id: "asset", signed_url: "https://signed.invalid/video.mp4",
      width: 1280, height: 720, duration_seconds: 8, mime_type: "video/mp4" } }));
  const deps: MastraVideoJobDependencies = {
    createUserClient: () => userClient(),
    jobService: { assertMastraImageRun: vi.fn(async () => ({ requestMessageId: ids.message })),
      createJobWithReplay, findVideoSubmission, commitVideoJob,
      cancelUncommittedVideoJob, getJob } as unknown as JobService,
    workspaceModelCatalogService: { resolvePublishedModel: vi.fn(async () => ({
      upstreamModelId: "veo-3.1-fast-generate-preview", catalogKey: "video",
      providerConfigId: "provider", revision: 1, capabilities: ["video_generation"],
    })) } as never,
    creditService: { getSubscription: vi.fn(async () => ({ plan: "pro" })),
      getBalance: vi.fn(async () => ({ balance: 100, plan: "pro", dailyClaimed: false })) } as never,
    tierGuard: { checkModelAccess: vi.fn(), checkVideoResolution: vi.fn(),
      checkConcurrency: vi.fn(async () => undefined), calculateCreditCost: vi.fn(() => 12) } as never,
    sleep: vi.fn(async () => undefined),
    ...overrides,
  };
  return { deps, createJobWithReplay, findVideoSubmission, commitVideoJob,
    cancelUncommittedVideoJob, getJob };
}

describe("Mastra video job submitter", () => {
  it("derives one canonical in-run submission key", () => {
    expect(mastraVideoSubmissionKey(ids.run, videoInput())).toBe(mastraVideoSubmissionKey(ids.run, {
      resolution: "720p", duration: 8, model: "workspace:video", prompt: videoInput().prompt,
      title: "Launch", aspectRatio: "16:9",
    }));
  });

  it("uses the current workspace catalog, bills upstream, polls and inserts into Canvas", async () => {
    vi.mocked(insertVideoElement).mockClear();
    const { deps, createJobWithReplay, commitVideoJob } = dependencies();
    const pushToCanvas = vi.fn();
    deps.connectionManager = { pushToCanvas } as never;
    const result = await createMastraVideoJobSubmitter(deps).submit(context(), videoInput());
    expect(result).toMatchObject({ status: "succeeded", jobId: ids.job,
      elementId: "video-element", videoUrl: "https://signed.invalid/video.mp4" });
    expect(createJobWithReplay).toHaveBeenCalledWith(expect.objectContaining({ id: ids.user }),
      expect.objectContaining({ workspaceId: ids.workspace, canvasId: ids.canvas,
        sessionId: ids.session, jobType: "video_generation", deferEnqueue: true,
        videoSubmission: expect.objectContaining({ kind: "mastra", runId: ids.run }),
        payload: expect.objectContaining({ model: "workspace:video" }) }));
    expect(commitVideoJob).toHaveBeenCalledWith(expect.objectContaining({ id: ids.user }),
      expect.objectContaining({ jobId: ids.job, creditsCost: 12, runId: ids.run }));
    expect(insertVideoElement).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      canvasId: ids.canvas, sourceJobId: ids.job, assetId: "asset",
    }), undefined);
    expect(pushToCanvas).toHaveBeenCalledOnce();
  });

  it("fails before job creation when the authenticated run scope is invalid", async () => {
    const { deps, createJobWithReplay } = dependencies({ createUserClient: () => userClient(false) });
    await expect(createMastraVideoJobSubmitter(deps).submit(context(), videoInput()))
      .rejects.toThrow("mastra_video_run_scope_forbidden");
    expect(createJobWithReplay).not.toHaveBeenCalled();
  });

  it("never accepts an environment or unpublished model", async () => {
    const first = dependencies();
    await expect(createMastraVideoJobSubmitter(first.deps).submit(context(), {
      ...videoInput(), model: "veo-3.1-fast-generate-preview",
    })).rejects.toThrow("mastra_video_workspace_model_required");
    expect(first.createJobWithReplay).not.toHaveBeenCalled();
    const second = dependencies({ workspaceModelCatalogService: {
      resolvePublishedModel: vi.fn(async () => null),
    } as never });
    await expect(createMastraVideoJobSubmitter(second.deps).submit(context(), videoInput()))
      .rejects.toThrow("mastra_video_model_unavailable");
    expect(second.createJobWithReplay).not.toHaveBeenCalled();
  });

  it("returns processing without unsafe cancellation when the atomic commit outcome is unknown", async () => {
    const { deps, commitVideoJob, cancelUncommittedVideoJob } = dependencies();
    commitVideoJob.mockRejectedValueOnce(Object.assign(new Error("transport unknown"), {
      code: "video_commit_unknown",
    }));
    await expect(createMastraVideoJobSubmitter(deps).submit(context(), videoInput()))
      .resolves.toMatchObject({ status: "processing", jobId: ids.job });
    expect(cancelUncommittedVideoJob).not.toHaveBeenCalled();
  });

  it("returns processing after the bounded foreground poll expires", async () => {
    const { deps, getJob } = dependencies({ maxWaitMs: 0 });
    await expect(createMastraVideoJobSubmitter(deps).submit(context(), videoInput()))
      .resolves.toMatchObject({ status: "processing", jobId: ids.job });
    expect(getJob).not.toHaveBeenCalled();
  });

  it("does not disclose a completed URL after the current user loses RLS access", async () => {
    vi.mocked(insertVideoElement).mockClear();
    const { deps, getJob } = dependencies();
    getJob.mockRejectedValueOnce(new Error("job_not_found"));
    await expect(createMastraVideoJobSubmitter(deps).submit(context(), videoInput()))
      .rejects.toThrow("job_not_found");
    expect(insertVideoElement).not.toHaveBeenCalled();
  });

  it("cancels without charging when the run is aborted after staging", async () => {
    const controller = new AbortController();
    const { deps, createJobWithReplay, cancelUncommittedVideoJob } = dependencies();
    createJobWithReplay.mockImplementationOnce(async () => {
      controller.abort();
      return { job: queuedJob(), replayed: false, billingCommitted: false };
    });
    await expect(createMastraVideoJobSubmitter(deps).submit(context(controller.signal), videoInput()))
      .resolves.toEqual({ jobId: ids.job, error: "Run was canceled" });
    expect(cancelUncommittedVideoJob).toHaveBeenCalledOnce();
  });

  it("replays a durable cross-process submission without repricing or creating another job", async () => {
    const { deps, findVideoSubmission, createJobWithReplay, commitVideoJob } = dependencies({
      maxWaitMs: 0,
    });
    findVideoSubmission.mockResolvedValueOnce({ ...queuedJob(), status: "running" } as never);
    await expect(createMastraVideoJobSubmitter(deps).submit(context(), videoInput()))
      .resolves.toMatchObject({ jobId: ids.job, status: "processing" });
    expect(deps.workspaceModelCatalogService!.resolvePublishedModel).not.toHaveBeenCalled();
    expect(createJobWithReplay).not.toHaveBeenCalled();
    expect(commitVideoJob).not.toHaveBeenCalled();
  });

  it("does not cancel or refund after publication when foreground waiting is aborted", async () => {
    const controller = new AbortController();
    const { deps, cancelUncommittedVideoJob } = dependencies({
      sleep: vi.fn(async () => { controller.abort(); }),
    });
    await expect(createMastraVideoJobSubmitter(deps).submit(context(controller.signal), videoInput()))
      .resolves.toMatchObject({ jobId: ids.job, status: "processing" });
    expect(cancelUncommittedVideoJob).not.toHaveBeenCalled();
  });

  it("shares one submission promise for duplicate calls in the same run", async () => {
    const { deps, createJobWithReplay } = dependencies();
    const submitter = createMastraVideoJobSubmitter(deps);
    const [first, second] = await Promise.all([
      submitter.submit(context(), videoInput()), submitter.submit(context(), videoInput()),
    ]);
    expect(first).toEqual(second);
    expect(createJobWithReplay).toHaveBeenCalledOnce();
  });
});
