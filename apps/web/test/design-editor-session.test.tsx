import "@testing-library/jest-dom/vitest";

import type {
  BackgroundJob,
  DesignTemplateDetailDto,
  DesignTemplateDto,
  DesignTemplateReplacePreviewResponse,
  LoomicSceneV1,
} from "@loomic/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const getDesign = vi.fn();
const queueDesignPreview = vi.fn(async () => ({ status: "queued" }));
const mutateDesign = vi.fn();
let latestSave: () => Promise<void>;
const exportDesign = vi.fn();
const listDesignExportJobs = vi.fn<() => Promise<BackgroundJob[]>>(
  async () => [],
);
const getDesignExportJob = vi.fn();
const cancelDesignExportJob = vi.fn();
const createDesignImageJob = vi.fn();
const listDesignImageJobs = vi.fn<() => Promise<BackgroundJob[]>>(
  async () => [],
);
const getDesignImageJob = vi.fn(async () => imageJobFixture());
const cancelDesignImageJob = vi.fn();
const uploadFile = vi.hoisted(() => vi.fn());
const fetchAssetBlob = vi.hoisted(() => vi.fn());
const getFontFaceContent = vi.hoisted(() => vi.fn());
const getTemplate = vi.hoisted(() => vi.fn());
const listTemplates = vi.hoisted(() =>
  vi.fn<
    () => Promise<{ items: DesignTemplateDto[]; next_cursor: string | null }>
  >(async () => ({ items: [], next_cursor: null })),
);
const previewTemplateReplacement = vi.hoisted(() => vi.fn());
const applyTemplateReplacement = vi.hoisted(() => vi.fn());
const addImage = vi.fn(
  async (_input: { assetObjectId: string; source: Blob }) =>
    "40000000-0000-4000-8000-000000000001",
);
const addSvg = vi.fn(
  async (_input: { assetObjectId: string; source: Blob }) =>
    "40000000-0000-4000-8000-000000000002",
);
const applyCommands = vi.fn(async () => undefined);
const serializeScene = vi.fn<() => LoomicSceneV1>(
  () => documentFixture().scene,
);
const mockEditor = {
  applyCommands,
  addObject: vi.fn(),
  addImage,
  addSvg,
  getSelectionIds: vi.fn<() => string[]>(() => []),
  select: vi.fn(),
  reorder: vi.fn(),
  loadScene: vi.fn(async () => undefined),
  serializeScene,
  waitForImages: vi.fn(async () => undefined),
  renderToBlob: vi.fn(async () => new Blob(["pixels"])),
  refreshTextMetrics: vi.fn(),
  getObjectViewportBounds: vi.fn(() => ({
    x: 100,
    y: 120,
    width: 320,
    height: 180,
    angle: 0,
  })),
};

const exportClone = vi.hoisted(() => ({
  loadScene: vi.fn(async () => undefined),
  waitForImages: vi.fn(async () => ({ missingAssetObjectIds: [] as string[] })),
  renderToBlob: vi.fn(async () => new Blob(["snapshot-pixels"])),
  disposeEditor: vi.fn(),
  offCanvas: vi.fn(),
  disposeCanvas: vi.fn(async () => undefined),
}));

vi.mock("fabric", () => ({
  Canvas: class MockExportCanvas {
    off = exportClone.offCanvas;
    dispose = exportClone.disposeCanvas;
  },
}));

vi.mock("../src/components/design/fabric-object-editor", () => ({
  FabricObjectEditor: class MockSnapshotEditor {
    loadScene = exportClone.loadScene;
    waitForImages = exportClone.waitForImages;
    renderToBlob = exportClone.renderToBlob;
    dispose = exportClone.disposeEditor;
  },
}));

vi.mock("../src/lib/design-api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/lib/design-api")>(),
  createDesignApiClient: () => ({
    getDesign,
    mutateDesign,
    queueDesignPreview,
    exportDesign,
    listDesignExportJobs,
    getDesignExportJob,
    cancelDesignExportJob,
    createDesignImageJob,
    listDesignImageJobs,
    getDesignImageJob,
    cancelDesignImageJob,
  }),
}));

vi.mock("../src/lib/server-api", () => ({ uploadFile }));
vi.mock("../src/lib/canvas-elements", () => ({ fetchAssetBlob }));
vi.mock("../src/lib/design-resource-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/design-resource-api")>();
  return {
    ...actual,
    createDesignResourceApiClient: () => ({
      getFontFaceContent,
      getTemplate,
      previewTemplateReplacement,
      applyTemplateReplacement,
      listResources: vi.fn(async () => ({ items: [], next_cursor: null })),
      listTemplates,
      listTextPresets: vi.fn(async () => ({ items: [], next_cursor: null })),
      listFonts: vi.fn(async () => ({ items: [], next_cursor: null })),
    }),
  };
});

