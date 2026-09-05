import { describe, expect, it } from "vitest";
import {
  collectCanvasOwnedStoragePaths,
  collectLiveAssetReferences,
  pruneFilesWithoutLiveElements,
} from "./canvas-asset-references.js";

const assetId = "00000000-0000-4000-8000-000000000001";

describe("canvas asset reference extraction", () => {
  it("counts only live elements and prunes deleted image files", () => {
    const content = {
      elements: [
        { id: "live", fileId: "file-live", customData: { assetId } },
        { id: "deleted", fileId: "file-deleted", isDeleted: true, customData: { assetId } },
      ],
      appState: {},
      files: {
        "file-live": { dataURL: "oss://workspace-assets/ws/canvas-files/c/file-live.png" },
        "file-deleted": { dataURL: "oss://workspace-assets/ws/canvas-files/c/file-deleted.png" },
      },
    };

    expect(collectLiveAssetReferences(content)).toEqual([{ assetId, elementId: "live" }]);
    expect(Object.keys((pruneFilesWithoutLiveElements(content) as any).files)).toEqual(["file-live"]);
  });

  it("only returns canvas-owned paths under the exact workspace and canvas", () => {
    const content = {
      elements: [{ id: "one", fileId: "one" }, { id: "two", fileId: "two" }],
      appState: {},
      files: {
        one: { storageRef: "oss://workspace-assets/ws/canvas-files/c/one.png" },
        two: { storageRef: "oss://workspace-assets/other/canvas-files/c/two.png" },
      },
    };
    expect(collectCanvasOwnedStoragePaths(content, "ws", "c")).toEqual([
      "ws/canvas-files/c/one.png",
    ]);
  });
});
