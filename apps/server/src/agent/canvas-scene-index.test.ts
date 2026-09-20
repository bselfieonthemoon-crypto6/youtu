import { describe, expect, it } from "vitest";
import {
  CANVAS_FRAME_DIMENSION_NOTE,
  CANVAS_ORDER_NOTE,
  buildCanvasSceneIndex,
  compactSceneEntry,
  queryCanvasScene,
  renderCanvasSceneContext,
  type CanvasSceneIndex,
} from "./canvas-scene-index.js";

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

  it("marks a failed generation placeholder so it can be identified and removed on request", () => {
    const jobId = "80000000-0000-4000-8000-000000000001";
    const index = buildCanvasSceneIndex([
      element("failed-box", 0, { customData: { type: "image-generator", status: "error", jobId } }),
      element("running-box", 1, { customData: { type: "image-generator", status: "generating", jobId } }),
      // A stray `status` on an ordinary element is not a generation placeholder.
      element("plain", 2, { customData: { status: "error" } }),
    ]);
    const failed = index.entries.find(entry => entry.id === "failed-box")!;
    expect(failed).toMatchObject({ generationStatus: "error", generationJobId: jobId });
    expect(index.entries.find(entry => entry.id === "running-box")).toMatchObject({ generationStatus: "generating" });
    expect(index.entries.find(entry => entry.id === "plain")).not.toHaveProperty("generationStatus");
    const context = renderCanvasSceneContext(index)!;
    expect(context).toContain(`generationStatus=error jobId=${jobId}`);
    expect(context).toContain("generationStatus=generating");
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

  it("names the canvas display frame instead of leaving a bare width/height beside an image", () => {
    // The defect: a generated 880x1184 PNG sits in a 381x512 Excalidraw frame,
    // and a status answer reported the frame as the image's "实际像素".
    const index = buildCanvasSceneIndex([
      element("poster", 0, { type: "image", x: 80, y: 80, width: 381, height: 512,
        customData: { assetId: "70000000-0000-4000-8000-000000000010" } }),
    ]);
    const compact = compactSceneEntry(index.entries[0]!);
    expect(compact).toMatchObject({ canvas_index: 0, canvas_frame_width: 381, canvas_frame_height: 512 });
    expect(compact).not.toHaveProperty("width");
    expect(compact).not.toHaveProperty("height");
    const context = renderCanvasSceneContext(index)!;
    expect(context).toContain("canvasIndex=0");
    expect(context).toContain("canvasFrame=381x512");
    // The two semantics lines must survive even a tight character budget,
    // because they are exactly what the wrong answer omitted.
    expect(context).toContain(CANVAS_FRAME_DIMENSION_NOTE);
    expect(context).toContain(CANVAS_ORDER_NOTE);
    expect(renderCanvasSceneContext(index, [], 800)).toContain(CANVAS_FRAME_DIMENSION_NOTE);
  });

  it("returns the identical canvas order for two reads of the same scene, including same-size images", () => {
    // Two 512x512 squares once came back reversed between reads: one surface
    // listed canvas order and another listed recency. Canvas order is now the
    // single documented order, so a repeated read cannot reshuffle them.
    const scene = [
      element("poster", 0, { type: "image", x: 80, y: 80, width: 381, height: 512, customData: { assetId: "asset-poster" } }),
      element("square-first", 1, { type: "image", x: 501, y: 80, width: 512, height: 512, customData: { assetId: "asset-first" } }),
      element("square-edit", 2, { type: "image", x: 1_053, y: 80, width: 512, height: 512, customData: { assetId: "asset-edit" } }),
    ];
    const order = (index: CanvasSceneIndex) => {
      const page = queryCanvasScene(index, { types: ["image"] });
      if (!("entries" in page)) throw new Error("expected an image page");
      return page.entries.map(entry => `${entry.ordinal}:${entry.id}`);
    };
    const first = buildCanvasSceneIndex(scene);
    const second = buildCanvasSceneIndex(scene.map(item => ({ ...item })));
    expect(order(first)).toEqual(["0:poster", "1:square-first", "2:square-edit"]);
    expect(order(second)).toEqual(order(first));
    expect(second.entries.map(entry => entry.id)).toEqual(first.entries.map(entry => entry.id));
    expect(renderCanvasSceneContext(second)).toBe(renderCanvasSceneContext(first));
  });
});
