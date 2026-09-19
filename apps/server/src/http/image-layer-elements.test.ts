import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerImageLayerElementRoutes } from "./image-layer-elements.js";
import { CanvasServiceError } from "../features/canvas/canvas-service.js";
import { parseSuggestedLayerElements } from "../features/images/layer-element-suggester.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("image layer element routes", () => {
  it("returns 404 without calling vision for an inaccessible canvas", async () => {
    const app = Fastify(); apps.push(app);
    const suggest = vi.fn();
    await registerImageLayerElementRoutes(app, {
      auth: { authenticate: async () => ({ id: "user-1", accessToken: "token" }) } as never,
      canvasService: { getCanvas: async () => { throw new CanvasServiceError("canvas_not_found", "Canvas not found.", 404); } } as never,
      createUserClient: () => ({}) as never, suggester: { suggest },
    });
    const response = await app.inject({ method: "POST", url: "/api/images/layer-elements",
      payload: { canvasId: "d15393dd-63cd-4e92-abb6-5010398e5152", image: { assetId: "image-1", url: PNG, mimeType: "image/png" } } });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("canvas_not_found");
    expect(suggest).not.toHaveBeenCalled();
  });

  it("authorizes the canvas image and returns the proposed element names", async () => {
    const app = Fastify(); apps.push(app);
    const suggest = vi.fn(async () => ["左侧人物", "标题文字"]);
    await registerImageLayerElementRoutes(app, {
      auth: { authenticate: async () => ({ id: "user-1", accessToken: "token" }) } as never,
      canvasService: {
        getCanvas: async () => ({
          id: "d15393dd-63cd-4e92-abb6-5010398e5152", name: "Canvas", projectId: "project-1",
          content: {
            elements: [{ id: "image-1", type: "image", fileId: "file-1", isDeleted: false }],
            appState: {},
            files: { "file-1": { id: "file-1", dataURL: PNG, mimeType: "image/png" } },
          },
        }),
        saveCanvasContent: vi.fn(),
      } as never,
      createUserClient: () => ({}) as never,
      suggester: { suggest },
    });

    const response = await app.inject({ method: "POST", url: "/api/images/layer-elements",
      payload: { canvasId: "d15393dd-63cd-4e92-abb6-5010398e5152",
        image: { assetId: "image-1", url: PNG, mimeType: "image/png" } } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ elements: ["左侧人物", "标题文字"] });
    expect(suggest).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "image/png" }));
  });

  it("explains that too few elements means using the box flow instead", async () => {
    const app = Fastify(); apps.push(app);
    const error = Object.assign(new Error("too few"), { code: "layer_elements_unavailable" });
    await registerImageLayerElementRoutes(app, {
      auth: { authenticate: async () => ({ id: "user-1", accessToken: "token" }) } as never,
      canvasService: {
        getCanvas: async () => ({
          id: "d15393dd-63cd-4e92-abb6-5010398e5152", name: "Canvas", projectId: "project-1",
          content: {
            elements: [{ id: "image-1", type: "image", fileId: "file-1", isDeleted: false }],
            appState: {},
            files: { "file-1": { id: "file-1", dataURL: PNG, mimeType: "image/png" } },
          },
        }),
        saveCanvasContent: vi.fn(),
      } as never,
      createUserClient: () => ({}) as never,
      suggester: { suggest: vi.fn(async () => { throw error; }) },
    });
    const response = await app.inject({ method: "POST", url: "/api/images/layer-elements",
      payload: { canvasId: "d15393dd-63cd-4e92-abb6-5010398e5152",
        image: { assetId: "image-1", url: PNG, mimeType: "image/png" } } });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toContain("框选剥离");
  });
});

describe("parseSuggestedLayerElements", () => {
  it("keeps a bounded, deduplicated list and drops prose or markdown", () => {
    expect(parseSuggestedLayerElements('```json\n{"elements":["左侧人物","标题文字","左侧人物","右下角金币","多余元素"]}\n```'))
      .toEqual(["左侧人物", "标题文字", "右下角金币", "多余元素"]);
    expect(parseSuggestedLayerElements('{"elements":["  人物  ","","人物"]}')).toEqual(["人物"]);
    expect(parseSuggestedLayerElements("sorry, I could not read this image")).toEqual([]);
    expect(parseSuggestedLayerElements('{"elements":[1,null]}')).toEqual([]);
  });
});
