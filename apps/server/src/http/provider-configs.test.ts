import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ProviderConfigServiceError,
  type ProviderConfigService,
  type WorkspaceProviderConfigView,
} from "../features/providers/index.js";
import { registerProviderConfigRoutes } from "./provider-configs.js";

const user = { id: "user-1", accessToken: "token-1" } as any;
const workspaceId = "20000000-0000-4000-8000-000000000001";
const configId = "10000000-0000-4000-8000-000000000001";

function makeConfig(): WorkspaceProviderConfigView {
  return {
    id: configId,
    adapter: "openai_compatible",
    displayName: "APIYI",
    baseUrl: "https://api.apiyi.com/v1",
    enabled: true,
    hasApiKey: true,
    lastFour: "abcd",
    models: [
      {
        id: "30000000-0000-4000-8000-000000000001",
        upstreamModelId: "text-model",
        displayName: "Text model",
        modality: "text",
        enabled: true,
        capabilities: ["text", "vision_input"],
      },
    ],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    lastTestedAt: null,
    lastTestStatus: "never",
  };
}

function makeService(): ProviderConfigService {
  return {
    list: vi.fn().mockResolvedValue([makeConfig()]),
    create: vi.fn().mockResolvedValue(makeConfig()),
    update: vi.fn().mockResolvedValue(makeConfig()),
    delete: vi.fn().mockResolvedValue(undefined),
    test: vi.fn().mockResolvedValue({
      ok: true,
      testedAt: "2026-09-01T00:00:01.000Z",
    }),
    discoverModels: vi.fn().mockResolvedValue([]),
    discoverDraftModels: vi.fn().mockResolvedValue([]),
  };
}

async function makeApp(
  service: ProviderConfigService,
  authenticatedUser: typeof user | null = user,
) {
  const app = Fastify();
  await registerProviderConfigRoutes(app, {
    auth: { authenticate: vi.fn().mockResolvedValue(authenticatedUser) } as any,
    providerConfigService: service,
    viewerService: {
      ensureViewer: vi.fn().mockResolvedValue({ workspace: { id: workspaceId } }),
    } as any,
  });
  return app;
}

