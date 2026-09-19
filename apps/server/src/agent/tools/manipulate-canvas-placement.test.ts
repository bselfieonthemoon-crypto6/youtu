import { describe, expect, it, vi } from "vitest";

import { manipulateCanvasWithCas } from "./manipulate-canvas.js";

type Row = {
  content: { elements: any[]; appState: object; files: object };
  updated_at: string;
};

function canvasClient(row: Row) {
  const update = vi.fn((payload: { content: typeof row.content }) => ({
    eq() { return this; },
    select() { return this; },
    async maybeSingle() {
      row.content = structuredClone(payload.content);
      row.updated_at = "v2";
      return { data: { id: "canvas" }, error: null };
    },
  }));
  const client = {
    from: () => ({
      select: () => ({
        eq() { return this; },
        single: async () => ({ data: structuredClone(row), error: null }),
      }),
      update,
    }),
  };
  return { client, update };
}

/** A 400x300 image already sitting where the model wants to put the new one. */
function occupiedRow(): Row {
  return {
    content: {
      elements: [
        { id: "mover", type: "image", x: 0, y: 0, width: 400, height: 300, version: 1, isDeleted: false },
        { id: "resident", type: "image", x: 500, y: 100, width: 400, height: 300, version: 1, isDeleted: false },
      ],
      appState: {},
      files: {},
    },
    updated_at: "v1",
  };
}

describe("move avoids an occupied position", () => {
  it("nudges past the occupant instead of stacking on it", async () => {
    const row = occupiedRow();
    const { client } = canvasClient(row);

    // Requested position is exactly the resident element's rectangle.
    const result = await manipulateCanvasWithCas(
      client as any,
      "canvas",
      [{ action: "move", element_id: "mover", x: 500, y: 100 }] as any,
      "把这张图放到原来那张的右边",
    );

    expect(result.success).toBe(true);
    const moved = row.content.elements.find((el) => el.id === "mover")!;
    expect(moved.x).toBeGreaterThanOrEqual(500 + 400);
    expect(moved.y).toBe(100);
    // The receipt must state the final coordinates and name what was avoided.
    expect(result.summary).toContain(`(${moved.x}, ${moved.y})`);
    expect(result.summary).toContain("avoiding");
    expect(result.summary).toContain("resident");
  });

  it("keeps the exact requested position when it is free", async () => {
    const row = occupiedRow();
    const { client } = canvasClient(row);

    const result = await manipulateCanvasWithCas(
      client as any,
      "canvas",
      [{ action: "move", element_id: "mover", x: 1100, y: 700 }] as any,
      "把这张图移到右下角",
    );

    expect(result.success).toBe(true);
    const moved = row.content.elements.find((el) => el.id === "mover")!;
    expect({ x: moved.x, y: moved.y }).toEqual({ x: 1100, y: 700 });
    expect(result.summary).toContain("moved");
    expect(result.summary).not.toContain("avoiding");
  });

  it("keeps a partial overlap below the threshold instead of always nudging", async () => {
    const row: Row = {
      content: {
        elements: [
          { id: "mover", type: "image", x: 0, y: 0, width: 400, height: 300, version: 1, isDeleted: false },
          { id: "resident", type: "image", x: 0, y: 600, width: 400, height: 300, version: 1, isDeleted: false },
        ],
        appState: {},
        files: {},
      },
      updated_at: "v1",
    };
    const { client } = canvasClient(row);

    // 100 of 300 rows overlap: a deliberate vertical stack offset, not a drop on
    // top of the resident element, so the requested position must survive.
    const result = await manipulateCanvasWithCas(
      client as any,
      "canvas",
      [{ action: "move", element_id: "mover", x: 0, y: 800 }] as any,
      "把这张图摞在原来那张下面一点",
    );

    expect(result.success).toBe(true);
    const moved = row.content.elements.find((el) => el.id === "mover")!;
    expect({ x: moved.x, y: moved.y }).toEqual({ x: 0, y: 800 });
    expect(result.summary).not.toContain("avoiding");
  });
});

describe("align and distribute report foreign overlap", () => {
  it("warns when a negative distribute gap lands on a non-target element", async () => {
    const row: Row = {
      content: {
        elements: [
          { id: "a", type: "rectangle", x: 0, y: 0, width: 400, height: 200, version: 1, isDeleted: false },
          { id: "b", type: "rectangle", x: 100, y: 0, width: 400, height: 200, version: 1, isDeleted: false },
          { id: "c", type: "rectangle", x: 200, y: 0, width: 400, height: 200, version: 1, isDeleted: false },
          { id: "bystander", type: "image", x: 250, y: 0, width: 400, height: 200, version: 1, isDeleted: false },
        ],
        appState: {},
        files: {},
      },
      updated_at: "v1",
    };
    const { client } = canvasClient(row);

    // Three 400-wide targets inside a 600-wide span means a -300 gap: the
    // targets overlap each other (their own business) and also land on the
    // bystander image, which the caller must hear about.
    const result = await manipulateCanvasWithCas(
      client as any,
      "canvas",
      [{ action: "distribute", element_ids: ["a", "b", "c"], direction: "horizontal" }] as any,
      "让这三张图等距排列",
    );

    expect(result.success).toBe(true);
    expect(result.summary).toContain("distributed 3 elements");
    expect(result.summary).toContain("warning:");
    expect(result.summary).toContain("bystander");
  });

  it("stays quiet when aligned elements only overlap each other", async () => {
    const row: Row = {
      content: {
        elements: [
          { id: "a", type: "rectangle", x: 0, y: 0, width: 400, height: 200, version: 1, isDeleted: false },
          { id: "b", type: "rectangle", x: 200, y: 100, width: 400, height: 200, version: 1, isDeleted: false },
        ],
        appState: {},
        files: {},
      },
      updated_at: "v1",
    };
    const { client } = canvasClient(row);

    const result = await manipulateCanvasWithCas(
      client as any,
      "canvas",
      [{ action: "align", element_ids: ["a", "b"], alignment: "left" }] as any,
      "左对齐这两张图",
    );

    expect(result.success).toBe(true);
    expect(result.summary).toBe("aligned 2 elements left");
  });
});
