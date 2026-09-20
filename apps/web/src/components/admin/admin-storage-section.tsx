"use client";

import type {
  AdminAssetOverviewResponse,
  AdminAssetQueueResponse,
  AdminAssetRow,
  AdminAssetOrphanRow,
  AdminWorkspaceDirectoryEntry,
} from "@loomic/shared";
import { ADMIN_ASSET_QUEUE_KINDS } from "@loomic/shared";
import { useCallback, useEffect, useState } from "react";

import {
  fetchAdminAssetLargeObjects,
  fetchAdminAssetOrphans,
  fetchAdminAssetQueue,
  fetchAdminStorageOverview,
  fetchAdminWorkspaces,
  purgeAdminOrphanAsset,
} from "../../lib/server-api";
import { formatJobTimestamp } from "./admin-jobs-section";

/**
 * Storage health.
 *
 * The one thing this page must not do is pretend the orphan list is authoritative.
 * Deciding whether an asset is still referenced needs `loomic_asset_has_live_references`,
 * which costs about 20ms per asset (it scans job result jsonb), so the list starts from
 * a cheap candidate query and carries the real verdict only for the rows it shows
 * (`confirmedOrphan`). Candidates the verdict rejects say so, and their purge button
 * is disabled - the server would refuse anyway, but the operator should not have to
 * find that out by clicking.
 *
 * Nothing here deletes rows directly: the purge reuses the existing orphan pipeline,
 * and if the object removal fails the asset simply stays in the pending queue.
 */

const QUEUE_LABELS: Record<string, string> = {
  pending_delete: "待删除", gc_eligible: "可回收", gc_claimed: "已领取",
};

