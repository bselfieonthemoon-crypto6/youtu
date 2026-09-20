import { describe, expect, it, vi } from "vitest";

import { createWorkspaceModelCatalogService } from "./workspace-model-catalog-service.js";

const user = { id: "user-current", email: "user@example.com", accessToken: "token", userMetadata: {} };

type Result = { data: unknown; error: unknown };

/** A PostgREST-like chain that records which table it came from. */
function chain(table: string, result: Result) {
  const q: any = {
    table,
    select: vi.fn(() => q),
    eq: vi.fn(() => q),
    is: vi.fn(() => q),
    in: vi.fn(() => q),
    contains: vi.fn(() => q),
    limit: vi.fn(() => q),
    order: vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(async () => result),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(result).then(resolve),
  };
  return q;
}

function membership() {
  const q: any = {
    select: vi.fn(() => q),
    eq: vi.fn(() => q),
    maybeSingle: vi.fn(async () => ({ data: { role: "member" }, error: null })),
  };
  return q;
}

/**
 * Routes each table through a queue of results, so a test can say what the
 * workspace-scoped read returns and what the platform-scoped read returns.
 */
function adminRouter(routes: Record<string, Result[]>) {
  const calls: Record<string, number> = {};
  const chains: Record<string, any[]> = {};
  const from = vi.fn((table: string) => {
    if (table === "workspace_members") return membership();
    const index = calls[table] ?? 0;
    calls[table] = index + 1;
    const queue = routes[table] ?? [];
    const result = queue[Math.min(index, queue.length - 1)] ?? { data: [], error: null };
    const built = chain(table, result);
    chains[table] = [...(chains[table] ?? []), built];
    return built;
  });
  return { client: { from } as never, from, chains, calls };
}

const platformConfig = { id: "config-platform", display_name: "平台默认", revision: 4 };
const ownConfig = { id: "config-own", display_name: "工作区自有", revision: 7 };

const platformModelRow = {
  catalog_key: "10000000-0000-4000-8000-0000000000aa",
  provider_config_id: "config-platform",
  upstream_model_id: "private-platform-upstream",
  display_name: "Gemini Flash (平台)",
  modality: "text",
  capabilities: ["text", "vision_input"],
};

const ownModelRow = {
  catalog_key: "10000000-0000-4000-8000-0000000000bb",
  provider_config_id: "config-own",
  upstream_model_id: "private-own-upstream",
  display_name: "Gemini Flash (工作区)",
  modality: "text",
  capabilities: ["text"],
};

