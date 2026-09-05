import {
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
  const match = /^workspace:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(publicId);
  return match?.[1] ?? null;
}