export const assetQueueKindLabel = (kind: string) => QUEUE_LABELS[kind] ?? kind;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function AdminStorageSection({ accessToken }: { accessToken: string }) {
  const [overview, setOverview] = useState<AdminAssetOverviewResponse | null>(null);
  const [orphans, setOrphans] = useState<AdminAssetOrphanRow[]>([]);
  const [orphanTotal, setOrphanTotal] = useState(0);
  const [queue, setQueue] = useState<AdminAssetQueueResponse | null>(null);
  const [large, setLarge] = useState<AdminAssetRow[]>([]);
  const [workspaces, setWorkspaces] = useState<AdminWorkspaceDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [bucket, setBucket] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [minBytes, setMinBytes] = useState("");
  const [queueKind, setQueueKind] = useState<string>("pending_delete");
  const [applied, setApplied] = useState({ bucket: "", workspaceId: "", minBytes: "" });

  const [pending, setPending] = useState<AdminAssetOrphanRow | null>(null);
  const [reason, setReason] = useState("");

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
    const bytes = Number(applied.minBytes);
    try {
      const [overviewResult, orphanResult, queueResult, largeResult] = await Promise.all([
        fetchAdminStorageOverview(accessToken),
        fetchAdminAssetOrphans(accessToken, {
          ...(applied.bucket ? { bucket: applied.bucket } : {}),
          ...(applied.workspaceId ? { workspaceId: applied.workspaceId } : {}),
          ...(Number.isFinite(bytes) && applied.minBytes.trim() !== "" && bytes >= 0 ? { minBytes: bytes } : {}),
          limit: 50,
        }),
        fetchAdminAssetQueue(accessToken, queueKind, { limit: 50 }),
        fetchAdminAssetLargeObjects(accessToken, 20),
      ]);
      setOverview(overviewResult);
      setOrphans(orphanResult.objects);
      setOrphanTotal(orphanResult.total);
      setQueue(queueResult);
      setLarge(largeResult.objects);
    } catch (caught) {
      setOrphans([]);
      setOrphanTotal(0);
      setError(caught instanceof Error ? caught.message : "存储数据加载失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, [accessToken, applied, queueKind]);

  useEffect(() => { void load(); }, [load]);

  async function confirmPurge() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const removed = await purgeAdminOrphanAsset(accessToken, pending.id, reason);
      setFeedback(`已清理 ${formatBytes(pending.byteSize)}（${removed.bucket}/${removed.objectPath}），操作已记入审计。`);
      setPending(null);
      setReason("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "清理失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5" data-testid="admin-storage">
      <section className="rounded-lg border border-border bg-card p-5">
        <div>
          <h2 className="text-base font-semibold">存储</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            按桶/工作区看占用，盘点<strong>没有活引用</strong>的素材并交回既有回收流程清理。
            判定孤儿需要逐条跑权威引用检查（它要扫任务结果 jsonb，单条约 20ms），
            所以列表先做集合化的"候选"筛选，只为当前这一页给出权威结论；
            标为「仍被引用」的候选不能清理。清理是"认领 → 删对象 → 收尾"三步，
            删对象失败时素材留在待删队列，由回收流程继续处理，不会留下无主对象。
          </p>
        </div>
        {feedback ? <p className="mt-3 text-sm text-muted-foreground" data-testid="admin-storage-feedback">{feedback}</p> : null}
        {error ? <p className="mt-3 text-sm text-destructive" data-testid="admin-storage-error">{error}</p> : null}
      </section>

      {loading ? (
        <p className="text-sm text-muted-foreground">正在加载存储数据…</p>
      ) : (
        <>
          {overview ? (
            <section className="rounded-lg border border-border bg-card p-5" data-testid="admin-storage-overview">
              <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-5">
                <div><span className="text-muted-foreground">对象总数</span>
                  <p className="text-lg tabular-nums">{overview.totalObjects}</p></div>
                <div><span className="text-muted-foreground">占用</span>
                  <p className="text-lg tabular-nums" data-testid="admin-storage-bytes">{formatBytes(overview.totalBytes)}</p></div>
                <div><span className="text-muted-foreground">待删除</span>
                  <p className="text-lg tabular-nums">{overview.pendingCount}</p></div>
                <div><span className="text-muted-foreground">可回收</span>
                  <p className="text-lg tabular-nums">{overview.gcEligibleCount}</p></div>
                <div><span className="text-muted-foreground">已领取</span>
                  <p className="text-lg tabular-nums">{overview.gcClaimedCount}</p></div>
              </div>
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div>
                  <h3 className="text-xs font-medium">按桶</h3>
                  <table className="mt-2 w-full text-sm" data-testid="admin-storage-buckets">
                    <thead className="text-left text-xs text-muted-foreground">
                      <tr><th className="py-1">桶</th><th className="py-1 text-right">对象</th>
                        <th className="py-1 text-right">占用</th><th className="py-1 text-right">待删/可回收</th></tr>
                    </thead>
                    <tbody>
                      {overview.buckets.map(row => (
                        <tr key={`${row.bucket}-${row.scope}`} className="border-t border-border">
                          <td className="py-1">{row.bucket}</td>
                          <td className="py-1 text-right tabular-nums">{row.objects}</td>
                          <td className="py-1 text-right tabular-nums">{formatBytes(row.bytes)}</td>
                          <td className="py-1 text-right tabular-nums">{row.pendingCount}/{row.gcEligibleCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  <h3 className="text-xs font-medium">最占空间的工作区</h3>
                  <table className="mt-2 w-full text-sm" data-testid="admin-storage-workspaces">
                    <thead className="text-left text-xs text-muted-foreground">
                      <tr><th className="py-1">工作区</th><th className="py-1 text-right">对象</th>
                        <th className="py-1 text-right">占用</th></tr>
                    </thead>
                    <tbody>
                      {overview.workspaces.map(row => (
                        <tr key={row.workspaceId ?? "none"} className="border-t border-border">
                          <td className="py-1">{row.workspaceName ?? "（无工作区）"}</td>
                          <td className="py-1 text-right tabular-nums">{row.objects}</td>
                          <td className="py-1 text-right tabular-nums">{formatBytes(row.bytes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          ) : null}

          <section className="rounded-lg border border-border bg-card p-5">
            <form className="flex flex-wrap items-end gap-2"
              onSubmit={event => { event.preventDefault(); setApplied({ bucket, workspaceId, minBytes }); }}>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">桶
                <select value={bucket} aria-label="存储桶" onChange={event => setBucket(event.target.value)}
                  className="w-48 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground">
                  <option value="">全部</option>
                  {(overview?.buckets ?? []).map(row => (
                    <option key={`${row.bucket}-${row.scope}`} value={row.bucket}>{row.bucket}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">工作区
                <select value={workspaceId} aria-label="存储工作区" onChange={event => setWorkspaceId(event.target.value)}
                  className="w-56 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground">
                  <option value="">全部</option>
                  {workspaces.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">最小字节
                <input value={minBytes} onChange={event => setMinBytes(event.target.value)} aria-label="最小字节"
                  placeholder="例如 1048576"
                  className="w-40 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
              </label>
              <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-sm">查询</button>
              <button type="button" onClick={() => void load()} className="rounded-md border border-border px-3 py-1.5 text-sm">刷新</button>
              <span className="text-xs text-muted-foreground">共 {orphanTotal} 条候选（当前页 {orphans.length} 条已逐条复核）</span>
            </form>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm" data-testid="admin-storage-orphans">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-right">大小</th>
                    <th className="px-3 py-2">桶 / 路径</th>
                    <th className="px-3 py-2">工作区</th>
                    <th className="px-3 py-2 text-right">引用数</th>
                    <th className="px-3 py-2">权威判定</th>
                    <th className="px-3 py-2">创建</th>
                    <th className="px-3 py-2 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {orphans.length === 0 ? (
                    <tr><td colSpan={7} className="px-3 py-6 text-center text-sm text-muted-foreground">
                      没有匹配的孤儿候选。可以放宽筛选条件。
                    </td></tr>
                  ) : orphans.map(row => (
                    <tr key={row.id} className="border-t border-border align-top">
                      <td className="px-3 py-2 text-right tabular-nums">{formatBytes(row.byteSize)}</td>
                      <td className="px-3 py-2 max-w-[24rem]">
                        <div className="font-mono text-xs">{row.bucket}</div>
                        <div className="truncate font-mono text-xs text-muted-foreground" title={row.objectPath}>{row.objectPath}</div>
                      </td>
                      <td className="px-3 py-2 text-xs">{row.workspaceName ?? "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.referenceCount}</td>
                      <td className="px-3 py-2 text-xs">
                        {row.confirmedOrphan
                          ? <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-600">确认无引用</span>
                          : <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600" data-testid="admin-storage-referenced">仍被引用</span>}
                        {row.deletionPendingAt ? <div className="text-muted-foreground">已在待删队列</div> : null}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
                        {formatJobTimestamp(row.createdAt)}<div>{row.ageDays} 天前</div>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button type="button" disabled={!row.confirmedOrphan}
                          onClick={() => { setPending(row); setReason(""); setFeedback(null); }}
                          className="rounded-md border border-border px-3 py-1 text-xs text-destructive disabled:opacity-40">清理</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium">删除与回收队列</h3>
              <select value={queueKind} aria-label="队列类型" onChange={event => setQueueKind(event.target.value)}
                className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground">
                {ADMIN_ASSET_QUEUE_KINDS.map(kind => (
                  <option key={kind} value={kind}>{assetQueueKindLabel(kind)}</option>
                ))}
              </select>
              <span className="text-xs text-muted-foreground">共 {queue?.total ?? 0} 条</span>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm" data-testid="admin-storage-queue">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr><th className="px-3 py-2 text-right">大小</th><th className="px-3 py-2">桶 / 路径</th>
                    <th className="px-3 py-2">工作区</th><th className="px-3 py-2">待删</th>
                    <th className="px-3 py-2">回收</th><th className="px-3 py-2">领取</th></tr>
                </thead>
                <tbody>
                  {(queue?.objects ?? []).length === 0 ? (
                    <tr><td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground">
                      这个队列是空的。
                    </td></tr>
                  ) : (queue?.objects ?? []).map(row => (
                    <tr key={row.id} className="border-t border-border">
                      <td className="px-3 py-2 text-right tabular-nums">{formatBytes(row.byteSize)}</td>
                      <td className="px-3 py-2 max-w-[24rem] truncate font-mono text-xs" title={row.objectPath}>
                        {row.bucket}/{row.objectPath}
                      </td>
                      <td className="px-3 py-2 text-xs">{row.workspaceName ?? "—"}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{formatJobTimestamp(row.deletionPendingAt)}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{formatJobTimestamp(row.gcEligibleAt)}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{formatJobTimestamp(row.gcClaimedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <h3 className="text-sm font-medium">最大的对象</h3>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm" data-testid="admin-storage-large">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr><th className="px-3 py-2 text-right">大小</th><th className="px-3 py-2">桶 / 路径</th>
                    <th className="px-3 py-2">工作区</th><th className="px-3 py-2">类型</th>
                    <th className="px-3 py-2">引用</th></tr>
                </thead>
                <tbody>
                  {large.map(row => (
                    <tr key={row.id} className="border-t border-border">
                      <td className="px-3 py-2 text-right tabular-nums">{formatBytes(row.byteSize)}</td>
                      <td className="px-3 py-2 max-w-[28rem] truncate font-mono text-xs" title={row.objectPath}>
                        {row.bucket}/{row.objectPath}
                      </td>
                      <td className="px-3 py-2 text-xs">{row.workspaceName ?? "—"}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{row.mimeType ?? "—"}</td>
                      <td className="px-3 py-2 text-xs">
                        {row.referenceCount}
                        {row.confirmedOrphan ? <span className="ml-2 text-emerald-600">疑似孤儿</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {pending ? (
        <section className="rounded-lg border border-border bg-card p-5" data-testid="admin-storage-confirm">
          <h3 className="text-sm font-medium">
            清理 {formatBytes(pending.byteSize)} · {pending.bucket}
          </h3>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{pending.objectPath}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            会先向数据库认领（数据库会重新检查引用），再删除存储对象，最后删除记录；
            任一步失败都不会留下无主对象。操作连同原因写入管理审计。
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">原因（必填，至少 2 个字符）
              <input value={reason} onChange={event => setReason(event.target.value)} aria-label="清理原因"
                className="w-64 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
            </label>
            <button type="button" disabled={busy || reason.trim().length < 2}
              onClick={() => void confirmPurge()}
              className="rounded-md bg-destructive px-3 py-1.5 text-xs text-white disabled:opacity-50">确认清理</button>
            <button type="button" onClick={() => { setPending(null); setReason(""); }}
              className="rounded-md border border-border px-3 py-1.5 text-xs">取消</button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
