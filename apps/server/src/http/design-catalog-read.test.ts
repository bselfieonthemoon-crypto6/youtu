import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerDesignCatalogReadRoutes } from "./design-catalog-read.js";

const apps: Array<ReturnType<typeof Fastify>> = [];
const id = "11111111-1111-4111-8111-111111111111";
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function setup(authenticated = true, embed = true) {
  const app = Fastify();
  apps.push(app);
  const auth = {
    authenticate: vi.fn(async () =>
      authenticated ? { id: "user", accessToken: "token" } : null,
    ),
  };
  const catalogService = {
    listTextPresets: vi.fn(async () => ({ items: [], next_cursor: null })),
    getTextPreset: vi.fn(async () => ({
      preset: { preview_asset_object_id: "asset" },
      font_face_ids: [],
    })),
    listFonts: vi.fn(async () => ({ items: [], next_cursor: null })),
    getFont: vi.fn(async () => ({ family: {}, faces: [] })),
    getFontFace: vi.fn(async () => ({
      asset_object_id: "font-asset",
      allow_web_embed: embed,
    })),
  };
  const uploadService = {
    getAssetContent: vi.fn(async () => ({
      buffer: Buffer.from("data"),
      mimeType: "font/woff2",
    })),
  };
  await registerDesignCatalogReadRoutes(app, {
    auth: auth as never,
    catalogService: catalogService as never,
    uploadService: uploadService as never,
  });
  return { app, catalogService, uploadService };
}

describe("design catalog read routes", () => {
  it("requires authentication and validates bounded list input", async () => {
    const denied = await setup(false);
    expect(
      (await denied.app.inject({ method: "GET", url: "/api/design-fonts" }))
        .statusCode,
    ).toBe(401);
    expect(denied.catalogService.listFonts).not.toHaveBeenCalled();
    const allowed = await setup();
    expect(
      (
        await allowed.app.inject({
          method: "GET",
          url: "/api/design-text-presets?limit=101",
        })
      ).statusCode,
    ).toBe(400);
  });

  it("authorizes a preset before loading its private preview", async () => {
    const { app, catalogService, uploadService } = await setup();
    const response = await app.inject({
      method: "GET",
      url: `/api/design-text-presets/${id}/preview`,
    });
    expect(response.statusCode).toBe(200);
    expect(catalogService.getTextPreset).toHaveBeenCalledBefore(
      uploadService.getAssetContent,
    );
    expect(uploadService.getAssetContent).toHaveBeenCalledWith(
      expect.anything(),
      "asset",
      { preview: true },
    );
  });

  it("refuses font bytes when the face disallows web embedding", async () => {
    const { app, uploadService } = await setup(true, false);
    const response = await app.inject({
      method: "GET",
      url: `/api/design-fonts/faces/${id}/content`,
    });
    expect(response.statusCode).toBe(403);
    expect(uploadService.getAssetContent).not.toHaveBeenCalled();
  });
});
