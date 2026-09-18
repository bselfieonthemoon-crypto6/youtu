"use client";

import { BookOpen, ImageUp, Lock, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useGenerationErrorHandler } from "../../hooks/use-generation-error-handler";
import {
  getImageGeneratorData,
  type ImageGeneratorData,
  resizeImageGeneratorElement,
  updateImageGeneratorElement,
} from "../../lib/canvas-image-generator";
import {
  NodeImageSubmissionError,
  acceptNodeImageRequest,
  nodeImageSubmissionFailure,
  prepareNodeImageRequest,
  submitDurableNodeImage,
} from "../../lib/node-image-generation";
import { composeLibraryPrompt } from "../../lib/prompt-library-api";
import { PromptLibraryDialog } from "../prompt-library/prompt-library-dialog";
import type { ImageModelInfo } from "../../lib/server-api";
import {
  fetchImageModels,
  submitNodeImageGeneration,
} from "../../lib/server-api";

type ImageGeneratorPanelProps = {
  elementId: string;
  canvasId: string;
  elementBounds: { x: number; y: number; width: number; height: number };
  data: ImageGeneratorData;
  excalidrawApi: any;
  accessToken: string;
  canvasScrollZoom: { scrollX: number; scrollY: number; zoom: number };
  onPersistCanvas: () => Promise<void>;
  onClose: () => void;
};

const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;
const QUALITIES = [
  { value: "standard", label: "1K" },
  { value: "hd", label: "2K" },
  { value: "ultra", label: "4K" },
] as const;

function generateId(): string {
  return (
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  ).slice(0, 20);
}

