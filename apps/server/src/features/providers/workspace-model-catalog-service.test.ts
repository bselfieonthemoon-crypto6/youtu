import { describe, expect, it, vi } from "vitest";

import { createWorkspaceModelCatalogService } from "./workspace-model-catalog-service.js";

function query(result: unknown) {
  const chain: any = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    in: vi.fn(() => chain),
    order: vi.fn(() => Promise.resolve(result)),
  };
  return chain;
}

const user = { id: "user-current", email: "user@example.com", accessToken: "token", userMetadata: {} };

function membership() {
  const chain: any = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({ data: { role: "member" }, error: null })),
  };
  return chain;
}

describe("WorkspaceModelCatalogService", () => {
  it("returns only safe published catalog fields", async () => {
    const configs = query({ data: [{ id: "config-secret-id", display_name: "API 易" }], error: null });
    const models = query({ data: [{
      catalog_key: "10000000-0000-4000-8000-000000000001",
      provider_config_id: "config-secret-id",
      upstream_model_id: "private-upstream-id",
      display_name: "Gemini Flash",
      modality: "text",
      capabilities: ["text", "vision_input"],
    }], error: null });
    const admin = { from: vi.fn((table: string) => table === "workspace_members" ? membership() : table === "workspace_provider_configs" ? configs : models) };
    const service = createWorkspaceModelCatalogService({ getAdminClient: () => admin as never });

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
    expect(configs.eq).toHaveBeenCalledWith("workspace_id", "workspace-current");
    expect(admin.from).toHaveBeenCalledWith("workspace_members");
    expect(configs.eq).toHaveBeenCalledWith("enabled", true);
    expect(configs.eq).toHaveBeenCalledWith("last_test_status", "succeeded");
    expect(models.eq).toHaveBeenCalledWith("enabled", true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("config-secret-id");
    expect(serialized).not.toContain("base_url");
    expect(serialized).not.toContain("api_key");
  });

  it("resolves a published workspace ref only through all workspace and status guards", async () => {
    const chain: any = {
      select: vi.fn(() => chain), eq: vi.fn(() => chain),
      maybeSingle: vi.fn(async () => ({ data: {
        catalog_key: "10000000-0000-4000-8000-000000000001",
        provider_config_id: "config-internal",
        upstream_model_id: "gemini-flash",
        capabilities: ["text"],
        workspace_provider_configs: { revision: 7 },
      }, error: null })),
    };
    const service = createWorkspaceModelCatalogService({ getAdminClient: () => ({ from: (table: string) => table === "workspace_members" ? membership() : chain }) as never });
    await expect(service.resolvePublishedModel(user, "workspace-current", "workspace:10000000-0000-4000-8000-000000000001", "text")).resolves.toEqual({
      upstreamModelId: "gemini-flash",
      catalogKey: "10000000-0000-4000-8000-000000000001",
      providerConfigId: "config-internal",
      revision: 7,
      capabilities: ["text"],
    });
    expect(chain.eq).toHaveBeenCalledWith("workspace_provider_configs.workspace_id", "workspace-current");
    expect(chain.eq).toHaveBeenCalledWith("workspace_provider_configs.enabled", true);
    expect(chain.eq).toHaveBeenCalledWith("workspace_provider_configs.last_test_status", "succeeded");
  });

  it("does not query models when no published providers exist", async () => {
    const configs = query({ data: [], error: null });
    const admin = { from: vi.fn((table: string) => table === "workspace_members" ? membership() : configs) };
    const service = createWorkspaceModelCatalogService({ getAdminClient: () => admin as never });
    await expect(service.listPublished(user, "workspace-current")).resolves.toEqual([]);
    expect(admin.from).toHaveBeenCalledTimes(2);
  });
});