vi.mock("../src/components/design/design-editor-overlay", () => ({
  DesignEditorOverlay: (props: {
    name: string;
    width: number;
    height: number;
    editingEnabled: boolean;
    backgroundRoot: HTMLElement;
    onBackgroundChange: (background: string | null) => void;
    onSave: () => Promise<void>;
    onUndo: () => void;
    onRedo: () => void;
    onResize: (options: {
      width: number;
      height: number;
      strategy: "crop" | "extend" | "scale";
    }) => Promise<void>;
    onObjectCommand: (event: {
      commands: unknown[];
      inverseCommands: unknown[];
      edits: { command: unknown; inverse: unknown }[];
      source: "api";
    }) => void;
    onUpload: (file: File) => Promise<void>;
    onExport: (options: {
      format: "png" | "transparent-png" | "jpeg";
      multiplier: 1 | 2;
    }) => Promise<"background_queued" | undefined>;
    resolveAsset: (object: { assetObjectId: string }) => Promise<Blob>;
    editorRef: { current: typeof mockEditor | null };
    dirty: boolean;
    canUndo: boolean;
    resourcePanel: React.ReactNode;
    imageTools?: React.ReactNode;
    subInteraction?: React.ReactNode;
    onCanvasReady?: (canvas: {
      on: (name: string, callback: () => void) => void;
    }) => void;
    onResourceMissing?: (input: {
      objectId: string;
      assetObjectId: string;
      type: "image";
      error: Error;
    }) => void;
    statusMessage?: string | null;
    exportJobs?: readonly BackgroundJob[];
    onCancelExportJob?: (job: BackgroundJob) => void;
    onRetryExportJob?: (job: BackgroundJob) => void;
    onDownloadExportJob?: (job: BackgroundJob) => void;
  }) => {
    props.editorRef.current = mockEditor;
    return (
      <div
        data-testid="editor-overlay"
        data-size={`${props.width}x${props.height}`}
        data-editing={String(props.editingEnabled)}
        data-root={props.backgroundRoot.dataset.testRoot}
        data-dirty={String(props.dirty)}
        data-can-undo={String(props.canUndo)}
      >
        {props.name}
        {props.statusMessage ? <p>{props.statusMessage}</p> : null}
        {props.exportJobs?.map((job) => (
          <div key={job.id}>
            <p>{`恢复导出任务 ${job.id} ${job.status}`}</p>
            {job.status === "queued" && (
              <button
                type="button"
                onClick={() => props.onCancelExportJob?.(job)}
              >
                模拟取消导出
              </button>
            )}
            {job.status === "failed" && (
              <button
                type="button"
                onClick={() => props.onRetryExportJob?.(job)}
              >
                模拟重试导出
              </button>
            )}
            {job.status === "succeeded" && (
              <button
                type="button"
                onClick={() => props.onDownloadExportJob?.(job)}
              >
                模拟下载导出
              </button>
            )}
          </div>
        ))}
        {props.resourcePanel}
        {props.imageTools}
        {props.subInteraction}
        <button
          type="button"
          onClick={() => {
            mockEditor.getSelectionIds.mockReturnValue([
              "80000000-0000-4000-8000-000000000001",
            ]);
            props.onCanvasReady?.({ on: (_name, callback) => callback() });
          }}
        >
          模拟选择图片
        </button>
        <button
          type="button"
          onClick={() => props.onBackgroundChange("#000000")}
        >
          修改背景
        </button>
        <button type="button" ref={() => { latestSave = props.onSave; }} onClick={() => void props.onSave()}>
          保存
        </button>
        <button
          type="button"
          onClick={() =>
            props.onObjectCommand({
              commands: [addRectCommand],
              inverseCommands: [replaceEmptySceneCommand],
              edits: [
                { command: addRectCommand, inverse: replaceEmptySceneCommand },
              ],
              source: "api",
            })
          }
        >
          模拟添加对象
        </button>
        <button type="button" onClick={props.onUndo}>
          撤销
        </button>
        <button type="button" onClick={props.onRedo}>
          重做
        </button>
        <button
          type="button"
          onClick={() =>
            void props.onResize({
              width: 800,
              height: 400,
              strategy: "scale",
            })
          }
        >
          等比缩放画板
        </button>
        <button
          type="button"
          onClick={() =>
            void props.onUpload(
              new File(["pixels"], "poster.png", { type: "image/png" }),
            )
          }
        >
          上传图片
        </button>
        <button
          type="button"
          onClick={() => void props.onExport({ format: "png", multiplier: 1 })}
        >
          模拟导出
        </button>
        <button
          type="button"
          onClick={() =>
            props.onResourceMissing?.({
              objectId: "40000000-0000-4000-8000-000000000099",
              assetObjectId: "50000000-0000-4000-8000-000000000099",
              type: "image",
              error: new Error("transient asset failure"),
            })
          }
        >
          模拟资源缺失
        </button>
        <button
          type="button"
          onClick={() =>
            void props.resolveAsset({
              assetObjectId: "50000000-0000-4000-8000-000000000001",
            })
          }
        >
          解析资源
        </button>
      </div>
    );
  },
}));

import { DesignEditorSession } from "../src/components/design/design-editor-session";
import { resetDesignFontLoaderCache } from "../src/lib/design-font-loader";

const addRectCommand = {
  action: "object.add" as const,
  object: {
    objectId: "40000000-0000-4000-8000-000000000010",
    objectVersion: 1,
    type: "rect" as const,
    name: "矩形",
    role: null,
    x: 10,
    y: 10,
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    zIndex: 0,
    fill: { kind: "solid" as const, color: "#000000" },
    stroke: null,
    strokeWidth: 0,
    radiusX: 0,
    radiusY: 0,
    shadow: null,
  },
};

const replaceEmptySceneCommand = {
  action: "scene.replace" as const,
  scene: documentFixture().scene,
};

