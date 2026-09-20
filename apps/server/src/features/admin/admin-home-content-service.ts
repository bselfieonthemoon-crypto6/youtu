import type {
  AdminHomeCategoryReorderRequest,
  AdminHomeCategoryUpsertRequest,
  AdminHomeContentDeleteRequest,
  AdminHomeContentListResponse,
  AdminHomeContentOverviewResponse,
  AdminHomeContentReorderRequest,
  AdminHomeContentToggleRequest,
  AdminHomeDiscoveryCaseUpsertRequest,
  AdminHomeExampleUpsertRequest,
  AdminWriteErrorCode,
} from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { isActivePlatformAdmin } from "./platform-admin.js";

/**
 * Platform-admin home content management.
 *
 * Every write is one audited database function, so the row change and its audit
 * entry cannot come apart. Two shapes of this service are worth knowing about:
 *
 *   * `sortOrder` never travels through an upsert. The tables carry a unique index on
 *     (category_key, sort_order), so a direct position write can collide; rows append
 *     and order changes go through the reorder functions, which take the whole
 *     ordered list.
 *   * there is no category delete. The category foreign keys cascade, so the
 *     database refuses it outright and the console unpublishes instead.
 */

const LIST_LIMIT_MAX = 200;

export class AdminHomeContentError extends Error {
  constructor(
    readonly code: AdminWriteErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "AdminHomeContentError";
  }
}

export type AdminHomeContentFilters = {
  kind: string;
  categoryKey?: string;
  active?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
};

export type AdminHomeContentService = {
  overview(actorUserId: string): Promise<AdminHomeContentOverviewResponse>;
  list(actorUserId: string, filters: AdminHomeContentFilters): Promise<AdminHomeContentListResponse>;
  upsertDiscoveryCase(
    actorUserId: string,
    input: AdminHomeDiscoveryCaseUpsertRequest,
  ): Promise<{ id: string; created: boolean; sortOrder: number }>;
  upsertExample(
    actorUserId: string,
    input: AdminHomeExampleUpsertRequest,
  ): Promise<{ id: string; created: boolean; sortOrder: number }>;
  upsertCategory(
    actorUserId: string,
    input: AdminHomeCategoryUpsertRequest,
  ): Promise<{ key: string; kind: string; created: boolean; sortOrder: number }>;
  setActive(actorUserId: string, input: AdminHomeContentToggleRequest): Promise<{ hiddenItems: number; wasActive: boolean }>;
  reorderContent(actorUserId: string, input: AdminHomeContentReorderRequest): Promise<{ ordered: number }>;
  reorderCategories(actorUserId: string, input: AdminHomeCategoryReorderRequest): Promise<{ ordered: number }>;
  deleteContent(actorUserId: string, input: AdminHomeContentDeleteRequest): Promise<void>;
};

type LooseAdmin = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};
const loose = (client: AdminSupabaseClient) => client as unknown as LooseAdmin;

function fromDatabaseError(error: { message?: string } | null): AdminHomeContentError {
  const message = error?.message ?? "";
  if (message.includes("FORBIDDEN")) {
    return new AdminHomeContentError("platform_admin_required", "需要平台管理员权限才能维护首页内容。", 403);
  }
  if (message.includes("REASON_REQUIRED")) {
    return new AdminHomeContentError("admin_reason_required", "该操作必须填写原因（至少 2 个字符）。", 400);
  }
  if (message.includes("UNKNOWN_CATEGORY")) {
    return new AdminHomeContentError("admin_category_not_found", "该分类不存在。", 404);
  }
  if (message.includes("UNKNOWN_CONTENT")) {
    return new AdminHomeContentError("admin_content_not_found", "该内容不存在。", 404);
  }
  if (message.includes("UNKNOWN_KIND")) {
    return new AdminHomeContentError("admin_unknown_kind", "请求的内容类型不受支持。", 400);
  }
  if (message.includes("INVALID_ORDER")) {
    return new AdminHomeContentError("admin_invalid_order", "排序列表必须恰好包含该分组下的全部条目。", 400);
  }
  if (message.includes("UNSUPPORTED_TARGET")) {
    return new AdminHomeContentError("admin_unsupported_target", "分类不支持删除：请改为下架（下架会同时隐藏其下内容）。", 400);
  }
  if (message.includes("INVALID_CONTENT")) {
    return new AdminHomeContentError("admin_invalid_content", "内容字段不合法，请检查标题、图片地址与输入项。", 400);
  }
  return new AdminHomeContentError("admin_write_failed", "操作失败，请稍后重试。", 500);
}

/** Empty selections must reach the database as NULL, not as an empty filter value. */
const orNull = (value: string | null | undefined): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

function toInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

