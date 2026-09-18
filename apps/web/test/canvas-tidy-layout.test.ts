import { describe, expect, it } from "vitest";
import { CANVAS_TIDY_GAP, tidyCanvasLayout, type TidyCanvasElement } from "../src/lib/canvas-tidy-layout";

const element = (id: string, x: number, y: number, extra: Partial<TidyCanvasElement> = {}): TidyCanvasElement => ({
  id, x, y, width: 100, height: 50, angle: 0, ...extra,
});

describe("tidyCanvasLayout", () => {
  it("lays all live elements into a 64px grid without changing deleted records", () => {
    const deleted = element("deleted", 9, 9, { isDeleted: true });
    const source = [element("b", 500, 10), element("a", 20, 20), element("c", 10, 300), deleted];
    const result = tidyCanvasLayout(source);

    expect(result.elements).toHaveLength(source.length);
    expect(result.elements[3]).toBe(deleted);
    expect(result.movedCount).toBe(3);
    const [b, a, c] = result.elements as [TidyCanvasElement, TidyCanvasElement, TidyCanvasElement];
    expect(b).toMatchObject({ x: 10, y: 10 });
    expect(a).toMatchObject({ x: 174, y: 10 });
    expect(c).toMatchObject({ x: 10, y: 124 });
    expect((a.x - (b.x + b.width!))).toBe(CANVAS_TIDY_GAP);
  });

  it("uses the selection but expands group, bound text, and frame descendants", () => {
    const frame = element("frame", 500, 500, { width: 200, height: 100 });
    const boundText = element("text", 520, 530, { containerId: "shape" });
    const source = [
      element("other", 0, 0),
      element("shape", 500, 500, { groupIds: ["g"], boundElements: [{ id: "text" }] }),
      boundText,
      element("same-group", 650, 520, { groupIds: ["g"] }),
      frame,
      element("in-frame", 530, 540, { frameId: "frame" }),
    ];
    const result = tidyCanvasLayout(source, { other: true, shape: true });

    expect(result.elements[0]).toBe(source[0]);
    expect(result.movedCount).toBe(3);
    expect(result.elements[1]!.x).not.toBe(source[1]!.x);
    expect(result.elements[2]!.x - source[2]!.x).toBe(result.elements[1]!.x - source[1]!.x);
    expect(result.elements[3]!.x - source[3]!.x).toBe(result.elements[1]!.x - source[1]!.x);
    expect(result.elements[4]).toBe(frame);
    expect(result.elements[5]).toBe(source[5]);
  });

  it("skips an entire locked cluster and puts colliding selected objects below fixed obstacles", () => {
    const locked = element("locked", 0, 0, { locked: true, boundElements: [{ id: "locked-label" }] });
    const label = element("locked-label", 10, 10, { containerId: "locked" });
    const moving = element("moving", 0, 0);
    const source = [locked, label, moving];
    const result = tidyCanvasLayout(source, { locked: true, moving: true });

    expect(result.elements[0]).toBe(locked);
    expect(result.elements[1]).toBe(label);
    expect(result.elements[2]!.y).toBe(label.y + label.height! + CANVAS_TIDY_GAP);
    expect(result.movedCount).toBe(1);
  });

  it("uses rotated visual bounds and only clones records whose coordinates change", () => {
    const rotated = element("rotated", 100, 100, { width: 100, height: 20, angle: Math.PI / 2 });
    const plain = element("plain", 500, 100, { width: 40, height: 40 });
    const result = tidyCanvasLayout([rotated, plain]);

    expect(result.elements[0]).toBe(rotated);
    expect(result.elements[1]).not.toBe(plain);
    // The rotated rectangle's visual width is 20, so the next cell starts 64px after its visual edge.
    expect(result.elements[1]!.x).toBe(224);
    expect(result.elements[1]!.angle).toBe(plain.angle);
  });

  it("moves selected frame descendants, arrows, and board metadata as intact canvas clusters", () => {
    const boardMetadata = { kind: "loomic-design", designId: "design-1" };
    const source = [
      element("anchor", 0, 0),
      element("frame", 600, 400, { width: 200, height: 100 }),
      element("in-frame", 620, 420, { frameId: "frame" }),
      element("arrow", 610, 410, { type: "arrow", startBinding: { elementId: "frame" }, endBinding: { elementId: "board" }, points: [[0, 0], [-40, 80]] }),
      element("board", 700, 500, { customData: boardMetadata }),
    ];
    const result = tidyCanvasLayout(source, { anchor: true, "in-frame": true });

    expect(result.movedCount).toBe(4);
    const deltaX = result.elements[1]!.x - source[1]!.x;
    const deltaY = result.elements[1]!.y - source[1]!.y;
    for (const index of [2, 3, 4]) {
      expect(result.elements[index]!.x - source[index]!.x).toBe(deltaX);
      expect(result.elements[index]!.y - source[index]!.y).toBe(deltaY);
    }
    expect(result.elements[4]!.customData).toBe(boardMetadata);
  });

  it("is idempotent after arranging and preserves identities when nothing needs moving", () => {
    const once = tidyCanvasLayout([element("a", 500, 100), element("b", 0, 0), element("c", 0, 400)]);
    const twice = tidyCanvasLayout(once.elements);

    expect(twice.movedCount).toBe(0);
    expect(twice.elements[0]).toBe(once.elements[0]);
    expect(twice.elements[1]).toBe(once.elements[1]);
    expect(twice.elements[2]).toBe(once.elements[2]);
  });
});
