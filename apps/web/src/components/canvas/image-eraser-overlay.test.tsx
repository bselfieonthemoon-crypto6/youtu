import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ImageEraserOverlay } from "./image-eraser-overlay";

afterEach(cleanup);

// jsdom has no 2D context and reports it as an unhandled error per render. The
// overlay already treats a missing context as "nothing to draw".
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});

const bounds = { x: 100, y: 100, width: 300, height: 200 };

/** jsdom implements neither PointerEvent nor pointer capture; the overlay reads
 * pointer coordinates and captures the pointer, so the test supplies both. */
if (typeof window.PointerEvent === "undefined") {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  (window as unknown as { PointerEvent: unknown }).PointerEvent = TestPointerEvent;
}

function prepareCanvas() {
  const canvas = screen.getByLabelText("局部重绘涂抹区域") as HTMLCanvasElement;
  (canvas as unknown as { setPointerCapture: unknown }).setPointerCapture = vi.fn();
  (canvas as unknown as { releasePointerCapture: unknown }).releasePointerCapture = vi.fn();
  (canvas as unknown as { hasPointerCapture: unknown }).hasPointerCapture = () => false;
  return canvas;
}

function paintStroke(canvas: HTMLCanvasElement) {
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 140, clientY: 140 });
  fireEvent.pointerUp(canvas, { button: 0, pointerId: 1, clientX: 140, clientY: 140 });
}

describe("ImageEraserOverlay repaint panel", () => {
  it("paints a mask and submits the strokes with the description", () => {
    const onConfirm = vi.fn();
    render(
      <ImageEraserOverlay
        repaint
        bounds={bounds}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    const canvas = prepareCanvas();
    const submit = screen.getByRole("button", { name: "开始重绘" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    paintStroke(canvas);
    fireEvent.change(screen.getByLabelText("修改要求"), { target: { value: "换成一只猫" } });

    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [mode, strokes, prompt] = onConfirm.mock.calls[0]!;
    expect(mode).toBe("smart");
    expect(strokes).toHaveLength(1);
    expect(strokes[0].points).toHaveLength(1);
    expect(prompt).toBe("换成一只猫");
  });

  it("locks the mask, the description and the quick fill while a submission is unconfirmed", () => {
    const onConfirm = vi.fn();
    render(
      <ImageEraserOverlay
        repaint
        locked
        busy={false}
        error="提交结果尚未确认"
        bounds={bounds}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    const canvas = prepareCanvas();

    expect(canvas.className).toContain("pointer-events-none");
    expect((screen.getByLabelText("修改要求") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByLabelText("移除选中内容") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("添加涂抹") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/选区与描述已锁定为原请求/)).toBeTruthy();

    // The locked canvas accepts no new stroke, so the replay stays disabled
    // until the panel holds a mask and a description again.
    const replay = screen.getByRole("button", { name: /重试原请求/ }) as HTMLButtonElement;
    expect(replay.disabled).toBe(true);
    paintStroke(canvas);
    expect(replay.disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps the design-editor eraser panel on its own transparent/smart flow", () => {
    render(
      <ImageEraserOverlay bounds={bounds} onCancel={vi.fn()} onConfirm={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /透明擦除/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /智能修复/ })).toBeTruthy();
    expect(screen.queryByLabelText("修改要求")).toBeNull();
  });

  it("names the tracked-job recovery with the parent's wording", () => {
    render(
      <ImageEraserOverlay
        repaint
        locked
        replayLabel="查询原任务"
        lockNote="只会查询该任务，不会重复生成。"
        bounds={bounds}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /查询原任务/ })).toBeTruthy();
    expect(screen.getByText("只会查询该任务，不会重复生成。")).toBeTruthy();
  });
});