describe("DesignEditorSession", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockEditor.getSelectionIds.mockReturnValue([]);
    serializeScene.mockImplementation(() => documentFixture().scene);
    exportClone.loadScene.mockResolvedValue(undefined);
    exportClone.waitForImages.mockResolvedValue({ missingAssetObjectIds: [] });
    exportClone.renderToBlob.mockResolvedValue(new Blob(["snapshot-pixels"]));
    vi.unstubAllGlobals();
  });

  it("loads the authoritative document before mounting the Stage 3 surface", async () => {
    getDesign.mockResolvedValue(documentFixture());
    const root = document.createElement("div");
    root.dataset.testRoot = "canvas";
    render(
      <DesignEditorSession
        accessToken="token"
        designId="10000000-0000-4000-8000-000000000001"
        backgroundRoot={root}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("正在加载设计…")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("editor-overlay")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("editor-overlay")).toHaveTextContent("活动海报");
    expect(screen.getByTestId("editor-overlay")).toHaveAttribute(
      "data-size",
      "1080x1440",
    );
    expect(screen.getByTestId("editor-overlay")).toHaveAttribute(
      "data-editing",
      "true",
    );
    expect(screen.getByTestId("editor-overlay")).toHaveAttribute(
      "data-root",
      "canvas",
    );
    expect(getDesign).toHaveBeenCalledWith(
      "token",
      "10000000-0000-4000-8000-000000000001",
    );
    await waitFor(() => expect(queueDesignPreview).toHaveBeenCalledTimes(1));
    expect(queueDesignPreview).toHaveBeenCalledWith("token", expect.objectContaining({
      design_id: documentFixture().id, expected_revision: 0,
    }));
  });

  it("binds a model image job to the authoritative selected design object", async () => {
    const initial = documentFixture({ revision: 7 });
    (
      initial.scene.objects as unknown as ReturnType<typeof imageFixture>[]
    ).push(imageFixture());
    getDesign.mockResolvedValue(initial);
    serializeScene.mockReturnValue(initial.scene);
    createDesignImageJob.mockResolvedValue(imageJobFixture());
    render(
      <DesignEditorSession
        accessToken="token"
        designId={initial.id}
        backgroundRoot={document.createElement("div")}
        onClose={vi.fn()}
      />,
    );

    await screen.findByTestId("editor-overlay");
    fireEvent.click(screen.getByRole("button", { name: "模拟选择图片" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "去除背景" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "去除背景" }));

    await waitFor(() => expect(createDesignImageJob).toHaveBeenCalledOnce());
    expect(createDesignImageJob).toHaveBeenCalledWith(
      "token",
      expect.objectContaining({
        operation: "remove_background",
        model: "gpt-image-2",
        target: {
          kind: "design",
          design_id: initial.id,
          expected_revision: 7,
          idempotency_key: expect.any(String),
          source_object_id: imageFixture().objectId,
          expected_object_version: imageFixture().objectVersion,
          source_asset_object_id: imageFixture().assetObjectId,
          placement: {
            x: imageFixture().x,
            y: imageFixture().y,
            width: imageFixture().width,
            height: imageFixture().height,
            fit: imageFixture().fit,
            replace_object_id: imageFixture().objectId,
          },
        },
      }),
    );
    expect(createDesignImageJob.mock.calls[0]?.[1]).not.toHaveProperty(
      "input_images",
    );
  });

  it("restores a running image task and reloads the authoritative scene after finalization", async () => {
    const initial = documentFixture({ revision: 7 });
    (
      initial.scene.objects as unknown as ReturnType<typeof imageFixture>[]
    ).push(imageFixture());
    const updated = documentFixture({ revision: 8 });
    (
      updated.scene.objects as unknown as ReturnType<typeof imageFixture>[]
    ).push({
      ...imageFixture(),
      objectVersion: 4,
      assetObjectId: "90000000-0000-4000-8000-000000000099",
    });
    const running = imageJobFixture({ status: "running" });
    const completed = imageJobFixture({
      status: "succeeded",
      result: {
        asset_id: "90000000-0000-4000-8000-000000000099",
        target_finalization: { status: "completed" },
      },
    });
    getDesign.mockResolvedValueOnce(initial).mockResolvedValueOnce(updated);
    listDesignImageJobs.mockResolvedValueOnce([running]);
    getDesignImageJob.mockResolvedValueOnce(completed);

    render(
      <DesignEditorSession
        accessToken="token"
        designId={initial.id}
        backgroundRoot={document.createElement("div")}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(getDesignImageJob).toHaveBeenCalledWith("token", running.id),
    );
    await waitFor(() => expect(getDesign).toHaveBeenCalledTimes(2));
    expect(mockEditor.loadScene).toHaveBeenLastCalledWith(
      updated.scene,
      expect.any(Function),
    );
    expect(
      await screen.findByText("图片处理完成，已更新设计。"),
    ).toBeInTheDocument();
  });

  it("previews and explicitly applies template bindings through the server without scene.replace", async () => {
    const initial = documentFixture({ revision: 3 });
    (
      initial.scene.objects as unknown as ReturnType<
        typeof templateTextFixture
      >[]
    ).push(templateTextFixture("当前标题"));
    const updated = documentFixture({ revision: 4 });
    (
      updated.scene.objects as unknown as ReturnType<
        typeof templateTextFixture
      >[]
    ).push({ ...templateTextFixture("替换后标题"), objectVersion: 2 });
    const template = templateFixture();
    const preview = templatePreviewFixture();
    getDesign.mockResolvedValueOnce(initial).mockResolvedValueOnce(updated);
    listTemplates.mockResolvedValue({
      items: [template.template],
      next_cursor: null,
    });
    getTemplate.mockResolvedValue(template);
    previewTemplateReplacement.mockResolvedValue(preview);
    applyTemplateReplacement.mockResolvedValue({
      preview,
      mutation: {
        design_id: initial.id,
        revision: 4,
        changed_object_ids: [templateTextFixture("").objectId],
        replayed: false,
      },
    });
    render(
      <DesignEditorSession
        accessToken="token"
        designId={initial.id}
        backgroundRoot={document.createElement("div")}
        onClose={vi.fn()}
      />,
    );

    await screen.findByTestId("editor-overlay");
    fireEvent.click(screen.getByRole("button", { name: "模板" }));
    fireEvent.click(await screen.findByRole("button", { name: "使用" }));
    expect(await screen.findByText(/替换模板变量 · 活动模板/u)).toBeInTheDocument();
    expect(previewTemplateReplacement).toHaveBeenCalledWith(
      "token",
      expect.objectContaining({
        design_id: initial.id,
        template_id: template.template.id,
        expected_revision: 3,
        expected_template_revision: 2,
        bindings: [],
        smart_bindings: [
          expect.objectContaining({
            type: "text",
            selector: { role: "title" },
            value: "当前标题",
          }),
        ],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认应用替换" }));

    await waitFor(() =>
      expect(applyTemplateReplacement).toHaveBeenCalledOnce(),
    );
    expect(applyTemplateReplacement).toHaveBeenCalledWith(
      "token",
      expect.objectContaining({
        expected_revision: 3,
        expected_template_revision: 2,
        idempotency_key: expect.any(String),
      }),
    );
    expect(mutateDesign).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mockEditor.loadScene).toHaveBeenLastCalledWith(
        updated.scene,
        expect.any(Function),
      ),
    );
  });

  it("queues an oversized export through the persisted design job API", async () => {
    const large = {
      ...documentFixture({ revision: 7 }),
      width: 8000,
      height: 8000,
      scene: {
        ...documentFixture().scene,
        canvas: { width: 8000, height: 8000, background: "#ffffff" },
      },
    };
    getDesign.mockResolvedValue(large);
    serializeScene.mockReturnValue(large.scene);
    exportDesign.mockResolvedValue({ job: exportJobFixture() });
    const root = document.createElement("div");
    render(
      <DesignEditorSession
        accessToken="token"
        designId="10000000-0000-4000-8000-000000000001"
        backgroundRoot={root}
        onClose={vi.fn()}
      />,
    );

    await screen.findByTestId("editor-overlay");
    fireEvent.click(screen.getByRole("button", { name: "模拟导出" }));

    await waitFor(() =>
      expect(exportDesign).toHaveBeenCalledWith("token", {
        design_id: "10000000-0000-4000-8000-000000000001",
        revision: 7,
        idempotency_key: expect.any(String),
        format: "png",
        multiplier: 1,
        transparent: false,
      }),
    );
    expect(mockEditor.renderToBlob).not.toHaveBeenCalled();
    expect(screen.getByText(/大尺寸导出已提交/u)).toBeInTheDocument();
  });

  it("restores persisted export tasks when a design is reopened", async () => {
    const restored = exportJobFixture({ status: "succeeded" });
    getDesign.mockResolvedValue(documentFixture({ revision: 7 }));
    listDesignExportJobs.mockResolvedValueOnce([restored]);
    const root = document.createElement("div");
    render(
      <DesignEditorSession
        accessToken="token"
        designId="10000000-0000-4000-8000-000000000001"
        backgroundRoot={root}
        onClose={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(`恢复导出任务 ${restored.id} succeeded`),
    ).toBeInTheDocument();
    expect(listDesignExportJobs).toHaveBeenCalledWith(
      "token",
      "10000000-0000-4000-8000-000000000001",
    );
  });

  it("cancels and retries persisted export jobs through real client methods", async () => {
    const queued = exportJobFixture({ status: "queued" });
    const canceled = exportJobFixture({ status: "canceled" });
    getDesign.mockResolvedValue(documentFixture({ revision: 7 }));
    listDesignExportJobs.mockResolvedValueOnce([queued]);
    cancelDesignExportJob.mockResolvedValue(canceled);
    const root = document.createElement("div");
    render(
      <DesignEditorSession
        accessToken="token"
        designId="10000000-0000-4000-8000-000000000001"
        backgroundRoot={root}
        onClose={vi.fn()}
      />,
    );

    await screen.findByRole("button", { name: "模拟取消导出" });
    fireEvent.click(screen.getByRole("button", { name: "模拟取消导出" }));
    await waitFor(() =>
      expect(cancelDesignExportJob).toHaveBeenCalledWith("token", queued.id),
    );

    listDesignExportJobs.mockResolvedValueOnce([
      exportJobFixture({ status: "failed", error_message: "渲染失败" }),
    ]);
    // Reopening the same design performs the authoritative task-list query again.
    cleanup();
    render(
      <DesignEditorSession
        accessToken="token"
        designId="10000000-0000-4000-8000-000000000001"
        backgroundRoot={root}
        onClose={vi.fn()}
      />,
    );
    exportDesign.mockResolvedValue({
      job: exportJobFixture({
        id: "70000000-0000-4000-8000-000000000002",
        status: "queued",
      }),
    });
    await screen.findByRole("button", { name: "模拟重试导出" });
    fireEvent.click(screen.getByRole("button", { name: "模拟重试导出" }));
    await waitFor(() =>
      expect(exportDesign).toHaveBeenCalledWith("token", {
        design_id: "10000000-0000-4000-8000-000000000001",
        revision: 7,
        idempotency_key: expect.any(String),
        format: "png",
        multiplier: 1,
        transparent: false,
      }),
    );
  });

  it("downloads a completed export through its protected asset id", async () => {
    const succeeded = exportJobFixture({
      status: "succeeded",
      result: {
        asset_object_id: "50000000-0000-4000-8000-000000000009",
        design_id: "10000000-0000-4000-8000-000000000001",
        revision: 7,
        format: "png",
        width: 8000,
        height: 8000,
        byte_size: 1024,
        expires_at: "2026-09-11T00:00:00.000Z",
      },
      completed_at: "2026-09-04T00:01:00.000Z",
    });
    getDesign.mockResolvedValue(documentFixture({ revision: 7 }));
    listDesignExportJobs.mockResolvedValueOnce([succeeded]);
    fetchAssetBlob.mockResolvedValue(new Blob(["export"]));
    const createObjectURL = vi.fn(() => "blob:protected-export");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const root = document.createElement("div");
    render(
      <DesignEditorSession
        accessToken="token"
        designId="10000000-0000-4000-8000-000000000001"
        backgroundRoot={root}
        onClose={vi.fn()}
      />,
    );

    await screen.findByRole("button", { name: "模拟下载导出" });
    fireEvent.click(screen.getByRole("button", { name: "模拟下载导出" }));
    await waitFor(() =>
      expect(fetchAssetBlob).toHaveBeenCalledWith(
        "token",
        "50000000-0000-4000-8000-000000000009",
      ),
    );
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:protected-export"),
    );
    click.mockRestore();
  });

  it("reloads a clean open editor when an Agent mutation publishes design.sync", async () => {
    const initial = documentFixture({ revision: 3 });
    const updated = {
      ...scaleDocumentFixture(4, 1, 800, 400, 40),
      name: "Agent 已更新",
    };
    getDesign.mockResolvedValueOnce(initial).mockResolvedValueOnce(updated);
    let onDesignSync:
      | ((event: {
          designId: string;
          revision: number;
          updateType: "mutated";
        }) => void)
      | undefined;
    const ws = {
      onDesignSync: vi.fn((callback: typeof onDesignSync) => {
        onDesignSync = callback;
        return vi.fn();
      }),
    };

    render(
      <DesignEditorSession
        accessToken="token"
        designId={initial.id}
        backgroundRoot={document.createElement("div")}
        onClose={vi.fn()}
        ws={ws as never}
      />,
    );
    await screen.findByTestId("editor-overlay");

    onDesignSync?.({
      designId: initial.id,
      revision: 4,
      updateType: "mutated",
    });

    await waitFor(() => expect(getDesign).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId("editor-overlay")).toHaveTextContent(
        "Agent 已更新",
      ),
    );
    expect(screen.getByTestId("editor-overlay")).toHaveAttribute(
      "data-size",
      "800x400",
    );
    expect(mockEditor.loadScene).toHaveBeenLastCalledWith(
      updated.scene,
      expect.any(Function),
    );
    expect(mockEditor.refreshTextMetrics).toHaveBeenCalled();
    expect(screen.getByText("已同步设计版本 4")).toBeInTheDocument();
  });

  it("preserves dirty local edits and surfaces a conflict when design.sync is newer", async () => {
    const initial = documentFixture({ revision: 3 });
    getDesign.mockResolvedValue(initial);
    let onDesignSync:
      | ((event: {
          designId: string;
          revision: number;
          updateType: "mutated";
        }) => void)
      | undefined;
    const ws = {
      onDesignSync: vi.fn((callback: typeof onDesignSync) => {
        onDesignSync = callback;
        return vi.fn();
      }),
    };

    render(
      <DesignEditorSession
        accessToken="token"
        designId={initial.id}
        backgroundRoot={document.createElement("div")}
        onClose={vi.fn()}
        ws={ws as never}
      />,
    );
    await screen.findByTestId("editor-overlay");
    fireEvent.click(screen.getByRole("button", { name: "模拟添加对象" }));

    onDesignSync?.({
      designId: initial.id,
      revision: 4,
      updateType: "mutated",
    });

    expect(
      await screen.findByText(
        "设计已在其他位置更新到版本 4；本地修改仍保留，请保存并处理版本冲突。",
      ),
    ).toBeInTheDocument();
    expect(getDesign).toHaveBeenCalledOnce();
    expect(mockEditor.loadScene).not.toHaveBeenCalled();
  });

  it("reopens a saved custom font from an empty browser cache before mounting Fabric", async () => {
    resetDesignFontLoaderCache();
    let finishFont: ((value: object) => void) | undefined;
    const loadPromise = new Promise<object>((resolve) => {
      finishFont = resolve;
    });
    const fontFace = { load: vi.fn(() => loadPromise) };
    vi.stubGlobal(
      "FontFace",
      vi.fn(() => fontFace),
    );
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { add: vi.fn(), ready: Promise.resolve() },
    });
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:catalog-font"),
      revokeObjectURL: vi.fn(),
    });
    getFontFaceContent.mockResolvedValue(new Blob(["font"]));
    const initial = documentFixture();
    (
      initial.scene.objects as unknown as Array<ReturnType<typeof textFixture>>
    ).push(textFixture());
    getDesign.mockResolvedValue(initial);

    render(
      <DesignEditorSession
        accessToken="token"
        designId={initial.id}
        backgroundRoot={document.createElement("div")}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(getFontFaceContent).toHaveBeenCalledWith(
        "token",
        textFixture().fontFaceId,
        expect.any(AbortSignal),
      ),
    );
    expect(screen.queryByTestId("editor-overlay")).not.toBeInTheDocument();
    finishFont?.(fontFace);
    await screen.findByTestId("editor-overlay");
    expect(document.fonts.add).toHaveBeenCalledWith(fontFace);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:catalog-font");
  });

  it("retries a failed manual save using the same frozen request", async () => {
    const initial = documentFixture({ revision: 3 });
    getDesign.mockResolvedValue(initial);
    mutateDesign.mockRejectedValueOnce(new Error("Unable to reach the design service."))
      .mockResolvedValueOnce({ design_id: initial.id, revision: 4, changed_object_ids: [], replayed: false });
    render(<DesignEditorSession accessToken="token" designId={initial.id}
      backgroundRoot={document.createElement("div")} onClose={vi.fn()} />);
    await screen.findByTestId("editor-overlay");
    fireEvent.click(screen.getByRole("button", { name: "修改背景" }));
    await expect(latestSave()).rejects.toThrow("Unable to reach");
    await latestSave();
    expect(mutateDesign).toHaveBeenCalledTimes(2);
    expect(mutateDesign.mock.calls[1]).toEqual(mutateDesign.mock.calls[0]);
  });

  it("persists a background edit through a structured CAS command", async () => {
    const initial = documentFixture({ revision: 3 });
    getDesign.mockResolvedValueOnce(initial);
    mutateDesign.mockResolvedValue({
      design_id: initial.id,
      revision: 4,
      changed_object_ids: [],
      replayed: false,
    });
    const root = document.createElement("div");
    render(
      <DesignEditorSession
        accessToken="token"
        designId={initial.id}
        backgroundRoot={root}
        onClose={vi.fn()}
      />,
    );
    await screen.findByTestId("editor-overlay");
    fireEvent.click(screen.getByRole("button", { name: "修改背景" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(mutateDesign).toHaveBeenCalledTimes(1));
    expect(mutateDesign).toHaveBeenCalledWith(
      "token",
      expect.objectContaining({
        design_id: initial.id,
        expected_revision: 3,
        commands: [{ action: "canvas.update", background: "#000000" }],
      }),
    );
    expect(getDesign).toHaveBeenCalledOnce();
  });

  it("records Fabric command events and persists a later undo as a real inverse", async () => {
    const initial = documentFixture({ revision: 3 });
    getDesign.mockResolvedValue(initial);
    mutateDesign
      .mockResolvedValueOnce({
        design_id: initial.id,
        revision: 4,
        changed_object_ids: [addRectCommand.object.objectId],
        replayed: false,
      })
      .mockResolvedValueOnce({
        design_id: initial.id,
        revision: 5,
        changed_object_ids: [addRectCommand.object.objectId],
        replayed: false,
      });
    render(
      <DesignEditorSession
        accessToken="token"
        designId={initial.id}
        backgroundRoot={document.createElement("div")}
        onClose={vi.fn()}
      />,
    );
    await screen.findByTestId("editor-overlay");

    fireEvent.click(screen.getByRole("button", { name: "模拟添加对象" }));
    expect(screen.getByTestId("editor-overlay")).toHaveAttribute(
      "data-can-undo",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mutateDesign).toHaveBeenCalledTimes(1));
    expect(mutateDesign.mock.calls[0]?.[1].commands).toEqual([addRectCommand]);

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() =>
      expect(applyCommands).toHaveBeenCalledWith(
        [replaceEmptySceneCommand],
        "undo",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mutateDesign).toHaveBeenCalledTimes(2));
    expect(mutateDesign.mock.calls[1]?.[1].commands).toEqual([
      replaceEmptySceneCommand,
    ]);
  });

  it("persists scale resize as canvas.update and keeps undo/redo object versions monotonic", async () => {
    const initial = scaleDocumentFixture(3, 4, 400, 400, 50);
    const scaled = scaleDocumentFixture(4, 5, 800, 400, 250).scene;
    const restored = scaleDocumentFixture(5, 6, 400, 400, 50).scene;
    const redone = scaleDocumentFixture(6, 7, 800, 400, 250).scene;
    getDesign.mockResolvedValue(initial);
    mockEditor.serializeScene
      .mockReturnValueOnce(scaled)
      .mockReturnValueOnce(restored)
      .mockReturnValueOnce(redone);
    mutateDesign
      .mockResolvedValueOnce({
        design_id: initial.id,
        revision: 4,
        changed_object_ids: [initial.scene.objects[0]?.objectId],
        replayed: false,
      })
      .mockResolvedValueOnce({
        design_id: initial.id,
        revision: 5,
        changed_object_ids: [initial.scene.objects[0]?.objectId],
        replayed: false,
      })
      .mockResolvedValueOnce({
        design_id: initial.id,
        revision: 6,
        changed_object_ids: [initial.scene.objects[0]?.objectId],
        replayed: false,
      });
    render(
      <DesignEditorSession
        accessToken="token"
        designId={initial.id}
        backgroundRoot={document.createElement("div")}
        onClose={vi.fn()}
      />,
    );
    await screen.findByTestId("editor-overlay");

    fireEvent.click(screen.getByRole("button", { name: "等比缩放画板" }));
    await waitFor(() =>
      expect(applyCommands).toHaveBeenLastCalledWith(
        [
          {
            action: "canvas.update",
            width: 800,
            height: 400,
            resize_mode: "scale",
          },
        ],
        "sync",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mutateDesign).toHaveBeenCalledTimes(1));
    expect(mutateDesign.mock.calls[0]?.[1].commands).toEqual([
      {
        action: "canvas.update",
        width: 800,
        height: 400,
        resize_mode: "scale",
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() =>
      expect(applyCommands).toHaveBeenLastCalledWith(
        [
          expect.objectContaining({
            action: "scene.replace",
            scene: expect.objectContaining({
              canvas: expect.objectContaining({ width: 400, height: 400 }),
              objects: [
                expect.objectContaining({
                  x: 50,
                  width: 100,
                  height: 100,
                  objectVersion: 6,
                }),
              ],
            }),
          }),
        ],
        "undo",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mutateDesign).toHaveBeenCalledTimes(2));
    expect(mutateDesign.mock.calls[1]?.[1].commands[0]).toMatchObject({
      action: "scene.replace",
      scene: { objects: [{ objectVersion: 6 }] },
    });

    fireEvent.click(screen.getByRole("button", { name: "重做" }));
    await waitFor(() =>
      expect(applyCommands).toHaveBeenLastCalledWith(
        [
          {
            action: "canvas.update",
            width: 800,
            height: 400,
            resize_mode: "scale",
          },
        ],
        "redo",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mutateDesign).toHaveBeenCalledTimes(3));
    expect(mutateDesign.mock.calls[2]?.[1].commands).toEqual([
      {
        action: "canvas.update",
        width: 800,
        height: 400,
        resize_mode: "scale",
      },
    ]);
    expect(mockEditor.serializeScene).toHaveReturnedWith(redone);
  });

  it("cancels an unpersisted scale resize without jumping object versions", async () => {
    const initial = scaleDocumentFixture(3, 4, 400, 400, 50);
    const scaled = scaleDocumentFixture(3, 5, 800, 400, 250).scene;
    getDesign.mockResolvedValue(initial);
    mockEditor.serializeScene
      .mockReturnValueOnce(scaled)
      .mockReturnValueOnce(initial.scene);
    render(
      <DesignEditorSession
        accessToken="token"
        designId={initial.id}
        backgroundRoot={document.createElement("div")}
        onClose={vi.fn()}
      />,
    );
    await screen.findByTestId("editor-overlay");

    fireEvent.click(screen.getByRole("button", { name: "等比缩放画板" }));
    await waitFor(() =>
      expect(screen.getByTestId("editor-overlay")).toHaveAttribute(
        "data-can-undo",
        "true",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));

    await waitFor(() =>
      expect(applyCommands).toHaveBeenLastCalledWith(
        [
          expect.objectContaining({
            action: "scene.replace",
            scene: expect.objectContaining({
              objects: [expect.objectContaining({ objectVersion: 4 })],
            }),
          }),
        ],
        "undo",
      ),
    );
    expect(mutateDesign).not.toHaveBeenCalled();
    expect(screen.getByTestId("editor-overlay")).toHaveAttribute(
      "data-dirty",
      "false",
    );
  });

  it("uploads through the authenticated upload API and resolves stored assets as blobs", async () => {
    const initial = documentFixture();
    getDesign.mockResolvedValue(initial);
    uploadFile.mockResolvedValue({
      asset: { id: "50000000-0000-4000-8000-000000000001" },
      url: "https://example.invalid/signed",
    });
    fetchAssetBlob.mockResolvedValue(new Blob(["stored"]));
    render(
      <DesignEditorSession
        accessToken="token"
        designId={initial.id}
        backgroundRoot={document.createElement("div")}
        onClose={vi.fn()}
      />,
    );
    await screen.findByTestId("editor-overlay");

    fireEvent.click(screen.getByRole("button", { name: "上传图片" }));
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
    expect(uploadFile.mock.calls[0]?.[0]).toBe("token");
    expect(uploadFile.mock.calls[0]?.[2]).toBe(initial.project_id);
    await waitFor(() => expect(addImage).toHaveBeenCalledTimes(1));
    expect(addImage.mock.calls[0]?.[0]).toMatchObject({
      assetObjectId: "50000000-0000-4000-8000-000000000001",
    });

    fireEvent.click(screen.getByRole("button", { name: "解析资源" }));
    await waitFor(() =>
      expect(fetchAssetBlob).toHaveBeenCalledWith(
        "token",
        "50000000-0000-4000-8000-000000000001",
      ),
    );
  });

  it("waits for queued resource work before taking an isolated export snapshot", async () => {
    const initial = documentFixture();
    const exportedScene = structuredClone(initial.scene);
    (
      exportedScene.objects as unknown as ReturnType<typeof imageFixture>[]
    ).push(imageFixture());
    let resolveUpload!: (value: {
      asset: { id: string };
      url: string;
    }) => void;
    uploadFile.mockReturnValue(
      new Promise((resolve) => {
        resolveUpload = resolve;
      }),
    );
    getDesign.mockResolvedValue(initial);
    serializeScene.mockReturnValue(exportedScene);
    const createObjectURL = vi.fn(() => "blob:snapshot-export");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    render(
      <DesignEditorSession
        accessToken="token"
        designId={initial.id}
        backgroundRoot={document.createElement("div")}
        onClose={vi.fn()}
      />,
    );
    await screen.findByTestId("editor-overlay");

    fireEvent.click(screen.getByRole("button", { name: "上传图片" }));
    await waitFor(() => expect(uploadFile).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "模拟导出" }));
    await Promise.resolve();
    expect(exportClone.loadScene).not.toHaveBeenCalled();

    resolveUpload({
      asset: { id: imageFixture().assetObjectId },
      url: "https://example.invalid/signed",
    });
    await waitFor(() => expect(exportClone.loadScene).toHaveBeenCalledOnce());
    expect(exportClone.loadScene).toHaveBeenCalledWith(
      exportedScene,
      expect.any(Function),
    );
    expect(exportClone.renderToBlob).toHaveBeenCalledOnce();
    expect(exportClone.disposeEditor).toHaveBeenCalledOnce();
    expect(exportClone.disposeCanvas).toHaveBeenCalledOnce();
    click.mockRestore();
  });

  it("does not let a recovered resource's stale missing callback block export", async () => {
    const initial = documentFixture();
    getDesign.mockResolvedValue(initial);
    serializeScene.mockReturnValue(initial.scene);
    exportClone.waitForImages.mockResolvedValue({ missingAssetObjectIds: [] });
    const createObjectURL = vi.fn(() => "blob:recovered-export");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    render(
      <DesignEditorSession
        accessToken="token"
        designId={initial.id}
        backgroundRoot={document.createElement("div")}
        onClose={vi.fn()}
      />,
    );
    await screen.findByTestId("editor-overlay");
    fireEvent.click(screen.getByRole("button", { name: "模拟资源缺失" }));
    fireEvent.click(screen.getByRole("button", { name: "模拟导出" }));

    await waitFor(() => expect(exportClone.renderToBlob).toHaveBeenCalledOnce());
    expect(screen.getByText(/已导出 活动海报@1x\.png/u)).toBeInTheDocument();
    expect(exportClone.waitForImages).toHaveBeenCalledOnce();
    expect(exportClone.disposeEditor).toHaveBeenCalledOnce();
    click.mockRestore();
  });
});

