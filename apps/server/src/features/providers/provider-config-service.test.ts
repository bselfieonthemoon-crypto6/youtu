import { describe, expect, it, vi } from "vitest";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";
import {
  createProviderConfigService,
  normalizeBaseUrl,
  ProviderConfigServiceError,
} from "./provider-config-service.js";

const user: AuthenticatedUser = {
  accessToken: "token",
  email: "owner@example.test",
  id: "user-1",
  userMetadata: {},
};

const configRow = {
  id: "config-1",
  workspace_id: "workspace-1",
  adapter: "openai_compatible",
  display_name: "APIYI",
  base_url: "https://api.apiyi.com/v1",
  enabled: true,
  api_key_secret_id: "secret-internal-id",
  api_key_last_four: "7890",
  revision: 3,
  last_tested_at: null,
  last_test_status: "never",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
};

function userClient(role: "owner" | "admin" | "member") {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data: { role }, error: null })),
  };
  return { from: vi.fn(() => query) } as unknown as UserSupabaseClient;
}

function adminForConfig(options: {
  list?: boolean;
  rpc?: (name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>;
} = {}) {
  const from = vi.fn((table: string) => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      in: vi.fn(() => query),
      order: vi.fn(() => query),
      update: vi.fn(() => query),
      insert: vi.fn(async () => ({ error: null })),
      maybeSingle: vi.fn(async () => ({ data: configRow, error: null })),
      then(resolve: (value: unknown) => unknown) {
        const data = table === "workspace_provider_configs"
          ? [configRow]
          : table === "workspace_provider_models"
            ? [{
                id: "model-1",
                provider_config_id: "config-1",
                upstream_model_id: "gemini-3.1-flash-lite",
                display_name: "Gemini Flash Lite",
                modality: "text",
                enabled: true,
                capabilities: ["text", "vision_input"],
              }]
            : [];
        return Promise.resolve(resolve({ data, error: null }));
      },
    };
    return query;
  });
  const rpc = vi.fn(options.rpc ?? (async () => ({ data: null, error: null })));
  return { client: { from, rpc } as unknown as AdminSupabaseClient, from, rpc };
}

