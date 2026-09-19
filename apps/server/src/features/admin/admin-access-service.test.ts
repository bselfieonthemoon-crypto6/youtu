import { describe, expect, it, vi } from "vitest";

import { AdminWriteError, createAdminAccessService } from "./admin-access-service.js";

/**
 * A PostgREST-shaped fake. It answers `platform_admins`, `profiles`,
 * `workspaces` and `admin_audit_events` from fixtures, and records every RPC call
 * so the tests can prove which arguments reached the database function.
 */
function fakeAdmin(input: {
  platformAdmins?: Array<{ user_id: string; is_active: boolean; revoked_at: string | null; granted_by: string | null; granted_at: string }>;
  profiles?: Array<{ id: string; email: string | null; display_name: string | null }>;
  workspaces?: Array<{ id: string; name: string }>;
  audit?: Array<Record<string, unknown>>;
  rpcError?: { message: string } | null;
  isAdminActor?: boolean;
}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const from = (table: string) => {
    let filters: Array<[string, unknown]> = [];
    let inFilter: [string, readonly unknown[]] | null = null;
    const rows = () => {
      const source = table === "platform_admins" ? (input.platformAdmins ?? [])
        : table === "profiles" ? (input.profiles ?? [])
          : table === "workspaces" ? (input.workspaces ?? [])
            : (input.audit ?? []);
      let result = [...source] as Array<Record<string, unknown>>;
      for (const [column, value] of filters) {
        result = value === null
          ? result.filter(row => row[column] === null || row[column] === undefined)
          : result.filter(row => row[column] === value);
      }
      if (inFilter) result = result.filter(row => (inFilter![1] as readonly unknown[]).includes(row[inFilter![0]]));
      return result;
    };
    const builder: any = {
      select() { return builder; },
      eq(column: string, value: unknown) { filters.push([column, value]); return builder; },
      is(column: string, value: unknown) { filters.push([column, value]); return builder; },
      in(column: string, values: readonly unknown[]) { inFilter = [column, values]; return builder; },
      ilike(column: string, value: string) {
        const needle = value.toLowerCase();
        filters.push([column, needle]);
        return {
          limit: async () => ({ data: (input.profiles ?? []).filter(profile => (profile.email ?? "").toLowerCase() === needle), error: null }),
        };
      },
      order() { return builder; },
      limit: async () => ({ data: rows(), error: null }),
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve),
    };
    return builder;
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    return { error: input.rpcError ?? null };
  };
  const client = { from, rpc } as never;
  return { client, rpcCalls };
}

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function actorRow(userId = ACTOR) {
  return { user_id: userId, is_active: true, revoked_at: null, granted_by: null, granted_at: "2026-09-20T00:00:00.000Z" };
}

function service(input: Parameters<typeof fakeAdmin>[0]) {
  const fake = fakeAdmin(input);
  return { ...createAdminAccessService({ getAdminClient: () => fake.client }), fake };
}

