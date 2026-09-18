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
  it.each([['png', 'PNG'], ['transparent-png', '透明 PNG'], ['jpeg', 'JPEG'], ['gif', '动态 GIF']])("downloads %s from the menu without opening board details", async (format, label) => {
    const onExport = vi.fn(async () => undefined);
    render(<DesignInlineEditor {...base} onExport={onExport} />);
    fireEvent.click(screen.getByRole("button", { name: "下载" }));
    expect(onExport).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("menuitem", { name: label }));
    await waitFor(() => expect(onExport).toHaveBeenCalledWith({ format, multiplier: 1 }));
    expect(screen.queryByText("legacy editor")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "画板详情" })).toBeInTheDocument();
  });
  it.each(["image", "group"])("keeps %s objects inline even when rotated", (type) => {
    render(<DesignInlineEditor {...base} scene={{ schemaVersion: 1, engine: "fabric", canvas: { width: 640, height: 480, background: "#fff" }, objects: [{ type, rotation: 1 }] } as any} />);
    expect(screen.getByTestId("design-inline-editor")).toBeInTheDocument();
    expect(screen.queryByText("legacy editor")).not.toBeInTheDocument();
  });
  it("does not switch editors when saving fails", async () => {
    render(<DesignInlineEditor {...base} onSave={async () => { throw new Error("save failed"); }} />);
    fireEvent.click(screen.getByRole("button", { name: "画板详情" }));
    await screen.findByText("save failed");
    expect(screen.queryByText("legacy editor")).not.toBeInTheDocument();
  });
  it("docks against the live canvas edge as the chat panel resizes", async () => {
    const root = document.createElement("div");
    const canvas = document.createElement("div");
    canvas.dataset.testid = "canvas-editor";
    const preview = document.createElement("div");
    preview.dataset.testid = "design-node-preview";
    preview.dataset.designId = "test";
    canvas.append(preview); root.append(canvas);
    let width = 700;
    canvas.getBoundingClientRect = () => ({ left: 0, right: width, top: 0, bottom: 900, width, height: 900 } as DOMRect);
    preview.getBoundingClientRect = () => ({ left: 20, right: 340, top: 40, bottom: 280, width: 320, height: 240 } as DOMRect);
    render(<DesignInlineEditor {...base} backgroundRoot={root}
      scene={{ schemaVersion: 1, engine: "fabric", canvas: { width: 640, height: 480, background: "#fff" }, objects: [] }}
      layerAdapter={{} as any} />);
    fireEvent.click(screen.getByRole("button", { name: "图层 / 属性" }));
    const dock = await screen.findByTestId("design-properties-dock");
    await waitFor(() => expect(dock.style.right).toBe(`${window.innerWidth - 700}px`));
    width = 500;
    await waitFor(() => expect(dock.style.right).toBe(`${window.innerWidth - 500}px`));
    width = 200;
    await waitFor(() => expect(dock.style.width).toBe("200px"));
    width = window.innerWidth;
    await waitFor(() => expect(dock.style.right).toBe("0px"));
  });
  it('waits for preview completion before closing even when already saved', async () => {
    let complete!: () => void;
    const close = vi.fn();
    const finish = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
    render(<DesignInlineEditor {...base} onFinish={finish} onClose={close} />);
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(finish).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    complete();
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
  it('stays open when preview refresh fails', async () => {
    const close = vi.fn();
    render(<DesignInlineEditor {...base} onFinish={async () => { throw new Error('预览更新失败'); }} onClose={close} />);
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    await screen.findByText('预览更新失败');
    expect(close).not.toHaveBeenCalled();
  });
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
    expect(screen.getByRole("toolbar", { name: "画板工具栏" })).toBeInTheDocument();
    const resources = screen.getByRole("button", { name: "资源" });
    expect(resources).toHaveAttribute("title", "资源");
    expect(resources).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(resources);
    expect(resources).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("authorized resources")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
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
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await screen.findByText("revision conflict");
    expect(close).not.toHaveBeenCalled();
  });
  it("flushes pending changes before switching to the legacy editor", async () => {
    const save = vi.fn(async () => undefined);
    render(<DesignInlineEditor {...base} onSave={save} />);
    fireEvent.click(screen.getByRole("button", { name: "画板详情" }));
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
