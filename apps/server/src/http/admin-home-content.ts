import type { FastifyInstance, FastifyReply } from "fastify";

import {
  adminHomeCategoryReorderRequestSchema,
  adminHomeCategoryReorderResponseSchema,
  adminHomeCategoryUpsertRequestSchema,
  adminHomeCategoryUpsertResponseSchema,
  adminHomeContentDeleteRequestSchema,
  adminHomeContentDeleteResponseSchema,
  adminHomeContentListResponseSchema,
  adminHomeContentOverviewResponseSchema,
  adminHomeContentReorderRequestSchema,
  adminHomeContentReorderResponseSchema,
  adminHomeContentToggleRequestSchema,
  adminHomeContentToggleResponseSchema,
  adminHomeDiscoveryCaseUpsertRequestSchema,
  adminHomeContentUpsertResponseSchema,
  adminHomeExampleUpsertRequestSchema,
  adminWriteErrorResponseSchema,
  homeContentKindSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import { AdminHomeContentError, type AdminHomeContentService } from "../features/admin/admin-home-content-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Example ids are uuids; discovery case ids are short slugs. */
const uuidKinds = new Set(["example_example", "example_category"]);

/**
 * Home content management for platform admins: the discovery library and the
 * examples library, plus their categories.
 *
 * Reads are two endpoints (an overview with every category and its counts, and a
 * filtered list per kind). Writes are one audited database function each. There is
 * deliberately no category delete endpoint, because the category foreign keys
 * cascade into the whole library - unpublishing is the operation the console offers.
 */
export async function registerAdminHomeContentRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    adminHomeContentService: AdminHomeContentService;
  },
) {
  app.get("/api/admin/home-content/overview", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const result = await options.adminHomeContentService.overview(user.id);
      return reply.code(200).send(adminHomeContentOverviewResponseSchema.parse(result));
    } catch (error) {
      return sendHomeContentError(error, reply);
    }
  });

  app.get("/api/admin/home-content/items", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const query = request.query as {
        kind?: string; categoryKey?: string; active?: string; query?: string; limit?: string; offset?: string;
      };
      const kind = homeContentKindSchema.safeParse(query.kind);
      if (!kind.success) return invalidRequest(reply);
      if (query.active !== undefined && query.active !== "true" && query.active !== "false") {
        return invalidRequest(reply);
      }
      const limit = parseNumber(query.limit);
      if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 200)) return invalidRequest(reply);
      const offset = parseNumber(query.offset);
      if (offset !== null && (!Number.isInteger(offset) || offset < 0)) return invalidRequest(reply);
      const result = await options.adminHomeContentService.list(user.id, {
        kind: kind.data,
        ...(query.categoryKey ? { categoryKey: query.categoryKey } : {}),
        ...(query.active === undefined ? {} : { active: query.active === "true" }),
        ...(query.query ? { query: query.query } : {}),
        ...(limit === null ? {} : { limit }),
        ...(offset === null ? {} : { offset }),
      });
      return reply.code(200).send(adminHomeContentListResponseSchema.parse(result));
    } catch (error) {
      return sendHomeContentError(error, reply);
    }
  });

  app.post("/api/admin/home-content/discovery-cases", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const payload = adminHomeDiscoveryCaseUpsertRequestSchema.safeParse(request.body);
      if (!payload.success) return invalidRequest(reply);
      const result = await options.adminHomeContentService.upsertDiscoveryCase(user.id, payload.data);
      return reply.code(200).send(adminHomeContentUpsertResponseSchema.parse(result));
    } catch (error) {
      return sendHomeContentError(error, reply);
    }
  });

  app.post("/api/admin/home-content/examples", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const payload = adminHomeExampleUpsertRequestSchema.safeParse(request.body);
      if (!payload.success) return invalidRequest(reply);
      const result = await options.adminHomeContentService.upsertExample(user.id, payload.data);
      return reply.code(200).send(adminHomeContentUpsertResponseSchema.parse(result));
    } catch (error) {
      return sendHomeContentError(error, reply);
    }
  });

  app.post("/api/admin/home-content/categories", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const payload = adminHomeCategoryUpsertRequestSchema.safeParse(request.body);
      if (!payload.success) return invalidRequest(reply);
      const result = await options.adminHomeContentService.upsertCategory(user.id, payload.data);
      return reply.code(200).send(adminHomeCategoryUpsertResponseSchema.parse(result));
    } catch (error) {
      return sendHomeContentError(error, reply);
    }
  });

  app.post("/api/admin/home-content/active", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const payload = adminHomeContentToggleRequestSchema.safeParse(request.body);
      if (!payload.success) return invalidRequest(reply);
      if (uuidKinds.has(payload.data.kind) && !UUID_PATTERN.test(payload.data.entityId)) return invalidRequest(reply);
      const result = await options.adminHomeContentService.setActive(user.id, payload.data);
      return reply.code(200).send(adminHomeContentToggleResponseSchema.parse({
        kind: payload.data.kind,
        id: payload.data.entityId,
        isActive: payload.data.isActive,
        ...result,
      }));
    } catch (error) {
      return sendHomeContentError(error, reply);
    }
  });

  app.post("/api/admin/home-content/reorder", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const payload = adminHomeContentReorderRequestSchema.safeParse(request.body);
      if (!payload.success) return invalidRequest(reply);
      const result = await options.adminHomeContentService.reorderContent(user.id, payload.data);
      return reply.code(200).send(adminHomeContentReorderResponseSchema.parse({
        kind: payload.data.kind,
        categoryKey: payload.data.categoryKey,
        ...result,
      }));
    } catch (error) {
      return sendHomeContentError(error, reply);
    }
  });

  app.post("/api/admin/home-content/category-order", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const payload = adminHomeCategoryReorderRequestSchema.safeParse(request.body);
      if (!payload.success) return invalidRequest(reply);
      const result = await options.adminHomeContentService.reorderCategories(user.id, payload.data);
      return reply.code(200).send(adminHomeCategoryReorderResponseSchema.parse({
        kind: payload.data.kind,
        ...result,
      }));
    } catch (error) {
      return sendHomeContentError(error, reply);
    }
  });

  app.post("/api/admin/home-content/delete", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const payload = adminHomeContentDeleteRequestSchema.safeParse(request.body);
      if (!payload.success) return invalidRequest(reply);
      if (uuidKinds.has(payload.data.kind) && !UUID_PATTERN.test(payload.data.entityId)) return invalidRequest(reply);
      await options.adminHomeContentService.deleteContent(user.id, payload.data);
      return reply.code(200).send(adminHomeContentDeleteResponseSchema.parse({
        kind: payload.data.kind,
        id: payload.data.entityId,
        deleted: true,
      }));
    } catch (error) {
      return sendHomeContentError(error, reply);
    }
  });
}

/** `null` means "the caller did not send it"; a malformed value returns NaN. */
function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  return raw.trim() === "" ? Number.NaN : Number(raw);
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
    error: {
      code: "admin_invalid_request",
      message: "请求参数不合法：请检查内容类型、分类、图片地址、排序列表与原因（至少 2 个字符）。",
    },
  }));
}

function sendHomeContentError(error: unknown, reply: FastifyReply) {
  if (error instanceof AdminHomeContentError) {
    return reply.code(error.statusCode).send(adminWriteErrorResponseSchema.parse({
      error: { code: error.code, message: error.message },
    }));
  }
  return reply.code(500).send(adminWriteErrorResponseSchema.parse({
    error: { code: "admin_write_failed", message: "操作失败，请稍后重试。" },
  }));
}