describe("WorkspaceModelCatalogService", () => {
  // This is the case the platform scope was introduced for: a workspace created
  // by signup owns nothing, and before the fallback existed `listPublished`
  // returned [] and the picker had no model to offer.
  it("resolves the platform models for a workspace that owns no configuration", async () => {
    const router = adminRouter({
      workspace_provider_configs: [{ data: [], error: null }, { data: [platformConfig], error: null }],
      workspace_provider_models: [{ data: [platformModelRow], error: null }, { data: platformModelRow, error: null }],
    });
    const service = createWorkspaceModelCatalogService({ getAdminClient: () => router.client });

    await expect(service.listPublished(user, "workspace-new")).resolves.toEqual([{
      model: {
        id: "workspace:10000000-0000-4000-8000-0000000000aa",
        displayName: "Gemini Flash (平台)",
        providerDisplayName: "平台默认",
        modality: "text",
        capabilities: ["text", "vision_input"],
        source: "workspace",
      },
      upstreamModelId: "private-platform-upstream",
    }]);

    await expect(
      service.resolvePublishedModel(user, "workspace-new", "workspace:10000000-0000-4000-8000-0000000000aa", "text"),
    ).resolves.toEqual({
      upstreamModelId: "private-platform-upstream",
      catalogKey: "10000000-0000-4000-8000-0000000000aa",
      providerConfigId: "config-platform",
      revision: 4,
      capabilities: ["text", "vision_input"],
    });

    // The platform read is the NULL-workspace read, never another workspace's row.
    const platformRead = router.chains.workspace_provider_configs?.[1];
    expect(platformRead.is).toHaveBeenCalledWith("workspace_id", null);
    const ownRead = router.chains.workspace_provider_configs?.[0];
    expect(ownRead.eq).toHaveBeenCalledWith("workspace_id", "workspace-new");
    expect(ownRead.eq).toHaveBeenCalledWith("enabled", true);
    expect(ownRead.eq).toHaveBeenCalledWith("last_test_status", "succeeded");
  });

  // Regression guard for the QA workspace, which owns two channels and must
  // keep publishing exactly its own models.
  it("keeps using a workspace's own configuration and never mixes in the platform list", async () => {
    const router = adminRouter({
      workspace_provider_configs: [{ data: [ownConfig], error: null }],
      workspace_provider_models: [{ data: [ownModelRow], error: null }, { data: ownModelRow, error: null }],
    });
    const service = createWorkspaceModelCatalogService({ getAdminClient: () => router.client });

    await expect(service.listPublished(user, "workspace-current")).resolves.toEqual([{
      model: {
        id: "workspace:10000000-0000-4000-8000-0000000000bb",
        displayName: "Gemini Flash (工作区)",
        providerDisplayName: "工作区自有",
        modality: "text",
        capabilities: ["text"],
        source: "workspace",
      },
      upstreamModelId: "private-own-upstream",
    }]);
    await expect(
      service.resolvePublishedModel(user, "workspace-current", "workspace:10000000-0000-4000-8000-0000000000bb", "text"),
    ).resolves.toEqual({
      upstreamModelId: "private-own-upstream",
      catalogKey: "10000000-0000-4000-8000-0000000000bb",
      providerConfigId: "config-own",
      revision: 7,
      capabilities: ["text"],
    });
    // No platform read happened at all: every config read was workspace-scoped.
    expect(router.calls.workspace_provider_configs).toBe(2);
    for (const read of router.chains.workspace_provider_configs ?? []) {
      expect(read.eq).toHaveBeenCalledWith("workspace_id", "workspace-current");
      expect(read.is).not.toHaveBeenCalled();
    }
  });

  it("returns only safe published catalog fields", async () => {
    const router = adminRouter({
      workspace_provider_configs: [{ data: [{ id: "config-secret-id", display_name: "API 易", revision: 1 }], error: null }],
      workspace_provider_models: [{ data: [{
        catalog_key: "10000000-0000-4000-8000-000000000001",
        provider_config_id: "config-secret-id",
        upstream_model_id: "private-upstream-id",
        display_name: "Gemini Flash",
        modality: "text",
        capabilities: ["text", "vision_input"],
      }], error: null }],
    });
    const service = createWorkspaceModelCatalogService({ getAdminClient: () => router.client });

    const result = await service.listPublished(user, "workspace-current");
    expect(result).toEqual([{
      model: {
        id: "workspace:10000000-0000-4000-8000-000000000001",
        displayName: "Gemini Flash",
        providerDisplayName: "API 易",
        modality: "text",
        capabilities: ["text", "vision_input"],
        source: "workspace",
      },
      upstreamModelId: "private-upstream-id",
    }]);
    expect(router.from).toHaveBeenCalledWith("workspace_members");
    const modelsQuery = router.chains.workspace_provider_models?.[0];
    expect(modelsQuery.eq).toHaveBeenCalledWith("enabled", true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("config-secret-id");
    expect(serialized).not.toContain("base_url");
    expect(serialized).not.toContain("api_key");
  });

  it("does not query models when neither the workspace nor the platform publishes any", async () => {
    const router = adminRouter({
      workspace_provider_configs: [{ data: [], error: null }, { data: [], error: null }],
    });
    const service = createWorkspaceModelCatalogService({ getAdminClient: () => router.client });
    await expect(service.listPublished(user, "workspace-current")).resolves.toEqual([]);
    expect(router.from).toHaveBeenCalledTimes(3);
    expect(router.from).not.toHaveBeenCalledWith("workspace_provider_models");
  });

  it("fails closed when the catalog read itself errors", async () => {
    const router = adminRouter({
      workspace_provider_configs: [{ data: null, error: { message: "boom" } }],
    });
    const service = createWorkspaceModelCatalogService({ getAdminClient: () => router.client });
    await expect(service.listPublished(user, "workspace-current")).rejects.toThrow(
      "Workspace model catalog is unavailable.",
    );
  });

  it("refuses a caller who is not a member of the workspace", async () => {
    const client = {
      from: vi.fn((table: string) => table === "workspace_members"
        ? { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }
        : chain(table, { data: [], error: null })),
    };
    const service = createWorkspaceModelCatalogService({ getAdminClient: () => client as never });
    await expect(service.listPublished(user, "workspace-foreign")).rejects.toThrow(
      "Workspace model catalog is unavailable.",
    );
  });
});
