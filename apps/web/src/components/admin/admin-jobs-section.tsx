"use client";

import type { AdminJobDetailResponse, AdminJobRow, AdminWorkspaceDirectoryEntry } from "@loomic/shared";
import { ADMIN_JOB_STATUS_FILTERS, ADMIN_JOB_TYPE_FILTERS } from "@loomic/shared";
import { useCallback, useEffect, useState } from "react";

import {
  acknowledgeAdminJob,
  cancelAdminJob,
  fetchAdminJobDetail,
  fetchAdminJobs,
  fetchAdminWorkspaces,
} from "../../lib/server-api";

/**
 * Job inspection and disposition.
 *
 * The list answers "what is failing, where, and since when"; opening a job shows
 * its attempts, provider error, ledger rows and every admin action taken on it.
 * Two facts the panel is careful about:
 *   * `stuck` is computed from the job's own age, so a queued job from last night
 *     is visible without a separate health feed;
 *   * "已处置" is derived from the audit trail, and cancelling only stops the job —
 *     it does not refund or replay anything.
 */

const STATUS_LABELS: Record<string, string> = {
  queued: "排队", running: "执行中", succeeded: "成功", failed: "失败", canceled: "已取消", dead_letter: "死信",
};
const TYPE_LABELS: Record<string, string> = {
  image_generation: "图片生成", video_generation: "视频生成", code_execution: "代码执行",
  design_preview: "画板预览", design_export: "画板导出", design_resource_import: "设计资源导入",
};
const ACTION_LABELS: Record<string, string> = {
  "job.cancel": "取消任务", "job.failure.acknowledge": "标记已处置", "platform_admin.bootstrap": "初始化管理员",
};

export const adminJobStatusLabel = (status: string) => STATUS_LABELS[status] ?? status;
export const adminJobTypeLabel = (type: string) => TYPE_LABELS[type] ?? type;
export const adminJobActionLabel = (action: string) => ACTION_LABELS[action] ?? action;

export function formatJobAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)} 小时`;
  return `${(seconds / 86_400).toFixed(1)} 天`;
}

export function formatJobTimestamp(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(parsed);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")} ${read("hour")}:${read("minute")}:${read("second")}`;
}

const isTerminal = (status: string) => ["succeeded", "failed", "dead_letter", "canceled"].includes(status);
const isCancelable = (status: string) => ["queued", "running"].includes(status);

