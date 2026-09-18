import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fabricState = vi.hoisted(() => ({
  instances: [] as Array<{
    width: number;
    height: number;
    cssWidth: number;
    cssHeight: number;
    backgroundColor: string;
    upperCanvasEl: HTMLCanvasElement;
    activeObject: {
      hasControls: boolean;
      oCoords: Record<string, unknown>;
      set(options: object): void;
      setCoords(): void;
      isControlVisible(key: string): boolean;
    } | undefined;
    fire(event: string): void;
    getWidth(): number;
    getHeight(): number;
  }>,
}));

vi.mock("fabric", () => ({
  Rect: class { constructor(options: Record<string, unknown>) { Object.assign(this, options); } },
  Canvas: class FakeCanvas {
    width = 300;
    height = 150;
    cssWidth = 300;
    cssHeight = 150;
    backgroundColor: string;
    upperCanvasEl: HTMLCanvasElement;
    activeObject: {
      hasControls: boolean;
      oCoords: Record<string, unknown>;
      set(options: object): void;
      setCoords(): void;
      isControlVisible(key: string): boolean;
    } | undefined = undefined;
    private listeners = new Map<string, Set<() => void>>();
    constructor(
      element: HTMLCanvasElement,
      options: { backgroundColor: string },
    ) {
      this.backgroundColor = options.backgroundColor;
      this.upperCanvasEl = document.createElement("canvas");
      this.upperCanvasEl.className = "upper-canvas";
      element.parentElement?.appendChild(this.upperCanvasEl);
      fabricState.instances.push(this);
    }
    setDimensions(
      dimensions: { width: number; height: number },
      options?: { cssOnly?: boolean },
    ) {
      if (options?.cssOnly) {
        this.cssWidth = dimensions.width;
        this.cssHeight = dimensions.height;
        this.upperCanvasEl.style.width = `${dimensions.width}px`;
        this.upperCanvasEl.style.height = `${dimensions.height}px`;
      } else {
        this.width = dimensions.width;
        this.height = dimensions.height;
      }
    }
    getWidth() {
      return this.width;
    }
    getHeight() {
      return this.height;
    }
    requestRenderAll() { this.fire("after:render"); }
    calcOffset() {}
    setViewportTransform() {}
    getObjects() {
      return [];
    }
    clear() {}
    getActiveObjects() { return []; }
    getActiveObject() { return this.activeObject; }
    on(event: string, listener: () => void) {
      const listeners = this.listeners.get(event) ?? new Set();
      listeners.add(listener);
      this.listeners.set(event, listeners);
    }
    off(event?: string, listener?: () => void) {
      if (!event) this.listeners.clear();
      else if (listener) this.listeners.get(event)?.delete(listener);
      else this.listeners.delete(event);
    }
    fire(event: string) { this.listeners.get(event)?.forEach((listener) => listener()); }
    forEachObject() {}
    discardActiveObject() {}
    async dispose() {
      return true;
    }
  },
}));

import { FabricDesignSurface } from "../src/components/design/fabric-design-surface";

