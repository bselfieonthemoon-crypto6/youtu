import { describe, expect, it, vi } from "vitest";

import { AdminUserError, adminMemberRoleLabel, createAdminUserService } from "./admin-user-service.js";

/**
 * The service talks to four database functions through the loose client view.
 * This fake records every call and answers from fixtures, so the tests can prove
 * exactly which arguments reach the database and how refusals are translated.
 */
function fakeAdmin(input: {
  isActorAdmin?: boolean;
  directory?: unknown;
  workspaces?: unknown;
  rpcError?: { message: string } | null;
}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const from = (table: string) => {
    const builder: any = {
      select() { return builder; },
      eq() { return builder; },
      is() { return builder; },
      maybeSingle: async () => ({
        data: table === "platform_admins" && input.isActorAdmin !== false ? { user_id: "actor" } : null,
        error: null,
      }),
    };
    return builder;
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    if (input.rpcError) return { data: null, error: input.rpcError };
    if (fn === "admin_user_directory") return { data: input.directory ?? { total: 0, users: [] }, error: null };
    if (fn === "admin_workspace_directory") return { data: input.workspaces ?? { workspaces: [] }, error: null };
    return { data: {}, error: null };
  };
  return { client: { from, rpc } as never, rpcCalls };
}

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function service(input: Parameters<typeof fakeAdmin>[0]) {
  const fake = fakeAdmin(input);
  return { ...createAdminUserService({ getAdminClient: () => fake.client }), fake };
}

describe("admin user service", () => {
  it("refuses a non-platform-admin actor before any read or write", async () => {
    const { searchUsers, searchWorkspaces, addMember, setMemberRole, removeMember, fake } =
      service({ isActorAdmin: false });
    const calls = [
      () => searchUsers(ACTOR),
      () => searchWorkspaces(ACTOR),
      () => addMember(ACTOR, { workspaceId: WORKSPACE, userId: TARGET, role: "member", reason: "入职" }),
      () => setMemberRole(ACTOR, { workspaceId: WORKSPACE, userId: TARGET, role: "admin", reason: "升职" }),
      () => removeMember(ACTOR, { workspaceId: WORKSPACE, userId: TARGET, reason: "离职" }),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: "platform_admin_required", statusCode: 403 });
    }
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("passes the search, page and user filters to the directory function", async () => {
    const { searchUsers, fake } = service({
      directory: { total: 37, users: [{ userId: TARGET, email: "a@b.com", displayName: null, createdAt: "2026-09-01T00:00:00.000Z",
        isPlatformAdmin: false, lastActiveAt: null, runs30d: 0, jobs30d: 0, creditsSpent30d: 0, workspaces: [] }] },
    });
    await expect(searchUsers(ACTOR, { query: "  a@b.com  ", limit: 10, offset: 20 })).resolves.toMatchObject({ total: 37 });
    expect(fake.rpcCalls[0]).toEqual({
      fn: "admin_user_directory",
      args: { p_actor_user_id: ACTOR, p_query: "a@b.com", p_user_id: null, p_limit: 10, p_offset: 20 },
    });
  });

  it("clamps the page size and never sends a negative offset", async () => {
    const { searchUsers, searchWorkspaces, fake } = service({});
    await searchUsers(ACTOR, { limit: 10_000, offset: -5 });
    await searchUsers(ACTOR, {});
    await searchWorkspaces(ACTOR, { limit: 0 });
    expect(fake.rpcCalls[0]!.args).toMatchObject({ p_limit: 100, p_offset: 0 });
    expect(fake.rpcCalls[1]!.args).toMatchObject({ p_limit: 25, p_offset: 0 });
    expect(fake.rpcCalls[2]!.args).toMatchObject({ p_limit: 1 });
  });

  it("tolerates a malformed directory payload instead of throwing", async () => {
    const { searchUsers } = service({ directory: { total: "nope", users: "nope" } });
    await expect(searchUsers(ACTOR)).resolves.toEqual({ total: 0, users: [] });
    const { searchWorkspaces } = service({ workspaces: null });
    await expect(searchWorkspaces(ACTOR)).resolves.toEqual({ workspaces: [] });
  });

  it("adds a member through the audited function with a trimmed reason", async () => {
    const { addMember, fake } = service({});
    await expect(addMember(ACTOR, { workspaceId: WORKSPACE, userId: TARGET, role: "admin", reason: "  项目负责人  " }))
      .resolves.toEqual({ userId: TARGET, workspaceId: WORKSPACE, role: "admin" });
    expect(fake.rpcCalls).toEqual([{
      fn: "admin_add_workspace_member",
      args: { p_actor_user_id: ACTOR, p_workspace_id: WORKSPACE, p_user_id: TARGET, p_role: "admin", p_reason: "项目负责人" },
    }]);
  });

  it("changes a role and removes a member through their audited functions", async () => {
    const { setMemberRole, removeMember, fake } = service({});
    await setMemberRole(ACTOR, { workspaceId: WORKSPACE, userId: TARGET, role: "member", reason: "调整" });
    await removeMember(ACTOR, { workspaceId: WORKSPACE, userId: TARGET, reason: "离职" });
    expect(fake.rpcCalls.map(call => call.fn)).toEqual([
      "admin_set_workspace_member_role", "admin_remove_workspace_member",
    ]);
    expect(fake.rpcCalls[1]!.args).toEqual({
      p_actor_user_id: ACTOR, p_workspace_id: WORKSPACE, p_user_id: TARGET, p_reason: "离职",
    });
  });

  it("translates every membership refusal code instead of leaking the raw message", async () => {
    const cases: Array<[string, string, number]> = [
      ["FORBIDDEN: actor is not an active platform admin", "platform_admin_required", 403],
      ["REASON_REQUIRED: a reason is required for a membership change", "admin_reason_required", 400],
      ["UNKNOWN_USER: no such auth user", "admin_user_not_found", 404],
      ["UNKNOWN_WORKSPACE: no such workspace", "admin_workspace_not_found", 404],
      ["ALREADY_MEMBER: the user is already a member of this workspace", "admin_member_already_exists", 409],
      ["NOT_MEMBER: the user is not a member of this workspace", "admin_member_not_found", 404],
      ["OWNER_IMMUTABLE: the workspace owner membership cannot be removed here", "admin_owner_immutable", 409],
      ["INVALID_ROLE: ownership transfer is not available in this console", "admin_invalid_role", 400],
      ["unexpected database explosion", "admin_write_failed", 500],
    ];
    for (const [message, code, statusCode] of cases) {
      const { addMember } = service({ rpcError: { message } });
      const error = await addMember(ACTOR, { workspaceId: WORKSPACE, userId: TARGET, role: "member", reason: "入职" })
        .catch(caught => caught);
      expect(error, message).toBeInstanceOf(AdminUserError);
      expect(error, message).toMatchObject({ code, statusCode });
      expect(error.message, message).not.toContain(":");
    }
  });

  it("labels workspace roles for the console", () => {
    expect(adminMemberRoleLabel("owner")).toBe("所有者");
    expect(adminMemberRoleLabel("admin")).toBe("管理员");
    expect(adminMemberRoleLabel("member")).toBe("成员");
    expect(adminMemberRoleLabel("something_new")).toBe("something_new");
    void vi;
  });
});
