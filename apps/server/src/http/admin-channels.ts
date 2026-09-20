import type { FastifyInstance, FastifyReply } from "fastify";

import {
  adminChannelDetailResponseSchema,
  adminChannelFailureRatesResponseSchema,
  adminChannelListResponseSchema,
  adminWriteErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import { AdminChannelError, type AdminChannelService } from "../features/admin/admin-channel-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Channel health for platform admins: the cross-workspace directory, one channel
 * with its self-test history, and failure rates by error code.
 *
 * Every route here is a read. The console deliberately cannot edit another
 * workspace's channel configuration.
 */
export async function registerAdminChannelRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    adminChannelService: AdminChannelService;
  },
) {
  app.get("/api/admin/channels", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const query = request.query as {
        workspaceId?: string; query?: string; enabled?: string; testStatus?: string;
        days?: string; limit?: string; offset?: string;
      };
      if (query.workspaceId !== undefined && !UUID_PATTERN.test(query.workspaceId)) return invalidRequest(reply);
      if (query.enabled !== undefined && query.enabled !== "true" && query.enabled !== "false") return invalidRequest(reply);
      const days = parseNumber(query.days);
      if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) return invalidRequest(reply);
      const limit = parseNumber(query.limit);
      if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 200)) return invalidRequest(reply);
      const offset = parseNumber(query.offset);
      if (offset !== null && (!Number.isInteger(offset) || offset < 0)) return invalidRequest(reply);
      const result = await options.adminChannelService.listChannels(user.id, {
        ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
        ...(query.query ? { query: query.query } : {}),
        ...(query.enabled === undefined ? {} : { enabled: query.enabled === "true" }),
        ...(query.testStatus ? { testStatus: query.testStatus } : {}),
        ...(days === null ? {} : { days }),
        ...(limit === null ? {} : { limit }),
        ...(offset === null ? {} : { offset }),
      });
      return reply.code(200).send(adminChannelListResponseSchema.parse(result));
    } catch (error) {
      return sendChannelError(error, reply);
    }
  });

  // Declared before the parametric route so "failure-rates" is never read as a
  // channel id.
  app.get("/api/admin/channels/failure-rates", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const query = request.query as { days?: string; limit?: string };
      const days = parseNumber(query.days);
      if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) return invalidRequest(reply);
      const limit = parseNumber(query.limit);
      if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 100)) return invalidRequest(reply);
      const result = await options.adminChannelService.getFailureRates(user.id, {
        ...(days === null ? {} : { days }),
        ...(limit === null ? {} : { limit }),
      });
      return reply.code(200).send(adminChannelFailureRatesResponseSchema.parse(result));
    } catch (error) {
      return sendChannelError(error, reply);
    }
  });

  app.get("/api/admin/channels/:configId", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const { configId } = request.params as { configId?: string };
      if (!configId || !UUID_PATTERN.test(configId)) return invalidRequest(reply);
      const query = request.query as { days?: string; historyLimit?: string; jobLimit?: string };
      const days = parseNumber(query.days);
      if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) return invalidRequest(reply);
      const historyLimit = parseNumber(query.historyLimit);
      if (historyLimit !== null && (!Number.isInteger(historyLimit) || historyLimit < 1 || historyLimit > 100)) {
        return invalidRequest(reply);
      }
      const jobLimit = parseNumber(query.jobLimit);
      if (jobLimit !== null && (!Number.isInteger(jobLimit) || jobLimit < 1 || jobLimit > 100)) {
        return invalidRequest(reply);
      }
      const result = await options.adminChannelService.getChannel(user.id, configId, {
        ...(days === null ? {} : { days }),
        ...(historyLimit === null ? {} : { historyLimit }),
        ...(jobLimit === null ? {} : { jobLimit }),
      });
      return reply.code(200).send(adminChannelDetailResponseSchema.parse(result));
    } catch (error) {
      return sendChannelError(error, reply);
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
      message: "请求参数不合法：请检查渠道 id、筛选条件与统计窗口（1–365 天）。",
    },
  }));
}

function sendChannelError(error: unknown, reply: FastifyReply) {
  if (error instanceof AdminChannelError) {
    return reply.code(error.statusCode).send(adminWriteErrorResponseSchema.parse({
      error: { code: error.code, message: error.message },
    }));
  }
  return reply.code(500).send(adminWriteErrorResponseSchema.parse({
    error: { code: "admin_write_failed", message: "操作失败，请稍后重试。" },
  }));
}
