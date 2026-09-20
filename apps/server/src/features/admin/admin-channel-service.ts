import type {
  AdminChannelDetailResponse,
  AdminChannelFailureRatesResponse,
  AdminChannelListResponse,
  AdminWriteErrorCode,
} from "@loomic/shared";

import { ADMIN_CHANNEL_TEST_STATUS_FILTERS } from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { isActivePlatformAdmin } from "./platform-admin.js";

/**
 * Platform-admin channel health.
 *
 * Reads are database functions: the counters need a join across jobs, snapshots
 * and providers, and doing that per channel in the client would be a query per
 * row. Nothing here writes. A platform admin inspecting another workspace's
 * channel is useful; a platform admin silently repointing that workspace's
 * traffic is not something this console offers.
 */

const LIST_LIMIT_MAX = 200;
const HISTORY_LIMIT_MAX = 100;
const DETAIL_JOB_LIMIT_MAX = 100;
const DAYS_MAX = 365;
const DEFAULT_DAYS = 30;

export class AdminChannelError extends Error {
  constructor(
    readonly code: AdminWriteErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "AdminChannelError";
  }
}

export type AdminChannelFilters = {
  workspaceId?: string;
  /** Free text matched against the workspace name, channel name and base URL. */
  query?: string;
  enabled?: boolean;
  testStatus?: string;
  /** Reporting window in days (1..365); the database clamps as well. */
  days?: number;
  limit?: number;
  offset?: number;
};

export type AdminChannelService = {
  listChannels(actorUserId: string, filters?: AdminChannelFilters): Promise<AdminChannelListResponse>;
  getChannel(
    actorUserId: string,
    configId: string,
    options?: { days?: number; historyLimit?: number; jobLimit?: number },
  ): Promise<AdminChannelDetailResponse>;
  getFailureRates(
    actorUserId: string,
    options?: { days?: number; limit?: number },
  ): Promise<AdminChannelFailureRatesResponse>;
};

type LooseAdmin = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};
const loose = (client: AdminSupabaseClient) => client as unknown as LooseAdmin;

function fromDatabaseError(error: { message?: string } | null): AdminChannelError {
  const message = error?.message ?? "";
  if (message.includes("FORBIDDEN")) {
    return new AdminChannelError("platform_admin_required", "需要平台管理员权限才能查看渠道健康。", 403);
  }
  if (message.includes("UNKNOWN_CHANNEL")) {
    return new AdminChannelError("admin_channel_not_found", "该渠道配置不存在。", 404);
  }
  return new AdminChannelError("admin_write_failed", "操作失败，请稍后重试。", 500);
}

const isKnownTestStatus = (value: string): boolean =>
  (ADMIN_CHANNEL_TEST_STATUS_FILTERS as readonly string[]).includes(value);

function clampDays(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_DAYS;
  return Math.min(Math.max(Math.trunc(value), 1), DAYS_MAX);
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

export function createAdminChannelService(options: {
  getAdminClient: () => AdminSupabaseClient;
}): AdminChannelService {
  const admin = () => options.getAdminClient();

  async function assertActor(actorUserId: string): Promise<void> {
    if (!(await isActivePlatformAdmin(admin(), actorUserId))) {
      throw new AdminChannelError("platform_admin_required", "需要平台管理员权限才能查看渠道健康。", 403);
    }
  }

  async function callFunction(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await loose(admin()).rpc(name, args);
    if (error) throw fromDatabaseError(error);
    return data;
  }

  return {
    async listChannels(actorUserId, filters) {
      await assertActor(actorUserId);
      const testStatus = filters?.testStatus?.trim();
      const query = filters?.query?.trim();
      const data = await callFunction("admin_channel_directory", {
        p_actor_user_id: actorUserId,
        p_workspace_id: filters?.workspaceId ?? null,
        p_query: query ? query : null,
        // A false filter must stay false; `?? null` would silently widen it away.
        p_enabled: typeof filters?.enabled === "boolean" ? filters.enabled : null,
        p_test_status: testStatus && isKnownTestStatus(testStatus) ? testStatus : null,
        p_days: clampDays(filters?.days),
        p_limit: clampLimit(filters?.limit, 50, LIST_LIMIT_MAX),
        p_offset: Math.max(Math.trunc(filters?.offset ?? 0), 0),
      }) as Omit<AdminChannelListResponse, "channels"> & { channels?: unknown } | null;
      // Required fields are passed through rather than defaulted: the route parses
      // this against the shared contract, so a function that stops returning one is
      // a loud failure instead of a console quietly showing zeros.
      if (!data) throw new AdminChannelError("admin_write_failed", "操作失败，请稍后重试。", 500);
      return {
        ...data,
        channels: Array.isArray(data.channels) ? data.channels : [],
      };
    },

    async getChannel(actorUserId, configId, detailOptions) {
      await assertActor(actorUserId);
      const data = await callFunction("admin_channel_detail", {
        p_actor_user_id: actorUserId,
        p_config_id: configId,
        p_days: clampDays(detailOptions?.days),
        p_history_limit: clampLimit(detailOptions?.historyLimit, 20, HISTORY_LIMIT_MAX),
        p_job_limit: clampLimit(detailOptions?.jobLimit, 20, DETAIL_JOB_LIMIT_MAX),
      }) as { channel?: unknown; history?: unknown; errorCodes?: unknown; failures?: unknown } | null;
      if (!data?.channel) {
        throw new AdminChannelError("admin_channel_not_found", "该渠道配置不存在。", 404);
      }
      return {
        channel: data.channel,
        history: Array.isArray(data.history) ? data.history : [],
        errorCodes: Array.isArray(data.errorCodes) ? data.errorCodes : [],
        failures: Array.isArray(data.failures) ? data.failures : [],
      } as AdminChannelDetailResponse;
    },

    async getFailureRates(actorUserId, rateOptions) {
      await assertActor(actorUserId);
      const data = await callFunction("admin_channel_failure_rates", {
        p_actor_user_id: actorUserId,
        p_days: clampDays(rateOptions?.days),
        p_limit: clampLimit(rateOptions?.limit, 20, HISTORY_LIMIT_MAX),
      }) as (Omit<AdminChannelFailureRatesResponse, "errorCodes"> & { errorCodes?: unknown }) | null;
      if (!data) throw new AdminChannelError("admin_write_failed", "操作失败，请稍后重试。", 500);
      return {
        ...data,
        errorCodes: Array.isArray(data.errorCodes) ? data.errorCodes : [],
      };
    },
  };
}
