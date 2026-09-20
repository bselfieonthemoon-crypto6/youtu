import type {
  AdminAssetLargeObjectsResponse,
  AdminAssetOrphanListResponse,
  AdminAssetOverviewResponse,
  AdminAssetPurgeRequest,
  AdminAssetQueueResponse,
  AdminWriteErrorCode,
} from "@loomic/shared";

import { ADMIN_ASSET_QUEUE_KINDS } from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { isActivePlatformAdmin } from "./platform-admin.js";

/**
 * Platform-admin storage health.
 *
 * Reads are database functions: the occupancy aggregates and the two-tier orphan
 * verdict belong in SQL. The one write is a three-step purge that deliberately
 * reuses the existing orphan pipeline:
 *
 *   1. `admin_claim_orphan_asset` re-runs the authoritative reference check, marks the
 *      asset pending and audits the claim;
 *   2. this service removes the storage object;
 *   3. `admin_finalize_orphan_asset` drops the row, and refuses if a reference came
 *      back in the meantime.
 *
 * If step 2 or 3 fails the asset stays in the pending queue, which is the state the
 * existing GC worker already understands - a failed purge leaves work for the normal
 * machinery rather than an orphaned object.
 */

const LIST_LIMIT_MAX = 100;
const LARGE_LIMIT_MAX = 50;

export class AdminStorageError extends Error {
  constructor(
    readonly code: AdminWriteErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "AdminStorageError";
  }
}

export type AdminStorageFilters = {
  bucket?: string;
  workspaceId?: string;
  minBytes?: number;
  limit?: number;
  offset?: number;
};

export type AdminStorageService = {
  overview(actorUserId: string, workspaceLimit?: number): Promise<AdminAssetOverviewResponse>;
  orphanCandidates(actorUserId: string, filters?: AdminStorageFilters): Promise<AdminAssetOrphanListResponse>;
  queue(actorUserId: string, kind: string, options?: { limit?: number; offset?: number }): Promise<AdminAssetQueueResponse>;
  largeObjects(actorUserId: string, limit?: number): Promise<AdminAssetLargeObjectsResponse>;
  /** Claims, deletes the object, then finalizes. Returns what was removed. */
  purgeOrphan(
    actorUserId: string,
    input: AdminAssetPurgeRequest,
  ): Promise<{ bucket: string; objectPath: string }>;
};

type LooseAdmin = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
  storage: {
    from: (bucket: string) => {
      remove: (paths: string[]) => PromiseLike<{ error: { message?: string } | null }>;
    };
  };
};
const loose = (client: AdminSupabaseClient) => client as unknown as LooseAdmin;

function fromDatabaseError(error: { message?: string } | null): AdminStorageError {
  const message = error?.message ?? "";
  if (message.includes("FORBIDDEN")) {
    return new AdminStorageError("platform_admin_required", "需要平台管理员权限才能查看或清理存储。", 403);
  }
  if (message.includes("REASON_REQUIRED")) {
    return new AdminStorageError("admin_reason_required", "该操作必须填写原因（至少 2 个字符）。", 400);
  }
  if (message.includes("UNKNOWN_ASSET")) {
    return new AdminStorageError("admin_asset_not_found", "该存储对象不存在。", 404);
  }
  if (message.includes("ASSET_REFERENCED")) {
    return new AdminStorageError("admin_asset_referenced", "该素材仍被引用，不能清理。", 409);
  }
  if (message.includes("ASSET_FINALIZE_REFUSED")) {
    return new AdminStorageError("admin_asset_not_pending", "该素材不在待删状态（或又被引用），未删除记录。", 409);
  }
  if (message.includes("UNKNOWN_KIND")) {
    return new AdminStorageError("admin_unknown_kind", "请求的队列类型不受支持。", 400);
  }
  return new AdminStorageError("admin_write_failed", "操作失败，请稍后重试。", 500);
}

