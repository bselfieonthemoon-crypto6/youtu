import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceMemberService } from "../features/members/index.js";
import { registerWorkspaceMemberRoutes } from "./workspace-members.js";

const user = { id: "user-1", email: "owner@example.com", accessToken: "token", userMetadata: {} };
const member = {
  userId: "user-2",
  email: "member@example.com",
  displayName: "Member",
  avatarUrl: null,
  role: "member" as const,
  joinedAt: "2026-09-03T00:00:00.000Z",
  isCurrentUser: false,
};

function service(): WorkspaceMemberService {
  return {
    list: vi.fn().mockResolvedValue([member]),
    add: vi.fn().mockResolvedValue(member),
    updateRole: vi.fn().mockResolvedValue({ ...member, role: "admin" }),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function makeApp(memberService: WorkspaceMemberService, authenticated = true) {
  const app = Fastify();
  apps.push(app);
  await registerWorkspaceMemberRoutes(app, {
    auth: { authenticate: vi.fn().mockResolvedValue(authenticated ? user : null) } as any,
    memberService,
    viewerService: { ensureViewer: vi.fn().mockResolvedValue({ workspace: { id: "workspace-1" } }) } as any,
  });
  return app;
}

describe("workspace member routes", () => {
  it("requires authentication", async () => {
    const memberService = service();
    const response = await (await makeApp(memberService, false)).inject({ method: "GET", url: "/api/workspace/members" });
    expect(response.statusCode).toBe(401);
    expect(memberService.list).not.toHaveBeenCalled();
  });

  it("binds member listing to the authenticated viewer workspace", async () => {
    const memberService = service();
    const response = await (await makeApp(memberService)).inject({ method: "GET", url: "/api/workspace/members" });
    expect(response.statusCode).toBe(200);
    expect(memberService.list).toHaveBeenCalledWith(user, "workspace-1");
    expect(response.json().members).toEqual([member]);
  });

  it("validates email and manageable roles before adding a user", async () => {
    const memberService = service();
    const app = await makeApp(memberService);
    const badEmail = await app.inject({ method: "POST", url: "/api/workspace/members", payload: { email: "bad", role: "member" } });
    const ownerRole = await app.inject({ method: "POST", url: "/api/workspace/members", payload: { email: "new@example.com", role: "owner" } });
    expect(badEmail.statusCode).toBe(422);
    expect(ownerRole.statusCode).toBe(422);
    expect(memberService.add).not.toHaveBeenCalled();
  });

  it("updates and removes the selected member", async () => {
    const memberService = service();
    const app = await makeApp(memberService);
    expect((await app.inject({ method: "PATCH", url: "/api/workspace/members/user-2", payload: { role: "admin" } })).statusCode).toBe(200);
    expect(memberService.updateRole).toHaveBeenCalledWith(user, "workspace-1", "user-2", "admin");
    expect((await app.inject({ method: "DELETE", url: "/api/workspace/members/user-2" })).statusCode).toBe(204);
    expect(memberService.remove).toHaveBeenCalledWith(user, "workspace-1", "user-2");
  });
});
