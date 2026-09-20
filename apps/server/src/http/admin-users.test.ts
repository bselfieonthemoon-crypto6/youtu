import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminUserDirectoryEntry, AdminWorkspaceDirectoryEntry } from "@loomic/shared";

import { AdminUserError, type AdminUserService } from "../features/admin/admin-user-service.js";
import { registerAdminUserRoutes } from "./admin-users.js";

const user = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "admin@example.com", accessToken: "token", userMetadata: {} };
const workspace = "11111111-1111-4111-8111-111111111111";
const target = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const directoryEntry: AdminUserDirectoryEntry = {
  userId: target, email: "member@example.com", displayName: "成员", createdAt: "2026-09-01T00:00:00.000Z",
  isPlatformAdmin: false, lastActiveAt: null, runs30d: 2, jobs30d: 1, creditsSpent30d: 7,
  workspaces: [{ id: workspace, name: "设计团队", type: "team", role: "member" }],
};

const workspaceEntry: AdminWorkspaceDirectoryEntry = {
  id: workspace, name: "设计团队", type: "team", createdAt: "2026-09-01T00:00:00.000Z", memberCount: 3,
};

function service(overrides: Partial<AdminUserService> = {}): AdminUserService {
  // The service methods take (actorUserId, input): the mock must accept both
  // arguments, otherwise `input` is the actor id and the returned member is empty.
  return {
    searchUsers: vi.fn(async () => ({ total: 1, users: [directoryEntry] })),
    searchWorkspaces: vi.fn(async () => ({ workspaces: [workspaceEntry] })),
    addMember: vi.fn(async (_actor: string, input: { userId: string; workspaceId: string; role: "admin" | "member" }) =>
      ({ userId: input.userId, workspaceId: input.workspaceId, role: input.role })),
    setMemberRole: vi.fn(async (_actor: string, input: { userId: string; workspaceId: string; role: "admin" | "member" }) =>
      ({ userId: input.userId, workspaceId: input.workspaceId, role: input.role })),
    removeMember: vi.fn(async (_actor: string, input: { userId: string; workspaceId: string }) =>
      ({ userId: input.userId, workspaceId: input.workspaceId, removed: true as const })),
    ...overrides,
  };
}

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map(app => app.close())));

async function makeApp(adminUserService: AdminUserService, authenticated = true) {
  const app = Fastify();
  apps.push(app);
  await registerAdminUserRoutes(app, {
    auth: { authenticate: vi.fn().mockResolvedValue(authenticated ? user : null) } as never,
    adminUserService,
  });
  return app;
}

