import { describe, expect, it, vi } from "vitest";

import { createDesignCatalogAdminService } from "./design-catalog-admin-service.js";

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  accessToken: "token",
};
const input = {
  request_id: "22222222-2222-4222-8222-222222222222",
  entity_kind: "resource" as const,
  entity_id: "33333333-3333-4333-8333-333333333333",
  expected_revision: 2,
  status: "published" as const,
};

describe("design catalog admin service", () => {
  it("reads template references without querying a nonexistent source-template column", async () => {
    const visible = {
      select: vi.fn(() => visible),
      eq: vi.fn(() => visible),
      maybeSingle: vi.fn(async () => ({
        data: { id: input.entity_id },
        error: null,
      })),
    };
    const adminFrom = vi.fn();
    const service = createDesignCatalogAdminService({
      getAdminClient: () => ({ from: adminFrom }) as never,
      createUserClient: () => ({ from: vi.fn(() => visible) }) as never,
    });
    await expect(
      service.references(user as never, "template", input.entity_id),
    ).resolves.toEqual({
      entity_kind: "template",
      entity_id: input.entity_id,
      references: [],
    });
    expect(adminFrom).not.toHaveBeenCalled();
  });

  it("passes actor, request id, and CAS revision to the status RPC", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        entity_kind: "resource",
        entity_id: input.entity_id,
        revision: 3,
        status: "published",
        replayed: false,
      },
      error: null,
    }));
    const service = createDesignCatalogAdminService({
      getAdminClient: () => ({ rpc }) as never,
      createUserClient: vi.fn() as never,
    });
    await expect(
      service.setStatus(user as never, input),
    ).resolves.toMatchObject({ revision: 3 });
    expect(rpc).toHaveBeenCalledWith(
      "loomic_catalog_set_status",
      expect.objectContaining({
        p_request_id: input.request_id,
        p_expected_revision: 2,
        p_actor_user_id: user.id,
      }),
    );
  });

  it.each([
    ["40001", "catalog_revision_conflict", 409],
    ["23505", "catalog_idempotency_conflict", 409],
    ["23514", "catalog_publish_dependency_missing", 409],
    ["42501", "catalog_write_forbidden", 403],
  ])("maps database mutation error %s", async (code, message, statusCode) => {
    const service = createDesignCatalogAdminService({
      getAdminClient: () =>
        ({
          rpc: vi.fn(async () => ({ data: null, error: { code, message } })),
        }) as never,
      createUserClient: vi.fn() as never,
    });
    await expect(service.setStatus(user as never, input)).rejects.toMatchObject(
      { statusCode },
    );
  });
});

