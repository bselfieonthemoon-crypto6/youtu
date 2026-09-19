import type {
  AdminAuditEventView,
  AdminAuditListResponse,
  AdminPlatformAdminListResponse,
  AdminPlatformAdminView,
  AdminWriteErrorCode,
} from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { isActivePlatformAdmin } from "./platform-admin.js";

/**
 * Platform-admin access management plus the read side of the audit trail.
 *
 * Every write goes through a database function that re-checks the actor, applies
 * the change and writes the audit row in one transaction, so this service never
 * performs a privileged table write itself. Its job is to authorize, resolve
 * inputs, and translate the database's refusal codes into typed HTTP errors.
 */

const AUDIT_LIMIT_DEFAULT = 50;
const AUDIT_LIMIT_MAX = 200;

export class AdminWriteError extends Error {
  constructor(
    readonly code: AdminWriteErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "AdminWriteError";
  }
}

export type AdminAccessService = {
  listPlatformAdmins(actorUserId: string): Promise<AdminPlatformAdminListResponse>;
  grantPlatformAdmin(actorUserId: string, email: string, reason: string): Promise<AdminPlatformAdminView>;
  revokePlatformAdmin(actorUserId: string, targetUserId: string, reason: string): Promise<AdminPlatformAdminView>;
  listAuditEvents(actorUserId: string, options?: { limit?: number; targetKind?: string; targetId?: string }): Promise<AdminAuditListResponse>;
};

/** Map a database refusal onto the HTTP contract, never leaking the raw message. */
function fromDatabaseError(error: { message?: string } | null): AdminWriteError {
  const message = error?.message ?? "";
  if (message.includes("FORBIDDEN")) {
    return new AdminWriteError("platform_admin_required", "需要平台管理员权限才能执行该操作。", 403);
  }
  if (message.includes("UNKNOWN_USER")) {
    return new AdminWriteError("admin_user_not_found", "该邮箱没有对应的账号。", 404);
  }
  if (message.includes("NOT_PLATFORM_ADMIN")) {
    return new AdminWriteError("admin_not_platform_admin", "该用户当前不是平台管理员。", 404);
  }
  if (message.includes("LAST_PLATFORM_ADMIN")) {
    return new AdminWriteError("admin_last_platform_admin",
      "不能撤销最后一个平台管理员：撤销后将没有人能进入管理后台。", 409);
  }
  if (message.includes("REASON_REQUIRED")) {
    return new AdminWriteError("admin_reason_required", "该操作必须填写原因（至少 2 个字符）。", 400);
  }
  return new AdminWriteError("admin_write_failed", "操作失败，请稍后重试。", 500);
}

function bounded(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * `admin_audit_events` and the two admin RPCs are newer than the checked-in
 * Database type map, which this repo maintains by hand (the same reason
 * `http/skills.ts` has its own `untypedFrom`). Only these calls go through the
 * loose view; every other query stays typed.
 */
type LooseAdmin = {
  from: (table: string) => any;
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: { message?: string } | null }>;
};
const loose = (client: AdminSupabaseClient) => client as unknown as LooseAdmin;

/** Shape of one `admin_audit_events` row, declared here because the loose view erases types. */
type AdminAuditRow = {
  id: string;
  actor_user_id: string | null;
  action: string;
  target_kind: string;
  target_id: string;
  workspace_id: string | null;
  reason: string | null;
  created_at: string;
};

