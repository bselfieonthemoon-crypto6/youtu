// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImageTextReplacementPanel } from "../src/components/canvas/image-text-replacement-panel";

const image = {
  id: "image-1",
  fileId: "file-1",
  x: 20,
  y: 30,
  width: 256,
  height: 256,
  mimeType: "image/png",
} as const;

afterEach(cleanup);

describe("ImageTextReplacementPanel", () => {
  it("recognizes text, lets the user edit it, and submits changed mappings only", async () => {
    const onRecognize = vi.fn(async () => ["aaaa.", "com"]);
    const onApply = vi.fn(async () => {});

    render(
      <ImageTextReplacementPanel
        image={image}
        screenBounds={{
          x: 20,
          y: 30,
          width: 256,
          height: 256,
          viewportWidth: 900,
        }}
        onRecognize={onRecognize}
        onApply={onApply}
        onCancel={vi.fn()}
      />,
    );

    const first = await screen.findByRole("textbox", { name: "替换 aaaa." });
    expect(
      document.querySelector("[data-replacement-rows]")?.className,
    ).toContain("overflow-x-hidden");
    expect(
      (screen.getByRole("textbox", { name: "替换 com" }) as HTMLInputElement)
        .value,
    ).toBe("com");
    fireEvent.change(first, { target: { value: "bbbb." } });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));

    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith([
        { original: "aaaa.", replacement: "bbbb." },
      ]),
    );
  });

  it("does not render a second applying overlay after submission", async () => {
    let finishApply: (() => void) | undefined;
    const onApply = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishApply = resolve;
        }),
    );

    render(
      <ImageTextReplacementPanel
        image={image}
        screenBounds={{
          x: 20,
          y: 30,
          width: 256,
          height: 256,
          viewportWidth: 900,
        }}
        onRecognize={async () => ["aaaa.com"]}
        onApply={onApply}
        onCancel={vi.fn()}
      />,
    );

    const input = await screen.findByRole("textbox", { name: "替换 aaaa.com" });
    fireEvent.change(input, { target: { value: "bbbb.com" } });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));

    expect(onApply).toHaveBeenCalledOnce();
    expect(screen.queryByText("正在应用文字…")).toBeNull();
    finishApply?.();
  });

  it("ignores recognition results from the previously selected image", async () => {
    let resolveFirst: ((texts: string[]) => void) | undefined;
    let resolveSecond: ((texts: string[]) => void) | undefined;
    const recognizeFirst = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const recognizeSecond = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          resolveSecond = resolve;
        }),
    );
    const props = {
      screenBounds: {
        x: 20,
        y: 30,
        width: 256,
        height: 256,
        viewportWidth: 900,
      },
      onApply: vi.fn(async () => {}),
      onCancel: vi.fn(),
    };
    const { rerender } = render(
      <ImageTextReplacementPanel
        {...props}
        image={image}
        onRecognize={recognizeFirst}
      />,
    );

    await waitFor(() => expect(recognizeFirst).toHaveBeenCalledOnce());
    rerender(
      <ImageTextReplacementPanel
        {...props}
        image={{ ...image, id: "image-2", fileId: "file-2" }}
        onRecognize={recognizeSecond}
      />,
    );
    await waitFor(() => expect(recognizeSecond).toHaveBeenCalledOnce());

    await act(async () => resolveFirst?.(["old image text"]));
    expect(screen.getByText("正在识别文字…")).toBeTruthy();

    await act(async () => resolveSecond?.(["current image text"]));
    expect(
      await screen.findByRole("textbox", { name: "替换 current image text" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("textbox", { name: "替换 old image text" }),
    ).toBeNull();
  });
});
