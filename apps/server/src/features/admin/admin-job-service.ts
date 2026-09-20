import type {
  AdminJobDetailResponse,
  AdminJobListResponse,
  AdminWriteErrorCode,
} from "@loomic/shared";

import { ADMIN_JOB_STATUS_FILTERS, ADMIN_JOB_TYPE_FILTERS } from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { isActivePlatformAdmin } from "./platform-admin.js";

/**
 * Platform-admin job inspection and disposition.
 *
 * Reads are two database functions (list and detail) so a page of jobs is one
 * round trip and the detail arrives with its ledger rows and admin history
 * attached. Writes are the audited cancel/acknowledge functions; cancelling only
 * flips the status, leaving refunds and terminal settlement to the machinery that
 * already owns them. There is no replay here on purpose: it would call a paid
 * provider.
 */

const LIST_LIMIT_MAX = 100;
const DETAIL_PREVIEW_MAX = 8000;

export class AdminJobError extends Error {
  constructor(
    readonly code: AdminWriteErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "AdminJobError";
  }
}

export type AdminJobFilters = {
  status?: string;
  jobType?: string;
  workspaceId?: string;
  errorCode?: string;
  /** Only jobs created within the last N hours; omitted means no time bound. */
  sinceHours?: number;
  limit?: number;
  offset?: number;
};

export type AdminJobService = {
  listJobs(actorUserId: string, filters?: AdminJobFilters): Promise<AdminJobListResponse>;
  getJob(actorUserId: string, jobId: string): Promise<AdminJobDetailResponse>;
  cancelJob(actorUserId: string, input: { jobId: string; reason: string }): Promise<{ statusBefore: string }>;
  acknowledgeJob(actorUserId: string, input: { jobId: string; reason: string }): Promise<void>;
};

type LooseAdmin = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};
const loose = (client: AdminSupabaseClient) => client as unknown as LooseAdmin;

function fromDatabaseError(error: { message?: string } | null): AdminJobError {
  const message = error?.message ?? "";
  if (message.includes("FORBIDDEN")) {
    return new AdminJobError("platform_admin_required", "需要平台管理员权限才能执行该操作。", 403);
  }
  if (message.includes("REASON_REQUIRED")) {
    return new AdminJobError("admin_reason_required", "该操作必须填写原因（至少 2 个字符）。", 400);
  }
  if (message.includes("UNKNOWN_JOB")) {
    return new AdminJobError("admin_job_not_found", "该任务不存在。", 404);
  }
  if (message.includes("ALREADY_TERMINAL")) {
    return new AdminJobError("admin_job_already_terminal", "该任务已经结束，无法取消。", 409);
  }
  if (message.includes("NOT_TERMINAL")) {
    return new AdminJobError("admin_job_not_terminal", "只有已结束的任务可以标记为已处置。", 409);
  }
  return new AdminJobError("admin_write_failed", "操作失败，请稍后重试。", 500);
}

const isKnownStatus = (value: string): boolean => (ADMIN_JOB_STATUS_FILTERS as readonly string[]).includes(value);
const isKnownJobType = (value: string): boolean => (ADMIN_JOB_TYPE_FILTERS as readonly string[]).includes(value);

export function createAdminJobService(options: {
  getAdminClient: () => AdminSupabaseClient;
  now?: () => Date;
}): AdminJobService {
  const admin = () => options.getAdminClient();
  const now = options.now ?? (() => new Date());

  async function assertActor(actorUserId: string): Promise<void> {
    if (!(await isActivePlatformAdmin(admin(), actorUserId))) {
      throw new AdminJobError("platform_admin_required", "需要平台管理员权限才能执行该操作。", 403);
    }
  }

  async function callFunction(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await loose(admin()).rpc(name, args);
    if (error) throw fromDatabaseError(error);
    return data;
  }

  return {
    async listJobs(actorUserId, filters) {
      await assertActor(actorUserId);
      const status = filters?.status?.trim();
      const jobType = filters?.jobType?.trim();
      const hours = filters?.sinceHours;
      const since = typeof hours === "number" && Number.isFinite(hours) && hours > 0
        ? new Date(now().getTime() - Math.min(hours, 24 * 365) * 60 * 60 * 1000).toISOString()
        : null;
      const limit = filters?.limit === undefined || !Number.isFinite(filters.limit)
        ? 25
        : Math.min(Math.max(Math.trunc(filters.limit), 1), LIST_LIMIT_MAX);
      const data = await callFunction("admin_job_directory", {
        p_actor_user_id: actorUserId,
        p_status: status && isKnownStatus(status) ? status : null,
        p_job_type: jobType && isKnownJobType(jobType) ? jobType : null,
        p_workspace_id: filters?.workspaceId ?? null,
        p_error_code: filters?.errorCode?.trim() || null,
        p_since: since,
        p_limit: limit,
        p_offset: Math.max(Math.trunc(filters?.offset ?? 0), 0),
      }) as { total?: unknown; jobs?: unknown } | null;
      const total = Number(data?.total);
      return {
        total: Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0,
        jobs: (Array.isArray(data?.jobs) ? data!.jobs : []) as AdminJobListResponse["jobs"],
      };
    },

    async getJob(actorUserId, jobId) {
      await assertActor(actorUserId);
      const data = await callFunction("admin_job_detail", {
        p_actor_user_id: actorUserId,
        p_job_id: jobId,
        p_payload_preview_chars: DETAIL_PREVIEW_MAX,
      }) as { job?: unknown; transactions?: unknown; audit?: unknown } | null;
      if (!data?.job) throw new AdminJobError("admin_job_not_found", "该任务不存在。", 404);
      return {
        job: data.job,
        transactions: Array.isArray(data.transactions) ? data.transactions : [],
        audit: Array.isArray(data.audit) ? data.audit : [],
      } as AdminJobDetailResponse;
    },

    async cancelJob(actorUserId, input) {
      await assertActor(actorUserId);
      const data = await callFunction("admin_cancel_job", {
        p_actor_user_id: actorUserId,
        p_job_id: input.jobId,
        p_reason: input.reason.trim(),
      }) as { statusBefore?: unknown } | null;
      return { statusBefore: typeof data?.statusBefore === "string" ? data.statusBefore : "unknown" };
    },

    async acknowledgeJob(actorUserId, input) {
      await assertActor(actorUserId);
      await callFunction("admin_acknowledge_job", {
        p_actor_user_id: actorUserId,
        p_job_id: input.jobId,
        p_reason: input.reason.trim(),
      });
    },
  };
}
