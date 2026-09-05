import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesignResourceServiceError } from "../features/design-resources/design-resource-service.js";
import { registerDesignResourceRoutes } from "./design-resources.js";

const apps: Array<ReturnType<typeof Fastify>> = [];
const resourceId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function userAuth(authenticated = true) {
  return {
    authenticate: vi.fn(async () =>
      authenticated
        ? { id: "user-1", accessToken: "token", email: "u@example.test" }
        : null,
    ),
  };
}

async function setup(overrides: Record<string, unknown> = {}) {
  const app = Fastify();
  apps.push(app);
  const resourceService = {
    list: vi.fn(async () => ({ items: [], next_cursor: null })),
    get: vi.fn(async () => ({
      asset_object_id: "asset-original",
      preview_asset_object_id: "asset-preview",
    })),
    create: vi.fn(),
    setFavorite: vi.fn(async (_user, input) => ({ favorite: input.favorite })),
    recordRecentUse: vi.fn(async () => ({
      used_at: "2026-09-04T00:00:00.000Z",
      use_count: 1,
    })),
    references: vi.fn(async () => ({ resource_id: resourceId })),
    softDelete: vi.fn(async () => undefined),
    ...overrides,
  };
  const uploadService = {
    getAssetContent: vi.fn(async () => ({
      buffer: Buffer.from("preview"),
      mimeType: "image/webp",
    })),
  };
  const auth = userAuth();
  await registerDesignResourceRoutes(app, {
    auth: auth as never,
    resourceService: resourceService as never,
    uploadService: uploadService as never,
  });
  return { app, auth, resourceService, uploadService };
}

describe("design resource routes", () => {
  it("requires authentication before catalog reads", async () => {
    const { app, auth, resourceService, uploadService } = await setup();
    auth.authenticate.mockResolvedValueOnce(null);
    const response = await app.inject({
      method: "GET",
      url: "/api/design-resources",
    });
    expect(response.statusCode).toBe(401);
    expect(resourceService.list).not.toHaveBeenCalled();
    expect(uploadService.getAssetContent).not.toHaveBeenCalled();
  });

  it("parses bounded pagination and forwards collection scoping", async () => {
    const { app, resourceService } = await setup();
    const response = await app.inject({
      method: "GET",
      url: `/api/design-resources?limit=25&kind=image&collection=recent&workspace_id=${workspaceId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(resourceService.list).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-1" }),
      expect.objectContaining({ limit: 25, kind: "image" }),
      { collection: "recent", workspaceId },
    );
    const invalid = await app.inject({
      method: "GET",
      url: "/api/design-resources?limit=101",
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("authorizes the catalog row before streaming its preview asset", async () => {
    const { app, resourceService, uploadService } = await setup();
    const response = await app.inject({
      method: "GET",
      url: `/api/design-resources/${resourceId}/preview`,
    });
    expect(response.statusCode).toBe(200);
    expect(resourceService.get).toHaveBeenCalledBefore(
      uploadService.getAssetContent,
    );
    expect(uploadService.getAssetContent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-1" }),
      "asset-preview",
      { preview: true },
    );
    expect(response.headers["cache-control"]).toBe("private, max-age=900");
  });

  it("makes favorite verbs idempotent and binds recent resource id from the path", async () => {
    const { app, resourceService } = await setup();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/design-resources/${resourceId}/favorite`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/design-resources/${resourceId}/favorite`,
        })
      ).statusCode,
    ).toBe(200);
    expect(resourceService.setFavorite).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      { resource_id: resourceId, favorite: true },
    );
    expect(resourceService.setFavorite).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      { resource_id: resourceId, favorite: false },
    );
    const recent = await app.inject({
      method: "POST",
      url: `/api/design-resources/${resourceId}/recent`,
      payload: { workspace_id: workspaceId },
    });
    expect(recent.statusCode).toBe(200);
    expect(resourceService.recordRecentUse).toHaveBeenCalledWith(
      expect.anything(),
      { resource_id: resourceId, workspace_id: workspaceId },
    );
  });

  it("does not hide safe-delete conflicts behind a generic error", async () => {
    const { app } = await setup({
      softDelete: vi.fn(async () => {
        throw new DesignResourceServiceError(
          "resource_in_use",
          "Resource is in use.",
          409,
        );
      }),
    });
    const response = await app.inject({
      method: "DELETE",
      url: `/api/admin/design-catalog/resources/${resourceId}`,
      payload: {
        request_id: "33333333-3333-4333-8333-333333333334",
        expected_revision: 0,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: { code: "resource_in_use", message: "Resource is in use." },
    });
  });

  it("allows admin lists to include deleted resources for restore workflows", async () => {
    const { app, resourceService } = await setup();
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/design-catalog/resources?deleted=all&limit=10",
    });
    expect(response.statusCode).toBe(200);
    expect(resourceService.list).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 10 }),
      { deleted: "all" },
    );
  });
});
