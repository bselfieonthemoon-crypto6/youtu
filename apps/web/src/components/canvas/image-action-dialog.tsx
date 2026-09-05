"use client";

import { useEffect, useState } from "react";
import type { ImageToolbarActionId, SelectedCanvasImage } from "./image-toolbar-types";

const ACTION_TITLES: Partial<Record<ImageToolbarActionId, string>> = {
  regenerate: "重新生成",
  upscale: "高清增强",
};

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
  const scale = 2048 / Math.max(sourceWidth, sourceHeight);
  // GPT Image 2 custom dimensions must be multiples of 16.
  const toValidPixel = (value: number) => Math.max(16, Math.round(value / 16) * 16);
  return {
    sourceWidth,
    sourceHeight,
    targetWidth: toValidPixel(sourceWidth * scale),
    targetHeight: toValidPixel(sourceHeight * scale),
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
      const resolution = image ? calculate2KResolution(image) : null;
      const resolutionInstruction = resolution
        ? `当前图片实际分辨率为 ${resolution.sourceWidth}×${resolution.sourceHeight}px，请保持原始宽高比，将输出分辨率提升至 ${resolution.targetWidth}×${resolution.targetHeight}px（2K，长边 2048px）`
        : "请保持原始宽高比，将输出分辨率提升至 2K（长边 2048px）";
      return `${resolutionInstruction}。严格保持构图、文字拼写、Logo 形状、颜色和主体不变，只增强边缘、纹理和细节，避免新增元素。${extra ? `补充要求：${extra}` : ""} 仅输出高清增强后的完整图片。`;
    }
    default:
      return "";
  }
}

export function ImageActionDialog({ action, image, screenBounds, onOpenChange, onConfirm }: {
  action: ImageToolbarActionId | null;
  image: SelectedCanvasImage;
  screenBounds: { x: number; y: number; width: number; height: number; viewportWidth?: number };
  onOpenChange: (open: boolean) => void;
  onConfirm: (prompt: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => setValues({}), [action]);
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
  const panelHeight = action === "upscale" ? 150 : 218;
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
  const upscaleResolution = calculate2KResolution(image);
  return (
    <div
      data-image-action-popover="upscale"
      className="fixed z-[100] rounded-2xl border border-border bg-background p-3 shadow-xl"
      style={{ left, top, width: panelWidth }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <h3 className="text-sm font-semibold">高清增强</h3>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        是否将图片从 {upscaleResolution.sourceWidth} × {upscaleResolution.sourceHeight}px
        {" 提升为 "}{upscaleResolution.targetWidth} × {upscaleResolution.targetHeight}px（2K）？
      </p>
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={() => onOpenChange(false)} className="flex-1 rounded-lg border border-border px-3 py-1.5 text-xs">取消</button>
        <button type="button" onClick={() => onConfirm(buildImageActionPrompt(action, {}, image))} className="flex-1 rounded-lg bg-foreground px-3 py-1.5 text-xs text-background">确认高清</button>
      </div>
    </div>
  );
}
