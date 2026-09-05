import type { FastifyInstance } from "fastify";

import { type ModelInfo, modelListResponseSchema } from "@loomic/shared";
import type { ServerEnv } from "../config/env.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { WorkspaceModelCatalogService } from "../features/providers/index.js";
import type { RequestAuthenticator } from "../supabase/user.js";

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

    if (options) {
      try {
        const user = await options.auth.authenticate(request);
        if (user) {
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
        }
      } catch {
        // Catalog lookup is best-effort; anonymous/invalid sessions see no models.
      }
    }
    return reply.code(200).send(modelListResponseSchema.parse({ models }));
  });
}