describe("design catalog preview url", () => {
  const resourceId = "33333333-3333-4333-8333-333333333333";
  const previewAssetId = "44444444-4444-4444-8444-444444444444";
  const contentAssetId = "55555555-5555-4555-8555-555555555555";

  function fakeClients(options: {
    row?: unknown;
    rowError?: unknown;
    asset?: unknown;
    signedUrl?: string | null;
    onSelect?: (columns: string) => void;
  }) {
    const createSignedUrl = vi.fn(async () => ({
      data: options.signedUrl === undefined ? { signedUrl: "https://signed.example/thumb" } : (options.signedUrl === null ? null : { signedUrl: options.signedUrl }),
    }));
    const from = vi.fn((table: string) => {
      if (table === "design_resources" || table === "design_templates") {
        const visible: any = {
          select: (columns: string) => {
            options.onSelect?.(columns);
            return visible;
          },
          eq: () => visible,
          maybeSingle: async () => ({
            data: options.row === undefined ? { id: resourceId, asset_object_id: contentAssetId, preview_asset_object_id: previewAssetId } : options.row,
            error: options.rowError ?? null,
          }),
        };
        return visible;
      }
      const asset: any = {
        select: () => asset,
        eq: () => asset,
        maybeSingle: async () => ({
          data: options.asset === undefined
            ? { bucket: "workspace-assets", object_path: "w/1/thumb.png", mime_type: "image/png" }
            : options.asset,
          error: null,
        }),
      };
      return asset;
    });
    return {
      createUserClient: () => ({ from }) as never,
      getAdminClient: () => ({ from, storage: { from: () => ({ createSignedUrl }) } }) as never,
      createSignedUrl,
    };
  }

  it("signs the explicit preview asset and reports that it did", async () => {
    const clients = fakeClients({});
    const service = createDesignCatalogAdminService({
      createUserClient: clients.createUserClient,
      getAdminClient: clients.getAdminClient,
    });
    await expect(
      service.previewUrl(user as never, "resource", resourceId),
    ).resolves.toEqual({
      entity_kind: "resource",
      entity_id: resourceId,
      uses_preview: true,
      asset_object_id: previewAssetId,
      mime_type: "image/png",
      url: "https://signed.example/thumb",
    });
    expect(clients.createSignedUrl).toHaveBeenCalledWith("w/1/thumb.png", 900);
  });

  it("falls back to the content asset when there is no preview", async () => {
    const clients = fakeClients({
      row: { id: resourceId, asset_object_id: contentAssetId, preview_asset_object_id: null },
    });
    const service = createDesignCatalogAdminService({
      createUserClient: clients.createUserClient,
      getAdminClient: clients.getAdminClient,
    });
    await expect(
      service.previewUrl(user as never, "template", resourceId),
    ).resolves.toMatchObject({
      uses_preview: false,
      asset_object_id: contentAssetId,
    });
  });

  it("never asks templates for a content asset column they do not have", async () => {
    // `design_templates` has no `asset_object_id`; selecting it makes PostgREST
    // reject the whole query, which surfaced as a 500 before this was split.
    const selected: string[] = [];
    const clients = fakeClients({
      row: { id: resourceId, preview_asset_object_id: previewAssetId },
      onSelect: (columns) => selected.push(columns),
    });
    const service = createDesignCatalogAdminService({
      createUserClient: clients.createUserClient,
      getAdminClient: clients.getAdminClient,
    });
    await expect(
      service.previewUrl(user as never, "template", resourceId),
    ).resolves.toMatchObject({ uses_preview: true, asset_object_id: previewAssetId });
    expect(selected).toEqual(["id,preview_asset_object_id"]);
  });

  it("returns a null url instead of a broken thumbnail when signing fails", async () => {
    const clients = fakeClients({ signedUrl: null });
    const service = createDesignCatalogAdminService({
      createUserClient: clients.createUserClient,
      getAdminClient: clients.getAdminClient,
    });
    await expect(
      service.previewUrl(user as never, "resource", resourceId),
    ).resolves.toMatchObject({ url: null });
  });

  it("hides a row the caller cannot see, and refuses collections without an image", async () => {
    const invisible = fakeClients({ row: null });
    const hidden = createDesignCatalogAdminService({
      createUserClient: invisible.createUserClient,
      getAdminClient: invisible.getAdminClient,
    });
    await expect(
      hidden.previewUrl(user as never, "resource", resourceId),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(invisible.createSignedUrl).not.toHaveBeenCalled();

    const clients = fakeClients({});
    const service = createDesignCatalogAdminService({
      createUserClient: clients.createUserClient,
      getAdminClient: clients.getAdminClient,
    });
    for (const kind of ["text_preset", "font_family", "font_face", "category", "tag"] as const) {
      await expect(
        service.previewUrl(user as never, kind, resourceId),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
    // The refusal happens before any database access.
    expect(clients.createSignedUrl).not.toHaveBeenCalled();
  });

  it("reports a row with no image at all rather than signing nothing", async () => {
    const clients = fakeClients({ row: { id: resourceId, asset_object_id: null, preview_asset_object_id: null } });
    const service = createDesignCatalogAdminService({
      createUserClient: clients.createUserClient,
      getAdminClient: clients.getAdminClient,
    });
    await expect(
      service.previewUrl(user as never, "resource", resourceId),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