describe("FabricDesignSurface", () => {
  it("shows an overflow shade while retaining the board-sized layout", async () => {
    render(<FabricDesignSurface width={400} height={200} background="#fff" showOverflow inlineSize={{width:200,height:100}} />);
    await waitFor(() => expect(fabricState.instances).toHaveLength(1));
    await waitFor(() => expect(fabricState.instances[0]?.cssWidth).toBe(400), {timeout:5000});
    expect(fabricState.instances[0]?.cssHeight).toBe(300);
    expect(screen.getByTestId("design-overflow-shade")).toHaveClass("pointer-events-none");
  });
  it("opens only selected control hit areas beyond the board and restores empty-space panning on deselect", async () => {
    render(<FabricDesignSurface width={400} height={200} background="#fff" showOverflow inlineSize={{width:200,height:100}} />);
    await waitFor(() => expect(fabricState.instances[0]?.cssWidth).toBe(400), { timeout: 5000 });
    const canvas = fabricState.instances[0]!;
    const boardPath = canvas.upperCanvasEl.style.clipPath;
    expect(boardPath).toContain("M 100 100 L 300 100 L 300 200 L 100 200 Z");

    const setCoords = vi.fn();
    canvas.activeObject = {
      hasControls: true,
      set: () => {},
      setCoords,
      isControlVisible: (key) => key === "br",
      oCoords: {
        br: {
          corner: { tl: { x: 688, y: 288 }, tr: { x: 712, y: 288 }, br: { x: 712, y: 312 }, bl: { x: 688, y: 312 } },
          touchCorner: { tl: { x: 680, y: 280 }, tr: { x: 720, y: 280 }, br: { x: 720, y: 320 }, bl: { x: 680, y: 320 } },
        },
      },
    };
    canvas.fire("selection:created");
    expect(setCoords).toHaveBeenCalled();
    // Backing-store coordinates are halved to match the CSS presentation.
    expect(canvas.upperCanvasEl.style.clipPath).toContain("M 340 140 L 360 140 L 360 160 L 340 160 Z");
    canvas.activeObject = undefined;
    canvas.fire("selection:cleared");
    expect(canvas.upperCanvasEl.style.clipPath).toBe(boardPath);
  });
  beforeEach(() => {
    fabricState.instances.length = 0;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(720);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(640);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps 1080px logical dimensions while fitting only the CSS size", async () => {
    render(
      <FabricDesignSurface width={1080} height={1080} background="#fff" />,
    );

    await waitFor(() => expect(fabricState.instances).toHaveLength(1));
    const canvas = fabricState.instances[0];
    await waitFor(() => expect(canvas?.getWidth()).toBe(1080), {
      // The editor adapter is dynamically imported. A full parallel suite can
      // legitimately take longer than Testing Library's 1s default to parse it.
      timeout: 5_000,
    });
    expect(canvas?.getWidth()).toBe(1080);
    expect(canvas?.getHeight()).toBe(1080);
    expect(canvas?.cssWidth).toBeLessThan(1080);
    expect(canvas?.cssHeight).toBeLessThan(1080);
  });

  it("updates the background without replacing the Fabric instance", async () => {
    const { rerender } = render(
      <FabricDesignSurface width={1080} height={1080} background="#ffffff" />,
    );
    await waitFor(() => expect(fabricState.instances).toHaveLength(1));

    rerender(
      <FabricDesignSurface width={1080} height={1080} background="#123456" />,
    );
    await waitFor(() =>
      expect(fabricState.instances[0]?.backgroundColor).toBe("#123456"),
    );
    expect(fabricState.instances).toHaveLength(1);
  });
  it("hydrates the latest scene when dimensions recreate the canvas", async () => {
    const makeScene = (width: number, height: number, background: string) => ({
      schemaVersion: 1 as const, engine: "fabric" as const,
      canvas: { width, height, background }, objects: [],
    });
    const ready = vi.fn();
    const { rerender } = render(<FabricDesignSurface width={640} height={480} background="#ffffff"
      scene={makeScene(640,480,"#ffffff")} onCanvasReady={ready} />);
    await waitFor(() => expect(ready).toHaveBeenCalledTimes(1), { timeout: 5000 });
    rerender(<FabricDesignSurface width={800} height={800} background="#123456"
      scene={makeScene(800,800,"#123456")} onCanvasReady={ready} />);
    await waitFor(() => expect(ready).toHaveBeenCalledTimes(2), { timeout: 5000 });
    const current = fabricState.instances.at(-1)!;
    expect(current.getWidth()).toBe(800);
    expect(current.getHeight()).toBe(800);
    expect(current.backgroundColor).toBe("#123456");
  });

  it("caps a 32768 square document backing store while preserving its CSS fit", async () => {
    render(
      <FabricDesignSurface width={32768} height={32768} background="#fff" />,
    );
    await waitFor(() => expect(fabricState.instances).toHaveLength(1));

    expect(fabricState.instances[0]?.getWidth()).toBeLessThanOrEqual(4000);
    expect(fabricState.instances[0]?.getHeight()).toBeLessThanOrEqual(4000);
    expect(fabricState.instances[0]?.cssWidth).toBeLessThanOrEqual(656);
    expect(fabricState.instances[0]?.cssHeight).toBeLessThanOrEqual(576);
  });
});
