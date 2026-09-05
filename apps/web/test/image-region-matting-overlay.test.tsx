// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImageRegionMattingOverlay } from "../src/components/canvas/image-region-matting-overlay";

describe("ImageRegionMattingOverlay", () => {
  beforeEach(() => {
    vi.stubGlobal("PointerEvent", MouseEvent);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("draws and submits a free box from the actual pointer origin", () => {
    const onConfirm = vi.fn();
    const { container } = render(
      <ImageRegionMattingOverlay
        bounds={{ x: 100, y: 50, width: 400, height: 200 }}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    const surface = container.querySelector(".cursor-crosshair") as HTMLDivElement;
    surface.setPointerCapture = vi.fn();
    surface.hasPointerCapture = vi.fn(() => true);

    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 300, clientY: 100 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 420, clientY: 210 });

    const selection = container.querySelector(".border-2.border-white") as HTMLDivElement;
    expect(selection).toHaveStyle({ left: "200px", top: "50px", width: "120px", height: "110px" });

    fireEvent.click(screen.getByRole("button", { name: "确认抠图" }));
    expect(onConfirm).toHaveBeenCalledWith({ x: 0.5, y: 0.25, width: 0.3, height: 0.55 });
  });

  it("supports dragging from bottom-right back to top-left", () => {
    const onConfirm = vi.fn();
    const { container } = render(
      <ImageRegionMattingOverlay
        bounds={{ x: 10, y: 20, width: 200, height: 100 }}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    const surface = container.querySelector(".cursor-crosshair") as HTMLDivElement;
    surface.setPointerCapture = vi.fn();
    surface.hasPointerCapture = vi.fn(() => true);

    fireEvent.pointerDown(surface, { button: 0, pointerId: 2, clientX: 170, clientY: 100 });
    fireEvent.pointerMove(surface, { pointerId: 2, clientX: 50, clientY: 40 });
    fireEvent.click(screen.getByRole("button", { name: "确认抠图" }));

    expect(onConfirm).toHaveBeenCalledWith({ x: 0.2, y: 0.2, width: 0.6, height: 0.6 });
  });

  it("keeps the selected region attached when the image bounds change", () => {
    const onConfirm = vi.fn();
    const { container, rerender } = render(
      <ImageRegionMattingOverlay
        bounds={{ x: 100, y: 50, width: 400, height: 200 }}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    const surface = container.querySelector(".cursor-crosshair") as HTMLDivElement;
    surface.setPointerCapture = vi.fn();
    surface.hasPointerCapture = vi.fn(() => true);

    fireEvent.pointerDown(surface, { button: 0, pointerId: 3, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(surface, { pointerId: 3, clientX: 400, clientY: 200 });

    rerender(
      <ImageRegionMattingOverlay
        bounds={{ x: 40, y: 30, width: 200, height: 100 }}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    const movedSurface = container.querySelector(".cursor-crosshair") as HTMLDivElement;
    const selection = container.querySelector(".border-2.border-white") as HTMLDivElement;
    expect(movedSurface).toHaveStyle({ left: "40px", top: "30px", width: "200px", height: "100px" });
    expect(selection).toHaveStyle({ left: "50px", top: "25px", width: "100px", height: "50px" });

    fireEvent.click(screen.getByRole("button", { name: "确认抠图" }));
    expect(onConfirm).toHaveBeenCalledWith({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  });
});