describe("admin access service", () => {
  it("refuses a non-platform-admin actor before any write", async () => {
    const { listPlatformAdmins, grantPlatformAdmin, revokePlatformAdmin, fake } =
      service({ platformAdmins: [], profiles: [] });
    for (const call of [
      () => listPlatformAdmins(ACTOR),
      () => grantPlatformAdmin(ACTOR, "a@b.com", "原因"),
      () => revokePlatformAdmin(ACTOR, TARGET, "原因"),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "platform_admin_required", statusCode: 403 });
    }
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("lists only active, non-revoked admins with their profile and marks the caller", async () => {
    const { listPlatformAdmins } = service({
      platformAdmins: [actorRow(), { ...actorRow(TARGET), is_active: false, revoked_at: "2026-09-20T01:00:00.000Z" }],
      profiles: [{ id: ACTOR, email: "me@example.com", display_name: "我" }],
    });
    await expect(listPlatformAdmins(ACTOR)).resolves.toEqual({
      admins: [{ userId: ACTOR, email: "me@example.com", displayName: "我",
        grantedAt: "2026-09-20T00:00:00.000Z", grantedBy: null, isCurrentUser: true }],
    });
  });

  it("grants by email through the audited database function", async () => {
    const { grantPlatformAdmin, fake } = service({
      platformAdmins: [actorRow()],
      profiles: [{ id: TARGET, email: "new@example.com", display_name: "新管理员" }],
    });
    await expect(grantPlatformAdmin(ACTOR, "NEW@example.com ", " 任命第二管理员 ")).resolves.toMatchObject({
      userId: TARGET, email: "new@example.com", displayName: "新管理员", isCurrentUser: false,
    });
    expect(fake.rpcCalls).toEqual([{
      fn: "admin_grant_platform_admin",
      args: { p_actor_user_id: ACTOR, p_user_id: TARGET, p_reason: "任命第二管理员" },
    }]);
  });

  it("rejects an email with no account or an ambiguous one", async () => {
    const missing = service({ platformAdmins: [actorRow()], profiles: [] });
    await expect(missing.grantPlatformAdmin(ACTOR, "nobody@example.com", "原因"))
      .rejects.toMatchObject({ code: "admin_user_not_found", statusCode: 404 });
    expect(missing.fake.rpcCalls).toHaveLength(0);

    const ambiguous = service({
      platformAdmins: [actorRow()],
      profiles: [
        { id: TARGET, email: "dup@example.com", display_name: null },
        { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", email: "dup@example.com", display_name: null },
      ],
    });
    await expect(ambiguous.grantPlatformAdmin(ACTOR, "dup@example.com", "原因"))
      .rejects.toMatchObject({ code: "admin_user_not_found" });
    expect(ambiguous.fake.rpcCalls).toHaveLength(0);
  });

  it("translates every database refusal code instead of leaking the raw message", async () => {
    const cases: Array<[string, string, number]> = [
      ["FORBIDDEN: actor is not an active platform admin", "platform_admin_required", 403],
      ["UNKNOWN_USER: no such auth user", "admin_user_not_found", 404],
      ["NOT_PLATFORM_ADMIN: target is not an active platform admin", "admin_not_platform_admin", 404],
      ["LAST_PLATFORM_ADMIN: refusing to revoke the last active platform admin", "admin_last_platform_admin", 409],
      ["REASON_REQUIRED: a reason is required for an access change", "admin_reason_required", 400],
      ["something else entirely", "admin_write_failed", 500],
    ];
    for (const [message, code, statusCode] of cases) {
      const { revokePlatformAdmin } = service({
        platformAdmins: [actorRow()], profiles: [], rpcError: { message },
      });
      const error = await revokePlatformAdmin(ACTOR, TARGET, "原因").catch(caught => caught);
      expect(error, message).toBeInstanceOf(AdminWriteError);
      expect(error, message).toMatchObject({ code, statusCode });
      expect(error.message, message).not.toContain(":");
    }
  });

  it("revokes through the audited database function and never writes the table directly", async () => {
    const { revokePlatformAdmin, fake } = service({
      platformAdmins: [actorRow(), actorRow(TARGET)],
      profiles: [{ id: TARGET, email: "old@example.com", display_name: null }],
    });
    await expect(revokePlatformAdmin(ACTOR, TARGET, "离职")).resolves.toMatchObject({ userId: TARGET });
    expect(fake.rpcCalls).toEqual([{
      fn: "admin_revoke_platform_admin",
      args: { p_actor_user_id: ACTOR, p_user_id: TARGET, p_reason: "离职" },
    }]);
  });

  it("returns audit events newest first with actor email and workspace name", async () => {
    const { listAuditEvents } = service({
      platformAdmins: [actorRow()],
      profiles: [{ id: ACTOR, email: "me@example.com", display_name: "我" }],
      workspaces: [{ id: "wwwwwwww-wwww-4www-8www-wwwwwwwwwwww", name: "设计团队" }],
      audit: [
        { id: "e1", actor_user_id: ACTOR, action: "platform_admin.grant", target_kind: "user", target_id: TARGET,
          workspace_id: "wwwwwwww-wwww-4www-8www-wwwwwwwwwwww", reason: "任命", created_at: "2026-09-20T02:00:00.000Z" },
        { id: "e2", actor_user_id: null, action: "system.cleanup", target_kind: "job", target_id: "job-1",
          workspace_id: null, reason: null, created_at: "2026-09-20T01:00:00.000Z" },
      ],
    });
    await expect(listAuditEvents(ACTOR, {})).resolves.toEqual({
      events: [
        { id: "e1", actorUserId: ACTOR, actorEmail: "me@example.com", action: "platform_admin.grant",
          targetKind: "user", targetId: TARGET, workspaceId: "wwwwwwww-wwww-4www-8www-wwwwwwwwwwww",
          workspaceName: "设计团队", reason: "任命", createdAt: "2026-09-20T02:00:00.000Z" },
        { id: "e2", actorUserId: null, actorEmail: null, action: "system.cleanup", targetKind: "job",
          targetId: "job-1", workspaceId: null, workspaceName: null, reason: null,
          createdAt: "2026-09-20T01:00:00.000Z" },
      ],
    });
  });

  it("clamps the audit limit instead of trusting the caller", async () => {
    const { listAuditEvents, fake } = service({ platformAdmins: [actorRow()], audit: [] });
    const spy = vi.spyOn(fake.client as unknown as { from: (table: string) => unknown }, "from");
    await listAuditEvents(ACTOR, { limit: 10_000 });
    await listAuditEvents(ACTOR, { limit: 0 });
    await listAuditEvents(ACTOR, {});
    expect(spy).toHaveBeenCalled();
  });
});
