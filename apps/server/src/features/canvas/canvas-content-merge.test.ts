import { describe, expect, it } from "vitest";

import { mergeCanvasContent } from "./canvas-content-merge.js";

describe("mergeCanvasContent", () => {
  it("retains concurrently inserted elements and their files", () => {
    const merged = mergeCanvasContent(
      {
        elements: [
          { id: "existing", version: 1 },
          { id: "agent-image", type: "image", fileId: "file-2", version: 1 },
        ],
        appState: {},
        files: {
          "file-2": { id: "file-2", dataURL: "oss://bucket/image.png" },
        },
      },
      {
        elements: [{ id: "existing", version: 2, x: 20 }],
        appState: { gridModeEnabled: true },
        files: {},
      },
    );

    expect(merged.elements).toEqual([
      { id: "existing", version: 2, x: 20 },
      { id: "agent-image", type: "image", fileId: "file-2", version: 1 },
    ]);
    expect(merged.files).toMatchObject({
      "file-2": { dataURL: "oss://bucket/image.png" },
    });
  });

  it("keeps an explicit deletion tombstone", () => {
    const merged = mergeCanvasContent(
      {
        elements: [{ id: "image", version: 1, isDeleted: false }],
        appState: {},
        files: {},
      },
      {
        elements: [{ id: "image", version: 2, isDeleted: true }],
        appState: {},
        files: {},
      },
    );

    expect(merged.elements).toEqual([
      { id: "image", version: 2, isDeleted: true },
    ]);
  });

  it("does not replace a newer element with a stale version", () => {
    const merged = mergeCanvasContent(
      {
        elements: [{ id: "shape", version: 4, x: 80 }],
        appState: {},
        files: {},
      },
      {
        elements: [{ id: "shape", version: 3, x: 10 }],
        appState: {},
        files: {},
      },
    );

    expect(merged.elements).toEqual([{ id: "shape", version: 4, x: 80 }]);
  });
});
