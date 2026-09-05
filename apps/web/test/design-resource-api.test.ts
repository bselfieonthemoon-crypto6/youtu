import { describe, expect, it, vi } from "vitest";

import {
  DesignResourceApiError,
  createDesignResourceApiClient,
} from "../src/lib/design-resource-api";

const resourceId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const timestamp = "2026-09-04T00:00:00.000Z";

const resource = {
  id: resourceId,
  scope: "workspace",
  workspace_id: workspaceId,
  kind: "image",
  name: "封面素材",
  description: null,
  asset_object_id: assetId,
  preview_asset_object_id: null,
  width: 800,
  height: 600,
  checksum_sha256: "a".repeat(64),
  revision: 1,
  status: "published",
  category_id: null,
  tag_ids: [],
  source_url: null,
  author: null,
  license_name: null,
  license_url: null,
  attribution: null,
  usage_restrictions: null,
  deleted_at: null,
  created_at: timestamp,
  updated_at: timestamp,
};

describe("design resource API client", () => {
  it("validates and encodes server-side cursor/search/collection queries", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ items: [resource], next_cursor: "next page" }),
    );
    const client = createDesignResourceApiClient({
      baseUrl: "https://design.test/",
      fetch: fetchMock as typeof fetch,
    });

    const response = await client.listResources("token", {
      query: "海报 背景",
      cursor: "cursor/1",
      limit: 20,
      collection: "favorites",
      status: "published",
    });

    expect(response.items[0]?.asset_object_id).toBe(assetId);
    const calls = fetchMock.mock.calls as unknown as Array<
      [RequestInfo | URL, RequestInit?]
    >;
    const call = calls[0];
    expect(call).toBeDefined();
    const [requestUrl, requestInit] = call as [RequestInfo | URL, RequestInit?];
    const url = new URL(String(requestUrl));
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://design.test/api/design-resources",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: "published",
      query: "海报 背景",
      collection: "favorites",
      cursor: "cursor/1",
      limit: "20",
    });
    expect(requestInit).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token" }),
      }),
    );
  });

  it("downloads authorized binary content and forwards AbortSignal", async () => {
    const body = new Blob(["image"], { type: "image/png" });
    const fetchMock = vi.fn(
      async () =>
        new Response(body, { headers: { "content-type": "image/png" } }),
    );
    const client = createDesignResourceApiClient({
      baseUrl: "https://design.test",
      fetch: fetchMock as typeof fetch,
    });
    const controller = new AbortController();

    await expect(
      client.getResourcePreview("token", resourceId, controller.signal),
    ).resolves.toHaveProperty("type", "image/png");
    expect(fetchMock).toHaveBeenCalledWith(
      `https://design.test/api/design-resources/${resourceId}/preview`,
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("loads font bytes through the web-embedding policy endpoint", async () => {
    const body = new Blob(["font"], { type: "font/woff2" });
    const fetchMock = vi.fn(async () => new Response(body));
    const client = createDesignResourceApiClient({
      baseUrl: "https://design.test",
      fetch: fetchMock as typeof fetch,
    });

    await client.getFontFaceContent("token", resourceId);

    expect(fetchMock).toHaveBeenCalledWith(
      `https://design.test/api/design-fonts/faces/${resourceId}/content`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token" }),
      }),
    );
  });

  it("persists favorites and recent use through the catalog endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ favorite: true }))
      .mockResolvedValueOnce(
        Response.json({ used_at: timestamp, use_count: 2 }),
      );
    const client = createDesignResourceApiClient({
      baseUrl: "https://design.test",
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.setFavorite("token", resourceId, true)).resolves.toBe(
      true,
    );
    await expect(
      client.recordRecentUse("token", resourceId, workspaceId),
    ).resolves.toEqual({ used_at: timestamp, use_count: 2 });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "PUT" });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
  });

  it("rejects malformed catalog pages instead of leaking untyped data", async () => {
    const client = createDesignResourceApiClient({
      baseUrl: "https://design.test",
      fetch: vi.fn(async () =>
        Response.json({ items: [{}], next_cursor: null }),
      ) as typeof fetch,
    });

    await expect(client.listTemplates("token")).rejects.toBeInstanceOf(
      DesignResourceApiError,
    );
  });

  it("uploads font bytes through the validated admin font endpoint", async () => {
    const response = {
      asset_object_id: assetId,
      family_name: "Geist Mono",
      style: "normal",
      weight: 400,
      format: "ttf",
      checksum_sha256: "b".repeat(64),
      allow_web_embed: true,
    };
    const fetchMock = vi.fn(async () =>
      Response.json(response, { status: 201 }),
    );
    const client = createDesignResourceApiClient({
      baseUrl: "https://design.test",
      fetch: fetchMock as typeof fetch,
    });
    const file = new File(["font"], "GeistMono-Regular.ttf", {
      type: "font/ttf",
    });

    await expect(
      client.uploadAdminFontFile("token", workspaceId, file),
    ).resolves.toEqual(response);

    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(requestInit.method).toBe("POST");
    expect(requestInit.headers).not.toHaveProperty("content-type");
    const formData = requestInit.body as FormData;
    expect(formData.get("workspace_id")).toBe(workspaceId);
    expect(formData.get("file")).toBeInstanceOf(File);
  });

  it("uses the formal package, inline manifest and directory import contracts", async () => {
    const response = {
      import_job_id: "44444444-4444-4444-8444-444444444444",
      status: "queued",
      replayed: false,
    } as const;
    const fetchMock = vi.fn(async () => Response.json(response));
    const client = createDesignResourceApiClient({
      baseUrl: "https://design.test",
      fetch: fetchMock as typeof fetch,
    });
    const file = new File(["zip"], "catalog.zip", {
      type: "application/zip",
    });
    const inlineManifest = {
      version: 1 as const,
      items: [
        {
          source_key: "category/brand",
          entity_kind: "category" as const,
          payload: { name: "品牌", slug: "brand" },
        },
        {
          source_key: "tag/gold",
          entity_kind: "tag" as const,
          payload: { name: "金色", slug: "gold" },
        },
        {
          source_key: "resource/logo",
          entity_kind: "resource" as const,
          source_url: "https://example.com/logo.png",
          depends_on: ["category/brand", "tag/gold"],
          payload: { name: "Logo" },
        },
      ],
    };

    await client.createImportPackage("token", {
      request_id: resourceId,
      workspace_id: workspaceId,
      file,
    });
    await client.createImport("token", {
      request_id: resourceId,
      scope: "workspace",
      workspace_id: workspaceId,
      source_kind: "manifest_inline",
      manifest: inlineManifest,
    });
    await client.createDirectoryImport("token", {
      request_id: resourceId,
      scope: "workspace",
      workspace_id: workspaceId,
      source_kind: "server_directory",
      directory_path: "campaigns/autumn",
    });

    const calls = fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >;
    const packageRequest = calls[0]?.[1];
    expect(packageRequest?.headers).not.toHaveProperty("content-type");
    expect(packageRequest?.body).toBeInstanceOf(FormData);
    const formData = packageRequest?.body as FormData;
    expect(formData.get("request_id")).toBe(resourceId);
    expect(formData.get("workspace_id")).toBe(workspaceId);
    expect(formData.get("file")).toBeInstanceOf(File);
    expect(calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          request_id: resourceId,
          scope: "workspace",
          workspace_id: workspaceId,
          source_kind: "manifest_inline",
          manifest: inlineManifest,
        }),
      }),
    );
    expect(calls[2]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          request_id: resourceId,
          scope: "workspace",
          workspace_id: workspaceId,
          source_kind: "server_directory",
          directory_path: "campaigns/autumn",
        }),
      }),
    );
  });

  it("uses centralized admin CAS, deleted-list, reference and import endpoints", async () => {
    const mutation = {
      entity_kind: "resource",
      entity_id: resourceId,
      revision: 2,
      status: "draft",
      replayed: false,
    };
    const importId = "44444444-4444-4444-8444-444444444444";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          items: [{ ...resource, deleted_at: timestamp }],
          next_cursor: null,
        }),
      )
      .mockResolvedValueOnce(Response.json(mutation))
      .mockResolvedValueOnce(Response.json(mutation))
      .mockResolvedValueOnce(
        Response.json({ resource_id: resourceId, design_references: [] }),
      )
      .mockResolvedValueOnce(
        Response.json({
          import_job_id: importId,
          status: "queued",
          replayed: false,
        }),
      );
    const client = createDesignResourceApiClient({
      baseUrl: "https://design.test",
      fetch: fetchMock as typeof fetch,
    });

    await client.listAdminResources("token", { deleted: "true" });
    await client.updateAdminCatalogEntry("token", "resources", resourceId, {
      request_id: workspaceId,
      resource_id: resourceId,
      expected_revision: 1,
      name: "新名称",
    });
    await client.setAdminCatalogDeleted(
      "token",
      {
        request_id: workspaceId,
        entity_kind: "resource",
        entity_id: resourceId,
        expected_revision: 2,
      },
      true,
    );
    await client.getAdminReferences("token", "resource", resourceId);
    await client.createImport("token", {
      request_id: workspaceId,
      scope: "workspace",
      workspace_id: workspaceId,
      source_kind: "url",
      source_urls: ["https://example.com/poster.png"],
    });

    const calls = fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >;
    expect(calls[0]?.[0]).toContain("deleted=true");
    expect(calls[1]).toEqual([
      `https://design.test/api/admin/design-catalog/resources/${resourceId}`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          request_id: workspaceId,
          resource_id: resourceId,
          expected_revision: 1,
          name: "新名称",
        }),
      }),
    ]);
    expect(calls[2]?.[0]).toBe(
      "https://design.test/api/admin/design-catalog/delete",
    );
    expect(calls[3]?.[0]).toBe(
      `https://design.test/api/admin/design-catalog/resources/${resourceId}/references`,
    );
    expect(calls[4]?.[0]).toBe(
      "https://design.test/api/admin/design-catalog/imports",
    );
  });

  it("uses the formal variable update, smart preview and confirmed apply routes", async () => {
    const objectId = "44444444-4444-4444-8444-444444444444";
    const preview = {
      design_id: assetId,
      template_id: resourceId,
      design_revision: 5,
      template_revision: 3,
      commands: [],
      differences: [],
      unresolved_keys: [],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(preview))
      .mockResolvedValueOnce(
        Response.json({
          preview,
          mutation: {
            design_id: assetId,
            revision: 6,
            changed_object_ids: [objectId],
            replayed: false,
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          entity_kind: "template",
          entity_id: resourceId,
          revision: 4,
          status: "draft",
          replayed: false,
        }),
      );
    const client = createDesignResourceApiClient({
      baseUrl: "https://design.test",
      fetch: fetchMock as typeof fetch,
    });
    const replacement = {
      design_id: assetId,
      template_id: resourceId,
      expected_revision: 5,
      expected_template_revision: 3,
      bindings: [{ key: "title", type: "text" as const, value: "秋季活动" }],
      smart_bindings: [],
    };

    await client.previewTemplateReplacement("token", replacement);
    await client.applyTemplateReplacement("token", {
      ...replacement,
      idempotency_key: workspaceId,
    });
    await client.updateAdminTemplateVariables("token", resourceId, {
      request_id: workspaceId,
      expected_revision: 3,
      variables: [
        {
          key: "title",
          label: "标题",
          type: "text",
          required: true,
          target: { object_id: objectId, property: "text" },
        },
      ],
    });

    const calls = fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >;
    expect(calls[0]).toEqual([
      `https://design.test/api/design-templates/${resourceId}/replace-preview`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(replacement),
      }),
    ]);
    expect(calls[1]?.[0]).toBe(
      `https://design.test/api/design-templates/${resourceId}/replace-apply`,
    );
    expect(calls[2]).toEqual([
      `https://design.test/api/admin/design-catalog/templates/${resourceId}/variables`,
      expect.objectContaining({ method: "PUT" }),
    ]);
  });
});
