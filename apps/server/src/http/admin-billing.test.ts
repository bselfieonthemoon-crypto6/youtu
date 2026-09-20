import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminWorkspaceBillingResponse } from "@loomic/shared";

import { AdminBillingError, type AdminBillingService } from "../features/admin/admin-billing-service.js";
import { registerAdminBillingRoutes } from "./admin-billing.js";

const user = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "admin@example.com", accessToken: "token", userMetadata: {} };
const workspace = "11111111-1111-4111-8111-111111111111";
const jobId = "33333333-3333-4333-8333-333333333333";

const billing: AdminWorkspaceBillingResponse = {
  workspace: { id: workspace, name: "设计团队", type: "team", createdAt: "2026-09-01T00:00:00.000Z" },
  plan: "pro",
  balance: 940,
  subscription: {
    billingPeriod: "monthly", currentPeriodStart: "2026-09-01T00:00:00.000Z",
    currentPeriodEnd: "2026-10-01T00:00:00.000Z", canceledAt: null, hasExternalSubscription: true,
  },
  last30d: { deductedCredits: 21, refundedCredits: 7 },
  recentTransactions: [{
    id: "t1", transactionType: "generation_deduct", amount: -7, balanceAfter: 933, jobId,
    description: "生成扣费", actorEmail: "member@example.com", createdAt: "2026-09-20T04:00:00.000Z",
  }],
  mismatchedJobs: [{
    jobId, status: "succeeded", jobType: "image_generation", recordedCreditsCost: 7,
    ledgerCharged: 5, ledgerRefunded: 0, createdAt: "2026-09-20T04:00:00.000Z",
  }],
};

function service(overrides: Partial<AdminBillingService> = {}): AdminBillingService {
  return {
    getBilling: vi.fn(async () => billing),
    setPlan: vi.fn(async (_actor: string, input: { plan: string; grantCredits: number }) =>
      ({ plan: input.plan, planBefore: "free", grantedCredits: input.grantCredits, balance: 1040 })),
    adjustCredits: vi.fn(async (_actor: string, input: { delta: number }) => ({ delta: input.delta, balance: 1040 })),
    ...overrides,
  };
}

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map(app => app.close())));

async function makeApp(adminBillingService: AdminBillingService, authenticated = true) {
  const app = Fastify();
  apps.push(app);
  await registerAdminBillingRoutes(app, {
    auth: { authenticate: vi.fn().mockResolvedValue(authenticated ? user : null) } as never,
    adminBillingService,
  });
  return app;
}

describe("admin billing routes", () => {
  it("requires authentication on all three routes", async () => {
    const adminBillingService = service();
    const app = await makeApp(adminBillingService, false);
    for (const [method, url] of [["GET", `/api/admin/workspaces/${workspace}/billing`],
      ["POST", `/api/admin/workspaces/${workspace}/plan`],
      ["POST", `/api/admin/workspaces/${workspace}/credits`]] as const) {
      const response = await app.inject({ method, url, payload: { plan: "pro", delta: 1, reason: "原因" } });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
    expect(adminBillingService.getBilling).not.toHaveBeenCalled();
    expect(adminBillingService.setPlan).not.toHaveBeenCalled();
    expect(adminBillingService.adjustCredits).not.toHaveBeenCalled();
  });

  it("returns the billing view including the reconciliation list", async () => {
    const adminBillingService = service();
    const app = await makeApp(adminBillingService);
    const response = await app.inject({ method: "GET", url: `/api/admin/workspaces/${workspace}/billing?limit=5` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ plan: "pro", balance: 940, last30d: { deductedCredits: 21, refundedCredits: 7 } });
    expect(body.mismatchedJobs[0]).toMatchObject({ jobId, recordedCreditsCost: 7, ledgerCharged: 5 });
    expect(adminBillingService.getBilling).toHaveBeenCalledWith(user.id, workspace, 5);
  });

  it("rejects a bad workspace id or limit before the service", async () => {
    const adminBillingService = service();
    const app = await makeApp(adminBillingService);
    for (const url of ["/api/admin/workspaces/not-a-uuid/billing", `/api/admin/workspaces/${workspace}/billing?limit=0`,
      `/api/admin/workspaces/${workspace}/billing?limit=1000`]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(400);
      expect(response.json(), url).toMatchObject({ error: { code: "admin_invalid_request" } });
    }
    expect(adminBillingService.getBilling).not.toHaveBeenCalled();
  });

  it("sets a plan with a mandatory reason and defaults the grant to zero", async () => {
    const adminBillingService = service();
    const app = await makeApp(adminBillingService);
    const response = await app.inject({ method: "POST", url: `/api/admin/workspaces/${workspace}/plan`,
      payload: { plan: "ultra", reason: " 商务补偿 " } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ plan: "ultra", planBefore: "free", grantedCredits: 0, balance: 1040 });
    expect(adminBillingService.setPlan).toHaveBeenCalledWith(user.id,
      { workspaceId: workspace, plan: "ultra", grantCredits: 0, reason: "商务补偿" });
  });

  it("rejects an unknown plan, a missing reason and an out-of-range grant", async () => {
    const adminBillingService = service();
    const app = await makeApp(adminBillingService);
    for (const payload of [
      { plan: "enterprise", reason: "原因" },
      { plan: "pro", reason: "x" },
      { plan: "pro", grantCredits: 2_000_000, reason: "原因" },
      { plan: "pro", grantCredits: -5, reason: "原因" },
    ]) {
      const response = await app.inject({ method: "POST", url: `/api/admin/workspaces/${workspace}/plan`, payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(adminBillingService.setPlan).not.toHaveBeenCalled();
  });

  it("adjusts credits in both directions and refuses zero", async () => {
    const adminBillingService = service();
    const app = await makeApp(adminBillingService);
    const granted = await app.inject({ method: "POST", url: `/api/admin/workspaces/${workspace}/credits`,
      payload: { delta: 500, reason: "补偿" } });
    expect(granted.statusCode).toBe(200);
    expect(granted.json()).toEqual({ delta: 500, balance: 1040 });

    const deducted = await app.inject({ method: "POST", url: `/api/admin/workspaces/${workspace}/credits`,
      payload: { delta: -500, reason: "撤回补偿" } });
    expect(deducted.statusCode).toBe(200);

    const zero = await app.inject({ method: "POST", url: `/api/admin/workspaces/${workspace}/credits`,
      payload: { delta: 0, reason: "无效" } });
    expect(zero.statusCode).toBe(400);
    expect(adminBillingService.adjustCredits).toHaveBeenCalledTimes(2);
  });

  it("maps an insufficient balance to 409 with an explanatory message", async () => {
    const app = await makeApp(service({
      adjustCredits: vi.fn(async () => {
        throw new AdminBillingError("admin_insufficient_balance",
          "该工作区余额不足，扣减后不能为负数。", 409);
      }),
    }));
    const response = await app.inject({ method: "POST", url: `/api/admin/workspaces/${workspace}/credits`,
      payload: { delta: -999, reason: "扣减" } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "admin_insufficient_balance" } });
    expect(response.body).toContain("余额不足");
  });

  it("maps an unexpected failure to 500 without leaking the internal message", async () => {
    const app = await makeApp(service({
      getBilling: vi.fn(async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432"); }),
    }));
    const response = await app.inject({ method: "GET", url: `/api/admin/workspaces/${workspace}/billing` });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "admin_write_failed" } });
    expect(response.body).not.toContain("10.0.0.5");
  });
});