function documentFixture(overrides: { revision?: number } = {}) {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    workspace_id: "20000000-0000-4000-8000-000000000001",
    project_id: "30000000-0000-4000-8000-000000000001",
    name: "活动海报",
    width: 1080,
    height: 1440,
    revision: overrides.revision ?? 0,
    scene: {
      schemaVersion: 1 as const,
      engine: "fabric" as const,
      canvas: { width: 1080, height: 1440, background: "#ffffff" },
      objects: [],
    },
    preview_asset_object_id: null,
    preview_revision: 0,
    preview_status: "missing" as const,
    deleted_at: null,
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z",
  };
}

function scaleDocumentFixture(
  revision: number,
  objectVersion: number,
  width: number,
  height: number,
  x: number,
) {
  return {
    ...documentFixture({ revision }),
    width,
    height,
    scene: {
      schemaVersion: 1 as const,
      engine: "fabric" as const,
      canvas: { width, height, background: "#ffffff" },
      objects: [
        {
          objectId: "40000000-0000-4000-8000-000000000020",
          objectVersion,
          type: "rect" as const,
          name: "方形",
          role: null,
          x,
          y: 50,
          width: 100,
          height: 100,
          rotation: 0,
          opacity: 1,
          visible: true,
          locked: false,
          zIndex: 0,
          fill: { kind: "solid" as const, color: "#ff0000" },
          stroke: null,
          strokeWidth: 0,
          radiusX: 0,
          radiusY: 0,
          shadow: null,
        },
      ],
    },
  };
}

