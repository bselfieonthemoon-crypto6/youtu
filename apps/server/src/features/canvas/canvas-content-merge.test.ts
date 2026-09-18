import { describe, expect, it } from "vitest";

import { mergeCanvasContent } from "./canvas-content-merge.js";

describe("mergeCanvasContent", () => {
  it("keeps a completed split tombstone through a higher-version stale save", () => {
    const data = { type: "image-replacement", jobId: "split", completedJobId: "split" };
    const latest = { elements: [{ id: "pending", version: 3, isDeleted: true, customData: data }], files: {}, appState: {} };
    const incoming = { elements: [{ id: "pending", version: 40, isDeleted: false, customData: { type: "image-replacement", jobId: "split" } }], files: {}, appState: {} };
    expect(mergeCanvasContent(latest, incoming).elements).toEqual([expect.objectContaining({ isDeleted: true, customData: data })]);
  });
  it.each(["image-replacement", "image-generator"])("does not let a late %s save overwrite completed pixels", (type) => {
    const latest = { elements: [{ id: "p2", type: "image", version: 4, fileId: "f2", customData: { sourceJobId: "job2" } }], files: { f2: { id: "f2", dataURL: "oss://bucket/test.png" } }, appState: {} };
    const stale = { elements: [{ id: "p2", type: "rectangle", version: 40, x: 10, y: -500, customData: { type, status: "error", jobId: "job2" } }], appState: {}, files: {} };
    const result = mergeCanvasContent(latest, stale);
    expect(result.elements).toEqual([expect.objectContaining({ id: "p2", type: "image", version: 41, x: 10, y: -500, fileId: "f2", customData: { sourceJobId: "job2" } })]);
    expect(result.files).toHaveProperty("f2");
  });
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
