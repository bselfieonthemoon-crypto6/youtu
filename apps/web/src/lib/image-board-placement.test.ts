import { describe, expect, it } from "vitest";
import {
  boardContainsCanvasPoint,
  classifyImageBoardPlacement,
  getAdoptedImagePlacement,
  getFittedImagePlacement,
  type ImageBoardTarget,
} from "./image-board-placement";
import type { SelectedCanvasImage } from "../components/canvas/image-toolbar-types";

const board: ImageBoardTarget = { elementId: "board-1", designId: "design-1", name: "海报", x: 100, y: 100, width: 200, height: 100 };
const image = (overrides: Partial<SelectedCanvasImage> = {}): SelectedCanvasImage => ({ id: "image-1", fileId: "file-1", x: 150, y: 125, width: 40, height: 30, mimeType: "image/png", ...overrides });

describe("image board placement", () => {
  it("distinguishes fully-contained, centre-inside overflow, and outside images", () => {
    expect(classifyImageBoardPlacement(board, image())).toBe("fully-contained");
    expect(classifyImageBoardPlacement(board, image({ x: 240, y: 125, width: 120, height: 30 }))).toBe("center-inside");
    expect(classifyImageBoardPlacement(board, image({ x: 310, y: 125 }))).toBe("outside");
  });

  it("uses the board rotation when checking a canvas point", () => {
    const rotated = { ...board, angle: Math.PI / 2 };
    expect(boardContainsCanvasPoint(rotated, { x: 200, y: 220 })).toBe(true);
    expect(boardContainsCanvasPoint(rotated, { x: 310, y: 150 })).toBe(false);
  });

  it("adopts into board-local coordinates while retaining relative rotation", () => {
    const rotated = { ...board, angle: Math.PI / 2 };
    const placement = getAdoptedImagePlacement(image({ x: 185, y: 175, angle: (11 * Math.PI) / 18 }), rotated);
    expect(placement).toMatchObject({ x: 120, y: 30, width: 40, height: 30 });
    expect(placement.angle).toBeCloseTo(Math.PI / 9);
  });

  it("fits rotated source geometry inside the target board", () => {
    const placement = getFittedImagePlacement(image({ width: 200, height: 100, angle: Math.PI / 2 }), board);
    expect(placement.width).toBeCloseTo(100);
    expect(placement.height).toBeCloseTo(50);
    expect(placement.x).toBeCloseTo(50);
    expect(placement.y).toBeCloseTo(25);
    expect(placement.angle).toBeCloseTo(Math.PI / 2);
  });
});
