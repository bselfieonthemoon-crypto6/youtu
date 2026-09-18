// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasBottomBar } from "../src/components/canvas-bottom-bar";
import { ToastProvider } from "../src/components/toast";
import { clampMapPosition, mapPointToScroll, minimapLayout } from "../src/lib/canvas-minimap";

afterEach(cleanup);
const viewport = { x: -500, y: -300, width: 1000, height: 600 };
describe("canvas minimap", () => {
  it("maps negative and distant coordinates and excludes deleted elements", () => {
    const layout = minimapLayout([
      { id: "a", x: -2000, y: 400, width: 500, height: 300 },
      { id: "b", x: 9000, y: -700, width: 100, height: 200 },
      { id: "deleted", x: 1e9, y: 1e9, width: 10, height: 10, isDeleted: true },
    ], viewport);
    expect(layout.blocks).toHaveLength(2);
    const point = { x: 9050 * layout.scale + layout.offsetX, y: -600 * layout.scale + layout.offsetY };
    const scroll = mapPointToScroll(point, layout, viewport);
    expect(scroll.scrollX).toBeCloseTo(-8550);
    expect(scroll.scrollY).toBeCloseTo(900);
  });
  it("supports rotated objects and zero-size or empty scenes without invalid coordinates", () => {
    const layout = minimapLayout([{ id: "rotated", x: 0, y: 0, width: 200, height: 100, angle: Math.PI / 2 }], viewport);
    expect(layout.blocks[0]!.width).toBeCloseTo(100);
    expect(layout.blocks[0]!.height).toBeCloseTo(200);
    expect(Number.isFinite(minimapLayout([], { x: 0, y: 0, width: 0, height: 0 }).scale)).toBe(true);
    expect(clampMapPosition(2000, -50, 800, 600)).toEqual({ x: 552, y: 8 });
  });
  it("toggles from the existing toolbar and uses blocks only; navigation never edits scene content", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const unsubscribe = vi.fn();
    const api = {
      getAppState: () => ({ scrollX: 500, scrollY: 300, width: 1000, height: 600, zoom: { value: 1 }, selectedElementIds: {} }),
      getSceneElements: () => [{ id: "image", x: 0, y: 0, width: 100, height: 100 }],
      onChange: vi.fn(() => unsubscribe), updateScene: vi.fn(),
    };
    render(
      <ToastProvider>
        <CanvasBottomBar excalidrawApi={api} layersOpen={false} filesOpen={false} leftPanelOpen={false} onToggleLayers={vi.fn()} onToggleFiles={vi.fn()} />
      </ToastProvider>,
    );
    expect(screen.queryByRole("region", { name: "画布小地图" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "显示小地图" }));
    const region = screen.getByRole("region", { name: "画布小地图" });
    expect(region.querySelectorAll("[data-minimap-block]")).toHaveLength(1);
    expect(region.querySelector("img, image")).toBeNull();
    fireEvent.keyDown(screen.getByRole("application", { name: "小地图导航" }), { key: "ArrowRight" });
    expect(api.updateScene).toHaveBeenCalledWith({ appState: { scrollX: 300, scrollY: 300 }, captureUpdate: "NONE" });
    fireEvent.click(screen.getByRole("button", { name: "隐藏小地图" }));
    expect(screen.queryByRole("region", { name: "画布小地图" })).not.toBeInTheDocument();
    expect(unsubscribe).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
