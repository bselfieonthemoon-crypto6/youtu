import type { FastifyInstance, FastifyReply } from "fastify";

import {
  adminAssetLargeObjectsResponseSchema,
  adminAssetOrphanListResponseSchema,
  adminAssetOverviewResponseSchema,
  adminAssetPurgeRequestSchema,
  adminAssetPurgeResponseSchema,
  adminAssetQueueResponseSchema,
  adminWriteErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import { AdminStorageError, type AdminStorageService } from "../features/admin/admin-storage-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Storage health for platform admins: occupancy, orphan candidates, the deletion and
 * GC queues, the biggest objects, and one purge action.
 *
 * The purge is the only write and it goes through the existing orphan pipeline - the
 * console never removes a row on its own say-so, and the database re-checks the
 * reference graph at both ends of the operation.
 */
export async function registerAdminStorageRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    adminStorageService: AdminStorageService;
  },
) {
  app.get("/api/admin/storage/overview", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const query = request.query as { workspaceLimit?: string };
      const workspaceLimit = parseNumber(query.workspaceLimit);
      if (workspaceLimit !== null && (!Number.isInteger(workspaceLimit) || workspaceLimit < 1 || workspaceLimit > 100)) {
        return invalidRequest(reply);
      }
      const result = await options.adminStorageService.overview(
        user.id,
        workspaceLimit === null ? undefined : workspaceLimit,
      );
      return reply.code(200).send(adminAssetOverviewResponseSchema.parse(result));
    } catch (error) {
      return sendStorageError(error, reply);
    }
  });

  app.get("/api/admin/storage/orphans", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const query = request.query as {
        bucket?: string; workspaceId?: string; minBytes?: string; limit?: string; offset?: string;
      };
      if (query.workspaceId !== undefined && !UUID_PATTERN.test(query.workspaceId)) return invalidRequest(reply);
      const minBytes = parseNumber(query.minBytes);
      if (minBytes !== null && (!Number.isInteger(minBytes) || minBytes < 0)) return invalidRequest(reply);
      const limit = parseNumber(query.limit);
      if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 100)) return invalidRequest(reply);
      const offset = parseNumber(query.offset);
      if (offset !== null && (!Number.isInteger(offset) || offset < 0)) return invalidRequest(reply);
      const result = await options.adminStorageService.orphanCandidates(user.id, {
        ...(query.bucket ? { bucket: query.bucket } : {}),
        ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
        ...(minBytes === null ? {} : { minBytes }),
        ...(limit === null ? {} : { limit }),
        ...(offset === null ? {} : { offset }),
      });
      return reply.code(200).send(adminAssetOrphanListResponseSchema.parse(result));
    } catch (error) {
      return sendStorageError(error, reply);
    }
  });

  app.get("/api/admin/storage/queue", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const query = request.query as { kind?: string; limit?: string; offset?: string };
      if (!query.kind) return invalidRequest(reply);
      const limit = parseNumber(query.limit);
      if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 100)) return invalidRequest(reply);
      const offset = parseNumber(query.offset);
      if (offset !== null && (!Number.isInteger(offset) || offset < 0)) return invalidRequest(reply);
      const result = await options.adminStorageService.queue(user.id, query.kind, {
        ...(limit === null ? {} : { limit }),
        ...(offset === null ? {} : { offset }),
      });
      return reply.code(200).send(adminAssetQueueResponseSchema.parse(result));
    } catch (error) {
      return sendStorageError(error, reply);
    }
  });

  app.get("/api/admin/storage/large-objects", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const query = request.query as { limit?: string };
      const limit = parseNumber(query.limit);
      if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 50)) return invalidRequest(reply);
      const result = await options.adminStorageService.largeObjects(user.id, limit === null ? undefined : limit);
      return reply.code(200).send(adminAssetLargeObjectsResponseSchema.parse(result));
    } catch (error) {
      return sendStorageError(error, reply);
    }
  });

  app.post("/api/admin/storage/orphans/purge", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const payload = adminAssetPurgeRequestSchema.safeParse(request.body);
      if (!payload.success) return invalidRequest(reply);
      const result = await options.adminStorageService.purgeOrphan(user.id, payload.data);
      return reply.code(200).send(adminAssetPurgeResponseSchema.parse({
        assetId: payload.data.assetId,
        bucket: result.bucket,
        objectPath: result.objectPath,
        deleted: true,
      }));
    } catch (error) {
      return sendStorageError(error, reply);
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
      message: "请求参数不合法：请检查存储桶、工作区、大小、队列类型与原因（至少 2 个字符）。",
    },
  }));
}

function sendStorageError(error: unknown, reply: FastifyReply) {
  if (error instanceof AdminStorageError) {
    return reply.code(error.statusCode).send(adminWriteErrorResponseSchema.parse({
      error: { code: error.code, message: error.message },
    }));
  }
  return reply.code(500).send(adminWriteErrorResponseSchema.parse({
    error: { code: "admin_write_failed", message: "操作失败，请稍后重试。" },
  }));
}