export function createAdminAccessService(options: {
  getAdminClient: () => AdminSupabaseClient;
}): AdminAccessService {
  const admin = () => options.getAdminClient();

  async function assertActor(actorUserId: string): Promise<void> {
    if (!(await isActivePlatformAdmin(admin(), actorUserId))) {
      throw new AdminWriteError("platform_admin_required", "需要平台管理员权限才能执行该操作。", 403);
    }
  }

  async function profileFor(userIds: readonly string[]): Promise<Map<string, { email: string | null; displayName: string | null }>> {
    const distinct = [...new Set(userIds)];
    if (!distinct.length) return new Map();
    const { data, error } = await admin().from("profiles").select("id,email,display_name").in("id", distinct);
    if (error) throw new AdminWriteError("admin_write_failed", "操作失败，请稍后重试。", 500);
    return new Map((data ?? []).map(row => [row.id, { email: row.email ?? null, displayName: row.display_name ?? null }]));
  }

  async function viewFor(userId: string, actorUserId: string): Promise<AdminPlatformAdminView> {
    const { data, error } = await admin().from("platform_admins")
      .select("user_id,is_active,revoked_at,granted_by,granted_at")
      .eq("user_id", userId).maybeSingle();
    if (error) throw new AdminWriteError("admin_write_failed", "操作失败，请稍后重试。", 500);
    const profile = (await profileFor([userId])).get(userId);
    return {
      userId,
      email: profile?.email ?? null,
      displayName: profile?.displayName ?? null,
      grantedAt: data?.granted_at ?? null,
      grantedBy: data?.granted_by ?? null,
      isCurrentUser: userId === actorUserId,
    };
  }

  return {
    async listPlatformAdmins(actorUserId) {
      await assertActor(actorUserId);
      const { data, error } = await admin().from("platform_admins")
        .select("user_id,is_active,revoked_at,granted_by,granted_at")
        .eq("is_active", true).is("revoked_at", null)
        .order("granted_at", { ascending: true });
      if (error) throw new AdminWriteError("admin_write_failed", "操作失败，请稍后重试。", 500);
      const rows = data ?? [];
      const profiles = await profileFor(rows.map(row => row.user_id));
      return {
        admins: rows.map(row => ({
          userId: row.user_id,
          email: profiles.get(row.user_id)?.email ?? null,
          displayName: profiles.get(row.user_id)?.displayName ?? null,
          grantedAt: row.granted_at ?? null,
          grantedBy: row.granted_by ?? null,
          isCurrentUser: row.user_id === actorUserId,
        })),
      };
    },

    async grantPlatformAdmin(actorUserId, email, reason) {
      await assertActor(actorUserId);
      const normalized = email.trim().toLowerCase();
      const { data: profile, error: profileError } = await admin().from("profiles")
        .select("id,email").ilike("email", normalized).limit(2);
      if (profileError) throw new AdminWriteError("admin_write_failed", "操作失败，请稍后重试。", 500);
      const matches = profile ?? [];
      if (matches.length !== 1) {
        throw new AdminWriteError("admin_user_not_found",
          matches.length ? "该邮箱匹配到多个账号，请直接给用户 id 授权。" : "该邮箱没有对应的账号。", 404);
      }
      const { error } = await loose(admin()).rpc("admin_grant_platform_admin", {
        p_actor_user_id: actorUserId,
        p_user_id: matches[0]!.id,
        p_reason: reason.trim(),
      });
      if (error) throw fromDatabaseError(error);
      return viewFor(matches[0]!.id, actorUserId);
    },

    async revokePlatformAdmin(actorUserId, targetUserId, reason) {
      await assertActor(actorUserId);
      const { error } = await loose(admin()).rpc("admin_revoke_platform_admin", {
        p_actor_user_id: actorUserId,
        p_user_id: targetUserId,
        p_reason: reason.trim(),
      });
      if (error) throw fromDatabaseError(error);
      return viewFor(targetUserId, actorUserId);
    },

    async listAuditEvents(actorUserId, listOptions) {
      await assertActor(actorUserId);
      const limit = Math.min(Math.max(Math.trunc(listOptions?.limit ?? AUDIT_LIMIT_DEFAULT), 1), AUDIT_LIMIT_MAX);
      let query: any = loose(admin()).from("admin_audit_events")
        .select("id,actor_user_id,action,target_kind,target_id,workspace_id,reason,created_at");
      if (listOptions?.targetKind) query = query.eq("target_kind", listOptions.targetKind);
      if (listOptions?.targetId) query = query.eq("target_id", listOptions.targetId);
      const { data, error } = (await query.order("created_at", { ascending: false }).limit(limit)) as {
        data: AdminAuditRow[] | null; error: { message?: string } | null;
      };
      if (error) throw new AdminWriteError("admin_write_failed", "操作失败，请稍后重试。", 500);
      const rows: AdminAuditRow[] = data ?? [];
      const profiles = await profileFor(rows.map(row => row.actor_user_id).filter((id): id is string => typeof id === "string"));
      const workspaceIds = rows.map(row => row.workspace_id).filter((id): id is string => typeof id === "string");
      const workspaceNames = new Map<string, string>();
      if (workspaceIds.length) {
        const { data: workspaces, error: workspaceError } = await admin().from("workspaces")
          .select("id,name").in("id", [...new Set(workspaceIds)]);
        if (workspaceError) throw new AdminWriteError("admin_write_failed", "操作失败，请稍后重试。", 500);
        for (const row of workspaces ?? []) workspaceNames.set(row.id, row.name);
      }
      const events: AdminAuditEventView[] = rows.map(row => ({
        id: row.id,
        actorUserId: row.actor_user_id ?? null,
        actorEmail: typeof row.actor_user_id === "string" ? profiles.get(row.actor_user_id)?.email ?? null : null,
        action: row.action,
        targetKind: row.target_kind,
        targetId: row.target_id,
        workspaceId: row.workspace_id ?? null,
        workspaceName: typeof row.workspace_id === "string" ? workspaceNames.get(row.workspace_id) ?? null : null,
        reason: bounded(row.reason, 500),
        createdAt: row.created_at,
      }));
      return { events };
    },
  };
}
