import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerImageTextRoutes } from "./image-text.js";
import { CanvasServiceError } from "../features/canvas/canvas-service.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("image text routes", () => {
  it("returns 404 without calling vision for an inaccessible canvas", async () => {
    const app = Fastify();apps.push(app);
    const recognize = vi.fn();
    await registerImageTextRoutes(app, {
      auth: { authenticate: async () => ({id:"user-1",accessToken:"token"}) } as never,
      canvasService: {getCanvas: async () => {throw new CanvasServiceError("canvas_not_found","Canvas not found.",404);}} as never,
      createUserClient: () => ({}) as never, recognizer: {recognize},
    });
    const response=await app.inject({method:"POST",url:"/api/images/recognize-text",payload:{canvasId:"d15393dd-63cd-4e92-abb6-5010398e5152",image:{assetId:"image-1",url:PNG,mimeType:"image/png"}}});
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("canvas_not_found");
    expect(recognize).not.toHaveBeenCalled();
  });
  it("authorizes the canvas image and returns structured recognized text", async () => {
    const app = Fastify();
    apps.push(app);
    const recognize = vi.fn(async () => ["aaaa.", "com"]);
    await registerImageTextRoutes(app, {
      auth: { authenticate: async () => ({ id: "user-1", accessToken: "token" }) } as never,
      canvasService: {
        getCanvas: async () => ({
          id: "d15393dd-63cd-4e92-abb6-5010398e5152",
          name: "Canvas",
          projectId: "project-1",
          content: {
            elements: [{ id: "image-1", type: "image", fileId: "file-1", isDeleted: false }],
            appState: {},
            files: { "file-1": { id: "file-1", dataURL: PNG, mimeType: "image/png" } },
          },
        }),
        saveCanvasContent: vi.fn(),
      } as never,
      createUserClient: () => ({}) as never,
      recognizer: { recognize },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/images/recognize-text",
      payload: {
        canvasId: "d15393dd-63cd-4e92-abb6-5010398e5152",
        image: { assetId: "image-1", url: PNG, mimeType: "image/png" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ texts: ["aaaa.", "com"] });
    expect(recognize).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "image/png" }));
  });
});
