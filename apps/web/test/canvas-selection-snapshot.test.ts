import { describe, expect, it, vi } from "vitest";
import { captureCanvasSelection } from "../src/lib/canvas-selection-snapshot";

describe("send-time canvas selection evidence", () => {
  it("reads live app state and excludes false, deleted and foreign scene IDs", () => {
    const api = {
      getAppState: vi.fn(() => ({ selectedElementIds: { text: true, falseId: false, deleted: true, foreignCanvasId: true } })),
      getSceneElements: vi.fn(() => [{ id: "text" }, { id: "falseId" }, { id: "deleted", isDeleted: true }]),
    };
    expect(captureCanvasSelection(api)).toEqual({ elementIds: ["text"] });
    expect(api.getAppState).toHaveBeenCalledOnce();
    expect(api.getSceneElements).toHaveBeenCalledOnce();
  });

  it("does not invent a selection for an unavailable or empty canvas", () => {
    expect(captureCanvasSelection(null)).toEqual({ elementIds: [] });
    expect(captureCanvasSelection(undefined)).toEqual({ elementIds: [] });
    expect(captureCanvasSelection({ getAppState: () => ({}), getSceneElements: () => [{ id: "existing" }] })).toEqual({ elementIds: [] });
    expect(captureCanvasSelection({ getAppState: () => ({ selectedElementIds: { stale: true } }), getSceneElements: () => [] })).toEqual({ elementIds: [] });
  });

  it("returns an independent send-time snapshot, not a mutable selection reference", () => {
    const state: { selectedElementIds: Record<string, boolean> } = { selectedElementIds: { first: true } };
    const api = { getAppState: () => state, getSceneElements: () => [{ id: "first" }, { id: "second" }] };
    const snapshot = captureCanvasSelection(api);
    delete state.selectedElementIds.first;
    state.selectedElementIds.second = true;
    expect(snapshot).toEqual({ elementIds: ["first"] });
    expect(captureCanvasSelection(api)).toEqual({ elementIds: ["second"] });
  });

  it("accepts 100 IDs but never misrepresents a larger selection by truncating it", () => {
    const elements = Array.from({ length: 100 }, (_, i) => ({ id: `element-${i}` }));
    const api = { getAppState: () => ({ selectedElementIds: Object.fromEntries(elements.map(({ id }) => [id, true])) }), getSceneElements: () => elements };
    expect(captureCanvasSelection(api).elementIds).toHaveLength(100);
    elements.push({ id: "one-too-many" });
    expect(captureCanvasSelection(api)).toEqual({ elementIds: [] });
  });

  it("fails closed on an unavailable editor and invalid IDs", () => {
    expect(captureCanvasSelection({ getAppState: () => { throw new Error("unmounted"); }, getSceneElements: () => [] })).toEqual({ elementIds: [] });
    const invalid = ["", "x".repeat(201)];
    expect(captureCanvasSelection({ getAppState: () => ({ selectedElementIds: Object.fromEntries(invalid.map(id => [id, true])) }), getSceneElements: () => invalid.map(id => ({ id })) })).toEqual({ elementIds: [] });
  });
});
