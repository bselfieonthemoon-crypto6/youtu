import "@testing-library/jest-dom/vitest";

import type { BackgroundJob } from "@loomic/shared";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/components/design/fabric-design-surface", () => ({
  FabricDesignSurface: ({ readOnly }: { readOnly: boolean }) => (
    <div data-testid="fabric-surface" data-read-only={String(readOnly)} />
  ),
}));

import { DesignEditorOverlay } from "../src/components/design/design-editor-overlay";

const baseProps = {
  open: true,
  designId: "d15393dd-63cd-4e92-abb6-5010398e5152",
  name: "海报",
  width: 1080,
  height: 1080,
  background: "#ffffff",
  dirty: false,
  onClose: vi.fn(),
  onSave: vi.fn(async () => undefined),
};

describe("DesignEditorOverlay", () => {
  let narrow = false;

  beforeEach(() => {
    narrow = false;
    baseProps.onClose.mockClear();
    baseProps.onSave.mockClear();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("matchMedia", () => ({
      matches: narrow,
      media: "(max-width: 1023px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("isolates and restores the underlying canvas root", () => {
    const backgroundRoot = document.createElement("main");
    document.body.appendChild(backgroundRoot);
    const { unmount } = render(
      <DesignEditorOverlay {...baseProps} backgroundRoot={backgroundRoot} />,
    );

    expect(screen.getByRole("dialog", { name: "海报" })).toHaveClass("inset-3");
    expect(backgroundRoot.inert).toBe(true);
    expect(backgroundRoot).toHaveAttribute("aria-hidden", "true");

    unmount();
    expect(backgroundRoot.inert).toBe(false);
    expect(backgroundRoot).not.toHaveAttribute("aria-hidden");
    backgroundRoot.remove();
  });

  it("requires an explicit dirty-close decision and awaits save", async () => {
    let finishSave!: () => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    render(<DesignEditorOverlay {...baseProps} dirty onSave={onSave} />);

    fireEvent.click(screen.getByRole("button", { name: "返回画布" }));
    expect(
      screen.getByRole("alertdialog", { name: "保存后退出？" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存并退出" }));
    expect(baseProps.onClose).not.toHaveBeenCalled();

    finishSave();
    await waitFor(() => expect(baseProps.onClose).toHaveBeenCalledTimes(1));
  });

  it("switches the design surface to read-only below 1024px", () => {
    narrow = true;
    render(<DesignEditorOverlay {...baseProps} />);
    expect(screen.getByRole("status")).toHaveTextContent("已切换为只读");
    expect(screen.getByTestId("fabric-surface")).toHaveAttribute(
      "data-read-only",
      "true",
    );
  });

  it("does not guess an inert root and disables unavailable actions", () => {
    const unrelatedMain = document.createElement("main");
    document.body.appendChild(unrelatedMain);
    render(<DesignEditorOverlay {...baseProps} />);

    expect(unrelatedMain.inert).not.toBe(true);
    expect(screen.getByRole("button", { name: "预览" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "导出" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "文字" })).toBeDisabled();
    unrelatedMain.remove();
  });

  it("connects the basic object, upload, undo and redo controls", () => {
    const onAddObject = vi.fn();
    const onUpload = vi.fn(async () => undefined);
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    render(
      <DesignEditorOverlay
        {...baseProps}
        canUndo
        canRedo
        onUndo={onUndo}
        onRedo={onRedo}
        onAddObject={onAddObject}
        onUpload={onUpload}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "文字" }));
    fireEvent.click(screen.getByRole("button", { name: "矩形" }));
    fireEvent.click(screen.getByRole("button", { name: "圆形" }));
    expect(onAddObject.mock.calls.map(([type]) => type)).toEqual([
      "text",
      "rect",
      "circle",
    ]);

    const file = new File(["pixels"], "poster.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("选择要上传的设计资源"), {
      target: { files: [file] },
    });
    expect(onUpload).toHaveBeenCalledWith(file);

    const dialog = screen.getByRole("dialog", { name: "海报" });
    fireEvent.keyDown(dialog, { key: "z", ctrlKey: true });
    fireEvent.keyDown(dialog, { key: "z", ctrlKey: true, shiftKey: true });
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onRedo).toHaveBeenCalledOnce();
  });

  it("opens a browser export dialog and submits the selected format and scale", async () => {
    const onExport = vi.fn(async () => undefined);
    render(<DesignEditorOverlay {...baseProps} onExport={onExport} />);

    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    expect(
      screen.getByRole("dialog", { name: "导出设计" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("导出格式"), {
      target: { value: "transparent-png" },
    });
    fireEvent.change(screen.getByLabelText("导出倍率"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "下载" }));

    await waitFor(() =>
      expect(onExport).toHaveBeenCalledWith({
        format: "transparent-png",
        multiplier: 2,
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "导出设计" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("offers bounded animated GIF export without a raster multiplier", async () => {
    const onExport = vi.fn(async () => undefined);
    render(<DesignEditorOverlay {...baseProps} onExport={onExport} />);

    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    fireEvent.change(screen.getByLabelText("导出格式"), {
      target: { value: "gif" },
    });

    expect(screen.getByLabelText("导出倍率")).toBeDisabled();
    expect(screen.getByText(/最长边自动压缩至 1024px/)).toBeInTheDocument();
    expect(screen.getByText(/最多 60 帧/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下载" }));

    await waitFor(() =>
      expect(onExport).toHaveBeenCalledWith({ format: "gif", multiplier: 1 }),
    );
  });

  it("keeps the dialog open for a queued large export and shows restored progress", async () => {
    const onExport = vi.fn(async () => "background_queued" as const);
    const onRefreshExportJobs = vi.fn();
    render(
      <DesignEditorOverlay
        {...baseProps}
        onExport={onExport}
        exportJobs={[exportJob()]}
        onRefreshExportJobs={onRefreshExportJobs}
        onCancelExportJob={vi.fn()}
        onRetryExportJob={vi.fn()}
        onDownloadExportJob={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    expect(onRefreshExportJobs).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("region", { name: "后台导出任务" }),
    ).toHaveTextContent("等待服务器处理");
    fireEvent.click(screen.getByRole("button", { name: "下载" }));

    await waitFor(() => expect(onExport).toHaveBeenCalledOnce());
    expect(
      screen.getByRole("dialog", { name: "导出设计" }),
    ).toBeInTheDocument();
  });

  it("shows all conflict recovery choices", async () => {
    const onRetrySave = vi.fn(async () => undefined);
    const onReloadKeep = vi.fn(async () => undefined);
    const onReloadDiscard = vi.fn(async () => undefined);
    render(
      <DesignEditorOverlay
        {...baseProps}
        dirty
        conflictRevision={12}
        onRetrySave={onRetrySave}
        onReloadKeep={onReloadKeep}
        onReloadDiscard={onReloadDiscard}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("版本 12");
    fireEvent.click(screen.getByRole("button", { name: "重试原请求" }));
    await waitFor(() => expect(onRetrySave).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "重载并保留本地修改" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "重载并保留本地修改" }));
    await waitFor(() => expect(onReloadKeep).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "放弃本地并重载" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "放弃本地并重载" }));
    await waitFor(() => expect(onReloadDiscard).toHaveBeenCalledOnce());
  });

  it("keeps offline edits recoverable after a non-conflict save failure", async () => {
    const onRetrySave = vi.fn(async () => undefined);
    render(
      <DesignEditorOverlay
        {...baseProps}
        dirty
        saveError="Failed to fetch"
        onRetrySave={onRetrySave}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "保存失败，本地修改仍保留",
    );
    fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
    await waitFor(() => expect(onRetrySave).toHaveBeenCalledOnce());
  });

  it("isolates keyboard and clipboard events without cancelling native behavior", () => {
    const leaked = vi.fn();
    const eventTypes = ["keydown", "keyup", "copy", "cut", "paste"] as const;
    for (const type of eventTypes) document.addEventListener(type, leaked);
    render(<DesignEditorOverlay {...baseProps} editingEnabled />);
    const dialog = screen.getByRole("dialog", { name: "海报" });

    expect(fireEvent.keyDown(dialog, { key: "Delete", cancelable: true })).toBe(
      true,
    );
    expect(
      fireEvent.keyDown(dialog, {
        key: "z",
        ctrlKey: true,
        cancelable: true,
      }),
    ).toBe(true);
    expect(fireEvent.keyUp(dialog, { key: "Delete", cancelable: true })).toBe(
      true,
    );
    expect(fireEvent.copy(dialog, { cancelable: true })).toBe(true);
    expect(fireEvent.cut(dialog, { cancelable: true })).toBe(true);
    expect(fireEvent.paste(dialog, { cancelable: true })).toBe(true);
    expect(leaked).not.toHaveBeenCalled();

    for (const type of eventTypes) document.removeEventListener(type, leaked);
  });

  it("changes the real background color and transparency when editing is enabled", () => {
    const onBackgroundChange = vi.fn();
    const onDirtyChange = vi.fn();
    render(
      <DesignEditorOverlay
        {...baseProps}
        editingEnabled
        onBackgroundChange={onBackgroundChange}
        onDirtyChange={onDirtyChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("背景颜色"), {
      target: { value: "#123456" },
    });
    expect(onBackgroundChange).toHaveBeenCalledWith("#123456");
    fireEvent.click(screen.getByLabelText("透明背景"));
    expect(onBackgroundChange).toHaveBeenLastCalledWith(null);
    expect(onDirtyChange).toHaveBeenCalledTimes(2);
  });

  it("validates and submits a canvas resize strategy", async () => {
    const onResize = vi.fn(async () => undefined);
    render(<DesignEditorOverlay {...baseProps} onResize={onResize} />);

    fireEvent.change(screen.getByLabelText("宽度 px"), {
      target: { value: "2048" },
    });
    fireEvent.change(screen.getByLabelText("高度 px"), {
      target: { value: "1024" },
    });
    fireEvent.change(screen.getByLabelText("尺寸处理"), {
      target: { value: "scale" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用尺寸" }));

    await waitFor(() =>
      expect(onResize).toHaveBeenCalledWith({
        width: 2048,
        height: 1024,
        strategy: "scale",
      }),
    );
  });
});

function exportJob(): BackgroundJob {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    workspace_id: "20000000-0000-4000-8000-000000000002",
    project_id: "30000000-0000-4000-8000-000000000001",
    canvas_id: null,
    target_kind: "design",
    design_id: baseProps.designId,
    session_id: null,
    thread_id: null,
    queue_name: "design_export_jobs",
    job_type: "design_export",
    status: "queued",
    payload: {
      design_id: baseProps.designId,
      revision: 3,
      idempotency_key: "20000000-0000-4000-8000-000000000001",
      requested_by: "20000000-0000-4000-8000-000000000002",
      format: "png",
      multiplier: 2,
      transparent: false,
    },
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 0,
    max_attempts: 3,
    created_by: "20000000-0000-4000-8000-000000000002",
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
    canceled_at: null,
  };
}