function textFixture() {
  return {
    objectId: "40000000-0000-4000-8000-000000000030",
    objectVersion: 1,
    type: "text" as const,
    name: "自定义字体标题",
    role: null,
    x: 10,
    y: 10,
    width: 200,
    height: 60,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    zIndex: 0,
    text: "Loomic",
    fontFaceId: "60000000-0000-4000-8000-000000000001",
    fontFamily: "Catalog Sans",
    fontSize: 48,
    fontWeight: 700,
    fontStyle: "normal" as const,
    textAlign: "left" as const,
    lineHeight: 1.2,
    charSpacing: 0,
    fill: { kind: "solid" as const, color: "#111111" },
  };
}

function templateTextFixture(text: string) {
  return {
    objectId: "b0000000-0000-4000-8000-000000000001",
    objectVersion: 1,
    type: "text" as const,
    name: "活动标题",
    role: "title" as const,
    x: 10,
    y: 10,
    width: 300,
    height: 60,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    zIndex: 0,
    text,
    fontFamily: "Arial",
    fontSize: 48,
    fontWeight: 700,
    fontStyle: "normal" as const,
    textAlign: "left" as const,
    lineHeight: 1.2,
    charSpacing: 0,
    fill: { kind: "solid" as const, color: "#111111" },
  };
}

