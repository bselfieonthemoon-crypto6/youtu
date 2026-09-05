import "@testing-library/jest-dom/vitest";

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fabricState = vi.hoisted(() => ({
  instances: [] as Array<{
    width: number;
    height: number;
    cssWidth: number;
    cssHeight: number;
    backgroundColor: string;
    getWidth(): number;
    getHeight(): number;
  }>,
}));

vi.mock("fabric", () => ({
  Canvas: class FakeCanvas {
    width = 300;
    height = 150;
    cssWidth = 300;
    cssHeight = 150;
    backgroundColor: string;
    constructor(
      _element: HTMLCanvasElement,
      options: { backgroundColor: string },
    ) {
      this.backgroundColor = options.backgroundColor;
      fabricState.instances.push(this);
    }
    setDimensions(
      dimensions: { width: number; height: number },
      options?: { cssOnly?: boolean },
    ) {
      if (options?.cssOnly) {
        this.cssWidth = dimensions.width;
        this.cssHeight = dimensions.height;
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
    requestRenderAll() {}
    setViewportTransform() {}
    getObjects() {
      return [];
    }
    on() {}
    off() {}
    forEachObject() {}
    discardActiveObject() {}
    async dispose() {
      return true;
    }
  },
}));

import { FabricDesignSurface } from "../src/components/design/fabric-design-surface";

describe("FabricDesignSurface", () => {
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
