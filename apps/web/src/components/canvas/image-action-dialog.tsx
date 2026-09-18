"use client";

import { useEffect, useState } from "react";
import { resolveNativeImageSize } from "@loomic/shared";
import { fetchSemanticLayerQuote, type SemanticLayerQuote } from "../../lib/layer-backend";
import type { ImageToolbarActionId, SelectedCanvasImage } from "./image-toolbar-types";

const ACTION_TITLES: Partial<Record<ImageToolbarActionId, string>> = {
  regenerate: "重新生成",
  upscale: "高清增强",
  "split-layers": "AI 图层拆分",
};

export type SemanticLayerSplitRequest = {
  layerNames: string[];
  repairBackground: true;
  model: string;
};

const DEFAULT_LAYER_NAMES: string[] = [];

export function calculate2KResolution(image: SelectedCanvasImage): {
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
} {
  const sourceWidth = Math.max(
    1,
    Math.round(image.originalWidth && image.originalWidth > 0 ? image.originalWidth : image.width),
  );
  const sourceHeight = Math.max(
    1,
    Math.round(image.originalHeight && image.originalHeight > 0 ? image.originalHeight : image.height),
  );
  const target = resolveNativeImageSize(`${sourceWidth}:${sourceHeight}`, "2k");
  return {
    sourceWidth,
    sourceHeight,
    targetWidth: target.width,
    targetHeight: target.height,
  };
}

export function buildImageActionPrompt(
  action: ImageToolbarActionId,
  values: Record<string, string>,
  image?: SelectedCanvasImage,
): string {
  const extra = values.notes?.trim();
  switch (action) {
    case "regenerate":
      return `以参考图片为基础重新生成一个新版本，保留核心主体和品牌识别，同时提升视觉完成度。${extra ? `修改要求：${extra}` : "在构图和细节上提供有意义的新变化。"} 保留原图，仅输出新的图片版本。`;
    case "upscale": {
      const resolutionInstruction = `请保持原始宽高比，以 ${values.quality === "ultra" ? "4K" : "2K"} 分辨率档位增强图片，不改变比例`;
      return `${resolutionInstruction}。严格保持构图、文字拼写、Logo 形状、颜色和主体不变，只增强边缘、纹理和细节，避免新增元素。${extra ? `补充要求：${extra}` : ""} 仅输出高清增强后的完整图片。`;
    }
    case "split-layers": {
      const layerNames = values.layerNames
        ?.split("\n")
        .map((name) => name.trim())
        .filter(Boolean) ?? [];
      return `将原图拆分为修补后的完整底图，以及以下独立透明元素：${layerNames.join("、")}。保持原始构图和元素位置，分别生成每个元素；生成式拆分可能让局部纹理或细节略有变化。`;
    }
    default:
      return "";
  }
}