function templateFixture(): DesignTemplateDetailDto {
  return {
    template: {
      id: "c0000000-0000-4000-8000-000000000001",
      scope: "workspace",
      workspace_id: "20000000-0000-4000-8000-000000000001",
      name: "活动模板",
      description: null,
      width: 1080,
      height: 1440,
      schema_version: 1,
      engine_version: "fabric@7.4.0",
      revision: 2,
      status: "published",
      preview_asset_object_id: null,
      category_id: null,
      tag_ids: [],
      variables: [
        {
          key: "title",
          label: "标题",
          type: "text",
          required: true,
          target: {
            object_id: templateTextFixture("").objectId,
            property: "text",
          },
        },
      ],
      source_url: null,
      author: null,
      license_name: "自有版权",
      license_url: null,
      attribution: null,
      usage_restrictions: "工作区内使用",
      deleted_at: null,
      created_at: "2026-09-07T00:00:00.000Z",
      updated_at: "2026-09-07T00:00:00.000Z",
    },
    scene: {
      ...documentFixture().scene,
      objects: [templateTextFixture("模板标题")],
    },
    asset_refs: [],
    font_face_ids: [],
  };
}

function templatePreviewFixture(): DesignTemplateReplacePreviewResponse {
  return {
    design_id: documentFixture().id,
    template_id: templateFixture().template.id,
    design_revision: 3,
    template_revision: 2,
    commands: [
      {
        action: "object.update",
        object_id: templateTextFixture("").objectId,
        expected_object_version: 1,
        patch: { object_type: "text", text: "当前标题" },
      },
    ],
    differences: [
      {
        variable_key: "title",
        type: "text",
        object_id: templateTextFixture("").objectId,
        property: "text",
        source: "smart",
        before: "当前标题",
        after: "当前标题",
      },
    ],
    unresolved_keys: [],
  };
}

