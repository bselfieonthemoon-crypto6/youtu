"use client";

import { useState } from "react";
import type { BackgroundJob, DesignObject } from "@loomic/shared";
import {
  BoxSelect,
  Eraser,
  Layers3,
  RefreshCw,
  Scissors,
  Sparkles,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { LayerBackendOption } from "../canvas/layer-backend-option";
import { ImageActionDialog, type SemanticLayerSplitRequest } from "../canvas/image-action-dialog";

export type DesignImageOperation =
  | "remove_background"
  | "region_matting"
  | "split_layers"
  | "erase_transparent"
  | "smart_erase";

const OPERATION_LABELS: Record<DesignImageOperation, string> = {
  remove_background: "去除背景",
  region_matting: "框选主体",
  split_layers: "图层拆分",
  erase_transparent: "透明擦除",
  smart_erase: "智能擦除",
};

export function DesignImageTools({
  selectedImage,
  jobs,
  loading = false,
  error,
  busyJobId,
  onRun,
  onRunDedicatedLayers,
  onRunSemanticLayers,
  accessToken,
  onStartRegion,
  onStartErase,
  onRefresh,
  onCancel,
}: {
  selectedImage: Extract<DesignObject, { type: "image" }> | null;
  jobs: readonly BackgroundJob[];
  loading?: boolean;
  error?: string | null;
  busyJobId?: string | null;
  onRun: (operation: "remove_background" | "split_layers") => void;
  onRunDedicatedLayers?: () => void;
  onRunSemanticLayers?: (request: SemanticLayerSplitRequest) => void;
  accessToken?: string;
  onStartRegion: () => void;
  onStartErase: () => void;
  onRefresh: () => void;
  onCancel: (job: BackgroundJob) => void;
}) {
  const [semanticSplitOpen, setSemanticSplitOpen] = useState(false);
  const disabled = !selectedImage;
  return (
    <section className="border-l border-b p-3" aria-label="图片智能工具">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium">图片工具</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {selectedImage ? "结果将替换当前图片并保留排版" : "请选择一张图片"}
          </p>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="刷新图片任务"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <ToolButton
          icon={<Scissors />}
          label="去除背景"
          disabled={disabled}
          onClick={() => onRun("remove_background")}
        />
        <ToolButton
          icon={<BoxSelect />}
          label="框选主体"
          disabled={disabled}
          onClick={onStartRegion}
        />
        <ToolButton
          icon={<Eraser />}
          label="橡皮擦除"
          disabled={disabled}
          onClick={onStartErase}
        />
        <ToolButton
          icon={<Layers3 />}
          label="图层拆分"
          disabled={disabled}
          onClick={() => setSemanticSplitOpen(true)}
        />
        <ToolButton icon={<Layers3 />} label="本地拆分" disabled={disabled} onClick={() => onRun("split_layers")} />
      </div>
      {accessToken && onRunDedicatedLayers && <div className="mt-2"><LayerBackendOption accessToken={accessToken} disabled={disabled} onRun={onRunDedicatedLayers} /></div>}
      {semanticSplitOpen && selectedImage && (
        <ImageActionDialog
          action="split-layers"
          image={{ id: selectedImage.objectId, fileId: selectedImage.assetObjectId, x: 0, y: 0, width: selectedImage.width, height: selectedImage.height, mimeType: "image/*", title: "当前图片" }}
          screenBounds={{ x: 16, y: 80, width: 0, height: 0 }}
          {...(accessToken !== undefined ? { accessToken } : {})}
          onOpenChange={(open) => setSemanticSplitOpen(open)}
          onConfirm={(_prompt, _quality, request) => { setSemanticSplitOpen(false); if (request) onRunSemanticLayers?.(request); }}
        />
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {jobs.length > 0 && (
        <div className="mt-3 grid gap-2" aria-label="图片处理任务">
          {jobs.map((job) => {
            const operation = readOperation(job);
            const active = job.status === "queued" || job.status === "running";
            const finalizationError = readFinalizationError(job);
            return (
              <article key={job.id} className="rounded-lg border p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">
                    {operation ? OPERATION_LABELS[operation] : "图片处理"}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {statusLabel(job)}
                  </span>
                </div>
                {(job.error_message || finalizationError) && (
                  <p className="mt-1 text-destructive">
                    {job.error_message || finalizationError}
                  </p>
                )}
                {active && (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                      <div className="h-full w-1/2 animate-pulse rounded-full bg-primary" />
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label={`取消${operation ? OPERATION_LABELS[operation] : "图片处理"}`}
                      disabled={busyJobId === job.id}
                      onClick={() => onCancel(job)}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ToolButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="justify-start gap-1.5"
      disabled={disabled}
      onClick={onClick}
    >
      <span className="[&>svg]:size-3.5">{icon}</span>
      {label}
    </Button>
  );
}

function readOperation(job: BackgroundJob): DesignImageOperation | null {
  const value = job.payload.operation;
  return typeof value === "string" && value in OPERATION_LABELS
    ? (value as DesignImageOperation)
    : null;
}

function statusLabel(job: BackgroundJob) {
  if (job.status === "queued") return "等待中";
  if (job.status === "running")
    return `处理中 · ${job.attempt_count}/${job.max_attempts}`;
  if (job.status === "succeeded") {
    const finalization = job.result?.target_finalization;
    if (
      finalization &&
      typeof finalization === "object" &&
      "status" in finalization
    ) {
      if (finalization.status === "completed") return "已写入设计";
      if (finalization.status === "needs_attention") return "需要处理冲突";
      return "正在写入设计";
    }
    return "处理完成";
  }
  if (job.status === "canceled") return "已取消";
  if (job.status === "dead_letter") return "重试已耗尽";
  return "失败";
}

function readFinalizationError(job: BackgroundJob) {
  const value = job.result?.target_finalization;
  if (!value || typeof value !== "object") return null;
  if (!("error_message" in value) || typeof value.error_message !== "string")
    return null;
  return value.error_message;
}
