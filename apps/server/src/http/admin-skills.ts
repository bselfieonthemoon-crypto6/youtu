import type { FastifyInstance, FastifyReply } from "fastify";

import {
  adminSkillCatalogResponseSchema,
  adminSkillPreviewListResponseSchema,
  adminSkillPreviewOrderRequestSchema,
  adminSkillPreviewReasonRequestSchema,
  adminWriteErrorResponseSchema,
  publishedSkillPreviewsResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import { AdminSkillError, type AdminSkillService } from "../features/admin/admin-skill-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/i;

function fieldValue(fields: Record<string, unknown>, name: string): string | null {
  const field = fields[name];
  if (!field || typeof field !== "object") return null;
  const value = (field as { value?: unknown }).value;
  return typeof value === "string" ? value : null;
}

/**
 * Platform skill images: the console's catalog and preview management, plus the
 * customer-facing published read.
 *
 * The published read requires only authentication, because a published preview is
 * content for every signed-in user. Every other route is platform-admin only and
 * re-checked inside the database functions. Uploads are multipart: the file, its
 * role, an optional caption and the mandatory reason all arrive together, and the
 * reason ends up in the audit row.
 */
export async function registerAdminSkillRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    adminSkillService: AdminSkillService;
  },
) {
  app.get("/api/admin/skills", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const query = request.query as { query?: string; limit?: string };
      const limit = query.limit === undefined ? undefined : Number(query.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) return invalidRequest(reply);
      const result = await options.adminSkillService.listSkills(user.id, {
        ...(typeof query.query === "string" && query.query.trim() ? { query: query.query } : {}),
        ...(limit === undefined ? {} : { limit }),
      });
      return reply.code(200).send(adminSkillCatalogResponseSchema.parse(result));
    } catch (error) {
      return sendSkillError(error, reply);
    }
  });

  app.get("/api/admin/skills/:skillId/previews", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const { skillId } = request.params as { skillId?: string };
      if (!skillId || !UUID_PATTERN.test(skillId)) return invalidRequest(reply);
      const result = await options.adminSkillService.listPreviews(user.id, skillId);
      return reply.code(200).send(adminSkillPreviewListResponseSchema.parse(result));
    } catch (error) {
      return sendSkillError(error, reply);
    }
  });

  app.post("/api/admin/skills/:skillId/previews", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const { skillId } = request.params as { skillId?: string };
      if (!skillId || !UUID_PATTERN.test(skillId)) return invalidRequest(reply);

      const file = await request.file();
      if (!file) return invalidRequest(reply);
      const role = fieldValue(file.fields as Record<string, unknown>, "role");
      const caption = fieldValue(file.fields as Record<string, unknown>, "caption");
      const reason = fieldValue(file.fields as Record<string, unknown>, "reason");
      if (role !== "cover" && role !== "example") return invalidRequest(reply);
      if (!reason || reason.trim().length < 2 || reason.length > 500) return invalidRequest(reply);
      if (caption && caption.length > 300) return invalidRequest(reply);

      const buffer = await file.toBuffer();
      const preview = await options.adminSkillService.attachPreview(user.id, {
        skillId,
        role,
        caption: caption?.trim() ? caption.trim() : null,
        reason,
        fileName: file.filename,
        mimeType: file.mimetype,
        buffer,
      });
      return reply.code(201).send({ preview });
    } catch (error) {
      return sendSkillError(error, reply);
    }
  });

  for (const [suffix, action] of [["publish", "publishPreview"], ["unpublish", "unpublishPreview"]] as const) {
    app.post(`/api/admin/skills/:skillId/previews/:previewId/${suffix}`, async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthenticated(reply);
        const { previewId } = request.params as { previewId?: string };
        if (!previewId || !UUID_PATTERN.test(previewId)) return invalidRequest(reply);
        const payload = adminSkillPreviewReasonRequestSchema.safeParse(request.body);
        if (!payload.success) return invalidRequest(reply);
        await options.adminSkillService[action](user.id, { previewId, reason: payload.data.reason });
        return reply.code(200).send({ previewId, status: suffix === "publish" ? "published" : "draft" });
      } catch (error) {
        return sendSkillError(error, reply);
      }
    });
  }

  app.delete("/api/admin/skills/:skillId/previews/:previewId", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const { previewId } = request.params as { previewId?: string };
      if (!previewId || !UUID_PATTERN.test(previewId)) return invalidRequest(reply);
      const payload = adminSkillPreviewReasonRequestSchema.safeParse(request.body);
      if (!payload.success) return invalidRequest(reply);
      await options.adminSkillService.deletePreview(user.id, { previewId, reason: payload.data.reason });
      return reply.code(200).send({ previewId, deleted: true });
    } catch (error) {
      return sendSkillError(error, reply);
    }
  });

  app.post("/api/admin/skills/:skillId/previews/order", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const { skillId } = request.params as { skillId?: string };
      if (!skillId || !UUID_PATTERN.test(skillId)) return invalidRequest(reply);
      const payload = adminSkillPreviewOrderRequestSchema.safeParse(request.body);
      if (!payload.success) return invalidRequest(reply);
      await options.adminSkillService.reorderPreviews(user.id, {
        skillId, orderedPreviewIds: payload.data.orderedPreviewIds, reason: payload.data.reason,
      });
      return reply.code(200).send({ skillId, ordered: payload.data.orderedPreviewIds.length });
    } catch (error) {
      return sendSkillError(error, reply);
    }
  });

  // Customer-facing: published previews only. A signed-in user is enough, and the
  // service never returns draft rows or asset identifiers.
  app.get("/api/skills/:slug/previews", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const { slug } = request.params as { slug?: string };
      if (!slug || !SLUG_PATTERN.test(slug)) return invalidRequest(reply);
      const result = await options.adminSkillService.listPublishedPreviews(slug);
      return reply.code(200).send(publishedSkillPreviewsResponseSchema.parse(result));
    } catch (error) {
      return sendSkillError(error, reply);
    }
  });
}

function unauthenticated(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: { code: "unauthorized", message: "Missing or invalid bearer token." },
    }),
  );
}

function invalidRequest(reply: FastifyReply) {
  return reply.code(400).send(adminWriteErrorResponseSchema.parse({
    error: { code: "admin_invalid_request", message: "请求参数不合法：请检查技能 id、图片角色、文件类型与原因（至少 2 个字符）。" },
  }));
}

function sendSkillError(error: unknown, reply: FastifyReply) {
  if (error instanceof AdminSkillError) {
    return reply.code(error.statusCode).send(adminWriteErrorResponseSchema.parse({
      error: { code: error.code, message: error.message },
    }));
  }
  return reply.code(500).send(adminWriteErrorResponseSchema.parse({
    error: { code: "admin_write_failed", message: "操作失败，请稍后重试。" },
  }));
}