export function ImageActionDialog({ action, image, screenBounds, onOpenChange, onConfirm, accessToken }: {
  action: ImageToolbarActionId | null;
  image: SelectedCanvasImage;
  screenBounds: { x: number; y: number; width: number; height: number; viewportWidth?: number };
  onOpenChange: (open: boolean) => void;
  onConfirm: (prompt: string, quality?: "hd" | "ultra", layerSplit?: SemanticLayerSplitRequest) => void;
  accessToken?: string;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<SemanticLayerQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  useEffect(() => setValues(action === "split-layers" ? { layerNames: DEFAULT_LAYER_NAMES.join("\n") } : {}), [action]);
  const requestedLayerNames = (values.layerNames ?? "").split("\n").map((name) => name.trim()).filter(Boolean);
  const uniqueRequestedLayerNames = [...new Set(requestedLayerNames)];
  const layerNamesValid = uniqueRequestedLayerNames.length >= 2 && uniqueRequestedLayerNames.length <= 4 && uniqueRequestedLayerNames.length === requestedLayerNames.length;
  useEffect(() => {
    if (action !== "split-layers" || !layerNamesValid || !accessToken) { setQuote(null); setQuoteError(action === "split-layers" && !accessToken ? "请登录后读取本次拆分报价。" : null); return; }
    let canceled = false;
    setQuote(null); setQuoteError(null);
    void fetchSemanticLayerQuote(accessToken, uniqueRequestedLayerNames.length).then((next) => { if (!canceled) setQuote(next); }).catch((error) => { if (!canceled) setQuoteError(error instanceof Error ? error.message : "无法读取本次拆分报价。"); });
    return () => { canceled = true; };
  }, [action, accessToken, layerNamesValid, uniqueRequestedLayerNames.length]);
  if (!action || !ACTION_TITLES[action]) return null;
  const set = (key: string, value: string) => setValues((current) => ({ ...current, [key]: value }));
  const viewportWidth = Math.min(
    typeof window === "undefined" ? 1024 : window.innerWidth,
    screenBounds.viewportWidth ?? Number.POSITIVE_INFINITY,
  );
  const windowHeight = typeof window === "undefined" ? 768 : window.innerHeight;
  const panelWidth = Math.min(272, viewportWidth - 24);
  const fitsRight = screenBounds.x + screenBounds.width + panelWidth + 28 <= viewportWidth;
  const left = fitsRight
    ? screenBounds.x + screenBounds.width + 16
    : Math.max(12, screenBounds.x - panelWidth - 16);
  const panelHeight = action === "upscale" ? 190 : action === "split-layers" ? 344 : 218;
  const top = Math.max(12, Math.min(windowHeight - panelHeight, screenBounds.y));

  if (action === "regenerate") {
    return (
      <div
        data-image-action-popover="regenerate"
        className="fixed z-[101] rounded-2xl border border-border bg-background p-3 shadow-xl"
        style={{ left, top, width: panelWidth }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h3 className="text-sm font-semibold">重新生成</h3>
        <p className="mt-1 truncate text-[11px] text-muted-foreground">{image.title ?? image.id}</p>
        <textarea
          aria-label="补充要求（可选）"
          value={values.notes ?? ""}
          onChange={(event) => set("notes", event.target.value)}
          placeholder="描述希望保留或调整的细节"
          className="mt-2 min-h-16 w-full resize-none rounded-lg border border-border bg-background px-2.5 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={() => onOpenChange(false)} className="rounded-lg border border-border px-3 py-1.5 text-xs">取消</button>
          <button type="button" onClick={() => onConfirm(buildImageActionPrompt(action, values, image))} className="rounded-lg bg-foreground px-3 py-1.5 text-xs text-background">生成</button>
        </div>
      </div>
    );
  }
  if (action === "split-layers") {
    const layerNames = requestedLayerNames;
    const uniqueLayerNames = uniqueRequestedLayerNames;
    const valid = layerNamesValid;
    return (
      <div
        data-image-action-popover="split-layers"
        className="fixed z-[101] rounded-2xl border border-border bg-background p-3 shadow-xl"
        style={{ left, top, width: panelWidth }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h3 className="text-sm font-semibold">AI 图层拆分</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">分别生成透明元素，并补全一张底图。每行填写一个互不重复的视觉元素，共 2–4 个；子元素和包含它的整体请分清命名。</p>
        <textarea
          aria-label="要拆分的元素名称"
          value={values.layerNames ?? ""}
          onChange={(event) => set("layerNames", event.target.value)}
          placeholder="例如：人物\n窗边花瓶"
          className="mt-2 min-h-20 w-full resize-none rounded-lg border border-border bg-background px-2.5 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
        {!valid && <p role="alert" className="mt-1 text-[11px] text-destructive">请填写 2–4 个互不重复的视觉元素名称。</p>}
        <p className="mt-2 text-xs">补全底图（必选）</p>
        <p className="mt-2 text-[11px] leading-4 text-muted-foreground">将生成 {uniqueLayerNames.length || 0} 张透明元素图和 1 张底图。{quote ? `本次使用 ${quote.displayName}，Low / 1K，共 ${quote.layerCount + 1} 张、${quote.calls} 次图片调用，预计 ${quote.credits} credits。` : "正在读取本次模型与费用。"}生成式结果的局部细节可能略有变化。</p>
        {quoteError && <p role="alert" className="mt-1 text-[11px] text-destructive">{quoteError}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={() => onOpenChange(false)} className="rounded-lg border border-border px-3 py-1.5 text-xs">取消</button>
          <button type="button" disabled={!valid || !quote} onClick={() => onConfirm(buildImageActionPrompt(action, { layerNames: uniqueLayerNames.join("\n") }, image), undefined, { layerNames: uniqueLayerNames, repairBackground: true, model: quote!.model })} className="rounded-lg bg-foreground px-3 py-1.5 text-xs text-background disabled:cursor-not-allowed disabled:opacity-50">开始拆分</button>
        </div>
      </div>
    );
  }
  const upscaleQuality = values.quality === "ultra" ? "ultra" : "hd";
  let targetSize: string | undefined;
  try {
    targetSize = resolveNativeImageSize(`${image.originalWidth || image.width}:${image.originalHeight || image.height}`, upscaleQuality === "ultra" ? "4k" : "2k").size.replace("x", " × ");
  } catch { /* The provider validates unsupported ratios; do not invent a preview. */ }
  return (
    <div
      data-image-action-popover="upscale"
      className="fixed z-[100] rounded-2xl border border-border bg-background p-3 shadow-xl"
      style={{ left, top, width: panelWidth }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <h3 className="text-sm font-semibold">高清增强</h3>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        保持原图比例，提升分辨率。画质参数默认 Low。
      </p>
      <label className="mt-2 block text-xs">分辨率
        <select aria-label="高清分辨率" value={upscaleQuality} onChange={event => set("quality", event.target.value)} className="ml-2 rounded border border-border bg-background p-1">
          <option value="hd">2K</option>
          <option value="ultra">4K（按比例适配）</option>
        </select>
      </label>
      <p className="mt-1 text-[11px] text-muted-foreground">{targetSize ? `目标 ${targetSize}；最终以实际出图为准。` : "该比例需确认渠道尺寸支持。"}</p>
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={() => onOpenChange(false)} className="flex-1 rounded-lg border border-border px-3 py-1.5 text-xs">取消</button>
        <button type="button" onClick={() => onConfirm(buildImageActionPrompt(action, values, image), upscaleQuality)} className="flex-1 rounded-lg bg-foreground px-3 py-1.5 text-xs text-background">确认高清</button>
      </div>
    </div>
  );
}
