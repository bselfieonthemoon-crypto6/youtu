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

function membershipQuery() {
  const chain: any = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({ data: { role: "member" }, error: null })),
  };
  return chain;
}

function modelQuery(single: unknown, list: unknown = []) {
  const chain: any = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    contains: vi.fn(() => chain),
    limit: vi.fn(async () => ({ data: list, error: null })),
    maybeSingle: vi.fn(async () => ({ data: single, error: null })),
  };
  return chain;
}

function serviceFor(requested: unknown, candidates: unknown[]) {
  const requestedQuery = modelQuery(requested);
  const candidateQuery = modelQuery(null, candidates);
  const admin = {
    from: vi.fn((table: string) => {
      if (table === "workspace_members") return membershipQuery();
      return admin.from.mock.calls.length === 2 ? requestedQuery : candidateQuery;
    }),
  };
  return {
    service: createWorkspaceModelCatalogService({ getAdminClient: () => admin as never }),
    requestedQuery,
    candidateQuery,
  };
}

const disabledAlias = {
  catalog_key: catalogKey,
  provider_config_id: "config-original",
  upstream_model_id: "gpt-image-2",
  modality: "image",
  capabilities: ["image_generation"],
  workspace_provider_configs: { workspace_id: workspace, revision: 7 },
};

describe("WorkspaceModelCatalogService image fallback", () => {
  it("returns the original identity when an exact-upstream tested candidate exists", async () => {
    const { service, requestedQuery, candidateQuery } = serviceFor(disabledAlias, [
      {
        catalog_key: "10000000-0000-4000-8000-000000000002",
        workspace_provider_configs: {
          workspace_id: workspace,
          enabled: true,
          last_test_status: "succeeded",
        },
      },
    ]);

    await expect(
      service.resolveCompatibleImageFallback!(user, workspace, publicId),
    ).resolves.toEqual({
      upstreamModelId: "gpt-image-2",
      catalogKey,
      providerConfigId: "config-original",
      revision: 7,
      capabilities: ["image_generation"],
    });
    expect(requestedQuery.eq).toHaveBeenCalledWith(
      "workspace_provider_configs.workspace_id",
      workspace,
    );
    expect(candidateQuery.contains).toHaveBeenCalledWith("capabilities", '["image_generation"]');
  });

  it("returns null when no exact-upstream candidate is enabled and tested", async () => {
    const { service } = serviceFor(disabledAlias, []);
    await expect(
      service.resolveCompatibleImageFallback!(user, workspace, publicId),
    ).resolves.toBeNull();
  });

  it("does not resolve an alias from a foreign workspace", async () => {
    const { service, requestedQuery } = serviceFor(null, [
      {
        catalog_key: "10000000-0000-4000-8000-000000000002",
        workspace_provider_configs: {
          workspace_id: "workspace-foreign",
          enabled: true,
          last_test_status: "succeeded",
        },
      },
    ]);
    await expect(
      service.resolveCompatibleImageFallback!(user, "workspace-foreign", publicId),
    ).resolves.toBeNull();
    expect(requestedQuery.eq).toHaveBeenCalledWith(
      "workspace_provider_configs.workspace_id",
      "workspace-foreign",
    );
  });
});
