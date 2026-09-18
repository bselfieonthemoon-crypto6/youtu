import { describe, expect, it } from "vitest";
import { buildCanvasSceneIndex, queryCanvasScene, renderCanvasSceneContext } from "./canvas-scene-index.js";

const element = (id: string, index: number, extra: Record<string, unknown> = {}) => ({
  id, type: "rectangle", x: -500 + index * 20, y: -200 + (index % 7) * 100,
  width: 18, height: 40, ...extra,
});

describe("canvas scene index", () => {
  it("covers more than 100 live elements with bounded global regions instead of a first-page illusion", () => {
    const index = buildCanvasSceneIndex(Array.from({ length: 160 }, (_, i) =>
      element(`node-${i}`, i, i % 17 === 0 ? { type: "text", text: `Section ${i}` } : {})));
    expect(index.coverage).toMatchObject({ rawCount: 160, liveCount: 160, indexedCount: 160, complete: true });
    expect(index.bounds.minX).toBe(-500);
    expect(index.regions.reduce((sum, region) => sum + region.count, 0)).toBe(160);
    expect(index.regions.length).toBeLessThanOrEqual(16);
    const context = renderCanvasSceneContext(index)!;
    expect(context.length).toBeLessThanOrEqual(12_000);
    expect(context).toContain("region aggregates above cover every indexed element");
    expect(context).toContain("detailTruncated=true");
    const selectedContext = renderCanvasSceneContext(index, ["node-159"])!;
    expect(selectedContext).toContain("SELECTED rectangle#node-159");
    const details = selectedContext.split("Representative details")[1]!;
    expect(details.indexOf("SELECTED rectangle#node-159")).toBeLessThan(details.indexOf("node-0"));
  });

  it("reserves explicit coverage and paging guidance when the context body is truncated", () => {
    const index = buildCanvasSceneIndex(Array.from({ length: 80 }, (_, i) =>
      element(`long-${i}`, i, { type: `custom-${i}-${"x".repeat(60)}`, text: `Copy ${i} ${"y".repeat(100)}` })));
    const context = renderCanvasSceneContext(index, [], 800)!;
    expect(context.length).toBeLessThanOrEqual(800);
    expect(context).toContain("Coverage: globalMapComplete=true; detailTruncated=true");
    expect(context).toContain("use inspect_canvas with filters and revision-bound cursor");
  });

  it("exposes authenticated image asset identity in representative context without image bytes or URLs", () => {
    const assetId = "70000000-0000-4000-8000-000000000001";
    const context = renderCanvasSceneContext(buildCanvasSceneIndex([
      element("logo", 0, { type: "image", customData: { assetId } }),
    ]))!;
    expect(context).toContain(`image#logo`);
    expect(context).toContain(`assetId=${assetId}`);
    expect(context).not.toMatch(/data:image|https?:\/\//);
  });

  it("preserves group, frame, container, bindings and design associations while reporting dangling references", () => {
    const index = buildCanvasSceneIndex([
      element("frame", 0, { type: "frame" }),
      element("shape", 1, { groupIds: ["group-a"], frameId: "frame", containerId: "label",
        boundElements: [{ id: "label", type: "text" }], startBinding: { elementId: "missing" },
        customData: { role: "hero", designId: "design-a", designObjectId: "object-a" } }),
      element("label", 2, { type: "text", text: "Launch", containerId: "shape" }),
    ]);
    const shape = index.entries.find(entry => entry.id === "shape")!;
    expect(shape).toMatchObject({ groupIds: ["group-a"], frameId: "frame", containerId: "label",
      role: "hero", designId: "design-a", designObjectId: "object-a" });
    expect(shape.bindings).toEqual(expect.arrayContaining([
      { kind: "bound", targetId: "label" }, { kind: "start", targetId: "missing" },
      { kind: "container", targetId: "label" }, { kind: "frame", targetId: "frame" },
    ]));
    expect(index.coverage).toMatchObject({ relationCount: 5, danglingRelationCount: 1 });
  });

  it("counts deleted, malformed and duplicate identities without silently treating the index as complete", () => {
    const index = buildCanvasSceneIndex([
      element("same", 0), element("same", 1), element("gone", 2, { isDeleted: true }),
      { id: "bad", type: "text", x: Number.NaN, y: 0, width: 1, height: 1 }, null,
    ]);
    expect(index.coverage).toMatchObject({ rawCount: 5, liveCount: 4, indexedCount: 2,
      deletedCount: 1, malformedCount: 2, duplicateIdCount: 1, complete: false });
    expect(index.duplicateIds).toEqual(["same"]);
    expect(queryCanvasScene(index, { elementId: "same" })).toMatchObject({ matchedCount: 2 });
  });

  it("queries by text, group and negative-coordinate region and prioritizes selected nodes", () => {
    const index = buildCanvasSceneIndex([
      element("a", 0, { type: "text", text: "Summer launch", groupIds: ["campaign"] }),
      element("b", 1, { type: "text", text: "Summer details", groupIds: ["campaign"] }),
      element("c", 100, { type: "image", customData: { title: "Winter" } }),
    ]);
    const result = queryCanvasScene(index, { text: "summer", groupId: "campaign",
      region: { minX: -600, minY: -300, maxX: 0, maxY: 500 }, selectedIds: ["b"] });
    expect("entries" in result && result.entries.map(entry => entry.id)).toEqual(["b", "a"]);
  });

  it("binds pagination to the exact query and immutable global revision", () => {
    const index = buildCanvasSceneIndex(Array.from({ length: 12 }, (_, i) => element(`n-${i}`, i)));
    const first = queryCanvasScene(index, { types: ["rectangle"], limit: 5 });
    if (!("entries" in first)) throw new Error("expected page");
    expect(first).toMatchObject({ returnedCount: 5, truncated: true });
    const second = queryCanvasScene(index, { types: ["rectangle"], limit: 5, cursor: first.nextCursor! });
    expect("entries" in second && second.entries[0]?.id).toBe("n-5");
    expect(queryCanvasScene(index, { types: ["text"], limit: 5, cursor: first.nextCursor! }))
      .toMatchObject({ error: "canvas_cursor_query_mismatch" });
    const changed = buildCanvasSceneIndex([...index.entries.map(entry => entry.raw), element("new", 20)]);
    expect(queryCanvasScene(changed, { types: ["rectangle"], limit: 5, cursor: first.nextCursor! }))
      .toMatchObject({ error: "canvas_revision_changed" });
  });
});
