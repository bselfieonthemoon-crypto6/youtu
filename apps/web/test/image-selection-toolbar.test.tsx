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

it("starts the box-selection split from the button and keeps the paid flows in the menu", () => {
  const onSplitLayersBox = vi.fn();
  const onSplitLayers = vi.fn();
  const onSplitLayersDedicated = vi.fn();
  const props = { image: { id: "image" } as any, screenBounds: { x: 100, y: 100, width: 100, height: 100 },
    onDownload: vi.fn(), onCrop: vi.fn(), onRegenerate: vi.fn(), onUpscale: vi.fn(), onRemoveBackground: vi.fn(),
    onSplitLayers, onSplitLayersDedicated, onSplitLayersBox, onErase: vi.fn(), onChatCommand: vi.fn(),
    onRecognizeText: async () => [], onApplyTextReplacement: async () => {} };
  render(<ImageSelectionToolbar {...props} />);

  // The visible split entry is the free box flow, not the paid named-layer dialog.
  fireEvent.click(screen.getByRole("button", { name: "图层拆分" }));
  expect(onSplitLayersBox).toHaveBeenCalledOnce();
  expect(onSplitLayersDedicated).not.toHaveBeenCalled();

  // The earlier generative and local paths stay reachable, one level down.
  fireEvent.click(screen.getByRole("button", { name: "更多图片工具" }));
  fireEvent.click(screen.getByText("按名称拆分（付费）"));
  expect(onSplitLayersDedicated).not.toHaveBeenCalled();
  expect(screen.getByText("AI 图层拆分")).toBeTruthy();
});
