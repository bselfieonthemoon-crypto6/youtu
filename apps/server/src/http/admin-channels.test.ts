import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AdminChannelDetailResponse,
  AdminChannelFailureRatesResponse,
  AdminChannelListResponse,
  AdminChannelView,
} from "@loomic/shared";

import { AdminChannelError, type AdminChannelService } from "../features/admin/admin-channel-service.js";
import { registerAdminChannelRoutes } from "./admin-channels.js";

const user = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "admin@example.com", accessToken: "token", userMetadata: {} };
const CONFIG = "66666666-6666-4666-8666-666666666666";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";

const channelRow: AdminChannelView = {
  id: CONFIG, workspaceId: WORKSPACE, workspaceName: "765966283 Workspace", displayName: "BASE",
  adapter: "openai_compatible", baseUrl: "https://api.example.com/v1", enabled: true, revision: 18,
  apiKeyLastFour: "97Dd", modelCount: 5, enabledModelCount: 5, modalities: ["image", "text", "video"],
  createdAt: "2026-09-03T05:19:19.030989+00:00", updatedAt: "2026-09-16T07:35:28.003898+00:00",
  lastTestedAt: "2026-09-16T07:35:27.133+00:00", lastTestStatus: "succeeded", lastTestErrorCode: null,
  windowDays: 30, jobs: 350, failures: 42, failureRate: 0.12,
  lastFailureAt: "2026-09-19T11:46:24.855691+00:00",
  topErrorCodes: [{ errorCode: "image_generation_result_unknown", count: 19, lastSeenAt: "2026-09-19T11:46:24.855691+00:00" }],
};

const list: AdminChannelListResponse = {
  total: 5, windowDays: 30, totalJobs: 358, totalFailures: 49, channels: [channelRow],
};

const detail: AdminChannelDetailResponse = {
  channel: {
    id: CONFIG, workspaceId: WORKSPACE, workspaceName: "765966283 Workspace", displayName: "BASE",
    adapter: "openai_compatible", baseUrl: "https://api.example.com/v1", enabled: true, revision: 18,
    apiKeyLastFour: "97Dd", modelCount: 5, enabledModelCount: 5, modalities: ["image"],
    createdAt: "2026-09-03T05:19:19.030989+00:00", updatedAt: "2026-09-16T07:35:28.003898+00:00",
    lastTestedAt: "2026-09-16T07:35:27.133+00:00", lastTestStatus: "succeeded", lastTestErrorCode: null,
    windowDays: 30, jobs: 350, failures: 42, failureRate: 0.12,
    lastFailureAt: "2026-09-19T11:46:24.855691+00:00",
    createdByEmail: "owner@example.com", updatedByEmail: "owner@example.com",
  },
  history: [{ action: "test_succeeded", actorUserId: user.id, actorEmail: "owner@example.com",
    errorCode: null, createdAt: "2026-09-16T07:35:28.019065+00:00" }],
  errorCodes: [{ errorCode: "provider_rejected", failures: 9, failed: 0, deadLetter: 9,
    lastSeenAt: "2026-09-19T11:34:47.411808+00:00" }],
  failures: [{ jobId: "job-1", jobType: "image_generation", status: "dead_letter",
    errorCode: "provider_rejected", createdAt: "2026-09-19T11:34:47.411808+00:00",
    finishedAt: "2026-09-19T11:37:06.394226+00:00" }],
};

const rates: AdminChannelFailureRatesResponse = {
  windowDays: 30, totalJobs: 1449, totalFailures: 553, overallFailureRate: 0.3816,
  providerJobs: 358, providerFailures: 49, providerFailureRate: 0.1369, channelCount: 3,
  errorCodes: [{ errorCode: "design_preview_stale", failures: 504, failed: 0, deadLetter: 504,
    share: 0.9114, channelCount: 0, lastSeenAt: "2026-09-17T17:16:53.527457+00:00" }],
};

function service(overrides: Partial<AdminChannelService> = {}): AdminChannelService {
  return {
    listChannels: vi.fn(async () => list),
    getChannel: vi.fn(async () => detail),
    getFailureRates: vi.fn(async () => rates),
    ...overrides,
  };
}

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map(app => app.close())));

async function makeApp(adminChannelService: AdminChannelService, authenticated = true) {
  const app = Fastify();
  apps.push(app);
  await registerAdminChannelRoutes(app, {
    auth: { authenticate: vi.fn().mockResolvedValue(authenticated ? user : null) } as never,
    adminChannelService,
  });
  return app;
}