export function createAdminStorageService(options: {
  getAdminClient: () => AdminSupabaseClient;
}): AdminStorageService {
  const admin = () => options.getAdminClient();

  async function assertActor(actorUserId: string): Promise<void> {
    if (!(await isActivePlatformAdmin(admin(), actorUserId))) {
      throw new AdminStorageError("platform_admin_required", "需要平台管理员权限才能查看或清理存储。", 403);
    }
  }

  async function callFunction(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { data, error } = await loose(admin()).rpc(name, args);
    if (error) throw fromDatabaseError(error);
    return (data ?? {}) as Record<string, unknown>;
  }

  function clampLimit(value: number | undefined, fallback: number, max: number): number {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.trunc(value), 1), max);
  }

  return {
    async overview(actorUserId, workspaceLimit) {
      await assertActor(actorUserId);
      const data = await callFunction("admin_asset_overview", {
        p_actor_user_id: actorUserId,
        p_workspace_limit: clampLimit(workspaceLimit, 10, LIST_LIMIT_MAX),
      });
      return data as unknown as AdminAssetOverviewResponse;
    },

    async orphanCandidates(actorUserId, filters) {
      await assertActor(actorUserId);
      const bucket = filters?.bucket?.trim();
      const data = await callFunction("admin_asset_orphan_candidates", {
        p_actor_user_id: actorUserId,
        p_bucket: bucket ? bucket : null,
        p_workspace_id: filters?.workspaceId ?? null,
        p_min_bytes: typeof filters?.minBytes === "number" && Number.isFinite(filters.minBytes)
          ? Math.max(Math.trunc(filters.minBytes), 0)
          : null,
        p_limit: clampLimit(filters?.limit, 50, LIST_LIMIT_MAX),
        p_offset: Math.max(Math.trunc(filters?.offset ?? 0), 0),
      });
      return {
        ...data,
        objects: Array.isArray(data.objects) ? data.objects : [],
      } as unknown as AdminAssetOrphanListResponse;
    },

    async queue(actorUserId, kind, queueOptions) {
      await assertActor(actorUserId);
      const wanted = kind.trim();
      if (!(ADMIN_ASSET_QUEUE_KINDS as readonly string[]).includes(wanted)) {
        throw new AdminStorageError("admin_unknown_kind", "请求的队列类型不受支持。", 400);
      }
      const data = await callFunction("admin_asset_queue", {
        p_actor_user_id: actorUserId,
        p_kind: wanted,
        p_limit: clampLimit(queueOptions?.limit, 50, LIST_LIMIT_MAX),
        p_offset: Math.max(Math.trunc(queueOptions?.offset ?? 0), 0),
      });
      return {
        ...data,
        objects: Array.isArray(data.objects) ? data.objects : [],
      } as unknown as AdminAssetQueueResponse;
    },

    async largeObjects(actorUserId, limit) {
      await assertActor(actorUserId);
      const data = await callFunction("admin_asset_large_objects", {
        p_actor_user_id: actorUserId,
        p_limit: clampLimit(limit, 20, LARGE_LIMIT_MAX),
      });
      return {
        objects: Array.isArray(data.objects) ? data.objects : [],
      } as unknown as AdminAssetLargeObjectsResponse;
    },

    async purgeOrphan(actorUserId, input) {
      await assertActor(actorUserId);
      const reason = input.reason.trim();
      const claim = await callFunction("admin_claim_orphan_asset", {
        p_actor_user_id: actorUserId,
        p_asset_id: input.assetId,
        p_reason: reason,
      });
      const bucket = typeof claim.bucket === "string" ? claim.bucket : "";
      const objectPath = typeof claim.objectPath === "string" ? claim.objectPath : "";
      if (!bucket || !objectPath) {
        throw new AdminStorageError("admin_write_failed", "操作失败，请稍后重试。", 500);
      }

      // The object goes first: if this fails the asset stays claimed and pending, and
      // the GC worker finishes the job later. Deleting the row first would leak the
      // object forever instead.
      const removal = await loose(admin()).storage.from(bucket).remove([objectPath]);
      if (removal.error) {
        throw new AdminStorageError(
          "admin_write_failed",
          "对象删除失败，该素材已留在待删队列，稍后会由回收流程继续处理。",
          500,
        );
      }

      await callFunction("admin_finalize_orphan_asset", {
        p_actor_user_id: actorUserId,
        p_asset_id: input.assetId,
        p_reason: reason,
      });

      return { bucket, objectPath };
    },
  };
}
