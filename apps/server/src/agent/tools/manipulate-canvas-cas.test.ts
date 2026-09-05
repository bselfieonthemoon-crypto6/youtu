import { describe, expect, it } from "vitest";

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
});
