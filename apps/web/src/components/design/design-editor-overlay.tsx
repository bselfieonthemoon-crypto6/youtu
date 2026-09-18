"use client";

import type {
  BackgroundJob,
  DesignObject,
  LoomicSceneV1,
} from "@loomic/shared";
import type { Canvas as FabricCanvas } from "fabric";
import {
  ArrowLeft,
  Download,
  Eye,
  Layers3,
  Minus,
  MoveRight,
  Redo2,
  Save,
  Shapes,
  Triangle as TriangleIcon,
  Type,
  Undo2,
  Upload,
} from "lucide-react";
import {
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DesignBrowserExportFormat } from "../../lib/design-browser-export";
import type { DesignLayerAdapter } from "../../lib/design-layer-model";
import { DesignExportTaskList } from "./design-export-task-list";
import { DesignLayersPanel } from "./design-layers-panel";
import {
  type DesignPropertiesActions,
  DesignPropertiesPanel,
} from "./design-properties-panel";
import { FabricDesignSurface } from "./fabric-design-surface";
import type {
  AddFabricObjectInput,
  FabricObjectCommandEvent,
  FabricObjectEditorApi,
} from "./fabric-object-editor";

export type DesignEditorExportOptions = {
  format: DesignBrowserExportFormat;
  multiplier: 1 | 2;
};

export type DesignResizeOptions = {
  width: number;
  height: number;
  strategy: "crop" | "extend" | "scale";
};

export type DesignEditorOverlayProps = {
  onDropResource?: (
    resourceId: string,
    point: { x: number; y: number },
  ) => Promise<void>;
  open: boolean;
  designId: string;
  name: string;
  onRename?: (name: string) => Promise<void>;
  width: number;
  height: number;
  background: string | null;
  scene?: LoomicSceneV1;
  editingEnabled?: boolean;
  dirty: boolean;
  saving?: boolean;
  saveError?: string | null;
  statusMessage?: string | null;
  backgroundRoot?: HTMLElement | null;
  onClose: () => void;
  onSave: () => Promise<void>;
  onFinish?: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  onBackgroundChange?: (background: string | null) => void;
  onResize?: (options: DesignResizeOptions) => Promise<void>;
  onCanvasReady?: (canvas: FabricCanvas) => void | Promise<void>;
  onCanvasDispose?: () => void;
  onCanvasError?: (error: unknown) => void;
  editorRef?: Ref<FabricObjectEditorApi>;
  resolveAsset?: (
    object: Extract<DesignObject, { type: "image" | "svg" }>,
  ) => Promise<string | Blob> | string | Blob;
  onObjectCommand?: (event: FabricObjectCommandEvent) => void;
  onResourceMissing?: (input: {
    objectId: string;
    assetObjectId: string;
    type: "image" | "svg";
    error: unknown;
  }) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onAddObject?: (type: AddFabricObjectInput["type"]) => void;
  onUpload?: (file: File) => Promise<void>;
  onReplaceUpload?: (file: File) => Promise<void>;
  uploading?: boolean;
  uploadError?: string | null;
  selectedObjectIds?: readonly string[];
  layerAdapter?: DesignLayerAdapter;
  propertyActions?: DesignPropertiesActions;
  onPreview?: () => void;
  onExport?: (
    options: DesignEditorExportOptions,
  ) => Promise<"background_queued" | undefined>;
  exportJobs?: readonly BackgroundJob[];
  exportJobsLoading?: boolean;
  exportJobsError?: string | null;
  exportJobBusyId?: string | null;
  onRefreshExportJobs?: () => void;
  onCancelExportJob?: (job: BackgroundJob) => void;
  onRetryExportJob?: (job: BackgroundJob) => void;
  onDownloadExportJob?: (job: BackgroundJob) => void;
  conflictRevision?: number | null;
  onRetrySave?: () => Promise<void>;
  onReloadKeep?: () => Promise<void>;
  onReloadDiscard?: () => Promise<void>;
  onEscapeSubInteraction?: () => boolean;
  resourcePanel?: ReactNode;
  imageTools?: ReactNode;
  subInteraction?: ReactNode;
};

const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function useNarrowViewport(open: boolean) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!open) return;
    const query = window.matchMedia("(max-width: 1023px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [open]);
  return narrow;
}

