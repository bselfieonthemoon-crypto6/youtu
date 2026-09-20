import type { FastifyInstance, FastifyReply } from "fastify";

import {
  adminAddWorkspaceMemberRequestSchema,
  adminMembershipChangeResponseSchema,
  adminMembershipRemovalResponseSchema,
  adminRemoveWorkspaceMemberRequestSchema,
  adminSetWorkspaceMemberRoleRequestSchema,
  adminUserDirectoryResponseSchema,
  adminWorkspaceDirectoryResponseSchema,
  adminWriteErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import { AdminUserError, type AdminUserService } from "../features/admin/admin-user-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Platform-level user directory and cross-workspace membership management.
 *
 * Reads: the directory is one aggregated call (search by email/name, 30-day
 * activity, per-user workspaces) and a bounded workspace picker for the "add to
 * workspace" flow. Writes: add / role / remove, each requiring a reason, executed
 * by the audited database functions and re-authorized there as well.
 */
export async function registerAdminUserRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    adminUserService: AdminUserService;
  },
) {
  app.get("/api/admin/users", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const query = request.query as { query?: string; userId?: string; limit?: string; offset?: string };
      if (query.userId !== undefined && !UUID_PATTERN.test(query.userId)) return invalidRequest(reply);
      const limit = query.limit === undefined ? undefined : Number(query.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) return invalidRequest(reply);
      const offset = query.offset === undefined ? undefined : Number(query.offset);
      if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) return invalidRequest(reply);
      const result = await options.adminUserService.searchUsers(user.id, {
        ...(typeof query.query === "string" && query.query.trim() ? { query: query.query } : {}),
        ...(query.userId ? { userId: query.userId } : {}),
        ...(limit === undefined ? {} : { limit }),
        ...(offset === undefined ? {} : { offset }),
      });
      return reply.code(200).send(adminUserDirectoryResponseSchema.parse(result));
    } catch (error) {
      return sendUserError(error, reply);
    }
  });

  app.get("/api/admin/workspaces", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const query = request.query as { query?: string; limit?: string };
      const limit = query.limit === undefined ? undefined : Number(query.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) return invalidRequest(reply);
      const result = await options.adminUserService.searchWorkspaces(user.id, {
        ...(typeof query.query === "string" && query.query.trim() ? { query: query.query } : {}),
        ...(limit === undefined ? {} : { limit }),
      });
      return reply.code(200).send(adminWorkspaceDirectoryResponseSchema.parse(result));
    } catch (error) {
      return sendUserError(error, reply);
    }
  });

  app.post("/api/admin/workspaces/:workspaceId/members", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const { workspaceId } = request.params as { workspaceId?: string };
      if (!workspaceId || !UUID_PATTERN.test(workspaceId)) return invalidRequest(reply);
      const payload = adminAddWorkspaceMemberRequestSchema.safeParse(request.body);
      if (!payload.success) return invalidRequest(reply);
      const member = await options.adminUserService.addMember(user.id, { workspaceId, ...payload.data });
      return reply.code(201).send(adminMembershipChangeResponseSchema.parse({ member }));
    } catch (error) {
      return sendUserError(error, reply);
    }
  });

  app.patch("/api/admin/workspaces/:workspaceId/members/:userId", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const { workspaceId, userId } = request.params as { workspaceId?: string; userId?: string };
      if (!workspaceId || !UUID_PATTERN.test(workspaceId) || !userId || !UUID_PATTERN.test(userId)) return invalidRequest(reply);
      const payload = adminSetWorkspaceMemberRoleRequestSchema.safeParse(request.body);
      if (!payload.success) return invalidRequest(reply);
      const member = await options.adminUserService.setMemberRole(user.id, { workspaceId, userId, ...payload.data });
      return reply.code(200).send(adminMembershipChangeResponseSchema.parse({ member }));
    } catch (error) {
      return sendUserError(error, reply);
    }
  });

  app.delete("/api/admin/workspaces/:workspaceId/members/:userId", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const { workspaceId, userId } = request.params as { workspaceId?: string; userId?: string };
      if (!workspaceId || !UUID_PATTERN.test(workspaceId) || !userId || !UUID_PATTERN.test(userId)) return invalidRequest(reply);
      const payload = adminRemoveWorkspaceMemberRequestSchema.safeParse(request.body);
      if (!payload.success) return invalidRequest(reply);
      const member = await options.adminUserService.removeMember(user.id, { workspaceId, userId, reason: payload.data.reason });
      return reply.code(200).send(adminMembershipRemovalResponseSchema.parse({ member }));
    } catch (error) {
      return sendUserError(error, reply);
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
    error: { code: "admin_invalid_request", message: "请求参数不合法：请检查工作区/用户 id、角色与原因（至少 2 个字符）。" },
  }));
}

function sendUserError(error: unknown, reply: FastifyReply) {
  if (error instanceof AdminUserError) {
    return reply.code(error.statusCode).send(adminWriteErrorResponseSchema.parse({
      error: { code: error.code, message: error.message },
    }));
  }
  return reply.code(500).send(adminWriteErrorResponseSchema.parse({
    error: { code: "admin_write_failed", message: "操作失败，请稍后重试。" },
  }));
}
