import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminWriteError, type AdminAccessService } from "../features/admin/admin-access-service.js";
import { registerAdminAccessRoutes } from "./admin-access.js";

const user = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "admin@example.com", accessToken: "token", userMetadata: {} };
const target = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const adminView = {
  userId: target, email: "new@example.com", displayName: "新管理员",
  grantedAt: "2026-09-20T00:00:00.000Z", grantedBy: user.id, isCurrentUser: false,
};

function service(overrides: Partial<AdminAccessService> = {}): AdminAccessService {
  return {
    listPlatformAdmins: vi.fn(async () => ({ admins: [{ ...adminView, isCurrentUser: true }] })),
    grantPlatformAdmin: vi.fn(async () => adminView),
    revokePlatformAdmin: vi.fn(async () => adminView),
    listAuditEvents: vi.fn(async () => ({ events: [{
      id: "e1", actorUserId: user.id, actorEmail: "admin@example.com", action: "platform_admin.grant",
      targetKind: "user", targetId: target, workspaceId: null, workspaceName: null, reason: "任命",
      createdAt: "2026-09-20T00:00:00.000Z" }] })),
    ...overrides,
  };
}

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map(app => app.close())));

async function makeApp(adminAccessService: AdminAccessService, authenticated = true) {
  const app = Fastify();
  apps.push(app);
  await registerAdminAccessRoutes(app, {
    auth: { authenticate: vi.fn().mockResolvedValue(authenticated ? user : null) } as never,
    adminAccessService,
  });
  return app;
}

describe("admin access routes", () => {
  it("requires authentication on every route and never reaches the service", async () => {
    const adminAccessService = service();
    const app = await makeApp(adminAccessService, false);
    for (const [method, url] of [["GET", "/api/admin/platform-admins"], ["POST", "/api/admin/platform-admins"],
      ["DELETE", `/api/admin/platform-admins/${target}`], ["GET", "/api/admin/audit"]] as const) {
      const response = await app.inject({ method, url, payload: { email: "a@b.com", reason: "原因" } });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
    expect(adminAccessService.listPlatformAdmins).not.toHaveBeenCalled();
    expect(adminAccessService.grantPlatformAdmin).not.toHaveBeenCalled();
    expect(adminAccessService.revokePlatformAdmin).not.toHaveBeenCalled();
    expect(adminAccessService.listAuditEvents).not.toHaveBeenCalled();
  });

  it("lists platform admins for a platform admin", async () => {
    const app = await makeApp(service());
    const response = await app.inject({ method: "GET", url: "/api/admin/platform-admins" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ admins: [{ ...adminView, isCurrentUser: true }] });
  });

  it("validates the grant payload before the service sees it", async () => {
    const adminAccessService = service();
    const app = await makeApp(adminAccessService);
    for (const payload of [{ email: "not-an-email", reason: "原因" }, { email: "a@b.com", reason: "x" },
      { email: "a@b.com", reason: "原因", extra: 1 }]) {
      const response = await app.inject({ method: "POST", url: "/api/admin/platform-admins", payload });
      // A malformed request is the caller's mistake: 400, not a generic 500.
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json(), JSON.stringify(payload)).toMatchObject({ error: { code: "admin_invalid_request" } });
    }
    expect(adminAccessService.grantPlatformAdmin).not.toHaveBeenCalled();
  });

  it("grants with 201 and the created admin view", async () => {
    const adminAccessService = service();
    const app = await makeApp(adminAccessService);
    const response = await app.inject({ method: "POST", url: "/api/admin/platform-admins",
      payload: { email: "new@example.com", reason: " 任命第二管理员 " } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ admin: adminView });
    // The request schema trims, so the service receives the normalized values.
    expect(adminAccessService.grantPlatformAdmin).toHaveBeenCalledWith(user.id, "new@example.com", "任命第二管理员");
  });

  it("rejects a malformed user id before revoking", async () => {
    const adminAccessService = service();
    const app = await makeApp(adminAccessService);
    const response = await app.inject({ method: "DELETE", url: "/api/admin/platform-admins/not-a-uuid",
      payload: { reason: "离职" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "admin_invalid_request" } });
    expect(adminAccessService.revokePlatformAdmin).not.toHaveBeenCalled();
  });

  it("maps the last-admin refusal to 409 with a clear message", async () => {
    const adminAccessService = service({
      revokePlatformAdmin: vi.fn(async () => {
        throw new AdminWriteError("admin_last_platform_admin",
          "不能撤销最后一个平台管理员：撤销后将没有人能进入管理后台。", 409);
      }),
    });
    const app = await makeApp(adminAccessService);
    const response = await app.inject({ method: "DELETE", url: `/api/admin/platform-admins/${target}`,
      payload: { reason: "离职" } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "admin_last_platform_admin" } });
    expect(response.body).toContain("最后一个平台管理员");
  });

  it("maps an unexpected failure to 500 without leaking the internal message", async () => {
    const app = await makeApp(service({
      listPlatformAdmins: vi.fn(async () => { throw new Error("connection to 10.0.0.5 refused"); }),
    }));
    const response = await app.inject({ method: "GET", url: "/api/admin/platform-admins" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "admin_write_failed" } });
    expect(response.body).not.toContain("10.0.0.5");
  });

  it("bounds the audit limit and forwards filters", async () => {
    const adminAccessService = service();
    const app = await makeApp(adminAccessService);
    const bad = await app.inject({ method: "GET", url: "/api/admin/audit?limit=1000" });
    expect(bad.statusCode).toBe(400);
    expect(adminAccessService.listAuditEvents).not.toHaveBeenCalled();

    const ok = await app.inject({ method: "GET", url: "/api/admin/audit?limit=10&targetKind=user&targetId=" + target });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().events).toHaveLength(1);
    expect(adminAccessService.listAuditEvents).toHaveBeenCalledWith(user.id, { limit: 10, targetKind: "user", targetId: target });
  });
});
