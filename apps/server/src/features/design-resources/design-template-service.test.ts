import { describe, expect, it, vi } from "vitest";

import { createDesignTemplateService } from "./design-template-service.js";

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  accessToken: "token",
  email: "u@example.test",
  userMetadata: {},
};

describe("design template service", () => {
  it("loads template asset references with their resource binding", async () => {
    const resourceId = "66666666-6666-4666-8666-666666666666";
    const assetId = "77777777-7777-4777-8777-777777777777";
    const templateId = "22222222-2222-4222-8222-222222222222";
    const selected = vi.fn();
    const chain = (result: unknown) => {
      const query: Record<string, unknown> = {};
      for (const method of ["eq", "is", "order", "in"])
        query[method] = vi.fn(() => query);
      query.select = vi.fn((columns: string) => {
        selected(columns);
        return query;
      });
      query.maybeSingle = vi.fn(async () => result);
      // biome-ignore lint/suspicious/noThenProperty: Supabase query builders are thenable
      query.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve(result).then(resolve);
      return query;
    };
    const scene = {
      schemaVersion: 1,
      engine: "fabric",
      canvas: { width: 100, height: 100, background: null },
      objects: [],
    };
    const templateRow = {
      id: templateId,
      scope: "workspace",
      workspace_id: "33333333-3333-4333-8333-333333333333",
      name: "Template",
      description: null,
      scene,
      schema_version: 1,
      engine_version: "fabric@7.4.0",
      width: 100,
      height: 100,
      preview_asset_object_id: null,
      revision: 0,
      status: "draft",
      category_id: null,
      source_url: null,
      author: null,
      license_name: null,
      license_url: null,
      attribution: null,
      usage_restrictions: null,
      deleted_at: null,
      created_at: "2026-09-04T00:00:00.000Z",
      updated_at: "2026-09-04T00:00:00.000Z",
    };
    const from = vi.fn((table: string) => {
      if (table === "design_templates")
        return chain({ data: templateRow, error: null });
      if (table === "design_template_asset_refs")
        return chain({
          data: [
            {
              template_id: templateId,
              object_id: "88888888-8888-4888-8888-888888888888",
              slot: "source",
              asset_object_id: assetId,
              resource_id: resourceId,
            },
          ],
          error: null,
        });
      return chain({ data: [], error: null });
    });
    const client = {
      from(table: string) {
        if (this !== client)
          throw new TypeError("Supabase from() lost its client receiver");
        return from(table);
      },
    };
    const service = createDesignTemplateService({
      createUserClient: () => client as never,
      getAdminClient: vi.fn() as never,
      designService: vi.fn() as never,
    });
    const detail = await service.get(user, templateId);
    expect(detail.asset_refs[0]?.resource_id).toBe(resourceId);
    expect(selected).toHaveBeenCalledWith(
      expect.stringContaining("resource_id"),
    );
  });

  it("never allows a workspace template to be created from another workspace design", async () => {
    const admin = { from: vi.fn() };
    const designService = {
      get: vi.fn(async () => ({
        id: "22222222-2222-4222-8222-222222222222",
        workspace_id: "33333333-3333-4333-8333-333333333333",
        width: 100,
        height: 100,
        preview_asset_object_id: null,
        scene: {
          schemaVersion: 1,
          engine: "fabric",
          canvas: { width: 100, height: 100, background: null },
          objects: [],
        },
      })),
    };
    const service = createDesignTemplateService({
      createUserClient: vi.fn() as never,
      getAdminClient: () => admin as never,
      designService: designService as never,
    });
    await expect(
      service.createFromDesign(user, {
        request_id: "44444444-4444-4444-8444-444444444444",
        design_id: "22222222-2222-4222-8222-222222222222",
        scope: "workspace",
        workspace_id: "55555555-5555-4555-8555-555555555555",
        name: "Cross workspace",
        description: null,
        preview_asset_object_id: null,
        category_id: null,
        tag_ids: [],
        source_url: null,
        author: null,
        license_name: null,
        license_url: null,
        attribution: null,
        usage_restrictions: null,
      }),
    ).rejects.toMatchObject({ code: "resource_forbidden", statusCode: 403 });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("keeps scope metadata outside the strict template RPC payload", async () => {
    const rpc = vi.fn(async (..._args: unknown[]) => ({
      data: null,
      error: { code: "42501", message: "catalog_write_forbidden" },
    }));
    const designService = {
      get: vi.fn(async () => ({
        id: "22222222-2222-4222-8222-222222222222",
        workspace_id: "33333333-3333-4333-8333-333333333333",
        width: 100,
        height: 100,
        preview_asset_object_id: null,
        scene: {
          schemaVersion: 1,
          engine: "fabric",
          canvas: { width: 100, height: 100, background: null },
          objects: [],
        },
      })),
    };
    const service = createDesignTemplateService({
      createUserClient: vi.fn() as never,
      getAdminClient: () => ({ rpc, from: vi.fn() }) as never,
      designService: designService as never,
    });
    await expect(
      service.createFromDesign(user, {
        request_id: "44444444-4444-4444-8444-444444444444",
        design_id: "22222222-2222-4222-8222-222222222222",
        scope: "workspace",
        workspace_id: "33333333-3333-4333-8333-333333333333",
        name: "Template",
        description: null,
        preview_asset_object_id: null,
        category_id: null,
        tag_ids: [],
        source_url: null,
        author: null,
        license_name: null,
        license_url: null,
        attribution: null,
        usage_restrictions: null,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const args = rpc.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(args).toMatchObject({
      p_request_id: "44444444-4444-4444-8444-444444444444",
      p_scope: "workspace",
      p_workspace_id: "33333333-3333-4333-8333-333333333333",
    });
    const payload = args?.p_payload as Record<string, unknown> | undefined;
    expect(payload).not.toHaveProperty("request_id");
    expect(payload).not.toHaveProperty("scope");
    expect(payload).not.toHaveProperty("workspace_id");
  });
});
