import type { FastifyInstance, FastifyReply } from "fastify";

import {
  adminAuditListResponseSchema,
  adminPlatformAdminGrantRequestSchema,
  adminPlatformAdminListResponseSchema,
  adminPlatformAdminRevokeRequestSchema,
  adminWriteErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import { AdminWriteError, type AdminAccessService } from "../features/admin/admin-access-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Platform-admin access management and the audit trail (server-enforced).
 *
 * The service authorizes through the same active-platform-admin check as the
 * overview, and the database functions re-check it again. The audit endpoint is
 * read-only; every write endpoint requires a stated reason.
 */
export async function registerAdminAccessRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    adminAccessService: AdminAccessService;
  },
) {
  app.get("/api/admin/platform-admins", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const result = await options.adminAccessService.listPlatformAdmins(user.id);
      return reply.code(200).send(adminPlatformAdminListResponseSchema.parse(result));
    } catch (error) {
      return sendWriteError(error, reply);
    }
  });

  app.post("/api/admin/platform-admins", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const payload = adminPlatformAdminGrantRequestSchema.safeParse(request.body);
      if (!payload.success) return invalidRequest(reply);
      const admin = await options.adminAccessService.grantPlatformAdmin(user.id, payload.data.email, payload.data.reason);
      return reply.code(201).send({ admin });
    } catch (error) {
      return sendWriteError(error, reply);
    }
  });

  app.delete("/api/admin/platform-admins/:userId", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const { userId } = request.params as { userId?: string };
      if (!userId || !USER_ID_PATTERN.test(userId)) return invalidRequest(reply);
      const payload = adminPlatformAdminRevokeRequestSchema.safeParse(request.body);
      if (!payload.success) return invalidRequest(reply);
      const admin = await options.adminAccessService.revokePlatformAdmin(user.id, userId, payload.data.reason);
      return reply.code(200).send({ admin });
    } catch (error) {
      return sendWriteError(error, reply);
    }
  });

  app.get("/api/admin/audit", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const query = request.query as { limit?: string; targetKind?: string; targetId?: string };
      const limit = query.limit === undefined ? undefined : Number(query.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) return invalidRequest(reply);
      const result = await options.adminAccessService.listAuditEvents(user.id, {
        ...(limit === undefined ? {} : { limit }),
        ...(typeof query.targetKind === "string" && query.targetKind ? { targetKind: query.targetKind } : {}),
        ...(typeof query.targetId === "string" && query.targetId ? { targetId: query.targetId } : {}),
      });
      return reply.code(200).send(adminAuditListResponseSchema.parse(result));
    } catch (error) {
      return sendWriteError(error, reply);
    }
  });
}

/** A malformed request is the caller's mistake: 400, never a generic 500. */
function invalidRequest(reply: FastifyReply) {
  return reply.code(400).send(adminWriteErrorResponseSchema.parse({
    error: { code: "admin_invalid_request", message: "请求参数不合法：请检查邮箱、原因（至少 2 个字符）或 limit（1..200）。" },
  }));
}

function unauthenticated(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: { code: "unauthorized", message: "Missing or invalid bearer token." },
    }),
  );
}

function sendWriteError(error: unknown, reply: FastifyReply) {
  if (error instanceof AdminWriteError) {
    return reply.code(error.statusCode).send(adminWriteErrorResponseSchema.parse({
      error: { code: error.code, message: error.message },
    }));
  }
  return reply.code(500).send(adminWriteErrorResponseSchema.parse({
    error: { code: "admin_write_failed", message: "操作失败，请稍后重试。" },
  }));
}