function imageFixture() {
  return {
    objectId: "80000000-0000-4000-8000-000000000001",
    objectVersion: 3,
    type: "image" as const,
    name: "产品图",
    role: null,
    x: 50,
    y: 80,
    width: 320,
    height: 180,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    zIndex: 0,
    assetObjectId: "90000000-0000-4000-8000-000000000001",
    fit: "cover" as const,
  };
}

function imageJobFixture(
  overrides: Partial<BackgroundJob> = {},
): BackgroundJob {
  return {
    ...exportJobFixture(),
    id: "a0000000-0000-4000-8000-000000000001",
    queue_name: "image_generation_jobs",
    job_type: "image_generation",
    payload: {
      operation: "remove_background",
      target: {
        kind: "design",
        design_id: "10000000-0000-4000-8000-000000000001",
      },
    },
    ...overrides,
  };
}

function exportJobFixture(
  overrides: Partial<BackgroundJob> = {},
): BackgroundJob {
  return {
    id: "70000000-0000-4000-8000-000000000001",
    workspace_id: "20000000-0000-4000-8000-000000000001",
    project_id: "30000000-0000-4000-8000-000000000001",
    canvas_id: null,
    target_kind: "design" as const,
    design_id: "10000000-0000-4000-8000-000000000001",
    session_id: null,
    thread_id: null,
    queue_name: "design_export_jobs",
    job_type: "design_export" as const,
    status: "queued" as const,
    payload: {
      design_id: "10000000-0000-4000-8000-000000000001",
      revision: 7,
      format: "png",
      multiplier: 1,
      transparent: false,
    },
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 0,
    max_attempts: 3,
    created_by: "20000000-0000-4000-8000-000000000001",
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
    canceled_at: null,
    ...overrides,
  };
}
