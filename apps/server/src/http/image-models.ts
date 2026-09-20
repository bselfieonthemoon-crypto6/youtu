// @credits-system — Image model list with tier annotations, credit costs, and accessibility flags
import type { FastifyInstance } from "fastify";

import type { CreditService } from "../features/credits/credit-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { WorkspaceModelCatalogService } from "../features/providers/index.js";
import { modelCatalogUnavailable } from "./models.js";

export async function registerImageModelRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    creditService: CreditService;
    viewerService: ViewerService;
    workspaceModelCatalogService?: WorkspaceModelCatalogService;
  },
) {
  app.get("/api/image-models", async (request, reply) => {
    // An anonymous or invalid session legitimately has no workspace catalog.
    let user: Awaited<ReturnType<RequestAuthenticator["authenticate"]>> = null;
    try {
      user = await options.auth.authenticate(request);
    } catch {
      user = null;
    }

    let workspaceModels: Awaited<ReturnType<WorkspaceModelCatalogService["listPublished"]>> = [];
    if (user) {
      // The identity is known, so an empty list would be a claim about this workspace.
      // A catalog that cannot be read must not be reported as "nothing configured".
      try {
        const viewer = await options.viewerService.ensureViewer(user);
        workspaceModels = options.workspaceModelCatalogService
          ? await options.workspaceModelCatalogService.listPublished(user, viewer.workspace.id)
          : [];
      } catch {
        return modelCatalogUnavailable(reply);
      }
    }

    const annotated = [] as Array<Record<string, unknown>>;
    for (const entry of workspaceModels) {
      if (entry.model.modality !== "image") continue;
      annotated.push({
        id: entry.model.id,
        displayName: entry.model.displayName,
        supportsExact2K: entry.upstreamModelId === "gpt-image-2",
        description: "工作区供应商计费",
        provider: entry.model.providerDisplayName,
        accessible: true,
        source: "workspace",
        providerDisplayName: entry.model.providerDisplayName,
        capabilities: entry.model.capabilities,
      });
    }

    return reply.code(200).send({ models: annotated });
  });
}
