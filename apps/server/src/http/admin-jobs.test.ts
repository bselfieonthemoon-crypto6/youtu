import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminJobDetailResponse, AdminJobListResponse } from "@loomic/shared";

import { AdminJobError, type AdminJobService } from "../features/admin/admin-job-service.js";
import { registerAdminJobRoutes } from "./admin-jobs.js";

const user = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "admin@example.com", accessToken: "token", userMetadata: {} };
const JOB = "33333333-3333-4333-8333-333333333333";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";

const jobRow = {
  id: JOB, status: "dead_letter", jobType: "image_generation", queueName: "image_generation_jobs",
  workspaceId: WORKSPACE, workspaceName: "设计团队", createdBy: user.id, createdByEmail: "member@example.com",
  title: "咖啡店开业海报", model: "workspace:model", createdAt: "2026-09-20T04:00:00.000Z",
  startedAt: "2026-09-20T04:00:05.000Z", completedAt: null, attemptCount: 3, maxAttempts: 3,
  errorCode: "provider_rate_limited", errorMessage: "429 上游负载已饱和", creditsCost: 0,
  stuck: false, ageSeconds: 3600, acknowledgedAt: null, acknowledgedByEmail: null, acknowledgeReason: null,
};

const list: AdminJobListResponse = { total: 1, jobs: [jobRow] };

const detail: AdminJobDetailResponse = {
  job: {
    id: JOB, status: "dead_letter", jobType: "image_generation", queueName: "image_generation_jobs",
    workspaceId: WORKSPACE, workspaceName: "设计团队", createdBy: user.id, createdByEmail: "member@example.com",
    createdAt: "2026-09-20T04:00:00.000Z", startedAt: "2026-09-20T04:00:05.000Z", completedAt: null,
    attemptCount: 3, maxAttempts: 3, errorCode: "provider_rate_limited", errorMessage: "429 上游负载已饱和",
    creditsCost: 0, acknowledgedAt: null, acknowledgedByEmail: null, acknowledgeReason: null,
    sessionId: "session-1", sessionTitle: "开业海报", canvasId: "canvas-1", failedAt: "2026-09-20T04:01:00.000Z",
    canceledAt: null, creditsTransactionId: null, payloadPreview: "{\"prompt\":\"…\"}", resultPreview: null,
  },
  transactions: [{ id: "t1", transactionType: "generation_deduct", amount: -7, balanceAfter: 933,
    description: "生成扣费", createdAt: "2026-09-20T04:00:06.000Z" }],
  audit: [{ action: "job.failure.acknowledge", reason: "已知悉", actorEmail: "admin@example.com",
    actorUserId: user.id, createdAt: "2026-09-20T05:00:00.000Z" }],
};

function service(overrides: Partial<AdminJobService> = {}): AdminJobService {
  return {
    listJobs: vi.fn(async () => list),
    getJob: vi.fn(async () => detail),
    cancelJob: vi.fn(async () => ({ statusBefore: "queued" })),
    acknowledgeJob: vi.fn(async () => undefined),
    ...overrides,
  };
}

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map(app => app.close())));

async function makeApp(adminJobService: AdminJobService, authenticated = true, settleTerminalJob?: (jobId: string) => Promise<unknown>) {
  const app = Fastify();
  apps.push(app);
  await registerAdminJobRoutes(app, {
    auth: { authenticate: vi.fn().mockResolvedValue(authenticated ? user : null) } as never,
    adminJobService,
    ...(settleTerminalJob ? { settleTerminalJob } : {}),
  });
  return app;
}

