import { describe, expect, it, vi } from "vitest";

import { createDesignImportApiService } from "./design-import-api-service.js";

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  accessToken: "token",
};
describe("design import API service", () => {
  it("enqueues the full discriminated manifest atomically through the idempotent RPC", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        import_job_id: "22222222-2222-4222-8222-222222222222",
        status: "queued",
        replayed: true,
      },
      error: null,
    }));
    const service = createDesignImportApiService({
      createUserClient: vi.fn() as never,
      getAdminClient: () => ({ rpc }) as never,
    });
    const input = {
      request_id: "33333333-3333-4333-8333-333333333333",
      scope: "workspace" as const,
      workspace_id: "44444444-4444-4444-8444-444444444444",
      items: [
        {
          source_key: "category/hero",
          entity_kind: "category" as const,
          asset_object_id: null,
          metadata: { payload: { name: "Hero" } },
        },
      ],
    };
    await expect(
      service.enqueueManifest(user as never, input),
    ).resolves.toMatchObject({ replayed: true });
    expect(rpc).toHaveBeenCalledWith(
      "loomic_resource_import_manifest_enqueue",
      expect.objectContaining({
        p_request_id: input.request_id,
        p_manifest_items: input.items,
        p_actor_user_id: user.id,
      }),
    );
  });

  it("creates an idempotent multi-item URL job through the actor RPC", async () => {
    const rpc = vi.fn(async (..._args: unknown[]) => ({
      data: {
        import_job_id: "22222222-2222-4222-8222-222222222222",
        status: "queued",
        replayed: false,
      },
      error: null,
    }));
    const service = createDesignImportApiService({
      createUserClient: vi.fn() as never,
      getAdminClient: () => ({ rpc }) as never,
    });
    await service.create(user as never, {
      request_id: "33333333-3333-4333-8333-333333333333",
      scope: "workspace",
      workspace_id: "44444444-4444-4444-8444-444444444444",
      source_kind: "url",
      source_urls: ["https://example.test/a.png", "https://example.test/b.png"],
    });
    expect(rpc).toHaveBeenCalledWith(
      "loomic_resource_import_create",
      expect.objectContaining({
        p_actor_user_id: user.id,
        p_source: {
          source_urls: [
            "https://example.test/a.png",
            "https://example.test/b.png",
          ],
        },
      }),
    );
  });

  it("maps RPC permission denial to 403", async () => {
    const service = createDesignImportApiService({
      createUserClient: vi.fn() as never,
      getAdminClient: () =>
        ({
          rpc: vi.fn(async () => ({ data: null, error: { code: "42501" } })),
        }) as never,
    });
    await expect(
      service.create(user as never, {
        request_id: "33333333-3333-4333-8333-333333333333",
        scope: "workspace",
        workspace_id: "44444444-4444-4444-8444-444444444444",
        source_kind: "url",
        source_urls: ["https://example.test/a.png"],
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
