"use client";

import type {
  AdminChannelDetailResponse,
  AdminChannelFailureRatesResponse,
  AdminChannelView,
  AdminWorkspaceDirectoryEntry,
} from "@loomic/shared";
import { ADMIN_CHANNEL_TEST_STATUS_FILTERS } from "@loomic/shared";
import { useCallback, useEffect, useState } from "react";

import {
  fetchAdminChannelDetail,
  fetchAdminChannelFailureRates,
  fetchAdminChannels,
  fetchAdminWorkspaces,
} from "../../lib/server-api";
import { formatJobTimestamp } from "./admin-jobs-section";

/**
 * Channel health across workspaces.
 *
 * Two numbers sit side by side on purpose, because they answer different questions:
 * the provider rate counts only jobs that reached a channel, and the overall rate
 * counts every job in the window. Showing only the first would hide failure classes
 * that never touch a channel (a stale design preview, for example); showing only the
 * second would blame channels for them. The per-code table reports how many channels
 * each code touched, and "无渠道记录" is a real answer, not a missing value.
 *
 * Nothing on this page writes: a platform admin can inspect another workspace's
 * channel, but repointing that workspace's traffic stays out of the console.
 */

const TEST_STATUS_LABELS: Record<string, string> = {
  never: "未自检", succeeded: "自检成功", failed: "自检失败",
};
const AUDIT_ACTION_LABELS: Record<string, string> = {
  created: "新建渠道", updated: "修改配置", key_rotated: "轮换密钥", deleted: "删除渠道",
  test_succeeded: "自检成功", test_failed: "自检失败",
};
const WINDOW_OPTIONS = [
  { value: "7", label: "最近 7 天" },
  { value: "30", label: "最近 30 天" },
  { value: "90", label: "最近 90 天" },
  { value: "365", label: "最近 365 天" },
];

export const providerTestStatusLabel = (status: string) => TEST_STATUS_LABELS[status] ?? status;
export const providerAuditActionLabel = (action: string) => AUDIT_ACTION_LABELS[action] ?? action;

