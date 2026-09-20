import type { FastifyInstance, FastifyReply } from "fastify";

import {
  type ModelInfo,
  applicationErrorResponseSchema,
  modelListResponseSchema,
} from "@loomic/shared";
import type { ServerEnv } from "../config/env.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { WorkspaceModelCatalogService } from "../features/providers/index.js";
import type { RequestAuthenticator } from "../supabase/user.js";

/**
 * The published catalog could not be read. This is deliberately NOT an empty list:
 * "no models are published in this workspace" and "we could not read the catalog" need
 * different actions from the user, and the picker used to render both as an empty
 * control with no explanation.
 */
export function modelCatalogUnavailable(reply: FastifyReply) {
  return reply.code(503).send(
    applicationErrorResponseSchema.parse({
      error: {
        code: "application_error",
        message: "模型目录暂时不可用，请稍后重试。",
      },
    }),
  );
}

export async function registerModelRoutes(
  app: FastifyInstance,
  _env: ServerEnv,
  options?: {
    auth: RequestAuthenticator;
    viewerService: ViewerService;
    workspaceModelCatalogService: WorkspaceModelCatalogService;
  },
) {
  app.get("/api/models", async (request, reply) => {
    const models: ModelInfo[] = [];

    if (!options) {
      return reply.code(200).send(modelListResponseSchema.parse({ models }));
    }

    // An anonymous or invalid session legitimately has no workspace catalog. That is an
    // empty list, not a failure: the caller simply is not signed in.
    let user: Awaited<ReturnType<RequestAuthenticator["authenticate"]>> = null;
    try {
      user = await options.auth.authenticate(request);
    } catch {
      user = null;
    }
    if (!user) {
      return reply.code(200).send(modelListResponseSchema.parse({ models }));
    }

    // From here on the identity is known, so an empty list would be a claim about this
    // workspace. If the catalog cannot be read we say so instead.
    try {
      const viewer = await options.viewerService.ensureViewer(user);
      const entries = await options.workspaceModelCatalogService.listPublished(
        user,
        viewer.workspace.id,
      );
      for (const entry of entries) {
        if (entry.model.modality !== "text") continue;
        models.push({
          id: entry.model.id,
          name: entry.model.displayName,
          provider: entry.model.providerDisplayName,
          providerDisplayName: entry.model.providerDisplayName,
          source: "workspace",
          capabilities: entry.model.capabilities,
        });
      }
    } catch {
      return modelCatalogUnavailable(reply);
    }

    return reply.code(200).send(modelListResponseSchema.parse({ models }));
  });
}
