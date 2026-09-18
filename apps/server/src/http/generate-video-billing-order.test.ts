import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JobServiceError } from "../features/jobs/job-service.js";
import { CreditServiceError } from "../features/credits/credit-service.js";
import type { AuthenticatedUser } from "../supabase/user.js";
import { registerGenerateRoutes } from "./generate.js";

const ids = {
  user: "00000000-0000-4000-8000-000000000001",
  workspace: "00000000-0000-4000-8000-000000000002",
  job: "00000000-0000-4000-8000-000000000003",
};

const user: AuthenticatedUser = {
  id: ids.user, accessToken: "token", email: "user@example.test", userMetadata: {},
};

const completedJob = {
  id: ids.job, workspace_id: ids.workspace, project_id: null, canvas_id: null,
  target_kind: null, design_id: null, session_id: null, thread_id: null,
  queue_name: "video_generation_jobs", job_type: "video_generation", status: "succeeded",
  payload: { prompt: "video", model: "model", duration: 5,
    video_credits_cost: 7, video_submission_kind: "http" },
  result: { signed_url: "https://signed.invalid/video.mp4", asset_id: "asset",
    width: 1280, height: 720, duration_seconds: 5, mime_type: "video/mp4" },
  error_code: null, error_message: null, attempt_count: 1, max_attempts: 3,
  created_by: ids.user, created_at: "now", updated_at: "now", started_at: "now",
  completed_at: "now", failed_at: null, canceled_at: null,
} as const;

function fixture(options: {
  existing?: typeof completedJob | null;
  commitError?: Error;
  cancelResult?: boolean;
} = {}) {
  const order: string[] = [];
  const stagedJob = { ...completedJob, status: "queued" as const, result: null };
  const jobService = {
    findVideoSubmission: vi.fn(async () => { order.push("find"); return options.existing ?? null; }),
    createJobWithReplay: vi.fn(async () => {
      order.push("create");
      return { job: stagedJob, replayed: false, billingCommitted: false };
    }),
    commitVideoJob: vi.fn(async () => {
      order.push("commit");
      if (options.commitError) throw options.commitError;
    }),
    cancelUncommittedVideoJob: vi.fn(async () => {
      order.push("cancel-cas");
      return options.cancelResult ?? true;
    }),
    getJobAdmin: vi.fn(async () => { order.push("poll"); return completedJob; }),
  };
  const creditService = {
    getSubscription: vi.fn(async () => ({ plan: "pro" })),
    deductCredits: vi.fn(), refundCredits: vi.fn(),
  };
  const tierGuard = {
    checkModelAccess: vi.fn(), checkVideoResolution: vi.fn(), checkConcurrency: vi.fn(),
    calculateCreditCost: vi.fn(() => 7),
  };
  return { order, jobService, creditService, tierGuard };
}

describe("direct durable video submission", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  async function register(deps: ReturnType<typeof fixture>) {
    const app = Fastify();
    apps.push(app);
    await registerGenerateRoutes(app, {
      auth: { authenticate: async () => user },
      viewerService: { ensureViewer: async () => ({ workspace: { id: ids.workspace } }) } as never,
      uploadService: {} as never, jobService: deps.jobService as never,
      creditService: deps.creditService as never, tierGuard: deps.tierGuard as never,
    });
    return app;
  }

  const request = { method: "POST" as const, url: "/api/agent/generate-video",
    headers: { "idempotency-key": "request-1" },
    payload: { prompt: "video", model: "model", duration: 5 } };

  it("uses one atomic commit instead of application-side debit and enqueue", async () => {
    const deps = fixture();
    const response = await (await register(deps)).inject(request);
    expect(response.statusCode).toBe(200);
    expect(deps.jobService.createJobWithReplay).toHaveBeenCalledWith(user,
      expect.objectContaining({ deferEnqueue: true,
        videoSubmission: expect.objectContaining({ kind: "http" }),
        providerBilling: expect.objectContaining({ creditsCost: 7 }) }));
    expect(deps.order).toEqual(["find", "create", "commit", "poll"]);
    expect(deps.creditService.deductCredits).not.toHaveBeenCalled();
    expect(deps.creditService.refundCredits).not.toHaveBeenCalled();
  });

  it("keeps polling the durable job after an unknown commit response", async () => {
    const deps = fixture({ commitError: new JobServiceError(
      "video_commit_unknown", "unknown", 503,
    ) });
    const response = await (await register(deps)).inject(request);
    expect(response.statusCode).toBe(200);
    expect(deps.order).toEqual(["find", "create", "commit", "poll"]);
    expect(deps.jobService.cancelUncommittedVideoJob).not.toHaveBeenCalled();
  });

  it("CAS-cancels only a definitive pre-enqueue rejection", async () => {
    const deps = fixture({ commitError: new JobServiceError(
      "video_commit_rejected", "rejected", 409,
    ) });
    const response = await (await register(deps)).inject(request);
    expect(response.statusCode).toBe(409);
    expect(deps.order).toEqual(["find", "create", "commit", "cancel-cas"]);
    expect(deps.jobService.getJobAdmin).not.toHaveBeenCalled();
    expect(deps.creditService.refundCredits).not.toHaveBeenCalled();
  });

  it("returns the credit error after CAS proves the atomic commit did not publish", async () => {
    const deps = fixture({ commitError: new CreditServiceError(
      "insufficient_credits", "Insufficient credits", 402,
    ) });
    const response = await (await register(deps)).inject(request);
    expect(response.statusCode).toBe(402);
    expect(deps.order).toEqual(["find", "create", "commit", "cancel-cas"]);
    expect(deps.creditService.refundCredits).not.toHaveBeenCalled();
  });

  it("replays a completed key without repricing or creating another job", async () => {
    const deps = fixture({ existing: completedJob });
    const response = await (await register(deps)).inject(request);
    expect(response.statusCode).toBe(200);
    expect(deps.order).toEqual(["find", "poll"]);
    expect(deps.jobService.createJobWithReplay).not.toHaveBeenCalled();
    expect(deps.tierGuard.calculateCreditCost).not.toHaveBeenCalled();
  });
});
