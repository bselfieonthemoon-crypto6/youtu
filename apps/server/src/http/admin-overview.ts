import type { FastifyInstance, FastifyReply } from "fastify";

import {
  adminAccessResponseSchema,
  adminOverviewErrorResponseSchema,
  adminOverviewResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import {
  AdminOverviewError,
  type AdminOverviewService,
} from "../features/admin/admin-overview-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";

/**
 * Platform operations console (read-only).
 *
 * Both routes authenticate first and then ask the service whether the caller is
 * an active platform admin. The `/api/admin/access` probe exists so the UI can
 * decide whether to render the tab at all; the data route re-checks the same
 * condition itself and never trusts the probe, so a hidden tab is never the
 * control.
 */
export async function registerAdminOverviewRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    adminOverviewService: AdminOverviewService;
  },
) {
  app.get("/api/admin/access", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const platformAdmin = await options.adminOverviewService.isPlatformAdmin(user.id);
      return reply.code(200).send(adminAccessResponseSchema.parse({ platformAdmin }));
    } catch (error) {
      return sendAdminError(error, reply);
    }
  });

  app.get("/api/admin/overview", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      if (!(await options.adminOverviewService.isPlatformAdmin(user.id))) {
        return reply.code(403).send(adminOverviewErrorResponseSchema.parse({
          error: {
            code: "platform_admin_required",
            message: "需要平台管理员权限才能查看平台总览。",
          },
        }));
      }
      const overview = await options.adminOverviewService.overview();
      return reply.code(200).send(adminOverviewResponseSchema.parse(overview));
    } catch (error) {
      return sendAdminError(error, reply);
    }
  });
}

function unauthenticated(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
      },
    }),
  );
}

function sendAdminError(error: unknown, reply: FastifyReply) {
  if (error instanceof AdminOverviewError) {
    return reply.code(error.statusCode).send(adminOverviewErrorResponseSchema.parse({
      error: {
        code: error.code,
        message: error.code === "platform_admin_required"
          ? "需要平台管理员权限才能查看平台总览。"
          : "平台总览加载失败，请稍后重试。",
      },
    }));
  }
  return reply.code(500).send(adminOverviewErrorResponseSchema.parse({
    error: { code: "admin_overview_failed", message: "平台总览加载失败，请稍后重试。" },
  }));
}
