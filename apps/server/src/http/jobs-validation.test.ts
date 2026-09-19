import Fastify from "fastify";
import { describe, it, expect, vi } from "vitest";
import { registerJobRoutes } from "./jobs.js";

describe("job route input validation", () => {
  it.each([
    ["GET", "/api/jobs?status=invalid"],
    ["GET", "/api/jobs?job_type=invalid"],
    ["GET", "/api/jobs?status=queued&status=running"],
    ["GET", "/api/jobs/not-a-uuid"],
    ["POST", "/api/jobs/not-a-uuid/cancel"],
    ["POST", "/api/jobs/not-a-uuid/restore-to-canvas"],
  ] as const)("rejects %s %s without querying storage", async (method, url) => {
    const app = Fastify();
    const jobService = { listJobs: vi.fn(), getJob: vi.fn(), cancelJob: vi.fn() };
    try {
      await registerJobRoutes(app, {
        auth: { authenticate: async () => ({ id: "test", accessToken: "test" }) } as never,
        viewerService: {} as never,
        jobService: jobService as never,
      });
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(400);
      for (const method of Object.values(jobService)) expect(method).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});

describe("cancel settles the job synchronously", () => {
  const canceledJob = {
    id: "11111111-1111-4111-8111-111111111111",
    workspace_id: "22222222-2222-4222-8222-222222222222",
    project_id: null, canvas_id: null, session_id: null, thread_id: null,
    queue_name: "image_generation_jobs", job_type: "image_generation",
    status: "canceled", payload: {}, result: null, error_code: null, error_message: null,
    attempt_count: 0, max_attempts: 3, created_by: "33333333-3333-4333-8333-333333333333",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    started_at: null, completed_at: null, failed_at: null, canceled_at: new Date().toISOString(),
  };

  async function build(overrides: {
    settleTerminalJob?: (jobId: string) => Promise<unknown>;
  } = {}) {
    const app = Fastify();
    const jobService = {
      cancelJob: vi.fn(async () => canceledJob),
      getCreditsCost: vi.fn(async () => 0),
      listJobs: vi.fn(), getJob: vi.fn(),
    };
    const creditService = { refundCredits: vi.fn(async () => "refund-1") };
    await registerJobRoutes(app, {
      auth: { authenticate: async () => ({ id: "user-1", accessToken: "token" }) } as never,
      viewerService: {} as never,
      jobService: jobService as never,
      creditService: creditService as never,
      ...(overrides.settleTerminalJob ? { settleTerminalJob: overrides.settleTerminalJob } : {}),
    });
    return { app, jobService, creditService };
  }

  // A job canceled while still queued is never picked up by the worker, which is
  // what normally settles the chat card and canvas placeholder. Measured before
  // this fix: chat/canvas still said "生成中" 132-145s after a successful cancel.
  it("converges the terminal job before answering", async () => {
    const settleTerminalJob = vi.fn(async () => true);
    const { app, jobService } = await build({ settleTerminalJob });
    try {
      const response = await app.inject({ method: "POST", url: `/api/jobs/${canceledJob.id}/cancel` });
      expect(response.statusCode, response.body).toBe(200);
      expect(jobService.cancelJob).toHaveBeenCalledWith(
        expect.objectContaining({ id: "user-1" }), canceledJob.id);
      expect(settleTerminalJob).toHaveBeenCalledWith(canceledJob.id);
    } finally { await app.close(); }
  });

  it("keeps a successful cancel successful when settlement fails", async () => {
    const settleTerminalJob = vi.fn(async () => { throw new Error("admin unavailable"); });
    const { app } = await build({ settleTerminalJob });
    try {
      const response = await app.inject({ method: "POST", url: `/api/jobs/${canceledJob.id}/cancel` });
      expect(response.statusCode).toBe(200);
      expect(settleTerminalJob).toHaveBeenCalledWith(canceledJob.id);
    } finally { await app.close(); }
  });
});
