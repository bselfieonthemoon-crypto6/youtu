import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerUploadRoutes } from "./uploads.js";

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("authorized asset content", () => {
  it("requires authentication", async () => {
    const app = Fastify();
    apps.push(app);
    const getAssetContent = vi.fn();
    await registerUploadRoutes(app, {
      auth: { authenticate: async () => null },
      uploadService: { getAssetContent } as never,
      viewerService: {} as never,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/uploads/asset-1/content?preview=1",
    });
    expect(response.statusCode).toBe(401);
    expect(getAssetContent).not.toHaveBeenCalled();
  });

  it("returns a private cacheable preview from the authorized service", async () => {
    const app = Fastify();
    apps.push(app);
    const getAssetContent = vi.fn(async () => ({
      buffer: Buffer.from("preview"),
      mimeType: "image/webp",
    }));
    await registerUploadRoutes(app, {
      auth: {
        authenticate: async () => ({ id: "user-1", accessToken: "token" }),
      } as never,
      uploadService: { getAssetContent } as never,
      viewerService: {} as never,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/uploads/asset-1/content?preview=1",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/webp");
    expect(response.headers["cache-control"]).toBe("private, max-age=900");
    expect(response.rawPayload.toString()).toBe("preview");
    expect(getAssetContent).toHaveBeenCalledWith(
      { id: "user-1", accessToken: "token" },
      "asset-1",
      { preview: true },
    );
  });
});
