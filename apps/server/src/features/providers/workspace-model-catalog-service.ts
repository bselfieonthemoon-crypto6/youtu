import {
  parseWorkspaceModelId,
  workspaceCatalogModelSchema,
  type WorkspaceCatalogModel,
} from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { AuthenticatedUser } from "../../supabase/user.js";

const CONFIG_COLUMNS = "id, display_name";
const MODEL_COLUMNS =
  "catalog_key, provider_config_id, upstream_model_id, display_name, modality, capabilities";

export class WorkspaceModelCatalogError extends Error {
  constructor(message = "Workspace model catalog is unavailable.") {
    super(message);
    this.name = "WorkspaceModelCatalogError";
  }
}

export type WorkspaceModelCatalogService = {
  listPublished(user: AuthenticatedUser, workspaceId: string): Promise<WorkspaceModelCatalogEntry[]>;
  resolvePublishedModel(
    user: AuthenticatedUser,
    workspaceId: string,
    publicId: string,
    modality: WorkspaceCatalogModel["modality"],
  ): Promise<ResolvedWorkspaceModel | null>;
  /**
   * Resolves the frozen upstream identity of an unavailable image alias only
   * when at least one currently enabled, connection-tested exact-upstream
   * alternative exists. It never returns a cross-model substitute.
   */
  resolveCompatibleImageFallback?(
    user: AuthenticatedUser,
    workspaceId: string,
    publicId: string,
  ): Promise<ResolvedWorkspaceModel | null>;
};

export type WorkspaceModelCatalogEntry = {
  model: WorkspaceCatalogModel;
  upstreamModelId: string;
};

export type ResolvedWorkspaceModel = {
  upstreamModelId: string;
  catalogKey: string;
  providerConfigId: string;
  revision: number;
  capabilities: WorkspaceCatalogModel["capabilities"];
};

export function createWorkspaceModelCatalogService(options: {
  getAdminClient: () => AdminSupabaseClient;
}): WorkspaceModelCatalogService {
  return {
    async resolveCompatibleImageFallback(user, workspaceId, publicId) {
      const catalogKey = parsePublicCatalogKey(publicId);
      if (!catalogKey) return null;
      const admin = options.getAdminClient();
      await assertWorkspaceMembership(admin, user.id, workspaceId);
      const requestedResult = await (admin.from("workspace_provider_models") as any)
        .select("catalog_key,provider_config_id,upstream_model_id,modality,capabilities,workspace_provider_configs!inner(workspace_id,revision)")
        .eq("catalog_key", catalogKey)
        .eq("modality", "image")
        .eq("workspace_provider_configs.workspace_id", workspaceId)
        .maybeSingle();
      if (requestedResult.error) throw new WorkspaceModelCatalogError();
      if (!requestedResult.data) return null;
      const requested = requestedResult.data as Record<string, unknown>;
      const capabilities = workspaceCatalogModelSchema.shape.capabilities.parse(
        requested.capabilities ?? [],
      );
      if (!capabilities.includes("image_generation")) return null;
      const upstreamModelId = String(requested.upstream_model_id);
      const candidateResult = await (admin.from("workspace_provider_models") as any)
        .select("catalog_key,workspace_provider_configs!inner(workspace_id,enabled,last_test_status)")
        .eq("upstream_model_id", upstreamModelId)
        .eq("modality", "image")
        .eq("enabled", true)
        // This column is JSONB, not a PostgreSQL text array. PostgREST's
        // array overload emits {image_generation}, which is invalid JSON.
        .contains("capabilities", JSON.stringify(["image_generation"]))
        .eq("workspace_provider_configs.workspace_id", workspaceId)
        .eq("workspace_provider_configs.enabled", true)
        .eq("workspace_provider_configs.last_test_status", "succeeded")
        .limit(1);
      if (candidateResult.error) throw new WorkspaceModelCatalogError();
      if (!Array.isArray(candidateResult.data) || candidateResult.data.length === 0) return null;
      const config = requested.workspace_provider_configs as Record<string, unknown>;
      return {
        upstreamModelId,
        catalogKey: String(requested.catalog_key),
        providerConfigId: String(requested.provider_config_id),
        revision: Number(config.revision),
        capabilities,
      };
    },
    async listPublished(user, workspaceId) {
      const admin = options.getAdminClient();
      await assertWorkspaceMembership(admin, user.id, workspaceId);
      const configsResult = await (admin.from("workspace_provider_configs") as any)
        .select(CONFIG_COLUMNS)
        .eq("workspace_id", workspaceId)
        .eq("enabled", true)
        .eq("last_test_status", "succeeded")
        .order("created_at", { ascending: true });
      if (configsResult.error) throw new WorkspaceModelCatalogError();

      const configs = (configsResult.data ?? []) as Array<Record<string, unknown>>;
      if (configs.length === 0) return [];
      const providerNames = new Map(
        configs.map((row) => [String(row.id), String(row.display_name)]),
      );

      const modelsResult = await (admin.from("workspace_provider_models") as any)
        .select(MODEL_COLUMNS)
        .in("provider_config_id", [...providerNames.keys()])
        .eq("enabled", true)
        .order("created_at", { ascending: true });
      if (modelsResult.error) throw new WorkspaceModelCatalogError();

      return ((modelsResult.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
          model: workspaceCatalogModelSchema.parse({
            id: `workspace:${String(row.catalog_key)}`,
            displayName: row.display_name,
            providerDisplayName: providerNames.get(String(row.provider_config_id)),
            modality: row.modality,
            capabilities: row.capabilities ?? [],
            source: "workspace",
          }),
          upstreamModelId: String(row.upstream_model_id),
        }));
    },

    async resolvePublishedModel(user, workspaceId, publicId, modality) {
      const catalogKey = parsePublicCatalogKey(publicId);
      if (!catalogKey) return null;
      const admin = options.getAdminClient();
      await assertWorkspaceMembership(admin, user.id, workspaceId);
      const result = await (admin.from("workspace_provider_models") as any)
        .select("catalog_key, provider_config_id, upstream_model_id, modality, capabilities, workspace_provider_configs!inner(workspace_id, enabled, last_test_status, revision)")
        .eq("catalog_key", catalogKey)
        .eq("modality", modality)
        .eq("enabled", true)
        .eq("workspace_provider_configs.workspace_id", workspaceId)
        .eq("workspace_provider_configs.enabled", true)
        .eq("workspace_provider_configs.last_test_status", "succeeded")
        .maybeSingle();
      if (result.error) throw new WorkspaceModelCatalogError();
      if (!result.data) return null;
      const row = result.data as Record<string, unknown>;
      const config = row.workspace_provider_configs as Record<string, unknown>;
      return {
        upstreamModelId: String(row.upstream_model_id),
        catalogKey: String(row.catalog_key),
        providerConfigId: String(row.provider_config_id),
        revision: Number(config.revision),
        capabilities: workspaceCatalogModelSchema.shape.capabilities.parse(
          row.capabilities ?? [],
        ),
      };
    },
  };
}

async function assertWorkspaceMembership(
  admin: AdminSupabaseClient,
  userId: string,
  workspaceId: string,
) {
  const result = await (admin.from("workspace_members") as any)
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (result.error || !result.data) throw new WorkspaceModelCatalogError();
}

function parsePublicCatalogKey(publicId: string) {
  return parseWorkspaceModelId(publicId);
}