export function ImageGeneratorPanel({
  elementId,
  canvasId,
  elementBounds,
  data,
  excalidrawApi,
  accessToken,
  canvasScrollZoom,
  onPersistCanvas,
}: ImageGeneratorPanelProps) {
  const [prompt, setPrompt] = useState(data.prompt);
  const [model, setModel] = useState(data.model);
  const [aspectRatio, setAspectRatio] = useState(data.aspectRatio);
  const [quality, setQuality] = useState(data.quality);
  const [loading, setLoading] = useState(
    data.status === "generating" && Boolean(data.jobId),
  );
  const [error, setError] = useState<string | null>(data.errorMessage ?? null);
  const [models, setModels] = useState<ImageModelInfo[]>([]);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showRatioDropdown, setShowRatioDropdown] = useState(false);
  const [showQualityDropdown, setShowQualityDropdown] = useState(false);
  const [showPromptLibrary, setShowPromptLibrary] = useState(false);
  const [refImages, setRefImages] = useState<
    Array<{ id: string; dataUrl: string; file: File }>
  >([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const refInputRef = useRef<HTMLInputElement>(null);
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;
  const { handleGenerationError } = useGenerationErrorHandler();
  const mountedRef = useRef(true);

  // Scene data is authoritative: selection, reload and canvas undo must restore
  // the node's own prompt. Never write from this effect (that would undo undo).
  useEffect(() => { setPrompt(data.prompt); }, [data.prompt, elementId]);
  useEffect(() => { setModel(data.model); }, [data.model, elementId]);
  useEffect(() => { setAspectRatio(data.aspectRatio); }, [data.aspectRatio, elementId]);
  useEffect(() => { setQuality(data.quality); }, [data.quality, elementId]);

  const changePrompt = useCallback((value: string) => {
    setPrompt(value);
    updateImageGeneratorElement(excalidrawApi, elementId, { prompt: value });
  }, [excalidrawApi, elementId]);

  // Fetch available models with error logging
  useEffect(() => {
    let cancelled = false;
    fetchImageModels(accessTokenRef.current)
      .then((r) => {
        if (cancelled) return;
        setModels(r.models);
        // Read at response time: the user may have changed models while this
        // request was pending. React can replay setState updater functions
        // during render, so canvas writes must never live inside an updater.
        const node = excalidrawApi.getSceneElements().find((element: any) =>
          element.id === elementId && !element.isDeleted &&
          element.customData?.type === "image-generator",
        );
        if (!node) return;
        const current = node.customData.model;
        // Once a paid submission identity exists, its model is frozen. Catalog
        // refreshes must not rewrite the request that an unknown retry replays.
        if (node.customData.nodeImageRequest) {
          setModel(current);
          return;
        }
        if (r.models.length === 0 || r.models.some((m) => m.id === current)) {
          setModel(current);
          return;
        }
        const fallback = r.models[0];
        if (!fallback) return;
        setModel(fallback.id);
        updateImageGeneratorElement(excalidrawApi, elementId, {
          model: fallback.id,
        });
      })
      .catch((err) => {
        console.warn("[image-gen] Failed to fetch models:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [excalidrawApi, elementId]);

  // Close dropdowns when clicking outside the panel
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
        setShowRatioDropdown(false);
        setShowQualityDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setLoading(data.status === "generating");
    setError(data.errorMessage ?? null);
  }, [data.errorMessage, data.status, elementId]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }, [prompt]);

  // Calculate panel screen position from canvas coordinates
  const { scrollX, scrollY, zoom } = canvasScrollZoom;
  const screenX = (elementBounds.x + scrollX) * zoom;
  const screenY = (elementBounds.y + elementBounds.height + scrollY) * zoom + 8;

  const currentModel = models.find((m) => m.id === model);
  const currentModelLabel = currentModel?.displayName
    ?? (model.startsWith("workspace:") ? "当前模型" : model.split("/").pop());
  const submissionLocked =
    loading || data.nodeImageRequest?.state === "unknown";

  const handleAspectRatioChange = useCallback(
    (ratio: string) => {
      setAspectRatio(ratio);
      setShowRatioDropdown(false);
      resizeImageGeneratorElement(excalidrawApi, elementId, ratio);
      updateImageGeneratorElement(excalidrawApi, elementId, {
        aspectRatio: ratio,
      });
    },
    [excalidrawApi, elementId],
  );

  const handleQualityChange = useCallback(
    (q: string) => {
      setQuality(q);
      setShowQualityDropdown(false);
      updateImageGeneratorElement(excalidrawApi, elementId, { quality: q });
    },
    [excalidrawApi, elementId],
  );

  const handleModelChange = useCallback(
    (m: string) => {
      setModel(m);
      setShowModelDropdown(false);
      updateImageGeneratorElement(excalidrawApi, elementId, { model: m });
    },
    [excalidrawApi, elementId],
  );

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim() || loading) return;
    // This node endpoint is intentionally text-only. Never silently charge for
    // a text-only result when the user attached references.
    if (refImages.length > 0 || (data.inputImages?.length ?? 0) > 0) {
      setError("当前节点暂不支持参考图生成，请使用图片改图入口；或移除参考图后仅用文字生成。");
      return;
    }

    const liveElement = excalidrawApi
      .getSceneElements()
      .find((element: any) => element.id === elementId && !element.isDeleted);
    const liveData = getImageGeneratorData(liveElement);
    if (!liveData || (liveData.status === "generating" && liveData.jobId)) return;
    const request = prepareNodeImageRequest(liveData);

    setLoading(true);
    setError(null);
    updateImageGeneratorElement(excalidrawApi, elementId, {
      status: "generating",
      // A terminal job belongs to the previous attempt. Keeping it here would
      // make read-only recovery skip this new request if its response is lost.
      jobId: undefined,
      prompt: request.prompt,
      model: request.model,
      aspectRatio: request.aspectRatio,
      // The saved control is a resolution tier; request.quality is independent.
      quality: liveData.quality,
      nodeImageRequest: request,
      errorMessage: undefined,
    });

    try {
      const response = await submitDurableNodeImage({
        accessToken: accessTokenRef.current,
        canvasId,
        elementId,
        request,
        persistCanvas: onPersistCanvas,
        submit: submitNodeImageGeneration,
      });
      updateImageGeneratorElement(excalidrawApi, elementId, {
        status: "generating",
        jobId: response.job.id,
        nodeImageRequest: acceptNodeImageRequest(request, response.job.payload),
        errorMessage: undefined,
      });
      // The server also binds the job atomically. This second save keeps the
      // current browser scene from later overwriting that binding.
      await onPersistCanvas().catch((error) => {
        console.warn("[image-gen] Failed to persist accepted job binding:", error);
      });
    } catch (err) {
      console.error("[image-gen] Generation error:", err);
      const cause = err instanceof NodeImageSubmissionError ? err.cause : err;
      const handled = handleGenerationError(cause);
      const failure = nodeImageSubmissionFailure(err, liveData.nodeImageRequest?.state === "unknown");
      const message = failure.message;
      if (!handled) {
        if (mountedRef.current) setError(message);
      }
      if (mountedRef.current) setLoading(false);
      updateImageGeneratorElement(excalidrawApi, elementId, {
        status: "error",
        nodeImageRequest: { ...request, state: failure.state },
        errorMessage: message,
      });
    }
  }, [
    prompt,
    loading,
    excalidrawApi,
    elementId,
    canvasId,
    onPersistCanvas,
    handleGenerationError,
    refImages.length,
    data.inputImages,
  ]);

  return createPortal(
    <div
      ref={panelRef}
      role="region"
      aria-label="生图节点设置"
      data-element-id={elementId}
      style={{ left: screenX, top: screenY }}
      className="fixed z-[100] w-[450px] rounded-xl border-[0.5px] border-border bg-card/95 p-2 shadow-card backdrop-blur-lg"
      onKeyDown={(e) => e.stopPropagation()}
      onKeyUp={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {/* Prompt textarea */}
      <textarea
        ref={textareaRef}
        value={prompt}
        aria-label="图片生成提示词"
        onChange={(e) => changePrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void handleGenerate();
          }
        }}
        placeholder="今天我们要创作什么"
        disabled={submissionLocked}
        style={{ scrollbarWidth: "none" }}
        className="min-h-[74px] max-h-[140px] w-full resize-none border-none bg-transparent p-1 text-[14px] leading-[18px] text-foreground placeholder:text-muted-foreground focus:outline-none [&::-webkit-scrollbar]:hidden"
      />

      {error && (
        <div role="alert" className="mb-2 rounded-lg bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {error}
        </div>
      )}

      {(data.inputImages?.length ?? 0) > 0 && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-muted px-2 py-1.5 text-xs text-muted-foreground">
          <span>已保存 {data.inputImages!.length} 张参考图，请使用图片改图入口</span>
          <button type="button" aria-label="移除已保存参考图" disabled={submissionLocked}
            className="shrink-0 text-foreground hover:underline"
            onClick={() => { updateImageGeneratorElement(excalidrawApi, elementId, { inputImages: [] }); setError(null); }}>
            移除参考图
          </button>
        </div>
      )}

      {/* Bottom toolbar */}
      <div className="mt-1 flex items-center justify-between">
        {/* Left: model + ref image */}
        <div className="flex min-w-0 items-center">
          {/* Model selector */}
          <div className="relative min-w-0 max-w-[160px]">
            <button
              type="button"
              aria-label="选择生图模型"
              title={model}
              disabled={submissionLocked}
              onClick={() => setShowModelDropdown((v) => !v)}
              className="flex h-8 min-w-0 max-w-full items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted"
            >
              {currentModel?.iconUrl && (
                <img
                  src={currentModel.iconUrl}
                  alt=""
                  className="h-3.5 w-3.5 shrink-0 rounded-full"
                />
              )}
              <span className="min-w-0 truncate text-foreground">
                {currentModelLabel}
              </span>
              <svg
                className="h-3 w-3 shrink-0 text-muted-foreground"
                viewBox="0 0 12 24"
                fill="currentColor"
              >
                <path d="M8.546 10.33a.4.4 0 0 1 .566 0l.424.424a.4.4 0 0 1 0 .566l-3.041 3.041a.7.7 0 0 1-.99 0l-3.04-3.04a.4.4 0 0 1 0-.567l.423-.424a.4.4 0 0 1 .567 0L6 12.876z" />
              </svg>
            </button>
            {showModelDropdown && (
              <div className="absolute bottom-full left-0 z-50 mb-1 max-h-[280px] w-[260px] overflow-y-auto rounded-xl border-[0.5px] border-border bg-card py-1 shadow-card">
                {models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => handleModelChange(m.id)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted ${m.id === model ? "bg-muted" : ""} ${m.accessible === false ? "opacity-60" : ""}`}
                  >
                    {m.iconUrl && (
                      <img
                        src={m.iconUrl}
                        alt=""
                        className="h-3.5 w-3.5 rounded-full"
                      />
                    )}
                    <span className="flex-1 text-foreground">
                      {m.displayName}
                      {m.accessible === false && (
                        <Lock className="ml-1 inline h-2.5 w-2.5 text-muted-foreground" />
                      )}
                    </span>
                    {typeof m.creditCost === "number" && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] tabular-nums text-muted-foreground">
                        <Zap className="h-2.5 w-2.5" />
                        {m.creditCost}
                      </span>
                    )}
                    {m.id === model && (
                      <svg
                        className="h-3 w-3 text-foreground"
                        viewBox="0 0 14 14"
                        fill="currentColor"
                      >
                        <path
                          fillRule="evenodd"
                          d="M12.08 3.087a.583.583 0 0 1 0 .825L5.661 10.33a.583.583 0 0 1-.824 0L1.92 7.412a.583.583 0 0 1 .825-.825L5.25 9.092l6.004-6.005a.583.583 0 0 1 .825 0"
                          clipRule="evenodd"
                        />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Reference image upload */}
          <input
            ref={refInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = e.target.files;
              if (!files) return;
              Array.from(files).forEach((file) => {
                const reader = new FileReader();
                reader.onload = () => {
                  setRefImages((prev) => [
                    ...prev,
                    {
                      id: generateId(),
                      dataUrl: reader.result as string,
                      file,
                    },
                  ]);
                };
                reader.readAsDataURL(file);
              });
              e.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={submissionLocked}
            onClick={() => refInputRef.current?.click()}
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-muted ${
              refImages.length > 0
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title="添加参考图（当前节点尚不支持参考图生成）"
            aria-label="添加参考图"
          >
            <ImageUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={submissionLocked || data.status === "generating"}
            onClick={() => {
              setShowModelDropdown(false);
              setShowRatioDropdown(false);
              setShowQualityDropdown(false);
              setShowPromptLibrary(true);
            }}
            aria-label="打开提示词库"
            aria-haspopup="dialog"
            title="提示词库"
            className="flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          ><BookOpen className="h-3.5 w-3.5" /><span>提示词</span></button>
          {/* Ref image thumbnails */}
          {refImages.length > 0 && (
            <div className="flex items-center gap-1 ml-1">
              {refImages.map((img) => (
                <div key={img.id} className="relative group">
                  <img
                    src={img.dataUrl}
                    alt="ref"
                    className="h-7 w-7 rounded object-cover border border-border"
                  />
                  <button
                    type="button"
                    aria-label="移除参考图"
                    disabled={submissionLocked}
                    onClick={() =>
                      setRefImages((prev) =>
                        prev.filter((r) => r.id !== img.id),
                      )
                    }
                    className="absolute -top-1 -right-1 hidden group-hover:flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground text-[8px]"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right: quality + ratio + generate */}
        <div className="flex shrink-0 items-center gap-1">
          {/* Quality (1K/2K/4K) */}
          <div className="relative">
            <button
              type="button"
              disabled={submissionLocked}
              onClick={() => setShowQualityDropdown((v) => !v)}
              className="flex h-8 items-center gap-0.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted"
            >
              <span className="text-foreground">
                {QUALITIES.find((q) => q.value === quality)?.label ?? "2K"}
              </span>
              <svg
                className="h-3 w-3 text-muted-foreground"
                viewBox="0 0 12 24"
                fill="currentColor"
              >
                <path d="M8.546 10.33a.4.4 0 0 1 .566 0l.424.424a.4.4 0 0 1 0 .566l-3.041 3.041a.7.7 0 0 1-.99 0l-3.04-3.04a.4.4 0 0 1 0-.567l.423-.424a.4.4 0 0 1 .567 0L6 12.876z" />
              </svg>
            </button>
            {showQualityDropdown && (
              <div className="absolute bottom-full right-0 z-50 mb-1 rounded-lg border-[0.5px] border-border bg-card py-1 shadow-card">
                {QUALITIES.map((q) => (
                  <button
                    key={q.value}
                    type="button"
                    onClick={() => handleQualityChange(q.value)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-muted ${q.value === quality ? "bg-muted text-foreground" : "text-muted-foreground"}`}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Aspect ratio */}
          <div className="relative">
            <button
              type="button"
              disabled={submissionLocked}
              onClick={() => setShowRatioDropdown((v) => !v)}
              className="flex h-8 items-center gap-0.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted"
            >
              <span className="text-foreground">{aspectRatio}</span>
              <svg
                className="h-3 w-3 text-muted-foreground"
                viewBox="0 0 12 24"
                fill="currentColor"
              >
                <path d="M8.546 10.33a.4.4 0 0 1 .566 0l.424.424a.4.4 0 0 1 0 .566l-3.041 3.041a.7.7 0 0 1-.99 0l-3.04-3.04a.4.4 0 0 1 0-.567l.423-.424a.4.4 0 0 1 .567 0L6 12.876z" />
              </svg>
            </button>
            {showRatioDropdown && (
              <div className="absolute bottom-full right-0 z-50 mb-1 rounded-lg border-[0.5px] border-border bg-card py-1 shadow-card">
                {ASPECT_RATIOS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => handleAspectRatioChange(r)}
                    className={`flex w-full items-center px-3 py-1.5 text-xs transition-colors hover:bg-muted ${r === aspectRatio ? "bg-muted text-foreground" : "text-muted-foreground"}`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Generate button */}
          <button
            type="button"
            aria-label="生成图片"
            onClick={() => void handleGenerate()}
            aria-description={data.nodeImageRequest?.state === "unknown" ? "沿用上次请求编号和参数，不会创建重复任务" : undefined}
            disabled={!prompt.trim() || loading}
            className="flex h-8 min-w-12 items-center justify-center gap-1 rounded-full bg-primary p-2 text-primary-foreground transition-colors hover:bg-primary/80 hover:accent-glow disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
          >
            {loading ? (
              <div className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-white/30 border-t-white" />
            ) : data.nodeImageRequest?.state === "unknown" ? (
              <span className="px-1 text-xs">重试</span>
            ) : (
              <svg
                className="h-3.5 w-[9.3px] shrink-0"
                viewBox="0 0 8 10"
                fill="currentColor"
              >
                <path d="M6.9 4.36H5.385V.76c0-.84-.447-1.01-.991-.38L4 .835.677 4.685c-.457.525-.265.955.422.955h1.517v3.6c0 .84.446 1.01.991.38L4 9.165l3.323-3.85c.456-.525.265-.955-.422-.955" />
              </svg>
            )}
          </button>
        </div>
      </div>
      {showPromptLibrary && <PromptLibraryDialog
        accessToken={accessToken}
        currentPrompt={prompt}
        disabled={loading || data.status === "generating"}
        onClose={() => setShowPromptLibrary(false)}
        onApply={(entry, mode) => {
          // Read the latest scene text so external edits/undo while the library
          // is open cannot be overwritten by an old React render's draft.
          const node = excalidrawApi.getSceneElements().find((element: any) => element.id === elementId && !element.isDeleted);
          if (!node || node.customData?.type !== "image-generator" || node.customData.status === "generating") return;
          changePrompt(composeLibraryPrompt(node.customData.prompt ?? "", entry.prompt, mode));
          setShowPromptLibrary(false);
          textareaRef.current?.focus();
        }}
      />}
    </div>,
    document.body,
  );
}
