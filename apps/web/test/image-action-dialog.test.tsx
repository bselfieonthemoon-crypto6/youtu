// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImageActionDialog } from "../src/components/canvas/image-action-dialog";

afterEach(cleanup);

describe("ImageActionDialog", () => {
  it("renders regeneration as a compact anchored popover without a modal overlay", () => {
    const onConfirm = vi.fn();
    render(<ImageActionDialog
      action="regenerate"
      image={{ id: "image-1", fileId: "file-1", x: 20, y: 30, width: 200, height: 200, mimeType: "image/png", title: "Logo" }}
      screenBounds={{ x: 100, y: 80, width: 240, height: 240, viewportWidth: 1000 }}
      onOpenChange={vi.fn()}
      onConfirm={onConfirm}
    />);

    const popover = document.querySelector('[data-image-action-popover="regenerate"]');
    expect(popover).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((popover as HTMLElement).style.left).toBe("356px");
    expect((popover as HTMLElement).style.top).toBe("80px");
    expect((popover as HTMLElement).style.width).toBe("272px");
    fireEvent.change(screen.getByRole("textbox", { name: "补充要求（可选）" }), { target: { value: "保持透明背景" } });
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    expect(onConfirm).toHaveBeenCalledWith(expect.stringContaining("保持透明背景"));
  });

  it("renders upscale as a compact confirmation popover and includes the 2K size", () => {
    const onConfirm = vi.fn();
    render(<ImageActionDialog
      action="upscale"
      image={{
        id: "image-2",
        fileId: "file-2",
        x: 20,
        y: 30,
        width: 512,
        height: 292,
        originalWidth: 1024,
        originalHeight: 584,
        mimeType: "image/png",
        title: "Logo",
      }}
      screenBounds={{ x: 100, y: 80, width: 240, height: 140, viewportWidth: 1000 }}
      onOpenChange={vi.fn()}
      onConfirm={onConfirm}
    />);

    const popover = document.querySelector('[data-image-action-popover="upscale"]');
    expect(popover).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((popover as HTMLElement).style.left).toBe("356px");
    expect(screen.getByText(/是否将图片从/).textContent).toContain(
      "1024 × 584px 提升为 2048 × 1168px（2K）",
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "确认高清" }));
    expect(onConfirm).toHaveBeenCalledWith(expect.stringContaining("2048×1168px"));
  });
});