export function createAdminHomeContentService(options: {
  getAdminClient: () => AdminSupabaseClient;
}): AdminHomeContentService {
  const admin = () => options.getAdminClient();

  async function assertActor(actorUserId: string): Promise<void> {
    if (!(await isActivePlatformAdmin(admin(), actorUserId))) {
      throw new AdminHomeContentError("platform_admin_required", "需要平台管理员权限才能维护首页内容。", 403);
    }
  }

  async function callFunction(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { data, error } = await loose(admin()).rpc(name, args);
    if (error) throw fromDatabaseError(error);
    return (data ?? {}) as Record<string, unknown>;
  }

  return {
    async overview(actorUserId) {
      await assertActor(actorUserId);
      const data = await callFunction("admin_home_content_overview", { p_actor_user_id: actorUserId });
      return data as unknown as AdminHomeContentOverviewResponse;
    },

    async list(actorUserId, filters) {
      await assertActor(actorUserId);
      const limit = filters.limit === undefined || !Number.isFinite(filters.limit)
        ? 50
        : Math.min(Math.max(Math.trunc(filters.limit), 1), LIST_LIMIT_MAX);
      const data = await callFunction("admin_home_content_list", {
        p_actor_user_id: actorUserId,
        p_kind: filters.kind,
        p_category_key: orNull(filters.categoryKey),
        p_active: typeof filters.active === "boolean" ? filters.active : null,
        p_query: orNull(filters.query),
        p_limit: limit,
        p_offset: Math.max(Math.trunc(filters.offset ?? 0), 0),
      });
      return {
        ...data,
        items: Array.isArray(data.items) ? data.items : [],
      } as unknown as AdminHomeContentListResponse;
    },

    async upsertDiscoveryCase(actorUserId, input) {
      await assertActor(actorUserId);
      const data = await callFunction("admin_upsert_home_discovery_case", {
        p_actor_user_id: actorUserId,
        p_case_id: input.caseId,
        p_category_key: input.categoryKey,
        p_title: input.title,
        p_cover_image_url: input.coverImageUrl,
        p_author_name: input.authorName,
        p_author_avatar_url: input.authorAvatarUrl,
        p_case_url: input.caseUrl,
        p_seed_prompt: input.seedPrompt,
        p_is_active: input.isActive,
        p_reason: input.reason,
      });
      return { id: String(data.id), created: data.created === true, sortOrder: toInteger(data.sortOrder) };
    },

    async upsertExample(actorUserId, input) {
      await assertActor(actorUserId);
      const data = await callFunction("admin_upsert_home_example_example", {
        p_actor_user_id: actorUserId,
        p_example_id: input.exampleId,
        p_category_key: input.categoryKey,
        p_title: input.title,
        p_prompt: input.prompt,
        p_image_urls: input.imageUrls,
        p_input_mentions: input.inputMentions,
        p_is_active: input.isActive,
        p_reason: input.reason,
      });
      return { id: String(data.id), created: data.created === true, sortOrder: toInteger(data.sortOrder) };
    },

    async upsertCategory(actorUserId, input) {
      await assertActor(actorUserId);
      const data = await callFunction("admin_upsert_home_category", {
        p_actor_user_id: actorUserId,
        p_kind: input.kind,
        p_key: input.key,
        p_label: input.label,
        p_data_type: input.dataType,
        p_accent: input.accent,
        p_is_active: input.isActive,
        p_reason: input.reason,
      });
      return {
        key: String(data.key),
        kind: String(data.kind),
        created: data.created === true,
        sortOrder: toInteger(data.sortOrder),
      };
    },

    async setActive(actorUserId, input) {
      await assertActor(actorUserId);
      const data = await callFunction("admin_set_home_content_active", {
        p_actor_user_id: actorUserId,
        p_kind: input.kind,
        p_entity_id: input.entityId,
        p_is_active: input.isActive,
        p_reason: input.reason,
      });
      const hidden = Number(data.hiddenItems);
      return {
        hiddenItems: Number.isFinite(hidden) && hidden > 0 ? Math.trunc(hidden) : 0,
        wasActive: data.wasActive === true,
      };
    },

    async reorderContent(actorUserId, input) {
      await assertActor(actorUserId);
      const data = await callFunction("admin_reorder_home_content", {
        p_actor_user_id: actorUserId,
        p_kind: input.kind,
        p_category_key: input.categoryKey,
        p_ordered_ids: input.orderedIds,
        p_reason: input.reason,
      });
      return { ordered: Number(data.ordered) || 0 };
    },

    async reorderCategories(actorUserId, input) {
      await assertActor(actorUserId);
      const data = await callFunction("admin_reorder_home_categories", {
        p_actor_user_id: actorUserId,
        p_kind: input.kind,
        p_ordered_keys: input.orderedKeys,
        p_reason: input.reason,
      });
      return { ordered: Number(data.ordered) || 0 };
    },

    async deleteContent(actorUserId, input) {
      await assertActor(actorUserId);
      await callFunction("admin_delete_home_content", {
        p_actor_user_id: actorUserId,
        p_kind: input.kind,
        p_entity_id: input.entityId,
        p_reason: input.reason,
      });
    },
  };
}
