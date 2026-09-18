import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImageSelectionToolbar } from "../src/components/canvas/image-selection-toolbar";
afterEach(cleanup);
it("shows only board import inside a board and restores tools outside", () => {
  const onAddToBoard = vi.fn();
  const props = { image: { id: "image" } as any, screenBounds: { x: 100, y: 100, width: 100, height: 100 }, onAddToBoard,
    onDownload: vi.fn(), onCrop: vi.fn(), onRegenerate: vi.fn(), onUpscale: vi.fn(), onRemoveBackground: vi.fn(), onSplitLayers: vi.fn(), onErase: vi.fn(), onChatCommand: vi.fn(), onRecognizeText: async () => [], onApplyTextReplacement: async () => {} };
  const view = render(<ImageSelectionToolbar {...props} boardOnly addToBoardLabel="加入此画板" />);
  expect(screen.getAllByRole("button")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "加入此画板" }));
  expect(onAddToBoard).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "更多图片工具" })).toBeNull();
  view.rerender(<ImageSelectionToolbar {...props} />);
  expect(screen.getByRole("button", { name: "更多图片工具" })).toBeTruthy();
});
