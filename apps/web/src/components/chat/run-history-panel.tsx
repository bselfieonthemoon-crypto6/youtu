"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronRight, History, X } from "lucide-react";

import {
  ApiAuthError,
  fetchAgentRunDetail,
  fetchSessionRuns,
  type AgentRunDetail as RunDetail,
  type AgentRunStatus as RunStatus,
  type AgentRunSummary as RunSummary,
} from "../../lib/server-api";

type StatusFilter = "all" | RunStatus;

const STATUS_LABEL: Record<RunStatus, string> = {
  accepted: "等待中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  canceled: "已取消",
};

const STATUS_TONE: Record<RunStatus, string> = {
  accepted: "bg-amber-100 text-amber-700",
  running: "bg-blue-100 text-blue-700",
  completed: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
  canceled: "bg-muted text-muted-foreground",
};

const FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "running", label: "进行中" },
  { value: "completed", label: "已完成" },
  { value: "failed", label: "失败" },
  { value: "canceled", label: "已取消" },
];

export function RunHistoryPanel({
  accessToken,
  sessionId,
  onClose,
}: {
  accessToken: string;
  sessionId: string | null;
  onClose: () => void;
}) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadPage = useCallback(
    async (cursor?: string) => {
      if (!sessionId) {
        setRuns([]);
        setNextCursor(null);
        setLoading(false);
        return;
      }
      cursor ? setLoadingMore(true) : setLoading(true);
      setError(null);
      try {
        const page = await fetchSessionRuns(accessToken, sessionId, {
          ...(cursor ? { cursor } : {}),
          limit: 20,
        });
        setRuns((current) => (cursor ? [...current, ...page.runs] : page.runs));
        setNextCursor(page.nextCursor);
      } catch (caught) {
        setError(historyErrorMessage(caught));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [accessToken, sessionId],
  );

  useEffect(() => {
    setFilter("all");
    setSelectedId(null);
    setDetail(null);
    void loadPage();
  }, [loadPage]);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    if (!sessionId) return;
    void fetchAgentRunDetail(accessToken, sessionId, selectedId)
      .then((response) => {
        if (active) setDetail(response);
      })
      .catch((caught) => {
        if (active) setDetailError(historyErrorMessage(caught));
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [accessToken, selectedId, sessionId]);

  const filteredRuns = useMemo(
    () => (filter === "all" ? runs : runs.filter((run) => run.status === filter)),
    [filter, runs],
  );

  return (
    <section
      aria-label="运行历史"
      className="absolute inset-0 z-30 flex flex-col bg-card"
    >
      <div className="flex min-h-12 items-center gap-2 border-b border-border px-3">
        {selectedId ? (
          <button
            type="button"
            aria-label="返回运行历史"
            onClick={() => setSelectedId(null)}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </button>
        ) : (
          <History className="size-4 text-muted-foreground" />
        )}
        <h2 className="flex-1 text-sm font-semibold">
          {selectedId ? "运行详情" : "运行历史"}
        </h2>
        <button
          type="button"
          aria-label="关闭运行历史"
          onClick={onClose}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      {selectedId ? (
        <RunDetailContent
          detail={detail}
          loading={detailLoading}
          error={detailError}
        />
      ) : (
        <>
          <div className="flex gap-1 overflow-x-auto border-b border-border px-3 py-2">
            {FILTERS.map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={filter === item.value}
                onClick={() => setFilter(item.value)}
                className={`shrink-0 rounded-full px-2.5 py-1 text-xs transition-colors ${
                  filter === item.value
                    ? "bg-foreground text-background"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-3">
            {loading ? (
              <StateMessage text="正在加载运行历史…" loading />
            ) : error ? (
              <StateMessage text={error} actionLabel="重试" onAction={() => void loadPage()} />
            ) : runs.length === 0 ? (
              <StateMessage text="当前会话还没有运行记录。" />
            ) : filteredRuns.length === 0 ? (
              <div className="flex min-h-48 flex-col items-center justify-center gap-3">
                <StateMessage text="当前已加载的记录中没有匹配项。可继续加载更早记录。" />
                {nextCursor && (
                  <LoadMoreButton
                    loading={loadingMore}
                    onClick={() => void loadPage(nextCursor)}
                  />
                )}
              </div>
            ) : (
              <div className="space-y-4">
                {groupRuns(filteredRuns).map(([label, group]) => (
                  <div key={label}>
                    <h3 className="mb-1.5 px-1 text-[11px] font-medium text-muted-foreground">
                      {label}
                    </h3>
                    <div className="space-y-1.5">
                      {group.map((run) => (
                        <RunRow key={run.runId} run={run} onOpen={() => setSelectedId(run.runId)} />
                      ))}
                    </div>
                  </div>
                ))}
                {nextCursor && (
                  <LoadMoreButton loading={loadingMore} onClick={() => void loadPage(nextCursor)} />
                )}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function LoadMoreButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={loading}
      onClick={onClick}
      className="w-full rounded-lg border border-border py-2 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
    >
      {loading ? "加载中…" : "加载更多"}
    </button>
  );
}

function RunRow({ run, onOpen }: { run: RunSummary; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-xl border border-border p-3 text-left hover:bg-muted/60"
    >
      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_TONE[run.status]}`}>
        {STATUS_LABEL[run.status]}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          {run.executionMode === "thinking" ? "Thinking" : "Fast"}
          <span className="font-normal text-muted-foreground">· {formatDuration(run.durationMs)}</span>
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
          {run.model ?? "默认模型"} · {formatDateTime(run.startedAt ?? run.createdAt)}
        </span>
        <span className="mt-1 block text-[10px] text-muted-foreground">
          工具 {run.toolCounts.completed}/{run.toolCounts.total}
          {run.toolCounts.failed > 0 ? ` · 失败 ${run.toolCounts.failed}` : ""}
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function RunDetailContent({
  detail,
  loading,
  error,
}: {
  detail: RunDetail | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) return <StateMessage text="正在加载运行详情…" loading />;
  if (error) return <StateMessage text={error} />;
  if (!detail) return <StateMessage text="没有找到这条运行记录。" />;
  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      <div className="rounded-xl border border-border p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{detail.executionMode === "thinking" ? "Thinking" : "Fast"}</span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_TONE[detail.status]}`}>
            {STATUS_LABEL[detail.status]}
          </span>
        </div>
        <dl className="mt-3 grid grid-cols-[64px_1fr] gap-x-2 gap-y-2 text-xs">
          <dt className="text-muted-foreground">模型</dt><dd className="break-all">{detail.model ?? "默认模型"}</dd>
          <dt className="text-muted-foreground">耗时</dt><dd>{formatDuration(detail.durationMs)}</dd>
          <dt className="text-muted-foreground">开始</dt><dd>{formatDateTime(detail.startedAt ?? detail.createdAt)}</dd>
          <dt className="text-muted-foreground">结束</dt><dd>{detail.completedAt ? formatDateTime(detail.completedAt) : "尚未结束"}</dd>
        </dl>
        {detail.error?.message && (
          <p className="mt-3 rounded-lg bg-red-50 p-2 text-xs text-red-700">{detail.error.message}</p>
        )}
      </div>
      <h3 className="mb-2 mt-5 text-xs font-semibold">工具执行（{detail.tools.length}）</h3>
      {detail.tools.length === 0 ? (
        <p className="rounded-lg bg-muted px-3 py-4 text-center text-xs text-muted-foreground">本次运行没有调用工具。</p>
      ) : (
        <div className="space-y-2">
          {detail.tools.map((tool) => (
            <div key={tool.id} className="rounded-lg border border-border px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium">{toolDisplayName(tool.toolName)}</span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${STATUS_TONE[tool.status]}`}>
                  {STATUS_LABEL[tool.status]}
                </span>
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                <span>第 {tool.attempt} 次尝试</span>
                <span>{tool.finishedAt ? formatDuration(new Date(tool.finishedAt).getTime() - new Date(tool.startedAt).getTime()) : "执行中"}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StateMessage({ text, loading = false, actionLabel, onAction }: { text: string; loading?: boolean; actionLabel?: string; onAction?: () => void }) {
  return (
    <div role="status" className="flex h-full min-h-48 flex-col items-center justify-center gap-3 px-6 text-center text-xs text-muted-foreground">
      {loading && <span className="size-5 animate-spin rounded-full border-2 border-border border-t-foreground" />}
      <p>{text}</p>
      {actionLabel && onAction && <button type="button" onClick={onAction} className="rounded-md border border-border px-3 py-1.5 text-foreground hover:bg-muted">{actionLabel}</button>}
    </div>
  );
}

function historyErrorMessage(error: unknown) {
  if (error instanceof ApiAuthError) return "登录状态已失效，请重新登录后查看运行历史。";
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (code === "forbidden" || code === "not_found") return "没有权限查看这条运行记录。";
  return "运行历史加载失败，请稍后重试。";
}

function formatDuration(milliseconds: number | null) {
  if (milliseconds === null) return "进行中";
  if (milliseconds < 1_000) return `${milliseconds} 毫秒`;
  const seconds = Math.round(milliseconds / 100) / 10;
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

function groupRuns(runs: RunSummary[]) {
  const groups = new Map<string, RunSummary[]>();
  for (const run of runs) {
    const label = dayLabel(run.startedAt ?? run.createdAt);
    groups.set(label, [...(groups.get(label) ?? []), run]);
  }
  return [...groups.entries()];
}

function dayLabel(value: string) {
  const date = new Date(value);
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (target === start) return "今天";
  if (target === start - 86_400_000) return "昨天";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(date);
}

function toolDisplayName(name: string) {
  const names: Record<string, string> = {
    generate_image: "生成图片",
    generate_video: "生成视频",
    manipulate_canvas: "操作画布",
    read_canvas: "读取画布",
  };
  return names[name] ?? name;
}