describe("admin user routes", () => {
  it("requires authentication on every route and never reaches the service", async () => {
    const adminUserService = service();
    const app = await makeApp(adminUserService, false);
    for (const [method, url] of [
      ["GET", "/api/admin/users"], ["GET", "/api/admin/workspaces"],
      ["POST", `/api/admin/workspaces/${workspace}/members`],
      ["PATCH", `/api/admin/workspaces/${workspace}/members/${target}`],
      ["DELETE", `/api/admin/workspaces/${workspace}/members/${target}`],
    ] as const) {
      const response = await app.inject({ method, url, payload: { userId: target, role: "member", reason: "原因" } });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
    expect(adminUserService.searchUsers).not.toHaveBeenCalled();
    expect(adminUserService.addMember).not.toHaveBeenCalled();
    expect(adminUserService.setMemberRole).not.toHaveBeenCalled();
    expect(adminUserService.removeMember).not.toHaveBeenCalled();
  });

  it("returns the directory with its filters", async () => {
    const adminUserService = service();
    const app = await makeApp(adminUserService);
    const response = await app.inject({ method: "GET", url: "/api/admin/users?query=member&limit=10&offset=5" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ total: 1, users: [directoryEntry] });
    expect(adminUserService.searchUsers).toHaveBeenCalledWith(user.id, { query: "member", limit: 10, offset: 5 });
  });

  it("rejects a bad page, a non-uuid user filter and a bad limit", async () => {
    const adminUserService = service();
    const app = await makeApp(adminUserService);
    for (const url of ["/api/admin/users?userId=nope", "/api/admin/users?limit=0", "/api/admin/users?limit=1000",
      "/api/admin/users?offset=-1", "/api/admin/workspaces?limit=1000"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(400);
      expect(response.json(), url).toMatchObject({ error: { code: "admin_invalid_request" } });
    }
    expect(adminUserService.searchUsers).not.toHaveBeenCalled();
    expect(adminUserService.searchWorkspaces).not.toHaveBeenCalled();
  });

  it("adds a member with 201 and forwards the validated payload", async () => {
    const adminUserService = service();
    const app = await makeApp(adminUserService);
    const response = await app.inject({ method: "POST", url: `/api/admin/workspaces/${workspace}/members`,
      payload: { userId: target, role: "admin", reason: " 项目负责人 " } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ member: { userId: target, workspaceId: workspace, role: "admin" } });
    expect(adminUserService.addMember).toHaveBeenCalledWith(user.id, {
      workspaceId: workspace, userId: target, role: "admin", reason: "项目负责人" });
  });

  it("never accepts the owner role through the console", async () => {
    const adminUserService = service();
    const app = await makeApp(adminUserService);
    const add = await app.inject({ method: "POST", url: `/api/admin/workspaces/${workspace}/members`,
      payload: { userId: target, role: "owner", reason: "移交" } });
    expect(add.statusCode).toBe(400);
    const patch = await app.inject({ method: "PATCH", url: `/api/admin/workspaces/${workspace}/members/${target}`,
      payload: { role: "owner", reason: "移交" } });
    expect(patch.statusCode).toBe(400);
    expect(adminUserService.addMember).not.toHaveBeenCalled();
    expect(adminUserService.setMemberRole).not.toHaveBeenCalled();
  });

  it("rejects malformed ids, roles and reasons before the service", async () => {
    const adminUserService = service();
    const app = await makeApp(adminUserService);
    for (const [method, url, payload] of [
      ["POST", "/api/admin/workspaces/not-a-uuid/members", { userId: target, role: "member", reason: "原因" }],
      ["POST", `/api/admin/workspaces/${workspace}/members`, { userId: "not-a-uuid", role: "member", reason: "原因" }],
      ["POST", `/api/admin/workspaces/${workspace}/members`, { userId: target, role: "boss", reason: "原因" }],
      ["POST", `/api/admin/workspaces/${workspace}/members`, { userId: target, role: "member", reason: "x" }],
      ["PATCH", `/api/admin/workspaces/${workspace}/members/${target}`, { role: "member", reason: "x" }],
      ["DELETE", `/api/admin/workspaces/${workspace}/members/${target}`, {}],
    ] as const) {
      const response = await app.inject({ method, url, payload });
      expect(response.statusCode, `${method} ${url}`).toBe(400);
    }
    expect(adminUserService.addMember).not.toHaveBeenCalled();
    expect(adminUserService.setMemberRole).not.toHaveBeenCalled();
    expect(adminUserService.removeMember).not.toHaveBeenCalled();
  });

  it("changes and removes a membership through their routes", async () => {
    const adminUserService = service();
    const app = await makeApp(adminUserService);
    const patch = await app.inject({ method: "PATCH", url: `/api/admin/workspaces/${workspace}/members/${target}`,
      payload: { role: "member", reason: "降级" } });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toEqual({ member: { userId: target, workspaceId: workspace, role: "member" } });

    const remove = await app.inject({ method: "DELETE", url: `/api/admin/workspaces/${workspace}/members/${target}`,
      payload: { reason: "离职" } });
    expect(remove.statusCode).toBe(200);
    expect(remove.json()).toEqual({ member: { userId: target, workspaceId: workspace, removed: true } });
  });

  it("maps refusals to their status and never leaks the raw message", async () => {
    for (const [code, status] of [["admin_owner_immutable", 409], ["admin_member_not_found", 404],
      ["admin_workspace_not_found", 404], ["admin_member_already_exists", 409]] as const) {
      const adminUserService = service({
        removeMember: vi.fn(async () => { throw new AdminUserError(code, "不能移除所有者。", status); }),
      });
      const app = await makeApp(adminUserService);
      const response = await app.inject({ method: "DELETE", url: `/api/admin/workspaces/${workspace}/members/${target}`,
        payload: { reason: "离职" } });
      expect(response.statusCode, code).toBe(status);
      expect(response.json(), code).toMatchObject({ error: { code } });
    }
  });

  it("maps an unexpected failure to 500 without leaking the internal message", async () => {
    const app = await makeApp(service({
      searchUsers: vi.fn(async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432"); }),
    }));
    const response = await app.inject({ method: "GET", url: "/api/admin/users" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "admin_write_failed" } });
    expect(response.body).not.toContain("10.0.0.5");
  });
});
