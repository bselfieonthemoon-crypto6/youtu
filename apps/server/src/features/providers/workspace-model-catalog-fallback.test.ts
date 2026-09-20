import { describe, expect, it, vi } from "vitest";

import { createWorkspaceModelCatalogService } from "./workspace-model-catalog-service.js";

const user = {
  id: "user-current",
  email: "user@example.com",
  accessToken: "token",
  userMetadata: {},
};
const workspace = "workspace-current";
const catalogKey = "10000000-0000-4000-8000-000000000001";
const publicId = `workspace:${catalogKey}`;
const platformConfig = { id: "config-platform", display_name: "平台默认", revision: 9 };

type Result = { data: unknown; error: unknown };

function chain(table: string, result: Result) {
  const q: any = {
    table,
    select: vi.fn(() => q),
    eq: vi.fn(() => q),
    is: vi.fn(() => q),
    in: vi.fn(() => q),
    contains: vi.fn(() => q),
    limit: vi.fn(async () => result),
    order: vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(async () => result),
  };
  return q;
}

function adminRouter(routes: Record<string, Result[]>) {
  const calls: Record<string, number> = {};
  const chains: Record<string, any[]> = {};
  const from = vi.fn((table: string) => {
    if (table === "workspace_members") {
      const q: any = {
        select: vi.fn(() => q),
        eq: vi.fn(() => q),
        maybeSingle: vi.fn(async () => ({ data: { role: "member" }, error: null })),
      };
      return q;
    }
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

const disabledAlias = {
  catalog_key: catalogKey,
  provider_config_id: "config-original",
  upstream_model_id: "gpt-image-2",
  modality: "image",
  capabilities: ["image_generation"],
};
const platformAlias = { ...disabledAlias, provider_config_id: "config-platform" };
const usableOwnConfig = { id: "config-original", display_name: "工作区自有", revision: 7 };

describe("WorkspaceModelCatalogService image fallback", () => {
  it("returns the original identity when an exact-upstream tested candidate exists", async () => {
    const router = adminRouter({
      workspace_provider_configs: [
        { data: [usableOwnConfig], error: null },
        { data: [usableOwnConfig], error: null },
      ],
      workspace_provider_models: [
        { data: disabledAlias, error: null },
        { data: [{ catalog_key: "10000000-0000-4000-8000-000000000002", provider_config_id: "config-original" }], error: null },
      ],
    });
    const service = createWorkspaceModelCatalogService({ getAdminClient: () => router.client });

    await expect(
      service.resolveCompatibleImageFallback!(user, workspace, publicId),
    ).resolves.toEqual({
      upstreamModelId: "gpt-image-2",
      catalogKey,
      providerConfigId: "config-original",
      revision: 7,
      capabilities: ["image_generation"],
    });
    expect(router.chains.workspace_provider_configs?.[0].eq).toHaveBeenCalledWith("workspace_id", workspace);
    expect(router.chains.workspace_provider_models?.[0].in).toHaveBeenCalledWith("provider_config_id", ["config-original"]);
    expect(router.chains.workspace_provider_models?.[1].contains).toHaveBeenCalledWith(
      "capabilities",
      '["image_generation"]',
    );
    expect(router.calls.workspace_provider_configs).toBe(2);
  });

  it("returns null when no exact-upstream candidate is enabled and tested", async () => {
    const router = adminRouter({
      workspace_provider_configs: [
        { data: [usableOwnConfig], error: null },
        { data: [usableOwnConfig], error: null },
      ],
      workspace_provider_models: [
        { data: disabledAlias, error: null },
        { data: [], error: null },
      ],
    });
    const service = createWorkspaceModelCatalogService({ getAdminClient: () => router.client });
    await expect(
      service.resolveCompatibleImageFallback!(user, workspace, publicId),
    ).resolves.toBeNull();
  });

  it("does not resolve an alias that belongs to another workspace", async () => {
    const router = adminRouter({ workspace_provider_configs: [{ data: [], error: null }, { data: [], error: null }] });
    const service = createWorkspaceModelCatalogService({ getAdminClient: () => router.client });
    await expect(
      service.resolveCompatibleImageFallback!(user, "workspace-foreign", publicId),
    ).resolves.toBeNull();
    expect(router.chains.workspace_provider_configs?.[0].eq).toHaveBeenCalledWith(
      "workspace_id",
      "workspace-foreign",
    );
    expect(router.from).not.toHaveBeenCalledWith("workspace_provider_models");
  });

  // The platform channel is a real credential source, so an image alias published
  // to a fresh workspace must resolve through it too (not only the text picker).
  it("resolves an image alias through the platform scope when the workspace owns nothing", async () => {
    const router = adminRouter({
      workspace_provider_configs: [
        { data: [], error: null },
        { data: [platformConfig], error: null },
        { data: [], error: null },
        { data: [platformConfig], error: null },
      ],
      workspace_provider_models: [
        { data: platformAlias, error: null },
        { data: [{ catalog_key: "10000000-0000-4000-8000-000000000003", provider_config_id: "config-platform" }], error: null },
      ],
    });
    const service = createWorkspaceModelCatalogService({ getAdminClient: () => router.client });

    await expect(
      service.resolveCompatibleImageFallback!(user, "workspace-new", publicId),
    ).resolves.toEqual({
      upstreamModelId: "gpt-image-2",
      catalogKey,
      providerConfigId: "config-platform",
      revision: 9,
      capabilities: ["image_generation"],
    });
    expect(router.chains.workspace_provider_configs?.[1].is).toHaveBeenCalledWith("workspace_id", null);
    expect(router.chains.workspace_provider_models?.[1].in).toHaveBeenCalledWith(
      "provider_config_id",
      ["config-platform"],
    );
  });
});