describe("provider config security", () => {
  it("accepts only allowlisted HTTPS provider base URLs", () => {
    expect(normalizeBaseUrl("https://api.apiyi.com/v1/")).toBe(
      "https://api.apiyi.com/v1",
    );
    for (const url of [
      "http://api.apiyi.com/v1",
      "https://127.0.0.1/v1",
      "https://api.openai.com/v1",
      "https://user:pass@api.openai.com/v1",
      "https://api.openai.com/internal",
      "https://api.openai.com/v1?target=metadata",
    ]) {
      expect(() => normalizeBaseUrl(url)).toThrow(ProviderConfigServiceError);
    }
  });

  it("rejects members before creating an admin client", async () => {
    const getAdminClient = vi.fn();
    const service = createProviderConfigService({
      createUserClient: () => userClient("member"),
      getAdminClient,
    });
    await expect(service.list(user, "workspace-1")).rejects.toMatchObject({
      code: "provider_forbidden",
      statusCode: 403,
    });
    expect(getAdminClient).not.toHaveBeenCalled();
  });

  it("returns safe list DTOs without Vault identifiers or API keys", async () => {
    const admin = adminForConfig({ list: true });
    const service = createProviderConfigService({
      createUserClient: () => userClient("owner"),
      getAdminClient: () => admin.client,
    });
    const result = await service.list(user, "workspace-1");
    expect(result).toEqual([expect.objectContaining({
      id: "config-1",
      hasApiKey: true,
      lastFour: "7890",
      models: [expect.objectContaining({
        upstreamModelId: "gemini-3.1-flash-lite",
        capabilities: ["text", "vision_input"],
      })],
    })]);
    expect(JSON.stringify(result)).not.toContain("secret-internal-id");
    expect(JSON.stringify(result)).not.toContain("sk-");
  });

  it("normalizes database timestamps with offsets for the API response", async () => {
    const offsetConfigRow = {
      ...configRow,
      created_at: "2026-09-03T04:49:49.95554+00:00",
      updated_at: "2026-09-03T04:50:01.12345+00:00",
      last_tested_at: "2026-09-03T04:50:00+00:00",
    };
    const admin = adminForConfig();
    admin.from.mockImplementation((table: string) => {
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        in: vi.fn(() => query),
        order: vi.fn(() => query),
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve(resolve({
            data: table === "workspace_provider_configs"
              ? [offsetConfigRow]
              : [],
            error: null,
          }));
        },
      };
      return query as any;
    });
    const service = createProviderConfigService({
      createUserClient: () => userClient("owner"),
      getAdminClient: () => admin.client,
    });

    const [result] = await service.list(user, "workspace-1");

    expect(result?.createdAt).toBe("2026-09-03T04:49:49.955Z");
    expect(result?.updatedAt).toBe("2026-09-03T04:50:01.123Z");
    expect(result?.lastTestedAt).toBe("2026-09-03T04:50:00.000Z");
  });

  it("treats an explicit empty update key as invalid instead of retaining it", async () => {
    const admin = adminForConfig();
    const service = createProviderConfigService({
      createUserClient: () => userClient("admin"),
      getAdminClient: () => admin.client,
    });
    await expect(service.update(user, "workspace-1", "config-1", {
      apiKey: "",
    })).rejects.toMatchObject({ code: "provider_invalid_request", statusCode: 400 });
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("requires a new key when the provider origin changes", async () => {
    const admin = adminForConfig();
    const service = createProviderConfigService({
      createUserClient: () => userClient("owner"),
      getAdminClient: () => admin.client,
    });
    await expect(service.update(user, "workspace-1", "config-1", {
      baseUrl: "https://api.openai.com/v1",
    })).rejects.toMatchObject({ code: "provider_invalid_request" });
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("tests only the persisted /models endpoint without redirects or key exposure", async () => {
    const seen: { url?: string; init: RequestInit | undefined } = { init: undefined };
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.url = String(url);
      seen.init = init;
      return new Response('{"data":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const admin = adminForConfig({
      rpc: async (name) => ({
        data: name === "loomic_provider_secret_read" ? "sk-live-secret-7890" : null,
        error: null,
      }),
    });
    const service = createProviderConfigService({
      createUserClient: () => userClient("owner"),
      getAdminClient: () => admin.client,
      fetchFn,
      now: () => "2026-09-01T01:00:00.000Z",
    });
    const result = await service.test(user, "workspace-1", "config-1");
    expect(result).toEqual({ ok: true, testedAt: "2026-09-01T01:00:00.000Z" });
    expect(seen.url).toBe("https://api.apiyi.com/v1/models");
    expect(seen.init).toMatchObject({ method: "GET", redirect: "manual" });
    expect((seen.init?.headers as Record<string, string>).authorization).toBe(
      "Bearer sk-live-secret-7890",
    );
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("discovers and classifies models from the persisted provider endpoint", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: "chat-model" },
      { id: "gpt-image-2-all" },
      { id: "veo-3.1" },
    ] }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const admin = adminForConfig({
      rpc: async (name) => ({
        data: name === "loomic_provider_secret_read" ? "sk-live-secret-7890" : null,
        error: null,
      }),
    });
    const service = createProviderConfigService({
      createUserClient: () => userClient("owner"),
      getAdminClient: () => admin.client,
      fetchFn,
    });
    await expect(service.discoverModels(user, "workspace-1", "config-1")).resolves.toEqual([
      expect.objectContaining({ upstreamModelId: "chat-model", modality: "text", capabilities: ["text"] }),
      expect.objectContaining({ upstreamModelId: "gpt-image-2-all", modality: "image", capabilities: ["image_generation"] }),
      expect.objectContaining({ upstreamModelId: "veo-3.1", modality: "video", capabilities: ["video_generation"] }),
    ]);
    expect(fetchFn).toHaveBeenCalledWith("https://api.apiyi.com/v1/models", expect.objectContaining({ redirect: "error" }));
  });

  it("rejects oversized connection-test responses with a stable code", async () => {
    const admin = adminForConfig({
      rpc: async (name) => ({
        data: name === "loomic_provider_secret_read" ? "sk-live-secret-7890" : null,
        error: null,
      }),
    });
    const service = createProviderConfigService({
      createUserClient: () => userClient("owner"),
      getAdminClient: () => admin.client,
      fetchFn: vi.fn(async () => new Response("", {
        status: 200,
        headers: { "content-length": String(64 * 1024 + 1) },
      })) as unknown as typeof fetch,
    });
    await expect(service.test(user, "workspace-1", "config-1")).resolves.toMatchObject({
      ok: false,
      errorCode: "provider_response_too_large",
    });
  });

  it("deletes through the atomic Vault cleanup RPC", async () => {
    const admin = adminForConfig({
      rpc: async (name) => ({
        data: name === "loomic_provider_config_delete" ? true : null,
        error: null,
      }),
    });
    const service = createProviderConfigService({
      createUserClient: () => userClient("owner"),
      getAdminClient: () => admin.client,
    });
    await expect(service.delete(user, "workspace-1", "config-1")).resolves.toBeUndefined();
    expect(admin.rpc).toHaveBeenCalledWith("loomic_provider_config_delete", {
      p_workspace_id: "workspace-1",
      p_provider_config_id: "config-1",
      p_actor_user_id: "user-1",
    });
  });
});