export function AdminJobsSection({ accessToken }: { accessToken: string }) {
  const [jobs, setJobs] = useState<AdminJobRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<AdminWorkspaceDirectoryEntry[]>([]);

  const [status, setStatus] = useState("");
  const [jobType, setJobType] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [sinceHours, setSinceHours] = useState("24");
  const [applied, setApplied] = useState({ status: "", jobType: "", workspaceId: "", errorCode: "", sinceHours: "24" });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminJobDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pending, setPending] = useState<{ jobId: string; kind: "cancel" | "acknowledge" } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await fetchAdminWorkspaces(accessToken, { limit: 100 });
        if (!cancelled) setWorkspaces(result.workspaces);
      } catch {
        if (!cancelled) setWorkspaces([]);
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken]);

  const load = useCallback(async () => {
    if (!accessToken) {
      setLoading(false);
      setError("无法获取登录凭据，请重新登录后再试。");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const hours = Number(applied.sinceHours);
      const result = await fetchAdminJobs(accessToken, {
        ...(applied.status ? { status: applied.status } : {}),
        ...(applied.jobType ? { jobType: applied.jobType } : {}),
        ...(applied.workspaceId ? { workspaceId: applied.workspaceId } : {}),
        ...(applied.errorCode.trim() ? { errorCode: applied.errorCode.trim() } : {}),
        ...(Number.isFinite(hours) && hours > 0 ? { sinceHours: hours } : {}),
        limit: 50,
      });
      setJobs(result.jobs);
      setTotal(result.total);
      setSelectedId(current => (current && result.jobs.some(job => job.id === current) ? current : null));
    } catch (caught) {
      setJobs([]);
      setTotal(0);
      setError(caught instanceof Error ? caught.message : "任务列表加载失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, [accessToken, applied]);

  useEffect(() => void load(), [load]);

  const loadDetail = useCallback(async (jobId: string) => {
    setDetailLoading(true);
    try {
      setDetail(await fetchAdminJobDetail(accessToken, jobId));
    } catch (caught) {
      setDetail(null);
      setFeedback(caught instanceof Error ? caught.message : "任务详情加载失败，请稍后重试。");
    } finally {
      setDetailLoading(false);
    }
  }, [accessToken]);

  async function runPending() {
    if (!pending) return;
    setFeedback(null);
    setBusy(true);
    try {
      if (pending.kind === "cancel") {
        await cancelAdminJob(accessToken, pending.jobId, reason);
        setFeedback("已取消该任务（只停止任务本身；退款与画布/卡片结算沿用既有流程），操作已记入审计。");
      } else {
        await acknowledgeAdminJob(accessToken, pending.jobId, reason);
        setFeedback("已标记为人工处置，操作已记入审计。");
      }
      setPending(null);
      setReason("");
      await load();
      if (selectedId === pending.jobId) await loadDetail(pending.jobId);
    } catch (caught) {
      setFeedback(caught instanceof Error ? caught.message : "操作失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  const selected = jobs.find(job => job.id === selectedId) ?? null;

  return (
    <div className="space-y-5" data-testid="admin-jobs">
      <section className="rounded-lg border border-border bg-card p-5">
        <div>
          <h2 className="text-base font-semibold">任务</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            按状态/类型/工作区/错误码/时间筛选任务，打开单个任务查看尝试次数、上游错误、额度流水与管理操作记录。
            「卡住」按任务自身时长判断（排队超 30 分钟、执行超 15 分钟）。取消只停止任务，退款与结算沿用既有流程；
            <strong>不提供重放</strong>（会真实调用上游并可能计费）。
          </p>
        </div>
        <form className="mt-4 flex flex-wrap items-end gap-2"
          onSubmit={event => { event.preventDefault(); setApplied({ status, jobType, workspaceId, errorCode, sinceHours }); }}>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">状态
            <select value={status} aria-label="任务状态" onChange={event => setStatus(event.target.value)}
              className="w-28 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground">
              <option value="">全部</option>
              {ADMIN_JOB_STATUS_FILTERS.map(value => <option key={value} value={value}>{adminJobStatusLabel(value)}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">类型
            <select value={jobType} aria-label="任务类型" onChange={event => setJobType(event.target.value)}
              className="w-32 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground">
              <option value="">全部</option>
              {ADMIN_JOB_TYPE_FILTERS.map(value => <option key={value} value={value}>{adminJobTypeLabel(value)}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">工作区
            <select value={workspaceId} aria-label="任务工作区" onChange={event => setWorkspaceId(event.target.value)}
              className="w-56 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground">
              <option value="">全部</option>
              {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">错误码
            <input value={errorCode} onChange={event => setErrorCode(event.target.value)} aria-label="错误码"
              placeholder="例如 provider_rate_limited"
              className="w-56 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">时间范围
            <select value={sinceHours} aria-label="时间范围" onChange={event => setSinceHours(event.target.value)}
              className="w-28 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground">
              <option value="1">最近 1 小时</option>
              <option value="24">最近 24 小时</option>
              <option value="168">最近 7 天</option>
              <option value="720">最近 30 天</option>
            </select>
          </label>
          <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-sm">查询</button>
          <button type="button" onClick={() => void load()} className="rounded-md border border-border px-3 py-1.5 text-sm">刷新</button>
        </form>
        {feedback ? <p className="mt-3 text-sm text-muted-foreground" data-testid="admin-jobs-feedback">{feedback}</p> : null}
      </section>

      {loading ? (
        <p className="text-sm text-muted-foreground">正在加载任务…</p>
      ) : error ? (
        <div>
          <p className="text-sm text-destructive">{error}</p>
          <button type="button" onClick={() => void load()}
            className="mt-4 inline-flex rounded-md border border-border px-3 py-1.5 text-sm">重试</button>
        </div>
      ) : (
        <section className="rounded-lg border border-border bg-card p-5">
          <p className="text-xs text-muted-foreground">共 {total} 条匹配，当前显示前 {jobs.length} 条。</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm" data-testid="admin-job-table">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">时间</th>
                  <th className="px-3 py-2">工作区</th>
                  <th className="px-3 py-2">类型</th>
                  <th className="px-3 py-2">状态</th>
                  <th className="px-3 py-2">错误码</th>
                  <th className="px-3 py-2 text-right">尝试</th>
                  <th className="px-3 py-2">处置</th>
                  <th className="px-3 py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {jobs.length === 0 ? (
                  <tr><td colSpan={8} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    没有匹配的任务。可以放宽时间范围或清空筛选条件。
                  </td></tr>
                ) : jobs.map(job => (
                  <tr key={job.id} className={`border-t border-border align-top ${job.id === selectedId ? "bg-muted/50" : ""}`}>
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{formatJobTimestamp(job.createdAt)}</td>
                    <td className="px-3 py-2">{job.workspaceName ?? "—"}</td>
                    <td className="px-3 py-2">{adminJobTypeLabel(job.jobType)}</td>
                    <td className="px-3 py-2">
                      {adminJobStatusLabel(job.status)}
                      {job.stuck ? <span className="ml-2 rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive"
                        data-testid="admin-job-stuck">卡住 {formatJobAge(job.ageSeconds)}</span> : null}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {job.errorCode ?? "—"}
                      {job.creditsCost ? <div className="text-muted-foreground">额度 {job.creditsCost}</div> : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{job.attemptCount}/{job.maxAttempts}</td>
                    <td className="px-3 py-2 text-xs">
                      {job.acknowledgedAt
                        ? <span className="text-muted-foreground">已处置 · {formatJobTimestamp(job.acknowledgedAt)}</span>
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button type="button" onClick={() => { setSelectedId(job.id); setPending(null); void loadDetail(job.id); }}
                        className="rounded-md border border-border px-3 py-1 text-xs">详情</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {selectedId ? (
        <section className="rounded-lg border border-border bg-card p-5" data-testid="admin-job-detail">
          {detailLoading ? (
            <p className="text-sm text-muted-foreground">正在加载任务详情…</p>
          ) : detail ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-medium">任务 {detail.job.id}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {detail.job.workspaceName ?? "未知工作区"} · {adminJobTypeLabel(detail.job.jobType)} ·{" "}
                    {adminJobStatusLabel(detail.job.status)} · 提交人 {detail.job.createdByEmail ?? "—"}
                  </p>
                </div>
                <div className="flex gap-2">
                  {isCancelable(detail.job.status) ? (
                    pending?.jobId === detail.job.id && pending.kind === "cancel" ? (
                      <div className="flex flex-col items-end gap-2">
                        <input value={reason} onChange={event => setReason(event.target.value)} aria-label="取消任务原因"
                          placeholder="取消原因（至少 2 个字符）"
                          className="w-64 rounded-md border border-border bg-background px-2 py-1 text-sm" />
                        <div className="flex gap-2">
                          <button type="button" disabled={busy || reason.trim().length < 2} onClick={() => void runPending()}
                            className="rounded-md bg-destructive px-3 py-1 text-xs text-white disabled:opacity-50">确认取消</button>
                          <button type="button" onClick={() => { setPending(null); setReason(""); }}
                            className="rounded-md border border-border px-3 py-1 text-xs">放弃</button>
                        </div>
                      </div>
                    ) : (
                      <button type="button" onClick={() => { setPending({ jobId: detail.job.id, kind: "cancel" }); setReason(""); setFeedback(null); }}
                        className="rounded-md border border-border px-3 py-1 text-xs">取消任务</button>
                    )
                  ) : null}
                  {isTerminal(detail.job.status) ? (
                    pending?.jobId === detail.job.id && pending.kind === "acknowledge" ? (
                      <div className="flex flex-col items-end gap-2">
                        <input value={reason} onChange={event => setReason(event.target.value)} aria-label="处置说明"
                          placeholder="处置说明（至少 2 个字符）"
                          className="w-64 rounded-md border border-border bg-background px-2 py-1 text-sm" />
                        <div className="flex gap-2">
                          <button type="button" disabled={busy || reason.trim().length < 2} onClick={() => void runPending()}
                            className="rounded-md bg-foreground px-3 py-1 text-xs text-background disabled:opacity-50">确认标记</button>
                          <button type="button" onClick={() => { setPending(null); setReason(""); }}
                            className="rounded-md border border-border px-3 py-1 text-xs">放弃</button>
                        </div>
                      </div>
                    ) : (
                      <button type="button" onClick={() => { setPending({ jobId: detail.job.id, kind: "acknowledge" }); setReason(""); setFeedback(null); }}
                        className="rounded-md border border-border px-3 py-1 text-xs">标记已处置</button>
                    )
                  ) : null}
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                <div><span className="text-muted-foreground">尝试次数</span><p>{detail.job.attemptCount}/{detail.job.maxAttempts}</p></div>
                <div><span className="text-muted-foreground">创建 → 开始</span>
                  <p>{formatJobTimestamp(detail.job.createdAt)} → {formatJobTimestamp(detail.job.startedAt)}</p></div>
                <div><span className="text-muted-foreground">结束</span>
                  <p>{formatJobTimestamp(detail.job.completedAt ?? detail.job.failedAt ?? detail.job.canceledAt)}</p></div>
                <div><span className="text-muted-foreground">额度</span><p>{detail.job.creditsCost ?? "—"}</p></div>
                <div><span className="text-muted-foreground">会话</span>
                  <p>{detail.job.sessionTitle ?? detail.job.sessionId ?? "—"}</p></div>
                <div><span className="text-muted-foreground">画布</span><p>{detail.job.canvasId ?? "—"}</p></div>
                <div><span className="text-muted-foreground">错误码</span><p className="font-mono">{detail.job.errorCode ?? "—"}</p></div>
                <div><span className="text-muted-foreground">处置</span>
                  <p>{detail.job.acknowledgedAt ? `已处置 · ${formatJobTimestamp(detail.job.acknowledgedAt)}` : "—"}</p></div>
              </div>

              {detail.job.errorMessage ? (
                <p className="mt-3 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground" data-testid="admin-job-error">
                  上游原文：{detail.job.errorMessage}
                </p>
              ) : null}

              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div>
                  <h4 className="text-xs font-medium">额度流水</h4>
                  {detail.transactions.length === 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">该任务没有额度流水（本地副本单笔多为 0 额度）。</p>
                  ) : (
                    <ul className="mt-2 space-y-1 text-xs">
                      {detail.transactions.map(transaction => (
                        <li key={transaction.id} className="flex justify-between gap-3 border-t border-border pt-1">
                          <span>{transaction.transactionType} · {transaction.description ?? "—"}</span>
                          <span className="tabular-nums">{transaction.amount} → {transaction.balanceAfter}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <h4 className="mt-4 text-xs font-medium">管理操作记录</h4>
                  {detail.audit.length === 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">还没有针对该任务的管理操作。</p>
                  ) : (
                    <ul className="mt-2 space-y-1 text-xs" data-testid="admin-job-audit">
                      {detail.audit.map((entry, index) => (
                        <li key={`${entry.action}-${index}`} className="border-t border-border pt-1">
                          {adminJobActionLabel(entry.action)} · {formatJobTimestamp(entry.createdAt)} · {entry.actorEmail ?? "系统"}
                          {entry.reason ? <div className="text-muted-foreground">{entry.reason}</div> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <h4 className="text-xs font-medium">请求预览</h4>
                  <pre className="mt-2 max-h-40 overflow-auto rounded border border-border p-2 text-[11px] whitespace-pre-wrap break-words">{detail.job.payloadPreview ?? "（无）"}</pre>
                  <h4 className="mt-4 text-xs font-medium">结果预览</h4>
                  <pre className="mt-2 max-h-40 overflow-auto rounded border border-border p-2 text-[11px] whitespace-pre-wrap break-words">{detail.job.resultPreview ?? "（无）"}</pre>
                </div>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">任务详情不可用。</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
