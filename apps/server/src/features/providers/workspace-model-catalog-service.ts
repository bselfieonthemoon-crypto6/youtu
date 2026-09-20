import {
  parseWorkspaceModelId,
  workspaceCatalogModelSchema,
  type WorkspaceCatalogModel,
} from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { AuthenticatedUser } from "../../supabase/user.js";

const CONFIG_COLUMNS = "id, display_name, revision";
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

/**
 * The provider rows a workspace resolves to.
 *
 * `kind` is `workspace` while the workspace has its own enabled, connection-tested
 * configuration, and `platform` (workspace_id IS NULL) otherwise. The database
 * enforces the same rule in public.loomic_provider_config_in_scope; keeping the
 * two in step is what lets a brand-new workspace chat and generate immediately
 * while an already-configured workspace is untouched.
 */
type ProviderScope = {
  kind: "workspace" | "platform";
  configIds: string[];
  revisions: Map<string, number>;
  providerNames: Map<string, string>;
};

export function createWorkspaceModelCatalogService(options: {
  getAdminClient: () => AdminSupabaseClient;
}): WorkspaceModelCatalogService {
  /** Configs the workspace may resolve models through: its own, else the platform's. */
  async function resolveEffectiveScope(
    admin: AdminSupabaseClient,
    workspaceId: string,
  ): Promise<ProviderScope> {
    const own = await usableConfigs(admin, (query) => query.eq("workspace_id", workspaceId));
    if (own.length > 0) return toScope("workspace", own);
    const platform = await usableConfigs(admin, (query) => query.is("workspace_id", null));
    return toScope("platform", platform);
  }

  /**
   * Any config the workspace may already own, including a disabled or untested
   * one: an alias a client already holds must resolve to the identity it was
   * published under even after that channel was switched off. Platform rows are
   * the fallback for a workspace that owns none.
   */
  async function resolveAliasScope(
    admin: AdminSupabaseClient,
    workspaceId: string,
  ): Promise<ProviderScope> {
    const own = await readConfigs(admin, (query) => query.eq("workspace_id", workspaceId));
    if (own.length > 0) return toScope("workspace", own);
    const platform = await readConfigs(admin, (query) => query.is("workspace_id", null));
    return toScope("platform", platform);
  }

  return {
    async resolveCompatibleImageFallback(user, workspaceId, publicId) {
      const catalogKey = parsePublicCatalogKey(publicId);
      if (!catalogKey) return null;
      const admin = options.getAdminClient();
      await assertWorkspaceMembership(admin, user.id, workspaceId);

      const aliasScope = await resolveAliasScope(admin, workspaceId);
      if (aliasScope.configIds.length === 0) return null;
      const requestedResult = await (admin.from("workspace_provider_models") as any)
        .select(MODEL_COLUMNS)
        .eq("catalog_key", catalogKey)
        .eq("modality", "image")
        .in("provider_config_id", aliasScope.configIds)
        .maybeSingle();
      if (requestedResult.error) throw new WorkspaceModelCatalogError();
      if (!requestedResult.data) return null;
      const requested = requestedResult.data as Record<string, unknown>;
      const capabilities = workspaceCatalogModelSchema.shape.capabilities.parse(
        requested.capabilities ?? [],
      );
      if (!capabilities.includes("image_generation")) return null;
      const upstreamModelId = String(requested.upstream_model_id);

      const effectiveScope = await resolveEffectiveScope(admin, workspaceId);
      if (effectiveScope.configIds.length === 0) return null;
      const candidateResult = await (admin.from("workspace_provider_models") as any)
        .select("catalog_key,provider_config_id")
        .eq("upstream_model_id", upstreamModelId)
        .eq("modality", "image")
        .eq("enabled", true)
        // This column is JSONB, not a PostgreSQL text array. PostgREST's
        // array overload emits {image_generation}, which is invalid JSON.
        .contains("capabilities", JSON.stringify(["image_generation"]))
        .in("provider_config_id", effectiveScope.configIds)
        .limit(1);
      if (candidateResult.error) throw new WorkspaceModelCatalogError();
      if (!Array.isArray(candidateResult.data) || candidateResult.data.length === 0) return null;
      return {
        upstreamModelId,
        catalogKey: String(requested.catalog_key),
        providerConfigId: String(requested.provider_config_id),
        revision: aliasScope.revisions.get(String(requested.provider_config_id)) ?? 0,
        capabilities,
      };
    },
    async listPublished(user, workspaceId) {
      const admin = options.getAdminClient();
      await assertWorkspaceMembership(admin, user.id, workspaceId);
      const scope = await resolveEffectiveScope(admin, workspaceId);
      if (scope.configIds.length === 0) return [];

      const modelsResult = await (admin.from("workspace_provider_models") as any)
        .select(MODEL_COLUMNS)
        .in("provider_config_id", scope.configIds)
        .eq("enabled", true)
        .order("created_at", { ascending: true });
      if (modelsResult.error) throw new WorkspaceModelCatalogError();

      return ((modelsResult.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
          model: workspaceCatalogModelSchema.parse({
            id: `workspace:${String(row.catalog_key)}`,
            displayName: row.display_name,
            providerDisplayName: scope.providerNames.get(String(row.provider_config_id)),
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
      const scope = await resolveEffectiveScope(admin, workspaceId);
      if (scope.configIds.length === 0) return null;
      const result = await (admin.from("workspace_provider_models") as any)
        .select(MODEL_COLUMNS)
        .eq("catalog_key", catalogKey)
        .eq("modality", modality)
        .eq("enabled", true)
        .in("provider_config_id", scope.configIds)
        .maybeSingle();
      if (result.error) throw new WorkspaceModelCatalogError();
      if (!result.data) return null;
      const row = result.data as Record<string, unknown>;
      return {
        upstreamModelId: String(row.upstream_model_id),
        catalogKey: String(row.catalog_key),
        providerConfigId: String(row.provider_config_id),
        revision: scope.revisions.get(String(row.provider_config_id)) ?? 0,
        capabilities: workspaceCatalogModelSchema.shape.capabilities.parse(
          row.capabilities ?? [],
        ),
      };
    },
  };
}

/** Published catalogue eligibility: enabled and connection-tested. */
function usableConfigs(
  admin: AdminSupabaseClient,
  scope: (query: any) => any,
): Promise<Array<Record<string, unknown>>> {
  return readConfigs(admin, (query) =>
    scope(query).eq("enabled", true).eq("last_test_status", "succeeded"),
  );
}

async function readConfigs(
  admin: AdminSupabaseClient,
  scope: (query: any) => any,
): Promise<Array<Record<string, unknown>>> {
  const result = await scope(
    (admin.from("workspace_provider_configs") as any).select(CONFIG_COLUMNS),
  ).order("created_at", { ascending: true });
  if (result.error) throw new WorkspaceModelCatalogError();
  return (result.data ?? []) as Array<Record<string, unknown>>;
}

function toScope(
  kind: ProviderScope["kind"],
  rows: Array<Record<string, unknown>>,
): ProviderScope {
  return {
    kind,
    configIds: rows.map((row) => String(row.id)),
    revisions: new Map(rows.map((row) => [String(row.id), Number(row.revision)])),
    providerNames: new Map(rows.map((row) => [String(row.id), String(row.display_name)])),
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
