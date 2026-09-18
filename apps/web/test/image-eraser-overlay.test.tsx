// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImageEraserOverlay } from "../src/components/canvas/image-eraser-overlay";

describe("ImageEraserOverlay", () => {
  beforeEach(() => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      scale: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(),
      moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("records normalized brush strokes and submits the selected mode", () => {
    const onConfirm = vi.fn();
    render(
      <ImageEraserOverlay
        bounds={{ x: 100, y: 50, width: 400, height: 200 }}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    const surface = screen.getByLabelText("橡皮涂抹区域") as HTMLCanvasElement;
    surface.setPointerCapture = vi.fn();
    surface.hasPointerCapture = vi.fn(() => true);
    surface.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 300, clientY: 150 });
    fireEvent.pointerUp(surface, { pointerId: 1 });
    fireEvent.click(screen.getByRole("button", { name: "智能修复" }));
    fireEvent.click(screen.getByRole("button", { name: "应用" }));

    expect(onConfirm).toHaveBeenCalledWith("smart", [{
      radius: 0.09,
      points: [{ x: 0.25, y: 0.25 }, { x: 0.5, y: 0.5 }],
    }]);
  });

  it("keeps its drawing surface attached to changing image bounds", () => {
    const props = { onCancel: vi.fn(), onConfirm: vi.fn() };
    const { rerender } = render(
      <ImageEraserOverlay bounds={{ x: 10, y: 20, width: 300, height: 180 }} {...props} />,
    );
    rerender(<ImageEraserOverlay bounds={{ x: 40, y: 60, width: 150, height: 90 }} {...props} />);
    expect(screen.getByLabelText("橡皮涂抹区域")).toHaveStyle({
      left: "40px", top: "60px", width: "150px", height: "90px",
    });
  });

  it("uses delete-paint as a subtracting brush while keeping undo separate", () => {
    const onConfirm = vi.fn();
    render(
      <ImageEraserOverlay
        bounds={{ x: 0, y: 0, width: 200, height: 200 }}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    const surface = screen.getByLabelText("橡皮涂抹区域") as HTMLCanvasElement;
    surface.setPointerCapture = vi.fn();
    surface.hasPointerCapture = vi.fn(() => true);
    surface.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(surface, { pointerId: 1 });
    fireEvent.click(screen.getByRole("button", { name: "删除涂抹" }));
    fireEvent.pointerDown(surface, { button: 0, pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(surface, { pointerId: 2 });

    fireEvent.click(screen.getByRole("button", { name: "撤销擦除" }));
    expect(screen.getByRole("button", { name: "应用" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "重做擦除" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "重做擦除" }));
    fireEvent.click(screen.getByRole("button", { name: "应用" }));

    expect(onConfirm).toHaveBeenCalledWith("transparent", [
      { radius: 0.09, points: [{ x: 0.2, y: 0.2 }] },
      { operation: "subtract", radius: 0.09, points: [{ x: 0.5, y: 0.5 }] },
    ]);
  });

  it("uses a fully opaque destination-out brush so one pass removes the preview mask", () => {
    const context = {
      scale: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(),
      moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      globalCompositeOperation: "source-over",
      strokeStyle: "",
      fillStyle: "",
      lineCap: "butt",
      lineJoin: "miter",
      lineWidth: 1,
    } as unknown as CanvasRenderingContext2D;
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context);

    render(
      <ImageEraserOverlay
        bounds={{ x: 0, y: 0, width: 200, height: 200 }}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    const surface = screen.getByLabelText("橡皮涂抹区域") as HTMLCanvasElement;
    surface.setPointerCapture = vi.fn();
    surface.hasPointerCapture = vi.fn(() => true);
    surface.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(surface, { pointerId: 1 });
    fireEvent.click(screen.getByRole("button", { name: "删除涂抹" }));
    fireEvent.pointerDown(surface, { button: 0, pointerId: 2, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(surface, { pointerId: 2 });

    expect(context.fillStyle).toBe("rgba(0, 0, 0, 1)");
  });

  it("uses the repaint panel to submit a smart mask and prompt", () => {
    const onConfirm = vi.fn();
    render(
      <ImageEraserOverlay
        repaint
        bounds={{ x: 0, y: 0, width: 200, height: 200 }}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    const surface = screen.getByLabelText("局部重绘涂抹区域") as HTMLCanvasElement;
    surface.setPointerCapture = vi.fn();
    surface.hasPointerCapture = vi.fn(() => true);
    surface.releasePointerCapture = vi.fn();

    expect(screen.getByRole("button", { name: "开始重绘" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("修改要求"), { target: { value: "把桌上的杯子改成花瓶" } });
    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(surface, { pointerId: 1 });
    fireEvent.click(screen.getByRole("button", { name: "开始重绘" }));

    expect(onConfirm).toHaveBeenCalledWith("smart", [{ radius: 0.09, points: [{ x: 0.2, y: 0.2 }] }], "把桌上的杯子改成花瓶");
  });

  it("uses quick fill only to populate the prompt and keeps its draft while busy", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { rerender } = render(
      <ImageEraserOverlay repaint bounds={{ x: 0, y: 0, width: 200, height: 200 }} onCancel={onCancel} onConfirm={onConfirm} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "移除选中内容" }));
    expect(screen.getByLabelText("修改要求")).toHaveValue("移除涂抹区域内的内容并自然补全背景");
    expect(screen.getByRole("button", { name: "开始重绘" })).toBeDisabled();
    const surface = screen.getByLabelText("局部重绘涂抹区域") as HTMLCanvasElement;
    surface.setPointerCapture = vi.fn();
    surface.hasPointerCapture = vi.fn(() => true);
    surface.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(surface, { pointerId: 1 });
    expect(screen.getByRole("button", { name: "开始重绘" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "开始重绘" }));
    expect(onConfirm).toHaveBeenCalledWith("smart", [{ radius: 0.09, points: [{ x: 0.2, y: 0.2 }] }], "移除涂抹区域内的内容并自然补全背景");

    rerender(<ImageEraserOverlay repaint busy error="重绘失败，请重试" bounds={{ x: 0, y: 0, width: 200, height: 200 }} onCancel={onCancel} onConfirm={onConfirm} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByLabelText("修改要求")).toHaveValue("移除涂抹区域内的内容并自然补全背景");
    expect(screen.getByRole("alert")).toHaveTextContent("重绘失败，请重试");
    expect(screen.getByRole("button", { name: "重绘中…" })).toBeDisabled();
  });

  it("rejects a repaint mask that has been completely erased", () => {
    render(<ImageEraserOverlay repaint bounds={{ x: 0, y: 0, width: 200, height: 200 }} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    const surface = screen.getByLabelText("局部重绘涂抹区域") as HTMLCanvasElement;
    surface.setPointerCapture = vi.fn();
    surface.hasPointerCapture = vi.fn(() => true);
    surface.releasePointerCapture = vi.fn();
    fireEvent.change(screen.getByLabelText("修改要求"), { target: { value: "修复这里" } });
    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(surface, { pointerId: 1 });
    expect(screen.getByRole("button", { name: "开始重绘" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "减少涂抹" }));
    fireEvent.pointerDown(surface, { button: 0, pointerId: 2, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(surface, { pointerId: 2 });
    expect(screen.getByRole("button", { name: "开始重绘" })).toBeDisabled();
  });
});
