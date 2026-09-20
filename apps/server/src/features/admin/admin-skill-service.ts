import { randomUUID } from "node:crypto";

import type {
  AdminSkillCatalogResponse,
  AdminSkillPreview,
  AdminSkillPreviewListResponse,
  AdminWriteErrorCode,
  PublishedSkillPreviewsResponse,
} from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { isActivePlatformAdmin } from "./platform-admin.js";

/**
 * Platform skill catalog images.
 *
 * The bytes go to the existing `platform-assets` bucket as a platform-scope
 * `asset_objects` row; the preview row only points at it. Uploading happens
 * before the audited attach call, and is rolled back (storage object plus asset
 * row) when the attach is refused, so a rejected file cannot leave an orphan that
 * looks attached.
 *
 * Customer-facing reads live here too because that bucket has no authenticated
 * storage policy: the route authenticates the caller, this service returns only
 * `published` rows, and the URL is signed with the service role.
 */

const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
const SIGNED_URL_EXPIRY_SECONDS = 900;
const CATALOG_LIMIT_MAX = 200;
export const SKILL_PREVIEW_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export class AdminSkillError extends Error {
  constructor(
    readonly code: AdminWriteErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "AdminSkillError";
  }
}

export type AdminSkillService = {
  listSkills(actorUserId: string, input?: { query?: string; limit?: number }): Promise<AdminSkillCatalogResponse>;
  listPreviews(actorUserId: string, skillId: string): Promise<AdminSkillPreviewListResponse>;
  attachPreview(actorUserId: string, input: {
    skillId: string; role: "cover" | "example"; caption: string | null; reason: string;
    fileName: string; mimeType: string; buffer: Buffer;
  }): Promise<AdminSkillPreview>;
  publishPreview(actorUserId: string, input: { previewId: string; reason: string }): Promise<void>;
  unpublishPreview(actorUserId: string, input: { previewId: string; reason: string }): Promise<void>;
  deletePreview(actorUserId: string, input: { previewId: string; reason: string }): Promise<void>;
  reorderPreviews(actorUserId: string, input: { skillId: string; orderedPreviewIds: string[]; reason: string }): Promise<void>;
  listPublishedPreviews(skillSlug: string): Promise<PublishedSkillPreviewsResponse>;
};

type LooseAdmin = {
  from: (table: string) => any;
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
  storage: { from: (bucket: string) => any };
};
const loose = (client: AdminSupabaseClient) => client as unknown as LooseAdmin;

function fromDatabaseError(error: { message?: string } | null): AdminSkillError {
  const message = error?.message ?? "";
  if (message.includes("FORBIDDEN")) {
    return new AdminSkillError("platform_admin_required", "需要平台管理员权限才能执行该操作。", 403);
  }
  if (message.includes("REASON_REQUIRED")) {
    return new AdminSkillError("admin_reason_required", "该操作必须填写原因（至少 2 个字符）。", 400);
  }
  if (message.includes("UNKNOWN_SKILL")) {
    return new AdminSkillError("admin_skill_not_found", "该技能不存在。", 404);
  }
  if (message.includes("UNKNOWN_PREVIEW")) {
    return new AdminSkillError("admin_preview_not_found", "该技能图片不存在。", 404);
  }
  if (message.includes("UNKNOWN_ASSET") || message.includes("INVALID_ASSET_SCOPE")) {
    return new AdminSkillError("admin_invalid_asset", "只能挂载平台级素材作为技能图片。", 400);
  }
  if (message.includes("INVALID_ROLE")) {
    return new AdminSkillError("admin_invalid_file", "图片角色只能是封面或示例。", 400);
  }
  if (message.includes("INVALID_ORDER")) {
    return new AdminSkillError("admin_invalid_order", "排序列表必须包含该技能的全部图片且不能重复。", 400);
  }
  return new AdminSkillError("admin_write_failed", "操作失败，请稍后重试。", 500);
}

