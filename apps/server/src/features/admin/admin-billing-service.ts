import type {
  AdminWorkspaceBillingResponse,
  AdminWriteErrorCode,
} from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { isActivePlatformAdmin } from "./platform-admin.js";

/**
 * Platform-admin plan and credit management.
 *
 * Writes are database functions that re-check the actor, require a reason, move
 * the balance through the shared ledger and write the audit row in one
 * transaction. This service authorizes, bounds its inputs and translates the
 * database's refusal codes into HTTP; it never touches `credit_balances`,
 * `subscriptions` or `credit_transactions` directly.
 */

const TRANSACTION_LIMIT_MAX = 100;

export class AdminBillingError extends Error {
  constructor(
    readonly code: AdminWriteErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "AdminBillingError";
  }
}

export type AdminBillingService = {
  getBilling(actorUserId: string, workspaceId: string, limit?: number): Promise<AdminWorkspaceBillingResponse>;
  setPlan(actorUserId: string, input: { workspaceId: string; plan: string; grantCredits: number; reason: string }): Promise<{ plan: string; planBefore: string | null; grantedCredits: number; balance: number }>;
  adjustCredits(actorUserId: string, input: { workspaceId: string; delta: number; reason: string }): Promise<{ delta: number; balance: number }>;
};

/** The billing functions are newer than the hand-maintained Database type map. */
type LooseAdmin = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};
const loose = (client: AdminSupabaseClient) => client as unknown as LooseAdmin;

function fromDatabaseError(error: { message?: string } | null): AdminBillingError {
  const message = error?.message ?? "";
  if (message.includes("FORBIDDEN")) {
    return new AdminBillingError("platform_admin_required", "需要平台管理员权限才能执行该操作。", 403);
  }
  if (message.includes("REASON_REQUIRED")) {
    return new AdminBillingError("admin_reason_required", "该操作必须填写原因（至少 2 个字符）。", 400);
  }
  if (message.includes("UNKNOWN_WORKSPACE")) {
    return new AdminBillingError("admin_workspace_not_found", "该工作区不存在。", 404);
  }
  if (message.includes("INVALID_AMOUNT")) {
    return new AdminBillingError("admin_invalid_amount", "额度数值不合法。", 400);
  }
  if (message.includes("INSUFFICIENT_BALANCE")) {
    return new AdminBillingError("admin_insufficient_balance",
      "该工作区余额不足，扣减后不能为负数。", 409);
  }
  if (message.includes("CONCURRENT_MODIFICATION")) {
    return new AdminBillingError("admin_write_failed", "余额刚刚被其他操作改动，请刷新后重试。", 409);
  }
  return new AdminBillingError("admin_write_failed", "操作失败，请稍后重试。", 500);
}

export function createAdminBillingService(options: {
  getAdminClient: () => AdminSupabaseClient;
}): AdminBillingService {
  const admin = () => options.getAdminClient();

  async function assertActor(actorUserId: string): Promise<void> {
    if (!(await isActivePlatformAdmin(admin(), actorUserId))) {
      throw new AdminBillingError("platform_admin_required", "需要平台管理员权限才能执行该操作。", 403);
    }
  }

  async function callFunction(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await loose(admin()).rpc(name, args);
    if (error) throw fromDatabaseError(error);
    return data;
  }

  return {
    async getBilling(actorUserId, workspaceId, limit) {
      await assertActor(actorUserId);
      const bounded = limit === undefined || !Number.isFinite(limit)
        ? 20
        : Math.min(Math.max(Math.trunc(limit), 1), TRANSACTION_LIMIT_MAX);
      const data = await callFunction("admin_workspace_billing", {
        p_actor_user_id: actorUserId,
        p_workspace_id: workspaceId,
        p_tx_limit: bounded,
      });
      return data as AdminWorkspaceBillingResponse;
    },

    async setPlan(actorUserId, input) {
      await assertActor(actorUserId);
      const data = await callFunction("admin_set_workspace_plan", {
        p_actor_user_id: actorUserId,
        p_workspace_id: input.workspaceId,
        p_plan: input.plan,
        p_grant_credits: input.grantCredits,
        p_reason: input.reason.trim(),
      }) as { plan?: unknown; planBefore?: unknown; grantedCredits?: unknown; balance?: unknown } | null;
      return {
        plan: String(data?.plan ?? input.plan),
        planBefore: typeof data?.planBefore === "string" ? data.planBefore : null,
        grantedCredits: Number(data?.grantedCredits ?? input.grantCredits) || 0,
        balance: Number(data?.balance ?? 0) || 0,
      };
    },

    async adjustCredits(actorUserId, input) {
      await assertActor(actorUserId);
      const data = await callFunction("admin_adjust_credits", {
        p_actor_user_id: actorUserId,
        p_workspace_id: input.workspaceId,
        p_delta: input.delta,
        p_reason: input.reason.trim(),
      }) as { delta?: unknown; balance?: unknown } | null;
      return {
        delta: Number(data?.delta ?? input.delta) || 0,
        balance: Number(data?.balance ?? 0) || 0,
      };
    },
  };
}
