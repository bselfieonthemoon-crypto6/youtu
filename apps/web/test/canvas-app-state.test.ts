import { describe, expect, it } from "vitest";

import { buildInitialCanvasAppState } from "../src/lib/canvas-app-state";

describe("canvas initial app state", () => {
  it("enables native object snapping and preserves the persisted canvas state", () => {
    expect(buildInitialCanvasAppState({
      viewBackgroundColor: "#ffffff",
      gridModeEnabled: false,
      objectsSnapModeEnabled: false,
    })).toEqual({
      viewBackgroundColor: "#ffffff",
      gridModeEnabled: false,
      objectsSnapModeEnabled: true,
    });
  });
});
