import type {
  AdminAssignableRole,
  AdminUserDirectoryResponse,
  AdminWorkspaceDirectoryResponse,
  AdminWriteErrorCode,
} from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { isActivePlatformAdmin } from "./platform-admin.js";

/**
 * Platform-level user directory and cross-workspace membership management.
 *
 * Reads are one RPC call each (`admin_user_directory`, `admin_workspace_directory`)
 * because per-user 30-day aggregates would otherwise be N+1 PostgREST queries.
 * Writes go through the audited membership functions, exactly like the platform
 * admin grant/revoke path: this service authorizes, validates and translates
 * database refusals; it never writes `workspace_members` itself.
 */

const USER_PAGE_MAX = 100;
const WORKSPACE_PAGE_MAX = 100;

export class AdminUserError extends Error {
  constructor(
    readonly code: AdminWriteErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "AdminUserError";
  }
}

export type AdminUserService = {
  searchUsers(actorUserId: string, input?: { query?: string; userId?: string; limit?: number; offset?: number }): Promise<AdminUserDirectoryResponse>;
  searchWorkspaces(actorUserId: string, input?: { query?: string; limit?: number }): Promise<AdminWorkspaceDirectoryResponse>;
  addMember(actorUserId: string, input: { workspaceId: string; userId: string; role: AdminAssignableRole; reason: string }): Promise<{ userId: string; workspaceId: string; role: AdminAssignableRole }>;
  setMemberRole(actorUserId: string, input: { workspaceId: string; userId: string; role: AdminAssignableRole; reason: string }): Promise<{ userId: string; workspaceId: string; role: AdminAssignableRole }>;
  removeMember(actorUserId: string, input: { workspaceId: string; userId: string; reason: string }): Promise<{ userId: string; workspaceId: string; removed: true }>;
};

/**
 * `admin_audit_events`, the directory functions and the membership functions are
 * newer than the checked-in Database type map (maintained by hand in this repo),
 * so these calls use a loose view of the same client. Everything else is typed.
 */
type LooseAdmin = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};
const loose = (client: AdminSupabaseClient) => client as unknown as LooseAdmin;

const WORKSPACE_MEMBER_NAMES: Record<string, string> = {
  owner: "所有者",
  admin: "管理员",
  member: "成员",
};

export const adminMemberRoleLabel = (role: string): string => WORKSPACE_MEMBER_NAMES[role] ?? role;

function fromDatabaseError(error: { message?: string } | null): AdminUserError {
  const message = error?.message ?? "";
  if (message.includes("FORBIDDEN")) {
    return new AdminUserError("platform_admin_required", "需要平台管理员权限才能执行该操作。", 403);
  }
  if (message.includes("REASON_REQUIRED")) {
    return new AdminUserError("admin_reason_required", "该操作必须填写原因（至少 2 个字符）。", 400);
  }
  if (message.includes("UNKNOWN_USER")) {
    return new AdminUserError("admin_user_not_found", "该用户不存在。", 404);
  }
  if (message.includes("UNKNOWN_WORKSPACE")) {
    return new AdminUserError("admin_workspace_not_found", "该工作区不存在。", 404);
  }
  if (message.includes("ALREADY_MEMBER")) {
    return new AdminUserError("admin_member_already_exists", "该用户已经是这个工作区的成员。", 409);
  }
  if (message.includes("NOT_MEMBER")) {
    return new AdminUserError("admin_member_not_found", "该用户不是这个工作区的成员。", 404);
  }
  if (message.includes("OWNER_IMMUTABLE")) {
    return new AdminUserError("admin_owner_immutable",
      "工作区所有者的成员身份不能在后台修改或移除。", 409);
  }
  if (message.includes("INVALID_ROLE")) {
    return new AdminUserError("admin_invalid_role",
      "后台只能授予管理员或成员角色；所有者变更需要单独的移交流程。", 400);
  }
  return new AdminUserError("admin_write_failed", "操作失败，请稍后重试。", 500);
}

function boundedLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

export function createAdminUserService(options: {
  getAdminClient: () => AdminSupabaseClient;
}): AdminUserService {
  const admin = () => options.getAdminClient();

  async function assertActor(actorUserId: string): Promise<void> {
    if (!(await isActivePlatformAdmin(admin(), actorUserId))) {
      throw new AdminUserError("platform_admin_required", "需要平台管理员权限才能执行该操作。", 403);
    }
  }

  async function callFunction(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await loose(admin()).rpc(name, args);
    if (error) throw fromDatabaseError(error);
    return data;
  }

  return {
    async searchUsers(actorUserId, input) {
      await assertActor(actorUserId);
      const data = await callFunction("admin_user_directory", {
        p_actor_user_id: actorUserId,
        p_query: input?.query?.trim() ?? null,
        p_user_id: input?.userId ?? null,
        p_limit: boundedLimit(input?.limit, 25, USER_PAGE_MAX),
        p_offset: Math.max(Math.trunc(input?.offset ?? 0), 0),
      });
      const parsed = data as { total?: unknown; users?: unknown } | null;
      const total = Number(parsed?.total);
      return {
        // A malformed payload must not become NaN: the response schema would
        // reject it downstream and turn a read into a 500.
        total: Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0,
        users: (Array.isArray(parsed?.users) ? parsed!.users : []) as AdminUserDirectoryResponse["users"],
      };
    },

    async searchWorkspaces(actorUserId, input) {
      await assertActor(actorUserId);
      const data = await callFunction("admin_workspace_directory", {
        p_actor_user_id: actorUserId,
        p_query: input?.query?.trim() ?? null,
        p_limit: boundedLimit(input?.limit, 25, WORKSPACE_PAGE_MAX),
      });
      const parsed = data as { workspaces?: unknown } | null;
      return { workspaces: (Array.isArray(parsed?.workspaces) ? parsed!.workspaces : []) as AdminWorkspaceDirectoryResponse["workspaces"] };
    },

    async addMember(actorUserId, input) {
      await assertActor(actorUserId);
      await callFunction("admin_add_workspace_member", {
        p_actor_user_id: actorUserId,
        p_workspace_id: input.workspaceId,
        p_user_id: input.userId,
        p_role: input.role,
        p_reason: input.reason.trim(),
      });
      return { userId: input.userId, workspaceId: input.workspaceId, role: input.role };
    },

    async setMemberRole(actorUserId, input) {
      await assertActor(actorUserId);
      await callFunction("admin_set_workspace_member_role", {
        p_actor_user_id: actorUserId,
        p_workspace_id: input.workspaceId,
        p_user_id: input.userId,
        p_role: input.role,
        p_reason: input.reason.trim(),
      });
      return { userId: input.userId, workspaceId: input.workspaceId, role: input.role };
    },

    async removeMember(actorUserId, input) {
      await assertActor(actorUserId);
      await callFunction("admin_remove_workspace_member", {
        p_actor_user_id: actorUserId,
        p_workspace_id: input.workspaceId,
        p_user_id: input.userId,
        p_reason: input.reason.trim(),
      });
      return { userId: input.userId, workspaceId: input.workspaceId, removed: true as const };
    },
  };
}
