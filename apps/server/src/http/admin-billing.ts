import type { FastifyInstance, FastifyReply } from "fastify";

import {
  adminAdjustCreditsRequestSchema,
  adminCreditAdjustmentResponseSchema,
  adminPlanChangeResponseSchema,
  adminSetWorkspacePlanRequestSchema,
  adminWorkspaceBillingResponseSchema,
  adminWriteErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import { AdminBillingError, type AdminBillingService } from "../features/admin/admin-billing-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Plan and credit management for one workspace (platform admins only).
 *
 * The read route returns the workspace's billing story together with the jobs
 * whose recorded cost disagrees with the ledger, so an operator can see the
 * effect of a change and spot an inconsistency in the same view. Both writes
 * require a reason and are applied by the audited database functions.
 */
export async function registerAdminBillingRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    adminBillingService: AdminBillingService;
  },
) {
  app.get("/api/admin/workspaces/:workspaceId/billing", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const { workspaceId } = request.params as { workspaceId?: string };
      if (!workspaceId || !UUID_PATTERN.test(workspaceId)) return invalidRequest(reply);
      const query = request.query as { limit?: string };
      const limit = query.limit === undefined ? undefined : Number(query.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) return invalidRequest(reply);
      const billing = await options.adminBillingService.getBilling(user.id, workspaceId, limit);
      return reply.code(200).send(adminWorkspaceBillingResponseSchema.parse(billing));
    } catch (error) {
      return sendBillingError(error, reply);
    }
  });

  app.post("/api/admin/workspaces/:workspaceId/plan", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const { workspaceId } = request.params as { workspaceId?: string };
      if (!workspaceId || !UUID_PATTERN.test(workspaceId)) return invalidRequest(reply);
      const payload = adminSetWorkspacePlanRequestSchema.safeParse(request.body);
      if (!payload.success) return invalidRequest(reply);
      const result = await options.adminBillingService.setPlan(user.id, {
        workspaceId, plan: payload.data.plan, grantCredits: payload.data.grantCredits, reason: payload.data.reason,
      });
      return reply.code(200).send(adminPlanChangeResponseSchema.parse(result));
    } catch (error) {
      return sendBillingError(error, reply);
    }
  });

  app.post("/api/admin/workspaces/:workspaceId/credits", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const { workspaceId } = request.params as { workspaceId?: string };
      if (!workspaceId || !UUID_PATTERN.test(workspaceId)) return invalidRequest(reply);
      const payload = adminAdjustCreditsRequestSchema.safeParse(request.body);
      if (!payload.success) return invalidRequest(reply);
      const result = await options.adminBillingService.adjustCredits(user.id, {
        workspaceId, delta: payload.data.delta, reason: payload.data.reason,
      });
      return reply.code(200).send(adminCreditAdjustmentResponseSchema.parse(result));
    } catch (error) {
      return sendBillingError(error, reply);
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
    error: { code: "admin_invalid_request", message: "请求参数不合法：请检查工作区 id、套餐、额度数值与原因（至少 2 个字符）。" },
  }));
}

function sendBillingError(error: unknown, reply: FastifyReply) {
  if (error instanceof AdminBillingError) {
    return reply.code(error.statusCode).send(adminWriteErrorResponseSchema.parse({
      error: { code: error.code, message: error.message },
    }));
  }
  return reply.code(500).send(adminWriteErrorResponseSchema.parse({
    error: { code: "admin_write_failed", message: "操作失败，请稍后重试。" },
  }));
}
