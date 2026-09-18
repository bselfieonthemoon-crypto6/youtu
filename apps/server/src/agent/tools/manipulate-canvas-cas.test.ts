import { describe, expect, it, vi } from "vitest";

import { manipulateCanvasWithCas } from "./manipulate-canvas.js";

describe("manipulateCanvasWithCas", () => {
  it("re-applies operations after a conflict and preserves concurrent inserts", async () => {
    let row = {
      content: {
        elements: [{ id: "existing", type: "rectangle", version: 1 }],
        appState: {},
        files: {},
      },
      updated_at: "v1",
    };
    let writeAttempts = 0;
    const client = {
      from: () => ({
        select: () => ({
          eq() { return this; },
          single: async () => ({ data: structuredClone(row), error: null }),
        }),
        update: (payload: { content: typeof row.content }) => {
          let expectedVersion: string | undefined;
          return {
            eq(column: string, value: string) {
              if (column === "updated_at") expectedVersion = value;
              return this;
            },
            select() { return this; },
            async maybeSingle() {
              writeAttempts += 1;
              if (writeAttempts === 1) {
                row = {
                  content: {
                    ...row.content,
                    elements: [
                      ...row.content.elements,
                      { id: "concurrent-image", type: "image", version: 1 },
                    ],
                  },
                  updated_at: "v2",
                };
              }
              if (expectedVersion !== row.updated_at) {
                return { data: null, error: null };
              }
              row = {
                content: structuredClone(payload.content),
                updated_at: `v${writeAttempts + 1}`,
              };
              return { data: { id: "canvas" }, error: null };
            },
          };
        },
      }),
    };

    const result = await manipulateCanvasWithCas(
      client,
      "canvas",
      [{ action: "add_text", text: "new", x: 20, y: 30 }],
      "添加文字",
    );

    expect(result.success).toBe(true);
    expect(writeAttempts).toBe(2);
    expect(row.content.elements.map((element) => element.id)).toEqual(
      expect.arrayContaining(["existing", "concurrent-image"]),
    );
    expect(row.content.elements.filter((element) => element.type === "text"))
      .toHaveLength(1);
  });

  it.each([
    ["move", [{ action: "move", element_id: "board", x: 90, y: 80 }]],
    ["delete", [{ action: "delete", element_id: "board" }]],
    ["align", [{ action: "align", element_ids: ["ordinary", "board"], alignment: "left" }]],
    ["binding", [{ action: "add_line", line_type: "arrow", start_element_id: "board", end_element_id: "ordinary" }]],
  ])("rejects native design board %s operations without writing", async (_operation, operations) => {
    const row = {
      content: {
        elements: [
          { id: "ordinary", type: "rectangle", x: 10, y: 20, version: 1, isDeleted: false },
          { id: "board", type: "rectangle", x: 40, y: 50, version: 1, isDeleted: false,
            boundElements: null,
            customData: { kind: "loomic-design", schemaVersion: 1, designId: "design-1", revision: 1 } },
        ],
        appState: {}, files: {},
      },
      updated_at: "v1",
    };
    const update = vi.fn();
    const client = {
      from: () => ({
        select: () => ({
          eq() { return this; },
          single: async () => ({ data: structuredClone(row), error: null }),
        }),
        update,
      }),
    };

    const result = await manipulateCanvasWithCas(client, "canvas", operations as any, "修改画布");

    expect(result).toMatchObject({ error: "native_design_board_protected" });
    expect(update).not.toHaveBeenCalled();
    expect(row.content.elements[1]).toMatchObject({
      id: "board", x: 40, y: 50, isDeleted: false, boundElements: null,
    });
  });

  it("still writes an ordinary infinite-canvas element without changing a native board", async () => {
    const row = {
      content: {
        elements: [
          { id: "ordinary", type: "rectangle", x: 10, y: 20, version: 1, isDeleted: false },
          { id: "board", type: "rectangle", x: 40, y: 50, version: 1, isDeleted: false,
            customData: { kind: "loomic-design", schemaVersion: 1, designId: "design-1", revision: 1 } },
        ],
        appState: {}, files: {},
      },
      updated_at: "v1",
    };
    const client = {
      from: () => ({
        select: () => ({
          eq() { return this; },
          single: async () => ({ data: structuredClone(row), error: null }),
        }),
        update: (payload: { content: typeof row.content }) => ({
          eq() { return this; },
          select() { return this; },
          maybeSingle: async () => {
            row.content = structuredClone(payload.content);
            return { data: { id: "canvas" }, error: null };
          },
        }),
      }),
    };

    const result = await manipulateCanvasWithCas(
      client, "canvas", [{ action: "move", element_id: "ordinary", x: 100, y: 120 }], "移动矩形",
    );

    expect(result.success).toBe(true);
    expect(row.content.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ordinary", x: 100, y: 120 }),
      expect.objectContaining({ id: "board", x: 40, y: 50, isDeleted: false }),
    ]));
  });
});
