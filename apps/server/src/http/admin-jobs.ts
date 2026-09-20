import type { FastifyInstance, FastifyReply } from "fastify";

import {
  adminJobAcknowledgeResponseSchema,
  adminJobActionRequestSchema,
  adminJobCancelResponseSchema,
  adminJobDetailResponseSchema,
  adminJobListResponseSchema,
  adminWriteErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import { AdminJobError, type AdminJobService } from "../features/admin/admin-job-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Job inspection and disposition (platform admins only).
 *
 * The list and the detail are read-only. The two writes both require a reason and
 * are executed by audited database functions; cancelling additionally settles the
 * job's chat card and canvas placeholder through the same injected hook the
 * user-facing cancel route uses, so the console cannot leave a job looking live.
 */
export async function registerAdminJobRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    adminJobService: AdminJobService;
    /** Converge a terminal job's chat card and canvas placeholder immediately. */
    settleTerminalJob?: (jobId: string) => Promise<unknown>;
  },
) {
  app.get("/api/admin/jobs", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const query = request.query as {
        status?: string; jobType?: string; workspaceId?: string; errorCode?: string;
        sinceHours?: string; limit?: string; offset?: string;
      };
      if (query.workspaceId !== undefined && !UUID_PATTERN.test(query.workspaceId)) return invalidRequest(reply);
      const limit = query.limit === undefined ? undefined : Number(query.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) return invalidRequest(reply);
      const offset = query.offset === undefined ? undefined : Number(query.offset);
      if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) return invalidRequest(reply);
      const sinceHours = query.sinceHours === undefined ? undefined : Number(query.sinceHours);
      if (sinceHours !== undefined && (!Number.isFinite(sinceHours) || sinceHours <= 0)) return invalidRequest(reply);
      const result = await options.adminJobService.listJobs(user.id, {
        ...(query.status ? { status: query.status } : {}),
        ...(query.jobType ? { jobType: query.jobType } : {}),
        ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
        ...(query.errorCode ? { errorCode: query.errorCode } : {}),
        ...(sinceHours === undefined ? {} : { sinceHours }),
        ...(limit === undefined ? {} : { limit }),
        ...(offset === undefined ? {} : { offset }),
      });
      return reply.code(200).send(adminJobListResponseSchema.parse(result));
    } catch (error) {
      return sendJobError(error, reply);
    }
  });

  app.get("/api/admin/jobs/:jobId", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const { jobId } = request.params as { jobId?: string };
      if (!jobId || !UUID_PATTERN.test(jobId)) return invalidRequest(reply);
      const result = await options.adminJobService.getJob(user.id, jobId);
      return reply.code(200).send(adminJobDetailResponseSchema.parse(result));
    } catch (error) {
      return sendJobError(error, reply);
    }
  });

  app.post("/api/admin/jobs/:jobId/cancel", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const { jobId } = request.params as { jobId?: string };
      if (!jobId || !UUID_PATTERN.test(jobId)) return invalidRequest(reply);
      const payload = adminJobActionRequestSchema.safeParse(request.body);
      if (!payload.success) return invalidRequest(reply);
      const result = await options.adminJobService.cancelJob(user.id, { jobId, reason: payload.data.reason });
      if (options.settleTerminalJob) {
        try {
          await options.settleTerminalJob(jobId);
        } catch (settleError) {
          // The cancellation is durable and the recovery scan retries settlement;
          // never turn a successful cancel into a failed request.
          request.log.error(settleError, "Failed to settle admin-canceled job immediately");
        }
      }
      return reply.code(200).send(adminJobCancelResponseSchema.parse({
        jobId, status: "canceled", statusBefore: result.statusBefore,
      }));
    } catch (error) {
      return sendJobError(error, reply);
    }
  });

  app.post("/api/admin/jobs/:jobId/acknowledge", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const { jobId } = request.params as { jobId?: string };
      if (!jobId || !UUID_PATTERN.test(jobId)) return invalidRequest(reply);
      const payload = adminJobActionRequestSchema.safeParse(request.body);
      if (!payload.success) return invalidRequest(reply);
      await options.adminJobService.acknowledgeJob(user.id, { jobId, reason: payload.data.reason });
      return reply.code(200).send(adminJobAcknowledgeResponseSchema.parse({ jobId, acknowledged: true }));
    } catch (error) {
      return sendJobError(error, reply);
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
    error: { code: "admin_invalid_request", message: "请求参数不合法：请检查任务 id、筛选条件与原因（至少 2 个字符）。" },
  }));
}

function sendJobError(error: unknown, reply: FastifyReply) {
  if (error instanceof AdminJobError) {
    return reply.code(error.statusCode).send(adminWriteErrorResponseSchema.parse({
      error: { code: error.code, message: error.message },
    }));
  }
  return reply.code(500).send(adminWriteErrorResponseSchema.parse({
    error: { code: "admin_write_failed", message: "操作失败，请稍后重试。" },
  }));
}
