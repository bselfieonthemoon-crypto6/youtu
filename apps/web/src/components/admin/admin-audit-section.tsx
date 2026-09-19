"use client";

import type { AdminAuditEventView } from "@loomic/shared";
import { useCallback, useEffect, useState } from "react";

import { fetchAdminAudit } from "../../lib/server-api";

/**
 * Read-only audit trail of platform-admin writes.
 *
 * "Who changed this, when, and why" is the whole point of the table, so the
 * action, target, actor and reason are always shown — and a row whose actor or
 * workspace has since been deleted says so instead of rendering blank.
 */

const ACTION_LABELS: Record<string, string> = {
  "platform_admin.grant": "授予平台管理员",
  "platform_admin.revoke": "撤销平台管理员",
  "workspace.plan.set": "修改工作区套餐",
  "credits.adjust": "调整额度",
  "skill.preview.publish": "发布技能图片",
  "skill.preview.unpublish": "下架技能图片",
};

const TARGET_LABELS: Record<string, string> = {
  user: "用户", workspace: "工作区", skill: "技能", job: "任务", provider_config: "渠道", asset: "素材",
};

export const AUDIT_PAGE_SIZE = 50;

export function formatAuditTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(parsed);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")} ${read("hour")}:${read("minute")}:${read("second")}`;
}

export const auditActionLabel = (action: string) => ACTION_LABELS[action] ?? action;
export const auditTargetLabel = (kind: string) => TARGET_LABELS[kind] ?? kind;

export function AdminAuditSection({ accessToken, refreshKey = 0 }: { accessToken: string; refreshKey?: number }) {
  const [events, setEvents] = useState<AdminAuditEventView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) {
      setLoading(false);
      setError("无法获取登录凭据，请重新登录后再试。");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setEvents((await fetchAdminAudit(accessToken, { limit: AUDIT_PAGE_SIZE })).events);
    } catch (caught) {
      setEvents([]);
      setError(caught instanceof Error ? caught.message : "审计记录加载失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => void load(), [load, refreshKey]);

  if (loading) return <p className="text-sm text-muted-foreground">正在加载审计记录…</p>;
  if (error) {
    return (
      <div>
        <p className="text-sm text-destructive">{error}</p>
        <button type="button" onClick={() => void load()}
          className="mt-4 inline-flex rounded-md border border-border px-3 py-1.5 text-sm">重试</button>
      </div>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-card p-5" data-testid="admin-audit">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">操作审计</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            平台管理员的写操作记录（最近 {AUDIT_PAGE_SIZE} 条）。审计行与改动在同一事务内写入，改不了的不会留下记录，改成的必然有记录。
          </p>
        </div>
        <button type="button" onClick={() => void load()}
          className="rounded-md border border-border px-3 py-1.5 text-sm">刷新</button>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2">时间</th>
              <th className="px-3 py-2">操作</th>
              <th className="px-3 py-2">对象</th>
              <th className="px-3 py-2">操作者</th>
              <th className="px-3 py-2">原因</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 ? (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">还没有任何管理操作记录。</td></tr>
            ) : events.map(event => (
              <tr key={event.id} className="border-t border-border align-top">
                <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{formatAuditTimestamp(event.createdAt)}</td>
                <td className="px-3 py-2">{auditActionLabel(event.action)}</td>
                <td className="px-3 py-2">
                  {auditTargetLabel(event.targetKind)}
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{event.targetId}</span>
                  {event.workspaceName ? <div className="text-xs text-muted-foreground">{event.workspaceName}</div> : null}
                </td>
                <td className="px-3 py-2">{event.actorEmail ?? event.actorUserId ?? "系统"}</td>
                <td className="px-3 py-2 max-w-sm break-words text-xs text-muted-foreground">{event.reason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