export function createAdminSkillService(options: {
  getAdminClient: () => AdminSupabaseClient;
}): AdminSkillService {
  const admin = () => options.getAdminClient();

  async function assertActor(actorUserId: string): Promise<void> {
    if (!(await isActivePlatformAdmin(admin(), actorUserId))) {
      throw new AdminSkillError("platform_admin_required", "需要平台管理员权限才能执行该操作。", 403);
    }
  }

  async function callFunction(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await loose(admin()).rpc(name, args);
    if (error) throw fromDatabaseError(error);
    return data;
  }

  async function signedUrl(bucket: string, objectPath: string): Promise<string | null> {
    const { data } = await loose(admin()).storage.from(bucket).createSignedUrl(objectPath, SIGNED_URL_EXPIRY_SECONDS);
    return typeof data?.signedUrl === "string" ? data.signedUrl : null;
  }

  async function previewRows(skillId: string): Promise<Array<Record<string, unknown>>> {
    const { data, error } = await loose(admin()).from("skill_previews")
      .select("id,skill_id,asset_object_id,role,caption,sort_order,status,created_by,created_at,updated_at")
      .eq("skill_id", skillId)
      .order("role", { ascending: true })
      .order("sort_order", { ascending: true });
    if (error) throw fromDatabaseError(error);
    return (data ?? []) as Array<Record<string, unknown>>;
  }

  async function viewForSkill(skillId: string): Promise<AdminSkillPreview[]> {
    const rows = await previewRows(skillId);
    if (!rows.length) return [];
    const assetIds = rows.map(row => String(row.asset_object_id));
    const { data: assets, error: assetError } = await loose(admin()).from("asset_objects")
      .select("id,bucket,object_path,mime_type,byte_size").in("id", assetIds);
    if (assetError) throw fromDatabaseError(assetError);
    const byId = new Map<string, Record<string, unknown>>(
      (assets ?? []).map((row: Record<string, unknown>) => [String(row.id), row]));
    const previews: AdminSkillPreview[] = [];
    for (const row of rows) {
      const asset = byId.get(String(row.asset_object_id));
      previews.push({
        id: String(row.id),
        skillId: String(row.skill_id),
        role: row.role === "cover" ? "cover" : "example",
        caption: typeof row.caption === "string" ? row.caption : null,
        sortOrder: Number(row.sort_order) || 0,
        status: row.status === "published" ? "published" : "draft",
        assetObjectId: String(row.asset_object_id),
        mimeType: typeof asset?.mime_type === "string" ? asset.mime_type : null,
        byteSize: typeof asset?.byte_size === "number" ? asset.byte_size : null,
        createdBy: typeof row.created_by === "string" ? row.created_by : null,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        imageUrl: asset ? await signedUrl(String(asset.bucket), String(asset.object_path)) : null,
      });
    }
    return previews;
  }

  return {
    async listSkills(actorUserId, input) {
      await assertActor(actorUserId);
      const limit = input?.limit === undefined || !Number.isFinite(input.limit)
        ? 50
        : Math.min(Math.max(Math.trunc(input.limit), 1), CATALOG_LIMIT_MAX);
      const data = await callFunction("admin_skill_catalog", {
        p_actor_user_id: actorUserId,
        p_query: input?.query?.trim() || null,
        p_limit: limit,
      }) as { skills?: unknown } | null;
      return { skills: (Array.isArray(data?.skills) ? data!.skills : []) as AdminSkillCatalogResponse["skills"] };
    },

    async listPreviews(actorUserId, skillId) {
      await assertActor(actorUserId);
      return { previews: await viewForSkill(skillId) };
    },

    async attachPreview(actorUserId, input) {
      await assertActor(actorUserId);
      if (!SKILL_PREVIEW_MIME_TYPES.includes(input.mimeType as typeof SKILL_PREVIEW_MIME_TYPES[number])) {
        throw new AdminSkillError("admin_invalid_file",
          `技能图片只支持 ${SKILL_PREVIEW_MIME_TYPES.join(" / ")}。`, 400);
      }
      if (input.buffer.byteLength === 0 || input.buffer.byteLength > MAX_PREVIEW_BYTES) {
        throw new AdminSkillError("admin_invalid_file",
          `技能图片大小必须在 1 字节到 ${Math.round(MAX_PREVIEW_BYTES / 1024 / 1024)}MB 之间。`, 400);
      }
      const client = loose(admin());
      const objectPath = `skills/${input.skillId}/${randomUUID()}.${EXTENSIONS[input.mimeType]}`;
      const upload = await client.storage.from("platform-assets")
        .upload(objectPath, input.buffer, { contentType: input.mimeType, upsert: false });
      if (upload.error) throw new AdminSkillError("admin_write_failed", "图片上传失败，请稍后重试。", 500);

      const { data: asset, error: assetError } = await client.from("asset_objects")
        .insert({
          scope: "platform", workspace_id: null, project_id: null, bucket: "platform-assets",
          object_path: objectPath, mime_type: input.mimeType, byte_size: input.buffer.byteLength,
          created_by: actorUserId,
        })
        .select("id").single();
      if (assetError || !asset) {
        // Never leave the uploaded object behind when its metadata is refused.
        await client.storage.from("platform-assets").remove([objectPath]);
        throw new AdminSkillError("admin_write_failed", "图片登记失败，请稍后重试。", 500);
      }

      try {
        await callFunction("admin_attach_skill_preview", {
          p_actor_user_id: actorUserId,
          p_skill_id: input.skillId,
          p_asset_object_id: asset.id,
          p_role: input.role,
          p_caption: input.caption,
          p_reason: input.reason.trim(),
        });
      } catch (error) {
        // The attach was refused (wrong skill, wrong scope, bad reason): remove
        // both the metadata row and the object so nothing half-attached remains.
        await client.from("asset_objects").delete().eq("id", asset.id);
        await client.storage.from("platform-assets").remove([objectPath]);
        throw error;
      }

      const previews = await viewForSkill(input.skillId);
      const created = previews.find(preview => preview.assetObjectId === String(asset.id));
      if (!created) throw new AdminSkillError("admin_write_failed", "图片登记结果无法读取，请刷新后重试。", 500);
      return created;
    },

    async publishPreview(actorUserId, input) {
      await assertActor(actorUserId);
      await callFunction("admin_publish_skill_preview", {
        p_actor_user_id: actorUserId, p_preview_id: input.previewId, p_reason: input.reason.trim(),
      });
    },

    async unpublishPreview(actorUserId, input) {
      await assertActor(actorUserId);
      await callFunction("admin_unpublish_skill_preview", {
        p_actor_user_id: actorUserId, p_preview_id: input.previewId, p_reason: input.reason.trim(),
      });
    },

    async deletePreview(actorUserId, input) {
      await assertActor(actorUserId);
      await callFunction("admin_delete_skill_preview", {
        p_actor_user_id: actorUserId, p_preview_id: input.previewId, p_reason: input.reason.trim(),
      });
    },

    async reorderPreviews(actorUserId, input) {
      await assertActor(actorUserId);
      await callFunction("admin_reorder_skill_previews", {
        p_actor_user_id: actorUserId,
        p_skill_id: input.skillId,
        p_ordered_ids: input.orderedPreviewIds,
        p_reason: input.reason.trim(),
      });
    },

    async listPublishedPreviews(skillSlug) {
      const client = loose(admin());
      const { data: skill, error: skillError } = await client.from("skills")
        .select("id").eq("slug", skillSlug).maybeSingle();
      if (skillError) throw new AdminSkillError("admin_write_failed", "技能图片加载失败，请稍后重试。", 500);
      if (!skill) return { previews: [] };

      const { data: rows, error } = await client.from("skill_previews")
        .select("id,role,caption,sort_order,asset_object_id")
        .eq("skill_id", String(skill.id)).eq("status", "published")
        .order("role", { ascending: true }).order("sort_order", { ascending: true });
      if (error) throw new AdminSkillError("admin_write_failed", "技能图片加载失败，请稍后重试。", 500);

      const previews: PublishedSkillPreviewsResponse["previews"] = [];
      for (const row of (rows ?? []) as Array<Record<string, unknown>>) {
        const { data: asset } = await client.from("asset_objects")
          .select("bucket,object_path").eq("id", String(row.asset_object_id)).maybeSingle();
        if (!asset) continue;
        const url = await signedUrl(String(asset.bucket), String(asset.object_path));
        if (!url) continue;
        previews.push({
          id: String(row.id),
          role: row.role === "cover" ? "cover" : "example",
          caption: typeof row.caption === "string" ? row.caption : null,
          imageUrl: url,
        });
      }
      return { previews };
    },
  };
}
