import { describe, expect, it, vi } from "vitest";
import { createInspectCanvasTool } from "./inspect-canvas.js";
import { toolExecutionContext } from "./tool-run-context.js";
import type { AgentToolExecutionContext } from "./tool-run-context.js";

/**
 * Raw arguments as the model sends them, before the tool's Zod schema applies the
 * `detail_level`/`limit` defaults. Mastra types `execute`'s parameter from the
 * schema's *parsed* output and declares `execute` optional, and its result would
 * be `unknown`, which `JSON.parse` cannot accept.
 */
type InspectCanvasInput = {
  detail_level?: "summary" | "full";
  limit?: number;
  element_id?: string;
  filter_text?: string;
  filter_group_id?: string;
  filter_type?: string[];
  filter_region?: { min_x: number; min_y: number; max_x: number; max_y: number };
  selected_element_ids?: string[];
  cursor?: string;
};

/** This tool answers with a JSON string, so the direct call is typed as one. */
type DirectInspectCanvasTool = {
  execute: (input: InspectCanvasInput, context: AgentToolExecutionContext) => Promise<string>;
};

function directTool(tool: { execute?: unknown }) {
  return tool as unknown as DirectInspectCanvasTool;
}

const node = (id: string, i: number, extra: Record<string, unknown> = {}) => ({
  id, type: "rectangle", x: -1_000 + i * 30, y: (i % 9) * 50 - 200,
  width: 24, height: 24, ...extra,
});

function fixture(initial: Record<string, unknown>[]) {
  let elements = initial;
  const single = vi.fn(async () => ({ data: { revision: 7, content: {
    elements, appState: { viewBackgroundColor: "#fafafa" },
  } }, error: null }));
  const query: any = { select: () => query, eq: () => query, single };
  const tool = directTool(createInspectCanvasTool({ createUserClient: () => ({ from: () => query }) }));
  const config = { configurable: { canvas_id: "canvas-a", access_token: "token" } };
  return { tool, config, setElements: (next: Record<string, unknown>[]) => { elements = next; } };
}

