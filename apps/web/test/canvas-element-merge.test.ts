import { describe, expect, it } from "vitest";
import { mergeCanvasElements } from "../src/lib/canvas-element-merge";

describe("mergeCanvasElements", () => {
  it("preserves unsaved local elements and appends generated remote elements", () => {
    const local = [{ id: "local", version: 1, x: 20 }];
    const remote = [{ id: "generated", version: 1, x: 200 }];

    expect(mergeCanvasElements(local, remote)).toEqual([
      { id: "local", version: 1, x: 20 },
      { id: "generated", version: 1, x: 200 },
    ]);
  });

  it("keeps the local copy when versions are equal", () => {
    const local = [{ id: "same", version: 3, x: 99 }];
    const remote = [{ id: "same", version: 3, x: 10 }];

    expect(mergeCanvasElements(local, remote)[0]?.x).toBe(99);
  });

  it("accepts a newer remote edit or deletion tombstone", () => {
    const local = [{ id: "same", version: 3, isDeleted: false }];
    const remote = [{ id: "same", version: 4, isDeleted: true }];

    expect(mergeCanvasElements(local, remote)[0]?.isDeleted).toBe(true);
  });
});
