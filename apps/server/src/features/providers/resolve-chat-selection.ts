import type { AuthenticatedUser } from "../../supabase/user.js";
import type { WorkspaceModelCatalogService } from "./workspace-model-catalog-service.js";

/** Both transports resolve Auto from the same live catalogue shown by /api/models.
 * An explicit selection never silently falls back, including an old env alias. */
export async function resolveChatSelection(input: {
  user: AuthenticatedUser;
  workspaceId?: string;
  requested?: string;
  defaultModel?: string;
  catalog?: WorkspaceModelCatalogService;
}): Promise<string | undefined> {
  if (!input.catalog) return input.requested ?? input.defaultModel;
  if (!input.workspaceId) throw new Error("model_not_accessible");
  if (input.requested) {
    const published = await input.catalog.resolvePublishedModel(input.user, input.workspaceId, input.requested, "text");
    if (!published) throw new Error("model_not_accessible");
    return input.requested;
  }
  const entries = (await input.catalog.listPublished(input.user, input.workspaceId))
    .filter(entry => entry.model.modality === "text");
  const selected = entries.find(entry => entry.model.id === input.defaultModel) ?? entries[0];
  if (!selected) throw new Error("model_not_accessible");
  return selected.model.id;
}