describe("admin channel routes", () => {
  it("requires authentication on all three routes", async () => {
    const adminChannelService = service();
    const app = await makeApp(adminChannelService, false);
    for (const url of ["/api/admin/channels", "/api/admin/channels/failure-rates", `/api/admin/channels/${CONFIG}`]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
    }
    expect(adminChannelService.listChannels).not.toHaveBeenCalled();
    expect(adminChannelService.getChannel).not.toHaveBeenCalled();
    expect(adminChannelService.getFailureRates).not.toHaveBeenCalled();
  });

  it("returns the directory with every filter applied", async () => {
    const adminChannelService = service();
    const app = await makeApp(adminChannelService);
    const response = await app.inject({ method: "GET",
      url: `/api/admin/channels?workspaceId=${WORKSPACE}&query=BASE&enabled=false&testStatus=failed&days=7&limit=20&offset=40` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(list);
    expect(adminChannelService.listChannels).toHaveBeenCalledWith(user.id, {
      workspaceId: WORKSPACE, query: "BASE", enabled: false, testStatus: "failed",
      days: 7, limit: 20, offset: 40,
    });
  });

  it("distinguishes an omitted enabled filter from an explicit false one", async () => {
    const adminChannelService = service();
    const app = await makeApp(adminChannelService);
    await app.inject({ method: "GET", url: "/api/admin/channels" });
    await app.inject({ method: "GET", url: "/api/admin/channels?enabled=true" });
    expect(adminChannelService.listChannels).toHaveBeenNthCalledWith(1, user.id, {});
    expect(adminChannelService.listChannels).toHaveBeenNthCalledWith(2, user.id, { enabled: true });
  });

  it("rejects a bad workspace id, flag, page or window before the service", async () => {
    const adminChannelService = service();
    const app = await makeApp(adminChannelService);
    for (const url of ["/api/admin/channels?workspaceId=nope", "/api/admin/channels?enabled=maybe",
      "/api/admin/channels?days=0", "/api/admin/channels?days=400", "/api/admin/channels?limit=0",
      "/api/admin/channels?limit=500", "/api/admin/channels?offset=-1", "/api/admin/channels?limit=abc"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(400);
      expect(response.json(), url).toMatchObject({ error: { code: "admin_invalid_request" } });
    }
    expect(adminChannelService.listChannels).not.toHaveBeenCalled();
  });

  it("serves the failure rates without reading 'failure-rates' as a channel id", async () => {
    const adminChannelService = service();
    const app = await makeApp(adminChannelService);
    const response = await app.inject({ method: "GET", url: "/api/admin/channels/failure-rates?days=7&limit=10" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(rates);
    expect(adminChannelService.getFailureRates).toHaveBeenCalledWith(user.id, { days: 7, limit: 10 });
    expect(adminChannelService.getChannel).not.toHaveBeenCalled();

    for (const url of ["/api/admin/channels/failure-rates?days=0", "/api/admin/channels/failure-rates?limit=101"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(400);
    }
  });

  it("returns one channel with its self-test history and newest failures", async () => {
    const app = await makeApp(service());
    const response = await app.inject({ method: "GET",
      url: `/api/admin/channels/${CONFIG}?days=30&historyLimit=5&jobLimit=3` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      channel: { id: CONFIG, displayName: "BASE", lastTestStatus: "succeeded" },
      history: [{ action: "test_succeeded" }],
      errorCodes: [{ errorCode: "provider_rejected", deadLetter: 9 }],
      failures: [{ jobId: "job-1" }],
    });
  });

  it("rejects a malformed channel id and out-of-range detail limits", async () => {
    const adminChannelService = service();
    const app = await makeApp(adminChannelService);
    for (const url of ["/api/admin/channels/not-a-uuid", `/api/admin/channels/${CONFIG}?days=0`,
      `/api/admin/channels/${CONFIG}?historyLimit=0`, `/api/admin/channels/${CONFIG}?jobLimit=101`]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(400);
    }
    expect(adminChannelService.getChannel).not.toHaveBeenCalled();
  });

  it("maps an unknown channel to 404 and a refusal to its status", async () => {
    for (const [code, status] of [["admin_channel_not_found", 404], ["platform_admin_required", 403]] as const) {
      const app = await makeApp(service({
        getChannel: vi.fn(async () => { throw new AdminChannelError(code, "该渠道配置不存在。", status); }),
      }));
      const response = await app.inject({ method: "GET", url: `/api/admin/channels/${CONFIG}` });
      expect(response.statusCode, code).toBe(status);
      expect(response.json(), code).toMatchObject({ error: { code } });
    }
  });

  it("maps an unexpected failure to 500 without leaking the internal message", async () => {
    const app = await makeApp(service({
      listChannels: vi.fn(async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432"); }),
    }));
    const response = await app.inject({ method: "GET", url: "/api/admin/channels" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "admin_write_failed" } });
    expect(response.body).not.toContain("10.0.0.5");
  });
});
