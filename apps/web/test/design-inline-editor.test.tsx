import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignInlineEditor } from "../src/components/design/design-inline-editor";

vi.mock("../src/components/design/fabric-design-surface", () => ({
  FabricDesignSurface: () => <div data-testid="surface" />,
}));
vi.mock("../src/components/design/design-editor-overlay", () => ({
  DesignEditorOverlay: () => <div>legacy editor</div>,
}));
afterEach(cleanup);
const base = {
  open: true,
  designId: "test",
  name: "测试画板",
  width: 640,
  height: 480,
  background: "#fff",
  dirty: false,
  onSave: async () => undefined,
  onClose: () => undefined,
};

describe("DesignInlineEditor", () => {
  it("uses the real session resource slot and undo callbacks without disabling the background", () => {
    const root = document.createElement("div");
    const undo = vi.fn();
    render(
      <DesignInlineEditor
        {...base}
        backgroundRoot={root}
        resourcePanel={<div>authorized resources</div>}
        canUndo
        onUndo={undo}
      />,
    );
    fireEvent.click(screen.getByText("资源"));
    expect(screen.getByText("authorized resources")).toBeInTheDocument();
    fireEvent.click(screen.getByText("撤销"));
    expect(undo).toHaveBeenCalledOnce();
    expect(root.inert).not.toBe(true);
  });
  it("never exits dirty editing if save fails", async () => {
    const close = vi.fn();
    render(
      <DesignInlineEditor
        {...base}
        dirty
        onClose={close}
        onSave={async () => {
          throw new Error("revision conflict");
        }}
      />,
    );
    fireEvent.click(screen.getByText("完成"));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(screen.getByText("保存并退出"));
    await screen.findByText("revision conflict");
    expect(close).not.toHaveBeenCalled();
  });
  it("flushes pending changes before switching to the legacy editor", async () => {
    const save = vi.fn(async () => undefined);
    render(<DesignInlineEditor {...base} onSave={save} />);
    fireEvent.click(screen.getByText("完整编辑器 / 导出"));
    await screen.findByText("legacy editor");
    expect(save).toHaveBeenCalledOnce();
  });
  it("exposes existing revision recovery without discarding edits", async () => {
    const keep = vi.fn(async () => undefined);
    render(
      <DesignInlineEditor {...base} conflictRevision={3} onReloadKeep={keep} />,
    );
    fireEvent.click(screen.getByText("保留本地并重载"));
    await waitFor(() => expect(keep).toHaveBeenCalledOnce());
  });
});
