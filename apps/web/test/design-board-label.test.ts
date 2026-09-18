import { describe, expect, it } from "vitest";
import { designBoardLabel } from "../src/lib/design-board-label";

describe("designBoardLabel", () => {
  it("uses a stable design identity instead of the canvas element position", () => {
    expect(designBoardLabel("fb182acd-b799-4d96-802a-f2e46b3d947d")).toBe("画板 · fb182acd");
  });
});
