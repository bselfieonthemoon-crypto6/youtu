import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminOverviewResponse } from "@loomic/shared";

import {
  AdminOverviewError,
  type AdminOverviewService,
} from "../features/admin/admin-overview-service.js";
import { registerAdminOverviewRoutes } from "./admin-overview.js";

const user = { id: "admin-1", email: "admin@example.com", accessToken: "token", userMetadata: {} };

const overview: AdminOverviewResponse = {
  generatedAt: "2026-09-20T12:00:00.000Z",
  workspaces: { total: 1, byType: { personal: 1, team: 0 }, items: [{
    id: "workspace-1", name: "工作区", type: "personal", createdAt: "2026-09-01T00:00:00.000Z",
    memberCount: 1, balance: 940, plan: "free" }] },
  jobs: { total: 2, active: 1, byStatus: { queued: 1, running: 0, succeeded: 1, failed: 0, canceled: 0, dead_letter: 0 },
    byType: { image_generation: 2 }, recentFailures: [] },
  credits: { totalBalance: 940, byPlan: { free: 1 }, deductionsLast30d: 0, refundsLast30d: 0, recentTransactions: [], truncated: false },
  providers: { configCount: 1, disabledConfigCount: 0, failingTestCount: 0, modelCount: 1, disabledModelCount: 0,
    modelsByModality: { image: 1 }, items: [], truncated: false },
  skills: { total: 16, byCategory: { design: 13, generation: 1, code: 0, data: 0, writing: 1, custom: 1 },
    installs: 341, enabledInstalls: 300, truncated: false },
};

function service(platformAdmin: boolean, failure?: unknown): AdminOverviewService {
  return {
    isPlatformAdmin: vi.fn(async () => {
      if (failure && !platformAdmin) throw failure;
      return platformAdmin;
    }),
    overview: vi.fn(async () => {
      if (failure) throw failure;
      return overview;
    }),
  };
}

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map(app => app.close())));

async function makeApp(adminOverviewService: AdminOverviewService, authenticated = true) {
  const app = Fastify();
  apps.push(app);
  await registerAdminOverviewRoutes(app, {
    auth: { authenticate: vi.fn().mockResolvedValue(authenticated ? user : null) } as never,
    adminOverviewService,
  });
  return app;
}

describe("admin overview routes", () => {
  it("requires authentication on both routes and never reaches the service", async () => {
    const adminOverviewService = service(true);
    const app = await makeApp(adminOverviewService, false);
    for (const url of ["/api/admin/access", "/api/admin/overview"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
    }
    expect(adminOverviewService.isPlatformAdmin).not.toHaveBeenCalled();
    expect(adminOverviewService.overview).not.toHaveBeenCalled();
  });

  it("answers the access probe with a boolean for everyone authenticated", async () => {
    const app = await makeApp(service(false));
    const response = await app.inject({ method: "GET", url: "/api/admin/access" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ platformAdmin: false });
  });

  it("refuses a non-admin and returns no overview data at all", async () => {
    const adminOverviewService = service(false);
    const app = await makeApp(adminOverviewService);
    const response = await app.inject({ method: "GET", url: "/api/admin/overview" });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: { code: "platform_admin_required", message: expect.any(String) } });
    // The guard is the control: the aggregate must not even be built.
    expect(adminOverviewService.overview).not.toHaveBeenCalled();
    expect(response.body).not.toContain("940");
  });

  it("returns the overview to a platform admin, already shape-validated", async () => {
    const app = await makeApp(service(true));
    const response = await app.inject({ method: "GET", url: "/api/admin/overview" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      workspaces: { total: 1, items: [{ name: "工作区", balance: 940 }] },
      skills: { total: 16, enabledInstalls: 300 },
    });
  });

  it("maps a service failure to 500 without leaking the internal message", async () => {
    const app = await makeApp(service(true, new AdminOverviewError("admin_overview_failed", "relation does not exist", 500)));
    const response = await app.inject({ method: "GET", url: "/api/admin/overview" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "admin_overview_failed" } });
    expect(response.body).not.toContain("relation does not exist");
  });

  it("maps an unexpected error to the same bounded shape", async () => {
    const app = await makeApp(service(true, new Error("kaboom")));
    const response = await app.inject({ method: "GET", url: "/api/admin/overview" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "admin_overview_failed" } });
    expect(response.body).not.toContain("kaboom");
  });

  it("reports an access-check failure as 500 rather than as a silent denial", async () => {
    const adminOverviewService: AdminOverviewService = {
      isPlatformAdmin: vi.fn(async () => { throw new Error("lookup exploded"); }),
      overview: vi.fn(),
    };
    const app = await makeApp(adminOverviewService);
    const response = await app.inject({ method: "GET", url: "/api/admin/access" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "admin_overview_failed" } });
  });
});
