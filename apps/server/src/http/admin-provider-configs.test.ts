import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ProviderConfigService,
  type WorkspaceProviderConfigView,
} from "../features/providers/index.js";
import { registerAdminProviderConfigRoutes } from "./admin-provider-configs.js";

const user = { id: "admin-1", accessToken: "token-1" } as any;
const configId = "10000000-0000-4000-8000-000000000001";
const modelId = "30000000-0000-4000-8000-000000000001";

function makeConfig(): WorkspaceProviderConfigView {
  return {
    id: configId,
    adapter: "openai_compatible",
    displayName: "平台默认",
    baseUrl: "https://api.apiyi.com/v1",
    enabled: true,
    hasApiKey: true,
    lastFour: "abcd",
    models: [
      {
        id: modelId,
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
    test: vi.fn().mockResolvedValue({ ok: true, testedAt: "2026-09-01T00:00:01.000Z" }),
    discoverModels: vi.fn().mockResolvedValue([]),
    discoverDraftModels: vi.fn().mockResolvedValue([]),
  };
}

async function makeApp(
  service: ProviderConfigService,
  authenticatedUser: typeof user | null = user,
) {
  const app = Fastify();
  await registerAdminProviderConfigRoutes(app, {
    auth: { authenticate: vi.fn().mockResolvedValue(authenticatedUser) } as any,
    providerConfigService: service,
  });
  return app;
}

/**
 * The platform channel set is not a workspace resource: these routes must never
 * resolve a workspace first, and every call must carry the platform scope (null).
 */
describe("admin platform provider config routes", () => {
  let service: ProviderConfigService;

  beforeEach(() => {
    service = makeService();
  });

  it("requires authentication", async () => {
    const app = await makeApp(service, null);
    const response = await app.inject({ method: "GET", url: "/api/admin/provider-configs" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
    expect(service.list).not.toHaveBeenCalled();
  });

  it("lists the platform channels without any workspace argument and strips secrets", async () => {
    vi.mocked(service.list).mockResolvedValue([
      { ...makeConfig(), apiKey: "must-not-leak", apiKeySecretId: "vault-secret-id" } as any,
    ]);
    const app = await makeApp(service);
    const response = await app.inject({ method: "GET", url: "/api/admin/provider-configs" });
    expect(response.statusCode).toBe(200);
    expect(service.list).toHaveBeenCalledWith(user, null);
    expect(response.body).not.toContain("must-not-leak");
    expect(response.body).not.toContain("vault-secret-id");
  });

  it("creates, updates, tests and deletes in the platform scope", async () => {
    const app = await makeApp(service);

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/provider-configs",
      payload: {
        displayName: "平台默认",
        baseUrl: "https://api.apiyi.com/v1",
        apiKey: "secret-key-value",
        models: [
          { upstreamModelId: "text-model", displayName: "Text model", modality: "text", enabled: true },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(service.create).toHaveBeenCalledWith(user, null, expect.objectContaining({
      displayName: "平台默认",
      apiKey: "secret-key-value",
    }));

    const updated = await app.inject({
      method: "PUT",
      url: `/api/admin/provider-configs/${configId}`,
      payload: { enabled: false },
    });
    expect(updated.statusCode).toBe(200);
    expect(service.update).toHaveBeenCalledWith(user, null, configId, { enabled: false });

    const tested = await app.inject({
      method: "POST",
      url: `/api/admin/provider-configs/${configId}/test`,
    });
    expect(tested.statusCode).toBe(200);
    expect(service.test).toHaveBeenCalledWith(user, null, configId);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/admin/provider-configs/${configId}`,
    });
    expect(deleted.statusCode).toBe(204);
    expect(service.delete).toHaveBeenCalledWith(user, null, configId);
  });

  it("reports a rejected connection test with the stable provider code", async () => {
    vi.mocked(service.test).mockResolvedValue({
      ok: false,
      testedAt: "2026-09-01T00:00:01.000Z",
      errorCode: "provider_auth_failed",
    });
    const app = await makeApp(service);
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/provider-configs/${configId}/test`,
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("provider_auth_failed");
  });

  it("validates the request body and the configuration id", async () => {
    const app = await makeApp(service);
    const badBody = await app.inject({
      method: "POST",
      url: "/api/admin/provider-configs",
      payload: { displayName: "" },
    });
    expect(badBody.statusCode).toBe(422);
    const badId = await app.inject({ method: "DELETE", url: "/api/admin/provider-configs/not-a-uuid" });
    expect(badId.statusCode).toBe(422);
    expect(service.delete).not.toHaveBeenCalled();
  });
});