describe("admin job routes", () => {
  it("requires authentication on all four routes", async () => {
    const adminJobService = service();
    const app = await makeApp(adminJobService, false);
    for (const [method, url] of [["GET", "/api/admin/jobs"], ["GET", `/api/admin/jobs/${JOB}`],
      ["POST", `/api/admin/jobs/${JOB}/cancel`], ["POST", `/api/admin/jobs/${JOB}/acknowledge`]] as const) {
      const response = await app.inject({ method, url, payload: { reason: "原因" } });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
    expect(adminJobService.listJobs).not.toHaveBeenCalled();
    expect(adminJobService.cancelJob).not.toHaveBeenCalled();
    expect(adminJobService.acknowledgeJob).not.toHaveBeenCalled();
  });

  it("returns the filtered list", async () => {
    const adminJobService = service();
    const app = await makeApp(adminJobService);
    const response = await app.inject({ method: "GET",
      url: `/api/admin/jobs?status=dead_letter&jobType=image_generation&workspaceId=${WORKSPACE}&errorCode=provider_rate_limited&sinceHours=24&limit=10&offset=5` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(list);
    expect(adminJobService.listJobs).toHaveBeenCalledWith(user.id, {
      status: "dead_letter", jobType: "image_generation", workspaceId: WORKSPACE,
      errorCode: "provider_rate_limited", sinceHours: 24, limit: 10, offset: 5,
    });
  });

  it("rejects a bad workspace id, page or time window before the service", async () => {
    const adminJobService = service();
    const app = await makeApp(adminJobService);
    for (const url of ["/api/admin/jobs?workspaceId=nope", "/api/admin/jobs?limit=0", "/api/admin/jobs?limit=1000",
      "/api/admin/jobs?offset=-1", "/api/admin/jobs?sinceHours=0"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(400);
      expect(response.json(), url).toMatchObject({ error: { code: "admin_invalid_request" } });
    }
    expect(adminJobService.listJobs).not.toHaveBeenCalled();
  });

  it("returns one job with its ledger rows and admin history", async () => {
    const app = await makeApp(service());
    const response = await app.inject({ method: "GET", url: `/api/admin/jobs/${JOB}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      job: { id: JOB, sessionTitle: "开业海报", errorCode: "provider_rate_limited" },
      transactions: [{ transactionType: "generation_deduct" }],
      audit: [{ action: "job.failure.acknowledge" }],
    });
  });

  it("rejects a malformed job id", async () => {
    const adminJobService = service();
    const app = await makeApp(adminJobService);
    const response = await app.inject({ method: "GET", url: "/api/admin/jobs/not-a-uuid" });
    expect(response.statusCode).toBe(400);
    expect(adminJobService.getJob).not.toHaveBeenCalled();
  });

  it("cancels with a reason and settles the job through the shared hook", async () => {
    const adminJobService = service();
    const settle = vi.fn(async () => true);
    const app = await makeApp(adminJobService, true, settle);
    const response = await app.inject({ method: "POST", url: `/api/admin/jobs/${JOB}/cancel`,
      payload: { reason: " 上游长期无响应 " } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ jobId: JOB, status: "canceled", statusBefore: "queued" });
    expect(adminJobService.cancelJob).toHaveBeenCalledWith(user.id, { jobId: JOB, reason: "上游长期无响应" });
    expect(settle).toHaveBeenCalledWith(JOB);
  });

  it("never turns a successful cancel into a failure when settlement throws", async () => {
    const settle = vi.fn(async () => { throw new Error("settle exploded"); });
    const app = await makeApp(service(), true, settle);
    const response = await app.inject({ method: "POST", url: `/api/admin/jobs/${JOB}/cancel`, payload: { reason: "取消" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "canceled" });
  });

  it("requires a reason for both writes and rejects a malformed id", async () => {
    const adminJobService = service();
    const app = await makeApp(adminJobService);
    for (const [url, payload] of [[`/api/admin/jobs/${JOB}/cancel`, { reason: "x" }],
      [`/api/admin/jobs/${JOB}/acknowledge`, {}],
      ["/api/admin/jobs/not-a-uuid/cancel", { reason: "取消" }],
      ["/api/admin/jobs/not-a-uuid/acknowledge", { reason: "已知悉" }]] as const) {
      const response = await app.inject({ method: "POST", url, payload });
      expect(response.statusCode, url).toBe(400);
    }
    expect(adminJobService.cancelJob).not.toHaveBeenCalled();
    expect(adminJobService.acknowledgeJob).not.toHaveBeenCalled();
  });

  it("acknowledges a terminal failure", async () => {
    const adminJobService = service();
    const app = await makeApp(adminJobService);
    const response = await app.inject({ method: "POST", url: `/api/admin/jobs/${JOB}/acknowledge`,
      payload: { reason: "已知悉，等待上游恢复" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ jobId: JOB, acknowledged: true });
    expect(adminJobService.acknowledgeJob).toHaveBeenCalledWith(user.id, { jobId: JOB, reason: "已知悉，等待上游恢复" });
  });

  it("maps refusals to their status without leaking the raw message", async () => {
    for (const [code, status] of [["admin_job_not_found", 404], ["admin_job_already_terminal", 409],
      ["admin_job_not_terminal", 409], ["admin_reason_required", 400]] as const) {
      const app = await makeApp(service({
        cancelJob: vi.fn(async () => { throw new AdminJobError(code, "该任务已经结束，无法取消。", status); }),
      }));
      const response = await app.inject({ method: "POST", url: `/api/admin/jobs/${JOB}/cancel`, payload: { reason: "取消" } });
      expect(response.statusCode, code).toBe(status);
      expect(response.json(), code).toMatchObject({ error: { code } });
    }
  });

  it("maps an unexpected failure to 500 without leaking the internal message", async () => {
    const app = await makeApp(service({
      listJobs: vi.fn(async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432"); }),
    }));
    const response = await app.inject({ method: "GET", url: "/api/admin/jobs" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "admin_write_failed" } });
    expect(response.body).not.toContain("10.0.0.5");
  });
});