describe("inspect_canvas global scene queries", () => {
  it("returns a bounded global map over every element and prioritizes the actual selection hint", async () => {
    const elements = Array.from({ length: 125 }, (_, i) => node(`node-${i}`, i,
      i === 110 ? { type: "text", text: "Selected far-away title", groupIds: ["hero"] } : {}));
    const f = fixture(elements);
    const output = JSON.parse(await f.tool.execute({ detail_level: "summary", limit: 40,
      selected_element_ids: ["node-110"] }, toolExecutionContext(f.config)));
    expect(output.coverage).toMatchObject({ liveCount: 125, indexedCount: 125, complete: true });
    expect(output.globalMap.regions.reduce((sum: number, region: { count: number }) => sum + region.count, 0)).toBe(125);
    expect(output.query).toMatchObject({ returnedCount: 40, matchedCount: 125, truncated: true });
    expect(output.elements[0]).toMatchObject({ id: "node-110", text: "Selected far-away title" });
    expect(output.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(output.canvas_revision).toBe(7);
  });

  it("pages every match and rejects query or revision mixing", async () => {
    const elements = Array.from({ length: 23 }, (_, i) => node(`node-${i}`, i));
    const f = fixture(elements);
    const first = JSON.parse(await f.tool.execute({ detail_level: "summary", filter_type: ["rectangle"], limit: 10 }, toolExecutionContext(f.config)));
    const second = JSON.parse(await f.tool.execute({ detail_level: "summary", filter_type: ["rectangle"], limit: 10,
      cursor: first.query.nextCursor }, toolExecutionContext(f.config)));
    const third = JSON.parse(await f.tool.execute({ detail_level: "summary", filter_type: ["rectangle"], limit: 10,
      cursor: second.query.nextCursor }, toolExecutionContext(f.config)));
    expect([first, second, third].flatMap(page => page.elements.map((item: { id: string }) => item.id)))
      .toEqual(elements.map(item => item.id));
    expect(third.query).toMatchObject({ returnedCount: 3, truncated: false, nextCursor: null });
    const wrongQuery = JSON.parse(await f.tool.execute({ detail_level: "summary", filter_type: ["text"], limit: 10,
      cursor: first.query.nextCursor }, toolExecutionContext(f.config)));
    expect(wrongQuery.error).toBe("canvas_cursor_query_mismatch");
    f.setElements([...elements, node("late", 30)]);
    const stale = JSON.parse(await f.tool.execute({ detail_level: "summary", filter_type: ["rectangle"], limit: 10,
      cursor: first.query.nextCursor }, toolExecutionContext(f.config)));
    expect(stale.error).toBe("canvas_revision_changed");
  });

  it("supports exact ID, text, group and negative-region lookup with explicit coverage", async () => {
    const f = fixture([
      node("title", 0, { type: "text", text: "Autumn Festival", groupIds: ["card-a"] }),
      node("photo", 1, { type: "image", groupIds: ["card-a"], frameId: "frame-a" }),
      node("frame-a", 2, { type: "frame" }),
      node("gone", 3, { isDeleted: true }),
    ]);
    const output = JSON.parse(await f.tool.execute({ detail_level: "summary", filter_text: "autumn",
      filter_group_id: "card-a", filter_region: { min_x: -1_100, min_y: -300, max_x: -900, max_y: 100 } }, toolExecutionContext(f.config)));
    expect(output.elements).toEqual([expect.objectContaining({ id: "title", groupIds: ["card-a"] })]);
    expect(output.coverage).toMatchObject({ rawCount: 4, liveCount: 3, deletedCount: 1 });
    const exact = JSON.parse(await f.tool.execute({ detail_level: "summary", element_id: "photo" }, toolExecutionContext(f.config)));
    expect(exact.elements[0]).toMatchObject({ id: "photo", frameId: "frame-a" });
  });

  it("caps full pages and collapses pathological raw properties", async () => {
    const elements = Array.from({ length: 8 }, (_, i) => node(`full-${i}`, i,
      i === 0 ? { customData: { huge: "x".repeat(30_000) } } : { customData: { value: i } }));
    const f = fixture(elements);
    const output = JSON.parse(await f.tool.execute({ detail_level: "full", limit: 100 }, toolExecutionContext(f.config)));
    expect(output.query).toMatchObject({ effectiveLimit: 5, returnedCount: 5, truncated: true });
    expect(output.elements[0]).toMatchObject({ id: "full-0", rawPropertiesTruncated: true });
    expect(JSON.stringify(output).length).toBeLessThan(80_000);
  });

  it("reports canvas images in one stable order and states what their dimensions mean", async () => {
    // Two same-size squares plus the poster, in the canvas's own document order.
    const f = fixture([
      node("poster", 0, { type: "image", x: 80, y: 80, width: 381, height: 512, customData: { assetId: "asset-poster" } }),
      node("square-first", 1, { type: "image", x: 501, y: 80, width: 512, height: 512, customData: { assetId: "asset-first" } }),
      node("square-edit", 2, { type: "image", x: 1_053, y: 80, width: 512, height: 512, customData: { assetId: "asset-edit" } }),
    ]);
    const read = async () => JSON.parse(await f.tool.execute({ detail_level: "summary", filter_type: ["image"] },
      toolExecutionContext(f.config))) as { elements: Array<Record<string, unknown>>;
        dimensions: { note: string; order: string } };
    const first = await read();
    const second = await read();
    expect(first.elements.map(item => item.id)).toEqual(["poster", "square-first", "square-edit"]);
    expect(second.elements.map(item => item.id)).toEqual(first.elements.map(item => item.id));
    expect(first.elements[0]).toMatchObject({ canvas_index: 0, canvas_frame_width: 381, canvas_frame_height: 512 });
    // The bare keys that were read as real pixels are gone from the surface.
    expect(first.elements[0]).not.toHaveProperty("width");
    expect(first.dimensions.note).toContain("CANVAS DISPLAY FRAME");
    expect(first.dimensions.note).toContain("sourcePixelWidth");
    expect(first.dimensions.order).toContain("canvas order");
  });
});
