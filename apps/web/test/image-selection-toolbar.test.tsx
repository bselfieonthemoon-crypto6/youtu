import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

it("keeps every split mode behind one 图层拆分 entry, each with its own cost", () => {
  const onSplitLayersBox = vi.fn();
  const onSplitLayers = vi.fn();
  const onSplitLayersDedicated = vi.fn();
  const props = { image: { id: "image" } as any, screenBounds: { x: 100, y: 100, width: 100, height: 100 },
    onDownload: vi.fn(), onCrop: vi.fn(), onRegenerate: vi.fn(), onUpscale: vi.fn(), onRemoveBackground: vi.fn(),
    onSplitLayers, onSplitLayersDedicated, onSplitLayersBox, onErase: vi.fn(), onChatCommand: vi.fn(),
    onRecognizeText: async () => [], onApplyTextReplacement: async () => {} };
  render(<ImageSelectionToolbar {...props} />);

  // Clicking the entry opens the mode panel; it does not start a paid flow by itself.
  fireEvent.click(screen.getByRole("button", { name: "图层拆分" }));
  const panel = screen.getByTestId("layer-split-menu");
  expect(panel).toBeTruthy();
  expect(onSplitLayersBox).not.toHaveBeenCalled();
  expect(onSplitLayers).not.toHaveBeenCalled();
  for (const mode of ["框选剥离", "按名称拆分", "本地快速拆分"]) expect(screen.getByText(mode)).toBeTruthy();
  expect(panel.textContent).toContain("2 次图片调用");
  expect(panel.textContent).toContain("免费 · 不出网");

  // The overflow menu no longer repeats them: one entry point, described modes.
  fireEvent.click(screen.getByRole("button", { name: "更多图片工具" }));
  expect(screen.queryByText("本地快速拆分")).toBeTruthy();
  expect(screen.getAllByText("框选剥离")).toHaveLength(1);

  fireEvent.click(screen.getByText("框选剥离"));
  expect(onSplitLayersBox).toHaveBeenCalledOnce();
});

it("fills the named split from the automatic element listing", async () => {
  const onSplitLayersAuto = vi.fn(async () => ["左侧人物", "标题文字"]);
  const props = { image: { id: "image" } as any, screenBounds: { x: 100, y: 100, width: 100, height: 100 },
    onDownload: vi.fn(), onCrop: vi.fn(), onRegenerate: vi.fn(), onUpscale: vi.fn(), onRemoveBackground: vi.fn(),
    onSplitLayers: vi.fn(), onSplitLayersDedicated: vi.fn(), onSplitLayersAuto, onErase: vi.fn(),
    onChatCommand: vi.fn(), onRecognizeText: async () => [], onApplyTextReplacement: async () => {} };
  render(<ImageSelectionToolbar {...props} />);

  fireEvent.click(screen.getByRole("button", { name: "图层拆分" }));
  fireEvent.click(screen.getByText("全部剥离"));

  // The proposed names prefill the editable dialog; they are not submitted blindly.
  await waitFor(() => expect(screen.getByLabelText("要拆分的元素名称")).toHaveValue("左侧人物\n标题文字"));
  expect(onSplitLayersAuto).toHaveBeenCalledOnce();
});

it("explains an empty element listing without leaving the split panel", async () => {
  const onSplitLayersAuto = vi.fn(async () => []);
  const props = { image: { id: "image" } as any, screenBounds: { x: 100, y: 100, width: 100, height: 100 },
    onDownload: vi.fn(), onCrop: vi.fn(), onRegenerate: vi.fn(), onUpscale: vi.fn(), onRemoveBackground: vi.fn(),
    onSplitLayers: vi.fn(), onSplitLayersAuto, onErase: vi.fn(),
    onChatCommand: vi.fn(), onRecognizeText: async () => [], onApplyTextReplacement: async () => {} };
  render(<ImageSelectionToolbar {...props} />);

  fireEvent.click(screen.getByRole("button", { name: "图层拆分" }));
  fireEvent.click(screen.getByText("全部剥离"));

  await waitFor(() => expect(screen.getByRole("alert"))
    .toHaveTextContent("没能从这张图里识别出独立元素，请改用框选剥离或自己填写元素名称。"));
  // The panel stays open with the reason, and no dialog was opened behind it.
  expect(screen.getByTestId("layer-split-menu")).toBeTruthy();
  expect(screen.queryByText("AI 图层拆分")).toBeNull();
});
