import { describe, expect, it } from "vitest";

import {
  CANVAS_SAVE_DEBOUNCE_MS,
  canvasSaveDelay,
  deletionRevisionKey,
} from "../src/lib/canvas-save-policy";

describe("canvas save policy", () => {
  it("saves a newly deleted element immediately", () => {
    const before = [{ id: "image", version: 1, isDeleted: false }];
    const after = [{ id: "image", version: 2, isDeleted: true }];

    expect(canvasSaveDelay(deletionRevisionKey(before), after)).toEqual({
      delayMs: 0,
      deletionKey: "image:2",
    });
  });

  it("keeps ordinary edits debounced", () => {
    const elements = [
      { id: "deleted", version: 3, isDeleted: true },
      { id: "live", version: 8, isDeleted: false, x: 100 },
    ];
    const key = deletionRevisionKey(elements);

    expect(canvasSaveDelay(key, elements)).toEqual({
      delayMs: CANVAS_SAVE_DEBOUNCE_MS,
      deletionKey: key,
    });
  });

  it("detects deletion revisions regardless of element order", () => {
    expect(deletionRevisionKey([
      { id: "b", version: 2, isDeleted: true },
      { id: "a", version: 4, isDeleted: true },
    ])).toBe("a:4|b:2");
  });
});
