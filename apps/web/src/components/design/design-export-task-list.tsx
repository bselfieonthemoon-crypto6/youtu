"use client";

import type { BackgroundJob } from "@loomic/shared";
import { Download, RefreshCw, RotateCcw, X } from "lucide-react";

import { Button } from "@/components/ui/button";

export type DesignExportTaskListProps = {
  jobs: readonly BackgroundJob[];
  loading?: boolean | undefined;
  error?: string | null | undefined;
  busyJobId?: string | null | undefined;
  onRefresh: () => void;
  onCancel: (job: BackgroundJob) => void;
  onRetry: (job: BackgroundJob) => void;
  onDownload: (job: BackgroundJob) => void;
};

const TERMINAL_FAILURES = new Set(["failed", "dead_letter", "canceled"]);

export function DesignExportTaskList({
  jobs,
  loading = false,
  error,
  busyJobId,
  onRefresh,
  onCancel,
  onRetry,
  onDownload,
}: DesignExportTaskListProps) {
  return (
    <section className="mt-5 border-t pt-4" aria-label="后台导出任务">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">后台导出任务</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            超过浏览器安全像素预算的导出会在服务器继续处理。
          </p>
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="刷新导出任务"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw className={loading ? "animate-spin" : undefined} />
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="mt-3 grid max-h-56 gap-2 overflow-y-auto">
        {jobs.length === 0 && !loading && (
          <p className="rounded-lg bg-muted/50 px-3 py-4 text-center text-xs text-muted-foreground">
            暂无后台导出任务
          </p>
        )}
        {jobs.map((job) => {
          const busy = busyJobId === job.id;
          const result = readExportResult(job);
          const payload = readExportPayload(job);
          return (
            <article key={job.id} className="rounded-lg border p-3 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{formatExportLabel(payload)}</p>
                  <p className="mt-1 text-muted-foreground" aria-live="polite">
                    {formatJobStatus(job)}
                  </p>
                  {job.error_message && (
                    <p role="alert" className="mt-1 text-destructive">
                      {job.error_message}
                    </p>
                  )}
                  {result && (
                    <p className="mt-1 text-muted-foreground">
                      {result.width} × {result.height} ·{" "}
                      {formatBytes(result.byteSize)}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {job.status === "succeeded" && result && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onDownload(job)}
                    >
                      <Download />
                      下载
                    </Button>
                  )}
                  {(job.status === "queued" || job.status === "running") && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onCancel(job)}
                    >
                      <X />
                      取消
                    </Button>
                  )}
                  {TERMINAL_FAILURES.has(job.status) && payload && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onRetry(job)}
                    >
                      <RotateCcw />
                      重试
                    </Button>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function readExportPayload(job: BackgroundJob) {
  const value = job.payload;
  const format = value.format;
  const multiplier = value.multiplier;
  const revision = value.revision;
  const transparent = value.transparent;
  if (
    (format !== "png" && format !== "jpeg") ||
    (multiplier !== 1 && multiplier !== 2) ||
    typeof revision !== "number" ||
    !Number.isInteger(revision) ||
    revision < 0 ||
    typeof transparent !== "boolean"
  ) {
    return null;
  }
  return { format, multiplier, revision, transparent } as const;
}

export function readExportResult(job: BackgroundJob) {
  const value = job.result;
  if (!value) return null;
  const assetObjectId = value.asset_object_id;
  const width = value.width;
  const height = value.height;
  const byteSize = value.byte_size;
  if (
    typeof assetObjectId !== "string" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    typeof byteSize !== "number"
  ) {
    return null;
  }
  return { assetObjectId, width, height, byteSize };
}

function formatExportLabel(payload: ReturnType<typeof readExportPayload>) {
  if (!payload) return "设计导出";
  const format = payload.transparent
    ? "透明 PNG"
    : payload.format.toUpperCase();
  return `${format} · ${payload.multiplier}× · 版本 ${payload.revision}`;
}

function formatJobStatus(job: BackgroundJob) {
  if (job.status === "queued") return "等待服务器处理";
  if (job.status === "running") {
    return `正在处理 · 尝试 ${Math.max(1, job.attempt_count)}/${job.max_attempts}`;
  }
  if (job.status === "succeeded") return "导出完成";
  if (job.status === "canceled") return "已取消";
  if (job.status === "dead_letter") return "多次重试后仍然失败";
  return "导出失败";
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