export function DesignEditorOverlay(props: DesignEditorOverlayProps) {
  const {
    open,
    designId,
    name,
    width,
    height,
    background,
    scene,
    editingEnabled = true,
    dirty,
    saving = false,
    saveError,
    statusMessage,
    backgroundRoot,
    onClose,
    onSave,
    onDirtyChange,
    onBackgroundChange,
    onResize,
    onCanvasReady,
    onCanvasDispose,
    onCanvasError,
    editorRef,
    resolveAsset,
    onObjectCommand,
    onResourceMissing,
    onUndo,
    onRedo,
    canUndo = Boolean(onUndo),
    canRedo = Boolean(onRedo),
    onAddObject,
    onUpload,
    onReplaceUpload,
    uploading = false,
    uploadError,
    selectedObjectIds = [],
    layerAdapter,
    propertyActions,
    onPreview,
    onExport,
    exportJobs = [],
    exportJobsLoading,
    exportJobsError,
    exportJobBusyId,
    onRefreshExportJobs,
    onCancelExportJob,
    onRetryExportJob,
    onDownloadExportJob,
    conflictRevision,
    onRetrySave,
    onReloadKeep,
    onReloadDiscard,
    onEscapeSubInteraction,
    resourcePanel,
    imageTools,
    subInteraction,
  } = props;
  const titleId = useId();
  const overlayRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const lastOpaqueBackgroundRef = useRef(background ?? "#ffffff");
  const [closePrompt, setClosePrompt] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [exportPrompt, setExportPrompt] = useState(false);
  const [exportFormat, setExportFormat] =
    useState<DesignBrowserExportFormat>("png");
  const [exportMultiplier, setExportMultiplier] = useState<1 | 2>(1);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [resizeWidth, setResizeWidth] = useState(String(width));
  const [resizeHeight, setResizeHeight] = useState(String(height));
  const [resizeStrategy, setResizeStrategy] =
    useState<DesignResizeOptions["strategy"]>("extend");
  const [resizeError, setResizeError] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const narrow = useNarrowViewport(open);
  if (background) lastOpaqueBackgroundRef.current = background;
  useEffect(() => setResizeWidth(String(width)), [width]);
  useEffect(() => setResizeHeight(String(height)), [height]);

  const requestClose = useCallback(() => {
    if (dirty) {
      setClosePrompt(true);
      setCloseError(null);
      return;
    }
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    // The integration owns the Excalidraw root. Do not guess with a generic
    // `main` selector because the portalled editor also contains a main.
    const root = backgroundRoot;
    const previousInert = root?.inert ?? false;
    const previousAriaHidden = root?.getAttribute("aria-hidden");
    if (root && !root.contains(overlayRef.current)) {
      root.inert = true;
      root.setAttribute("aria-hidden", "true");
    }
    requestAnimationFrame(() => overlayRef.current?.focus());
    return () => {
      if (root && !root.contains(overlayRef.current)) {
        root.inert = previousInert;
        if (previousAriaHidden === null) root.removeAttribute("aria-hidden");
        else if (typeof previousAriaHidden === "string")
          root.setAttribute("aria-hidden", previousAriaHidden);
      }
      previousFocusRef.current?.focus();
    };
  }, [backgroundRoot, open]);

  useEffect(() => {
    if (!open || !dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, open]);

  const handleKeyDownCapture = (
    event: ReactKeyboardEvent<HTMLDialogElement>,
  ) => {
    // Keep Excalidraw's document-level shortcuts isolated while preserving
    // native behavior for text fields and contenteditable descendants.
    event.stopPropagation();
    if (event.key === "Tab") {
      const focusable = Array.from(
        overlayRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      ).filter((element) => !element.hidden && element.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        overlayRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    const usesNativeEditing = Boolean(
      active?.isContentEditable ||
        active?.matches("input, textarea, select") ||
        active?.closest("[contenteditable='true']"),
    );
    if ((event.ctrlKey || event.metaKey) && !usesNativeEditing) {
      const key = event.key.toLowerCase();
      if (key === "z" && (onUndo || onRedo)) {
        event.preventDefault();
        if (event.shiftKey) onRedo?.();
        else onUndo?.();
        return;
      }
      if (key === "y" && onRedo) {
        event.preventDefault();
        onRedo();
        return;
      }
      if (key === "s" && dirty && !saving) {
        event.preventDefault();
        void onSave().catch(() => undefined);
        return;
      }
    }
    if (event.key !== "Escape") return;
    if (exportPrompt) {
      setExportPrompt(false);
      setExportError(null);
      return;
    }
    if (closePrompt) {
      setClosePrompt(false);
      setCloseError(null);
      return;
    }
    if (active?.isContentEditable) {
      active.blur();
      return;
    }
    if (active?.closest("[data-design-subinteraction='true']")) return;
    if (onEscapeSubInteraction?.()) return;
    requestClose();
  };

  const stopKeyboardPropagation = (
    event: ReactKeyboardEvent<HTMLDialogElement>,
  ) => event.stopPropagation();

  const stopClipboardPropagation = (
    event: ReactClipboardEvent<HTMLDialogElement>,
  ) => event.stopPropagation();

  const changeBackground = (nextBackground: string | null) => {
    if (!editingEnabled || narrow || !onBackgroundChange) return;
    if (nextBackground) lastOpaqueBackgroundRef.current = nextBackground;
    onBackgroundChange(nextBackground);
    onDirtyChange?.(true);
  };

  const saveAndClose = async () => {
    setCloseError(null);
    try {
      await onSave();
      setClosePrompt(false);
      onClose();
    } catch (error) {
      setCloseError(
        error instanceof Error ? error.message : "保存失败，请重试。",
      );
    }
  };

  const runRecovery = async (operation: (() => Promise<void>) | undefined) => {
    if (!operation || recoveryBusy) return;
    setRecoveryBusy(true);
    setRecoveryError(null);
    try {
      await operation();
    } catch (error) {
      setRecoveryError(
        error instanceof Error ? error.message : "冲突恢复失败，请重试。",
      );
    } finally {
      setRecoveryBusy(false);
    }
  };

  const runExport = async () => {
    if (!onExport || exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      const result = await onExport({
        format: exportFormat,
        multiplier: exportFormat === "gif" ? 1 : exportMultiplier,
      });
      if (result !== "background_queued") setExportPrompt(false);
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : "导出失败，请重试。",
      );
    } finally {
      setExporting(false);
    }
  };

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] bg-black/25 backdrop-blur-sm"
      data-testid="design-editor-backdrop"
    >
      <dialog
        open
        ref={overlayRef}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-design-id={designId}
        className="fixed inset-3 m-0 flex h-auto w-auto max-h-none max-w-none min-h-0 flex-col overflow-hidden rounded-2xl border bg-background p-0 text-foreground shadow-float outline-none"
        onKeyDownCapture={handleKeyDownCapture}
        onKeyUpCapture={stopKeyboardPropagation}
        onCopyCapture={stopClipboardPropagation}
        onCutCapture={stopClipboardPropagation}
        onPasteCapture={stopClipboardPropagation}
      >
        <header className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="返回画布"
            title="返回画布"
            onClick={requestClose}
          >
            <ArrowLeft />
          </Button>
          <h1
            id={titleId}
            className="min-w-0 flex-1 truncate px-2 text-sm font-medium"
          >
            {name}
          </h1>
          <span
            className="mr-2 text-xs text-muted-foreground"
            aria-live="polite"
          >
            {saving
              ? "保存中…"
              : saveError
                ? "保存失败"
                : dirty
                  ? "未保存"
                  : (statusMessage ?? "已保存")}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="撤销"
            title="撤销"
            onClick={onUndo}
            disabled={!onUndo || !canUndo || narrow || !editingEnabled}
          >
            <Undo2 />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="重做"
            title="重做"
            onClick={onRedo}
            disabled={!onRedo || !canRedo || narrow || !editingEnabled}
          >
            <Redo2 />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onSave().catch(() => undefined)}
            disabled={!editingEnabled || !dirty || saving || narrow}
          >
            <Save />
            保存
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="预览"
            title="预览"
            onClick={onPreview}
            disabled={!onPreview}
          >
            <Eye />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="导出"
            title="导出"
            onClick={() => {
              setExportError(null);
              setExportPrompt(true);
              onRefreshExportJobs?.();
            }}
            disabled={!onExport}
          >
            <Download />
          </Button>
        </header>

        {conflictRevision !== null && conflictRevision !== undefined && (
          <section
            role="alert"
            className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm"
          >
            <span className="mr-auto">
              服务器设计已更新到版本 {conflictRevision}，本地修改已暂停保存。
            </span>
            {recoveryError && (
              <span className="w-full text-xs text-destructive">
                {recoveryError}
              </span>
            )}
            {onRetrySave && (
              <Button
                variant="outline"
                size="sm"
                disabled={recoveryBusy}
                onClick={() => void runRecovery(onRetrySave)}
              >
                重试原请求
              </Button>
            )}
            {onReloadKeep && (
              <Button
                variant="outline"
                size="sm"
                disabled={recoveryBusy}
                onClick={() => void runRecovery(onReloadKeep)}
              >
                重载并保留本地修改
              </Button>
            )}
            {onReloadDiscard && (
              <Button
                size="sm"
                disabled={recoveryBusy}
                onClick={() => void runRecovery(onReloadDiscard)}
              >
                放弃本地并重载
              </Button>
            )}
          </section>
        )}

        {saveError &&
          (conflictRevision === null || conflictRevision === undefined) && (
            <section
              role="alert"
              className="flex shrink-0 flex-wrap items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm"
            >
              <span className="mr-auto">
                保存失败，本地修改仍保留：{saveError}
              </span>
              {onRetrySave && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={recoveryBusy}
                  onClick={() => void runRecovery(onRetrySave)}
                >
                  重试保存
                </Button>
              )}
            </section>
          )}

        {narrow && (
          <output className="block shrink-0 border-b bg-warning/10 px-4 py-2 text-center text-sm">
            当前窗口窄于 1024px，设计画板已切换为只读。请扩大窗口后继续编辑。
          </output>
        )}

        <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_300px] max-[1023px]:grid-cols-1">
          <aside
            className="overflow-y-auto border-r p-3 max-[1023px]:hidden"
            aria-label="添加内容"
          >
            {resourcePanel && (
              <div className="mb-4 border-b pb-4">{resourcePanel}</div>
            )}
            <p className="mb-3 px-2 text-xs font-medium text-muted-foreground">
              添加
            </p>
            <div className="grid grid-cols-2 gap-2">
              <ToolButton
                icon={<Type />}
                label="文字"
                disabled={!onAddObject || narrow || !editingEnabled}
                onClick={() => onAddObject?.("text")}
              />
              <ToolButton
                icon={<Type />}
                label="文本框"
                disabled={!onAddObject || narrow || !editingEnabled}
                onClick={() => onAddObject?.("textbox")}
              />
              <ToolButton
                icon={<Shapes />}
                label="矩形"
                disabled={!onAddObject || narrow || !editingEnabled}
                onClick={() => onAddObject?.("rect")}
              />
              <ToolButton
                icon={<Shapes />}
                label="圆形"
                disabled={!onAddObject || narrow || !editingEnabled}
                onClick={() => onAddObject?.("circle")}
              />
              <ToolButton
                icon={<TriangleIcon />}
                label="三角形"
                disabled={!onAddObject || narrow || !editingEnabled}
                onClick={() => onAddObject?.("triangle")}
              />
              <ToolButton
                icon={<Minus />}
                label="直线"
                disabled={!onAddObject || narrow || !editingEnabled}
                onClick={() => onAddObject?.("line")}
              />
              <ToolButton
                icon={<MoveRight />}
                label="箭头"
                disabled={!onAddObject || narrow || !editingEnabled}
                onClick={() => onAddObject?.("arrow")}
              />
              <ToolButton
                icon={<Upload />}
                label={uploading ? "上传中" : "上传"}
                disabled={!onUpload || uploading || narrow || !editingEnabled}
                onClick={() => uploadInputRef.current?.click()}
              />
            </div>
            <input
              ref={uploadInputRef}
              type="file"
              className="sr-only"
              aria-label="选择要上传的设计资源"
              accept="image/*,.svg"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file && onUpload) void onUpload(file);
              }}
            />
            <input
              ref={replaceInputRef}
              type="file"
              className="sr-only"
              aria-label="选择替换图片资源"
              accept="image/*,.svg"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file && onReplaceUpload) void onReplaceUpload(file);
              }}
            />
            {uploadError && (
              <p role="alert" className="mt-2 px-2 text-xs text-destructive">
                {uploadError}
              </p>
            )}
            <div className="mt-5 rounded-xl border p-3">
              <p className="mb-3 text-xs font-medium text-muted-foreground">
                画板
              </p>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>背景颜色</span>
                <input
                  type="color"
                  aria-label="背景颜色"
                  value={background ?? lastOpaqueBackgroundRef.current}
                  disabled={
                    !editingEnabled ||
                    narrow ||
                    !onBackgroundChange ||
                    background === null
                  }
                  className="h-8 w-12 cursor-pointer rounded-lg border bg-transparent p-1 disabled:cursor-not-allowed disabled:opacity-45"
                  onChange={(event) =>
                    changeBackground(event.currentTarget.value)
                  }
                />
              </label>
              <label className="mt-3 flex items-center justify-between gap-3 text-sm">
                <span>透明背景</span>
                <input
                  type="checkbox"
                  aria-label="透明背景"
                  checked={background === null}
                  disabled={!editingEnabled || narrow || !onBackgroundChange}
                  className="size-4 accent-foreground disabled:cursor-not-allowed disabled:opacity-45"
                  onChange={(event) =>
                    changeBackground(
                      event.currentTarget.checked
                        ? null
                        : lastOpaqueBackgroundRef.current,
                    )
                  }
                />
              </label>
              {onResize && (
                <div className="mt-4 grid grid-cols-2 gap-2 border-t pt-3">
                  <label className="grid gap-1 text-xs">
                    宽度 px
                    <input
                      type="number"
                      min={1}
                      max={32768}
                      value={resizeWidth}
                      className="h-8 min-w-0 rounded-md border bg-background px-2"
                      onChange={(event) =>
                        setResizeWidth(event.currentTarget.value)
                      }
                    />
                  </label>
                  <label className="grid gap-1 text-xs">
                    高度 px
                    <input
                      type="number"
                      min={1}
                      max={32768}
                      value={resizeHeight}
                      className="h-8 min-w-0 rounded-md border bg-background px-2"
                      onChange={(event) =>
                        setResizeHeight(event.currentTarget.value)
                      }
                    />
                  </label>
                  <label className="col-span-2 grid gap-1 text-xs">
                    尺寸处理
                    <select
                      value={resizeStrategy}
                      className="h-8 rounded-md border bg-background px-2"
                      onChange={(event) =>
                        setResizeStrategy(
                          event.currentTarget
                            .value as DesignResizeOptions["strategy"],
                        )
                      }
                    >
                      <option value="extend">扩展画板</option>
                      <option value="crop">裁切画板</option>
                      <option value="scale">等比缩放内容</option>
                    </select>
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    className="col-span-2"
                    onClick={() => {
                      const nextWidth = Number(resizeWidth);
                      const nextHeight = Number(resizeHeight);
                      if (
                        !Number.isInteger(nextWidth) ||
                        !Number.isInteger(nextHeight) ||
                        nextWidth < 1 ||
                        nextHeight < 1 ||
                        nextWidth > 32768 ||
                        nextHeight > 32768
                      ) {
                        setResizeError("宽高必须是 1–32768 的整数。");
                        return;
                      }
                      setResizeError(null);
                      void onResize({
                        width: nextWidth,
                        height: nextHeight,
                        strategy: resizeStrategy,
                      }).catch((error: unknown) =>
                        setResizeError(
                          error instanceof Error
                            ? error.message
                            : "调整尺寸失败。",
                        ),
                      );
                    }}
                  >
                    应用尺寸
                  </Button>
                  {resizeError && (
                    <p
                      role="alert"
                      className="col-span-2 text-xs text-destructive"
                    >
                      {resizeError}
                    </p>
                  )}
                </div>
              )}
            </div>
          </aside>
          <main className="min-h-0 min-w-0">
            <FabricDesignSurface
              showOverflow
              ref={editorRef}
              width={width}
              height={height}
              background={background}
              readOnly={narrow || !editingEnabled}
              {...(scene ? { scene } : {})}
              {...(resolveAsset ? { resolveAsset } : {})}
              {...(onObjectCommand ? { onObjectCommand } : {})}
              {...(onResourceMissing ? { onResourceMissing } : {})}
              {...(onCanvasReady ? { onCanvasReady } : {})}
              {...(onCanvasDispose ? { onCanvasDispose } : {})}
              {...(onCanvasError ? { onCanvasError } : {})}
              {...(editingEnabled && onDirtyChange ? { onDirtyChange } : {})}
            />
          </main>
          <div className="flex min-h-0 flex-col max-[1023px]:hidden">
            {imageTools}
            {propertyActions && (
              <DesignPropertiesPanel
                selectedObjects={
                  scene?.objects.filter((object) =>
                    selectedObjectIds.includes(object.objectId),
                  ) ?? []
                }
                actions={{
                  ...propertyActions,
                  ...(onReplaceUpload
                    ? {
                        requestReplaceAsset: () =>
                          replaceInputRef.current?.click(),
                      }
                    : {}),
                }}
              />
            )}
            {scene && layerAdapter ? (
              <div className="min-h-0 flex-1">
                <DesignLayersPanel
                  objects={scene.objects}
                  selectedObjectIds={selectedObjectIds}
                  adapter={layerAdapter}
                />
              </div>
            ) : (
              <aside
                className="flex h-full items-center justify-center border-l p-3 text-sm text-muted-foreground"
                aria-label="对象属性和图层"
              >
                <Layers3 className="mr-2 size-4" />
                暂无图层
              </aside>
            )}
          </div>
        </div>

        {exportPrompt && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center bg-black/20 p-4"
            data-design-subinteraction="true"
          >
            <dialog
              open
              aria-labelledby={`${titleId}-export`}
              className="relative m-0 w-full max-w-xl rounded-xl border bg-background p-4 text-foreground shadow-float"
            >
              <h2 id={`${titleId}-export`} className="font-medium">
                导出设计
              </h2>
              <div className="mt-4 grid gap-4">
                <label className="grid gap-1 text-sm">
                  <span>文件格式</span>
                  <select
                    aria-label="导出格式"
                    value={exportFormat}
                    className="h-9 rounded-lg border bg-background px-2"
                    onChange={(event) =>
                      setExportFormat(
                        event.currentTarget.value as DesignBrowserExportFormat,
                      )
                    }
                  >
                    <option value="png">PNG</option>
                    <option value="transparent-png">透明 PNG</option>
                    <option value="jpeg">JPEG</option>
                    <option value="gif">动态 GIF</option>
                  </select>
                </label>
                <label className="grid gap-1 text-sm">
                  <span>导出倍率</span>
                  <select
                    aria-label="导出倍率"
                    value={exportMultiplier}
                    disabled={exportFormat === "gif"}
                    className="h-9 rounded-lg border bg-background px-2"
                    onChange={(event) =>
                      setExportMultiplier(
                        event.currentTarget.value === "2" ? 2 : 1,
                      )
                    }
                  >
                    <option value={1}>1×</option>
                    <option value={2}>2×</option>
                  </select>
                </label>
                {exportFormat === "gif" && (
                  <p className="text-xs text-muted-foreground">
                    GIF 会按对象动画逐帧导出；最长边自动压缩至 1024px，最长
                    10 秒且最多 60 帧；多个动效优先按共同周期完整循环，超过
                    10 秒会截断。缩放动画在原始大小与设定增幅之间线性往返，
                    不改变透明度。
                  </p>
                )}
              </div>
              {exportError && (
                <p role="alert" className="mt-3 text-sm text-destructive">
                  {exportError}
                </p>
              )}
              {onRefreshExportJobs &&
                onCancelExportJob &&
                onRetryExportJob &&
                onDownloadExportJob && (
                  <DesignExportTaskList
                    jobs={exportJobs}
                    loading={exportJobsLoading}
                    error={exportJobsError}
                    busyJobId={exportJobBusyId}
                    onRefresh={onRefreshExportJobs}
                    onCancel={onCancelExportJob}
                    onRetry={onRetryExportJob}
                    onDownload={onDownloadExportJob}
                  />
                )}
              <div className="mt-5 flex justify-end gap-2">
                <Button
                  variant="ghost"
                  disabled={exporting}
                  onClick={() => setExportPrompt(false)}
                >
                  取消
                </Button>
                <Button onClick={() => void runExport()} disabled={exporting}>
                  {exporting ? "导出中…" : "下载"}
                </Button>
              </div>
            </dialog>
          </div>
        )}

        {closePrompt && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center bg-black/20 p-4"
            data-design-subinteraction="true"
          >
            <section
              role="alertdialog"
              aria-modal="true"
              aria-labelledby={`${titleId}-close`}
              className="w-full max-w-sm rounded-xl border bg-background p-4 shadow-float"
            >
              <h2 id={`${titleId}-close`} className="font-medium">
                保存后退出？
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                当前设计还有未保存的修改。
              </p>
              {closeError && (
                <p role="alert" className="mt-2 text-sm text-destructive">
                  {closeError}
                </p>
              )}
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setClosePrompt(false)}>
                  继续编辑
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setClosePrompt(false);
                    onClose();
                  }}
                >
                  放弃修改
                </Button>
                <Button onClick={() => void saveAndClose()} disabled={saving}>
                  {saving ? "保存中…" : closeError ? "重试保存" : "保存并退出"}
                </Button>
              </div>
            </section>
          </div>
        )}
      </dialog>
      {subInteraction}
    </div>,
    document.body,
  );
}

function ToolButton({
  icon,
  label,
  disabled = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={label}
      onClick={onClick}
      className={cn(
        "flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border bg-background text-xs transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45",
      )}
    >
      <span className="[&_svg]:size-5">{icon}</span>
      {label}
    </button>
  );
}