export function formatFailureRate(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

/** `0` channels means the failure never reached a channel, which is information. */
export function formatChannelCoverage(count: number): string {
  return count > 0 ? `${count} 个渠道` : "无渠道记录";
}

export function AdminChannelsSection({ accessToken }: { accessToken: string }) {
  const [channels, setChannels] = useState<AdminChannelView[]>([]);
  const [total, setTotal] = useState(0);
  const [windowDays, setWindowDays] = useState(30);
  const [totalJobs, setTotalJobs] = useState(0);
  const [totalFailures, setTotalFailures] = useState(0);
  const [rates, setRates] = useState<AdminChannelFailureRatesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<AdminWorkspaceDirectoryEntry[]>([]);

  const [workspaceId, setWorkspaceId] = useState("");
  const [query, setQuery] = useState("");
  const [enabled, setEnabled] = useState("");
  const [testStatus, setTestStatus] = useState("");
  const [days, setDays] = useState("30");
  const [applied, setApplied] = useState({ workspaceId: "", query: "", enabled: "", testStatus: "", days: "30" });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminChannelDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // A detail failure must not blank the table the operator is reading, or the
  // failure-rate panel that explains it.
  const [detailError, setDetailError] = useState<string | null>(null);

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
    const window = Number(applied.days);
    const windowOption = Number.isFinite(window) && window > 0 ? { days: window } : {};
    try {
      const [directory, failureRates] = await Promise.all([
        fetchAdminChannels(accessToken, {
          ...(applied.workspaceId ? { workspaceId: applied.workspaceId } : {}),
          ...(applied.query.trim() ? { query: applied.query.trim() } : {}),
          ...(applied.enabled === "" ? {} : { enabled: applied.enabled === "true" }),
          ...(applied.testStatus ? { testStatus: applied.testStatus } : {}),
          ...windowOption,
          limit: 100,
        }),
        fetchAdminChannelFailureRates(accessToken, { ...windowOption, limit: 20 }),
      ]);
      setChannels(directory.channels);
      setTotal(directory.total);
      setWindowDays(directory.windowDays);
      setTotalJobs(directory.totalJobs);
      setTotalFailures(directory.totalFailures);
      setRates(failureRates);
      setSelectedId(current => (current && directory.channels.some(channel => channel.id === current) ? current : null));
    } catch (caught) {
      setChannels([]);
      setTotal(0);
      setRates(null);
      setError(caught instanceof Error ? caught.message : "渠道列表加载失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, [accessToken, applied]);

  useEffect(() => void load(), [load]);

  const loadDetail = useCallback(async (configId: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const window = Number(applied.days);
      setDetail(await fetchAdminChannelDetail(accessToken, configId, {
        ...(Number.isFinite(window) && window > 0 ? { days: window } : {}),
        historyLimit: 20,
        jobLimit: 10,
      }));
    } catch (caught) {
      setDetail(null);
      setDetailError(caught instanceof Error ? caught.message : "渠道详情加载失败，请稍后重试。");
    } finally {
      setDetailLoading(false);
    }
  }, [accessToken, applied.days]);

  return (
    <div className="space-y-5" data-testid="admin-channels">
      <section className="rounded-lg border border-border bg-card p-5">
        <div>
          <h2 className="text-base font-semibold">渠道健康</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            跨工作区查看第三方渠道：连接自检结果、配置变更记录、按错误码的失败率。
            失败归属用服务端记录的 <span className="font-mono">provider_execution_snapshots</span>（真正跑过该任务的渠道），
            而不是任务里的模型名字符串。本页只读。
          </p>
        </div>
        <form className="mt-4 flex flex-wrap items-end gap-2"
          onSubmit={event => { event.preventDefault(); setApplied({ workspaceId, query, enabled, testStatus, days }); }}>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">工作区
            <select value={workspaceId} aria-label="渠道工作区" onChange={event => setWorkspaceId(event.target.value)}
              className="w-56 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground">
              <option value="">全部</option>
              {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">关键词
            <input value={query} onChange={event => setQuery(event.target.value)} aria-label="渠道关键词"
              placeholder="渠道名 / 地址 / 工作区"
              className="w-56 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">启用状态
            <select value={enabled} aria-label="渠道启用状态" onChange={event => setEnabled(event.target.value)}
              className="w-28 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground">
              <option value="">全部</option>
              <option value="true">已启用</option>
              <option value="false">已停用</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">自检状态
            <select value={testStatus} aria-label="渠道自检状态" onChange={event => setTestStatus(event.target.value)}
              className="w-32 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground">
              <option value="">全部</option>
              {ADMIN_CHANNEL_TEST_STATUS_FILTERS.map(value => (
                <option key={value} value={value}>{providerTestStatusLabel(value)}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">统计窗口
            <select value={days} aria-label="渠道统计窗口" onChange={event => setDays(event.target.value)}
              className="w-32 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground">
              {WINDOW_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-sm">查询</button>
          <button type="button" onClick={() => void load()} className="rounded-md border border-border px-3 py-1.5 text-sm">刷新</button>
        </form>
      </section>

      {loading ? (
        <p className="text-sm text-muted-foreground">正在加载渠道…</p>
      ) : error ? (
        <div>
          <p className="text-sm text-destructive">{error}</p>
          <button type="button" onClick={() => void load()}
            className="mt-4 inline-flex rounded-md border border-border px-3 py-1.5 text-sm">重试</button>
        </div>
      ) : (
        <>
          {rates ? (
            <section className="rounded-lg border border-border bg-card p-5" data-testid="admin-channel-rates">
              <h3 className="text-sm font-medium">失败率（最近 {rates.windowDays} 天）</h3>
              <div className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                <div>
                  <span className="text-muted-foreground">渠道可归属失败率</span>
                  <p className="text-lg tabular-nums" data-testid="admin-channel-provider-rate">
                    {formatFailureRate(rates.providerFailureRate)}
                  </p>
                  <p className="text-muted-foreground">{rates.providerFailures}/{rates.providerJobs} 条到过渠道</p>
                </div>
                <div>
                  <span className="text-muted-foreground">全部任务失败率</span>
                  <p className="text-lg tabular-nums">{formatFailureRate(rates.overallFailureRate)}</p>
                  <p className="text-muted-foreground">{rates.totalFailures}/{rates.totalJobs} 条（含无渠道记录）</p>
                </div>
                <div>
                  <span className="text-muted-foreground">无渠道记录的失败</span>
                  <p className="text-lg tabular-nums">{rates.totalFailures - rates.providerFailures}</p>
                  <p className="text-muted-foreground">多为画板预览过期等非上游失败</p>
                </div>
                <div>
                  <span className="text-muted-foreground">窗口内活跃渠道</span>
                  <p className="text-lg tabular-nums">{rates.channelCount}</p>
                  <p className="text-muted-foreground">至少跑过一个任务的渠道</p>
                </div>
              </div>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm" data-testid="admin-channel-rate-table">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">错误码</th>
                      <th className="px-3 py-2 text-right">失败总数</th>
                      <th className="px-3 py-2 text-right">失败</th>
                      <th className="px-3 py-2 text-right">死信</th>
                      <th className="px-3 py-2 text-right">占比</th>
                      <th className="px-3 py-2">涉及渠道</th>
                      <th className="px-3 py-2">最近一次</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rates.errorCodes.length === 0 ? (
                      <tr><td colSpan={7} className="px-3 py-6 text-center text-sm text-muted-foreground">
                        该窗口内没有失败记录。
                      </td></tr>
                    ) : rates.errorCodes.map(row => (
                      <tr key={row.errorCode} className="border-t border-border">
                        <td className="px-3 py-2 font-mono text-xs">{row.errorCode}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.failures}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.failed}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.deadLetter}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatFailureRate(row.share)}</td>
                        <td className="px-3 py-2 text-xs">{formatChannelCoverage(row.channelCount)}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
                          {formatJobTimestamp(row.lastSeenAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <section className="rounded-lg border border-border bg-card p-5">
            <p className="text-xs text-muted-foreground">
              共 {total} 个渠道，最近 {windowDays} 天窗口内 {totalJobs} 条任务、{totalFailures} 条失败。
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm" data-testid="admin-channel-table">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">工作区</th>
                    <th className="px-3 py-2">渠道</th>
                    <th className="px-3 py-2">地址</th>
                    <th className="px-3 py-2">状态</th>
                    <th className="px-3 py-2 text-right">模型</th>
                    <th className="px-3 py-2">自检</th>
                    <th className="px-3 py-2 text-right">任务</th>
                    <th className="px-3 py-2 text-right">失败率</th>
                    <th className="px-3 py-2 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {channels.length === 0 ? (
                    <tr><td colSpan={9} className="px-3 py-6 text-center text-sm text-muted-foreground">
                      没有匹配的渠道。可以清空筛选条件或换一个工作区。
                    </td></tr>
                  ) : channels.map(channel => (
                    <tr key={channel.id} className={`border-t border-border align-top ${channel.id === selectedId ? "bg-muted/50" : ""}`}>
                      <td className="px-3 py-2">{channel.workspaceName ?? "—"}</td>
                      <td className="px-3 py-2">
                        <div>{channel.displayName}</div>
                        <div className="text-xs text-muted-foreground">
                          {channel.adapter} · 密钥 ****{channel.apiKeyLastFour ?? "----"} · v{channel.revision}
                        </div>
                      </td>
                      <td className="px-3 py-2 max-w-[16rem] truncate font-mono text-xs" title={channel.baseUrl}>
                        {channel.baseUrl}
                      </td>
                      <td className="px-3 py-2">
                        {channel.enabled
                          ? <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-600">已启用</span>
                          : <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">已停用</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {channel.enabledModelCount}/{channel.modelCount}
                        <div className="text-xs text-muted-foreground">{channel.modalities.join("、") || "—"}</div>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <div data-testid="admin-channel-test-status">
                          {providerTestStatusLabel(channel.lastTestStatus)}
                          {channel.lastTestErrorCode ? <span className="ml-1 font-mono">{channel.lastTestErrorCode}</span> : null}
                        </div>
                        <div className="text-muted-foreground">{formatJobTimestamp(channel.lastTestedAt)}</div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {channel.jobs}
                        <div className="text-xs text-muted-foreground">失败 {channel.failures}</div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatFailureRate(channel.failureRate)}</td>
                      <td className="px-3 py-2 text-right">
                        <button type="button" onClick={() => { setSelectedId(channel.id); void loadDetail(channel.id); }}
                          className="rounded-md border border-border px-3 py-1 text-xs">详情</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {selectedId ? (
        <section className="rounded-lg border border-border bg-card p-5" data-testid="admin-channel-detail">
          {detailLoading ? (
            <p className="text-sm text-muted-foreground">正在加载渠道详情…</p>
          ) : detailError ? (
            <p className="text-sm text-destructive" data-testid="admin-channel-detail-error">{detailError}</p>
          ) : detail ? (
            <>
              <div>
                <h3 className="text-sm font-medium">渠道 {detail.channel.displayName}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {detail.channel.workspaceName ?? "未知工作区"} · {detail.channel.adapter} ·{" "}
                  {detail.channel.enabled ? "已启用" : "已停用"} · 最近 {detail.channel.windowDays} 天{" "}
                  {detail.channel.jobs} 条任务、失败 {detail.channel.failures} 条（
                  {formatFailureRate(detail.channel.failureRate)}）
                </p>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                <div><span className="text-muted-foreground">地址</span>
                  <p className="break-all font-mono">{detail.channel.baseUrl}</p></div>
                <div><span className="text-muted-foreground">密钥尾号</span>
                  <p className="font-mono">****{detail.channel.apiKeyLastFour ?? "----"}</p></div>
                <div><span className="text-muted-foreground">最后一次自检</span>
                  <p>{providerTestStatusLabel(detail.channel.lastTestStatus)}{" "}
                    {detail.channel.lastTestErrorCode ?? ""}</p>
                  <p className="text-muted-foreground">{formatJobTimestamp(detail.channel.lastTestedAt)}</p></div>
                <div><span className="text-muted-foreground">配置版本</span>
                  <p>v{detail.channel.revision}</p>
                  <p className="text-muted-foreground">{formatJobTimestamp(detail.channel.updatedAt)}</p></div>
                <div><span className="text-muted-foreground">创建</span>
                  <p>{detail.channel.createdByEmail ?? "—"}</p>
                  <p className="text-muted-foreground">{formatJobTimestamp(detail.channel.createdAt)}</p></div>
                <div><span className="text-muted-foreground">最后修改</span>
                  <p>{detail.channel.updatedByEmail ?? "—"}</p></div>
                <div><span className="text-muted-foreground">模型</span>
                  <p>{detail.channel.enabledModelCount}/{detail.channel.modelCount} 启用</p>
                  <p className="text-muted-foreground">{detail.channel.modalities.join("、") || "—"}</p></div>
                <div><span className="text-muted-foreground">最近失败</span>
                  <p>{formatJobTimestamp(detail.channel.lastFailureAt)}</p></div>
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div>
                  <h4 className="text-xs font-medium">自检与配置记录</h4>
                  {detail.history.length === 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">该渠道还没有任何记录。</p>
                  ) : (
                    <ul className="mt-2 space-y-1 text-xs" data-testid="admin-channel-history">
                      {detail.history.map((entry, index) => (
                        <li key={`${entry.action}-${index}`} className="border-t border-border pt-1">
                          {providerAuditActionLabel(entry.action)} · {formatJobTimestamp(entry.createdAt)} ·{" "}
                          {entry.actorEmail ?? "系统"}
                          {entry.errorCode ? <div className="font-mono text-muted-foreground">{entry.errorCode}</div> : null}
                        </li>
                      ))}
                    </ul>
                  )}

                  <h4 className="mt-4 text-xs font-medium">窗口内错误码分布</h4>
                  {detail.errorCodes.length === 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">该窗口内这个渠道没有失败。</p>
                  ) : (
                    <ul className="mt-2 space-y-1 text-xs" data-testid="admin-channel-errors">
                      {detail.errorCodes.map(row => (
                        <li key={row.errorCode} className="flex justify-between gap-3 border-t border-border pt-1">
                          <span className="font-mono">{row.errorCode}</span>
                          <span className="tabular-nums">
                            {row.failures}（失败 {row.failed} / 死信 {row.deadLetter}）
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div>
                  <h4 className="text-xs font-medium">最近的失败任务</h4>
                  {detail.failures.length === 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">没有可归属到该渠道的失败任务。</p>
                  ) : (
                    <ul className="mt-2 space-y-1 text-xs" data-testid="admin-channel-failures">
                      {detail.failures.map(job => (
                        <li key={job.jobId} className="border-t border-border pt-1">
                          <div className="font-mono">{job.errorCode ?? "—"}</div>
                          <div className="text-muted-foreground">
                            {job.jobType} · {job.status} · {formatJobTimestamp(job.createdAt)}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
