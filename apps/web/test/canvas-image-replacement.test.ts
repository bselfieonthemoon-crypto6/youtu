import { describe, expect, it, vi } from "vitest";

import {
  createImageReplacementElement,
  isImageReplacementElement,
  updateImageReplacementElement,
} from "../src/lib/canvas-image-replacement";

describe("canvas image replacement placeholder", () => {
  it("creates a real canvas node and can transition it without selection state", () => {
    let elements: any[] = [];
    const api = {
      getSceneElements: () => elements,
      updateScene: vi.fn((scene: { elements: any[] }) => { elements = scene.elements; }),
    };
    const id = createImageReplacementElement(api, { x: 300, y: 20, width: 200, height: 200 });

    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({ id, type: "rectangle", x: 300, y: 20, width: 200, height: 200 });
    expect(isImageReplacementElement(elements[0])).toBe(true);

    updateImageReplacementElement(api, id, { status: "error", errorMessage: "failed" });
    expect(elements[0].customData).toMatchObject({ status: "error", errorMessage: "failed" });
    expect(elements[0].version).toBe(2);
  });

  it("marks a direct regeneration placeholder with its own operation", () => {
    let elements: any[] = [];
    const api = {
      getSceneElements: () => elements,
      updateScene: (scene: { elements: any[] }) => { elements = scene.elements; },
    };
    createImageReplacementElement(api, { x: 10, y: 20, width: 100, height: 80 }, "regenerate");
    expect(elements[0].customData).toMatchObject({
      type: "image-replacement",
      status: "generating",
      operation: "regenerate",
    });
  });
});