describe("provider config HTTP routes", () => {
  let service: ProviderConfigService;

  beforeEach(() => {
    service = makeService();
  });

  it("requires authentication before listing workspace providers", async () => {
    const app = await makeApp(service, null);
    const response = await app.inject({
      method: "GET",
      url: "/api/workspace/provider-configs",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
    expect(service.list).not.toHaveBeenCalled();
  });

  it("binds listing to the viewer workspace and strips all secret fields", async () => {
    const unsafe = {
      ...makeConfig(),
      apiKey: "must-not-leak",
      apiKeySecretId: "vault-secret-id",
    };
    vi.mocked(service.list).mockResolvedValue([unsafe as any]);
    const app = await makeApp(service);
    const response = await app.inject({
      method: "GET",
      url: "/api/workspace/provider-configs",
    });
    expect(response.statusCode).toBe(200);
    expect(service.list).toHaveBeenCalledWith(user, workspaceId);
    expect(response.body).not.toContain("must-not-leak");
    expect(response.body).not.toContain("vault-secret-id");
    expect(response.json().configs[0].models[0].upstreamModelId).toBe(
      "text-model",
    );
  });

  it("creates a provider without echoing its API key", async () => {
    const app = await makeApp(service);
    const response = await app.inject({
      method: "POST",
      url: "/api/workspace/provider-configs",
      payload: {
        displayName: "APIYI",
        baseUrl: "https://api.apiyi.com/v1",
        apiKey: "secret-key-value",
        models: [
          {
            upstreamModelId: "text-model",
            displayName: "Text model",
            modality: "text",
            enabled: true,
            capabilities: ["text"],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    expect(service.create).toHaveBeenCalledWith(
      user,
      workspaceId,
      expect.objectContaining({ apiKey: "secret-key-value" }),
    );
    expect(response.body).not.toContain("secret-key-value");
  });

  it("returns models discovered through the stored provider configuration", async () => {
    const discovered = [{ upstreamModelId: "model-one", displayName: "model-one", modality: "text" as const, enabled: true, capabilities: ["text" as const] }];
    vi.mocked(service.discoverModels).mockResolvedValue(discovered);
    const response = await (await makeApp(service)).inject({
      method: "POST",
      url: `/api/workspace/provider-configs/${configId}/discover-models`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().models).toEqual(discovered);
    expect(service.discoverModels).toHaveBeenCalledWith(user, workspaceId, configId);
  });

  it("discovers a draft without persisting it or echoing its API key", async () => {
    const discovered = [{ upstreamModelId: "model-one", displayName: "model-one", modality: "text" as const, enabled: false, capabilities: ["text" as const] }];
    vi.mocked(service.discoverDraftModels).mockResolvedValue(discovered);
    const response = await (await makeApp(service)).inject({
      method: "POST",
      url: "/api/workspace/provider-configs/discover-models",
      payload: { baseUrl: "https://api.example.test/v1", apiKey: "secret-key-value" },
    });
    expect(response.statusCode).toBe(200);
    expect(service.discoverDraftModels).toHaveBeenCalledWith(user, workspaceId, {
      baseUrl: "https://api.example.test/v1", apiKey: "secret-key-value",
    });
    expect(response.body).not.toContain("secret-key-value");
  });

  it("rejects an invalid draft key without echoing it", async () => {
    const response = await (await makeApp(service)).inject({
      method: "POST",
      url: "/api/workspace/provider-configs/discover-models",
      payload: { baseUrl: "https://api.example.test/v1", apiKey: "leak" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("provider_invalid_request");
    expect(response.body).not.toContain("leak");
    expect(service.discoverDraftModels).not.toHaveBeenCalled();
  });

  it("rejects an explicitly empty update API key with stable 400", async () => {
    const app = await makeApp(service);
    const response = await app.inject({
      method: "PUT",
      url: `/api/workspace/provider-configs/${configId}`,
      payload: { apiKey: "" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("provider_invalid_request");
    expect(service.update).not.toHaveBeenCalled();
  });

  it("returns stable 403 when a workspace member is not an owner or admin", async () => {
    vi.mocked(service.list).mockRejectedValue(
      new ProviderConfigServiceError(
        "provider_forbidden",
        "Workspace owner or admin access is required.",
        403,
      ),
    );
    const app = await makeApp(service);
    const response = await app.inject({
      method: "GET",
      url: "/api/workspace/provider-configs",
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("provider_forbidden");
  });

  it.each([
    ["provider_not_found", 404],
    ["provider_conflict", 409],
    ["provider_invalid_request", 422],
  ] as const)("maps %s to stable HTTP %s", async (code, statusCode) => {
    vi.mocked(service.update).mockRejectedValue(
      new ProviderConfigServiceError(code, "Safe provider error.", statusCode),
    );
    const app = await makeApp(service);
    const response = await app.inject({
      method: "PUT",
      url: `/api/workspace/provider-configs/${configId}`,
      payload: { displayName: "Updated" },
    });
    expect(response.statusCode).toBe(statusCode);
    expect(response.json().error.code).toBe(code);
  });

  it("maps a provider test timeout to a stable 504 error", async () => {
    vi.mocked(service.test).mockResolvedValue({
      ok: false,
      testedAt: "2026-09-01T00:00:01.000Z",
      errorCode: "provider_connection_timeout",
    });
    const app = await makeApp(service);
    const response = await app.inject({
      method: "POST",
      url: `/api/workspace/provider-configs/${configId}/test`,
    });
    expect(response.statusCode).toBe(504);
    expect(response.json().error.code).toBe("provider_connection_timeout");
  });

  it("maps other provider connection failures to a stable 502 error", async () => {
    vi.mocked(service.test).mockResolvedValue({
      ok: false,
      testedAt: "2026-09-01T00:00:01.000Z",
      errorCode: "provider_auth_failed",
    });
    const app = await makeApp(service);
    const response = await app.inject({
      method: "POST",
      url: `/api/workspace/provider-configs/${configId}/test`,
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("provider_auth_failed");
  });

  it("deletes a provider through the workspace-bound service", async () => {
    const app = await makeApp(service);
    const response = await app.inject({
      method: "DELETE",
      url: `/api/workspace/provider-configs/${configId}`,
    });
    expect(response.statusCode).toBe(204);
    expect(service.delete).toHaveBeenCalledWith(user, workspaceId, configId);
  });
});
