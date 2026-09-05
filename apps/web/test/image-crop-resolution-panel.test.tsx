// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImageCropResolutionPanel } from "../src/components/canvas/image-crop-resolution-panel";

afterEach(cleanup);

describe("ImageCropResolutionPanel", () => {
  it("allows saving a typed pixel resolution", () => {
    const onSave = vi.fn();
    render(
      <ImageCropResolutionPanel
        bounds={{ x: 100, y: 100, width: 300, height: 300, viewportWidth: 900 }}
        width={1024}
        height={1024}
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "裁剪宽度" }), {
      target: { value: "800px" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "裁剪高度" }), {
      target: { value: "600" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onSave).toHaveBeenCalledWith(800, 600);
  });

  it("locks an in-flight save against double clicks while keeping cancel available", async () => {
    let finishSave: (() => void) | undefined;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const onCancel = vi.fn();
    render(
      <ImageCropResolutionPanel
        bounds={{ x: 100, y: 100, width: 300, height: 300, viewportWidth: 900 }}
        width={1024}
        height={1024}
        onCancel={onCancel}
        onSave={onSave}
      />,
    );

    const save = screen.getByRole("button", { name: "保存" });
    fireEvent.click(save);
    fireEvent.click(save);

    expect(onSave).toHaveBeenCalledOnce();
    expect(
      (screen.getByRole("button", { name: "保存中…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledOnce();

    await act(async () => finishSave?.());
  });
});
