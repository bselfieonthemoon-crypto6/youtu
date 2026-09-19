"use client";

import type { AdminOverviewResponse } from "@loomic/shared";
import { useCallback, useEffect, useState } from "react";

import { fetchAdminOverview } from "../../lib/server-api";

/**
 * Read-only platform operations overview.
 *
 * Everything here is a snapshot the server computed under a platform-admin
 * check; the component has no write path at all. It also refuses to invent
 * meaning: an empty list says it is empty, and a section whose scan hit its cap
 * says so instead of letting the operator read a short total as the whole truth.
 */

const numberFormat = new Intl.NumberFormat("zh-CN");

export function formatAdminNumber(value: number): string {
  return numberFormat.format(value);
}

export function formatAdminTimestamp(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(parsed);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")} ${read("hour")}:${read("minute")}`;
}

const JOB_STATUS_LABELS: Record<string, string> = {
  queued: "排队", running: "执行中", succeeded: "成功", failed: "失败", canceled: "已取消", dead_letter: "死信",
};
const JOB_TYPE_LABELS: Record<string, string> = {
  image_generation: "图片生成", video_generation: "视频生成", code_execution: "代码执行",
  design_preview: "画板预览", design_export: "画板导出", design_resource_import: "设计资源导入",
};
const PLAN_LABELS: Record<string, string> = {
  free: "免费", starter: "入门", pro: "专业", ultra: "旗舰", business: "企业",
};
const TRANSACTION_LABELS: Record<string, string> = {
  subscription_grant: "订阅发放", daily_grant: "每日发放", purchase: "购买", generation_deduct: "生成扣费",
  generation_refund: "生成退款", admin_adjustment: "后台调整", bonus: "奖励",
};
const MODALITY_LABELS: Record<string, string> = { text: "文本", image: "图片", video: "视频" };
const WORKSPACE_TYPE_LABELS: Record<string, string> = { personal: "个人", team: "团队" };
const PROVIDER_TEST_LABELS: Record<string, string> = { never: "未自检", succeeded: "通过", failed: "失败" };

const label = (dictionary: Record<string, string>, key: string) => dictionary[key] ?? key;

function SectionCard({ title, description, meta, children }: {
  title: string;
  description?: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {meta}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Stat({ name, value, hint }: { name: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md bg-muted/60 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{name}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
      {hint ? <div className="text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function EmptyRow({ columns, text }: { columns: number; text: string }) {
  return (
    <tr>
      <td colSpan={columns} className="px-3 py-6 text-center text-sm text-muted-foreground">{text}</td>
    </tr>
  );
}

export function AdminOverviewSection({ accessToken }: { accessToken: string }) {
  const [overview, setOverview] = useState<AdminOverviewResponse | null>(null);
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
      setOverview(await fetchAdminOverview(accessToken));
    } catch (caught) {
      setOverview(null);
      setError(caught instanceof Error ? caught.message : "平台总览加载失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => void load(), [load]);

  if (loading) return <div className="text-sm text-muted-foreground">正在加载平台总览…</div>;
  if (error) {
    return (
      <div>
        <p className="text-sm text-destructive">{error}</p>
        <button type="button" onClick={() => void load()}
          className="mt-4 inline-flex rounded-md border border-border px-3 py-1.5 text-sm">
          重试
        </button>
      </div>
    );
  }
  if (!overview) return null;

  const anyTruncated = overview.credits.truncated || overview.providers.truncated || overview.skills.truncated;

  return (
    <div className="space-y-5" data-testid="admin-overview">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          数据快照：{formatAdminTimestamp(overview.generatedAt)}（只读）
          {anyTruncated ? <span className="ml-2 text-amber-600">部分统计已达扫描上限，数字可能不完整。</span> : null}
        </p>
        <button type="button" onClick={() => void load()}
          className="inline-flex rounded-md border border-border px-3 py-1.5 text-sm">刷新</button>
      </div>

      <SectionCard
        title="工作区"
        description={`共 ${formatAdminNumber(overview.workspaces.total)} 个工作区；下表按创建时间列出前 ${overview.workspaces.items.length} 个。`}
        meta={
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span>个人 {formatAdminNumber(overview.workspaces.byType.personal ?? 0)}</span>
            <span>团队 {formatAdminNumber(overview.workspaces.byType.team ?? 0)}</span>
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat name="工作区总数" value={formatAdminNumber(overview.workspaces.total)} />
          <Stat name="额度合计" value={formatAdminNumber(overview.credits.totalBalance)} hint="全部工作区余额之和" />
          <Stat name="任务总数" value={formatAdminNumber(overview.jobs.total)} />
          <Stat name="进行中" value={formatAdminNumber(overview.jobs.active)} hint="排队 + 执行中" />
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm" data-testid="admin-workspaces">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">名称</th>
                <th className="px-3 py-2">类型</th>
                <th className="px-3 py-2 text-right">成员</th>
                <th className="px-3 py-2 text-right">额度</th>
                <th className="px-3 py-2">套餐</th>
                <th className="px-3 py-2">创建时间</th>
              </tr>
            </thead>
            <tbody>
              {overview.workspaces.items.length === 0 ? (
                <EmptyRow columns={6} text="暂无工作区。" />
              ) : overview.workspaces.items.map(workspace => (
                <tr key={workspace.id} className="border-t border-border">
                  <td className="px-3 py-2">{workspace.name}</td>
                  <td className="px-3 py-2">{label(WORKSPACE_TYPE_LABELS, workspace.type)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatAdminNumber(workspace.memberCount)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatAdminNumber(workspace.balance)}</td>
                  <td className="px-3 py-2">{label(PLAN_LABELS, workspace.plan)}</td>
                  <td className="px-3 py-2 text-muted-foreground">{formatAdminTimestamp(workspace.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="任务与死信" description="任务状态按错误码统计；下表列出最近失败与死信任务。">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {Object.entries(overview.jobs.byStatus).map(([status, count]) => (
            <Stat key={status} name={label(JOB_STATUS_LABELS, status)} value={formatAdminNumber(count)} />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {Object.entries(overview.jobs.byType).map(([jobType, count]) => (
            <span key={jobType}>{label(JOB_TYPE_LABELS, jobType)} {formatAdminNumber(count)}</span>
          ))}
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm" data-testid="admin-failures">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">时间</th>
                <th className="px-3 py-2">工作区</th>
                <th className="px-3 py-2">类型</th>
                <th className="px-3 py-2">状态</th>
                <th className="px-3 py-2">错误码</th>
                <th className="px-3 py-2">上游信息</th>
                <th className="px-3 py-2 text-right">尝试</th>
              </tr>
            </thead>
            <tbody>
              {overview.jobs.recentFailures.length === 0 ? (
                <EmptyRow columns={7} text="最近没有失败任务。" />
              ) : overview.jobs.recentFailures.map(job => (
                <tr key={job.id} className="border-t border-border align-top">
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{formatAdminTimestamp(job.createdAt)}</td>
                  <td className="px-3 py-2">{job.workspaceName}</td>
                  <td className="px-3 py-2">{label(JOB_TYPE_LABELS, job.jobType)}</td>
                  <td className="px-3 py-2">{label(JOB_STATUS_LABELS, job.status)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{job.errorCode ?? "—"}</td>
                  <td className="px-3 py-2 max-w-md break-words text-xs text-muted-foreground">{job.errorMessage ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatAdminNumber(job.attemptCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard
        title="额度与计费"
        description={`近 30 天扣费 ${formatAdminNumber(overview.credits.deductionsLast30d)} 笔、退款 ${formatAdminNumber(overview.credits.refundsLast30d)} 笔；下表为最近流水。`}
        meta={
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {Object.entries(overview.credits.byPlan).map(([plan, count]) => (
              <span key={plan}>{label(PLAN_LABELS, plan)} {formatAdminNumber(count)}</span>
            ))}
          </div>
        }
      >
        {overview.credits.truncated ? (
          <p className="mb-2 text-xs text-amber-600">余额或套餐统计已达扫描上限，合计可能偏小。</p>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="admin-transactions">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">时间</th>
                <th className="px-3 py-2">工作区</th>
                <th className="px-3 py-2">类型</th>
                <th className="px-3 py-2 text-right">金额</th>
                <th className="px-3 py-2 text-right">余额</th>
                <th className="px-3 py-2">关联任务</th>
              </tr>
            </thead>
            <tbody>
              {overview.credits.recentTransactions.length === 0 ? (
                <EmptyRow columns={6} text="暂无额度流水。" />
              ) : overview.credits.recentTransactions.map(transaction => (
                <tr key={transaction.id} className="border-t border-border">
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{formatAdminTimestamp(transaction.createdAt)}</td>
                  <td className="px-3 py-2">{transaction.workspaceName}</td>
                  <td className="px-3 py-2">{label(TRANSACTION_LABELS, transaction.transactionType)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${transaction.amount < 0 ? "text-destructive" : ""}`}>
                    {transaction.amount > 0 ? `+${formatAdminNumber(transaction.amount)}` : formatAdminNumber(transaction.amount)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatAdminNumber(transaction.balanceAfter)}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{transaction.jobId ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard
        title="模型与渠道"
        description={`渠道 ${formatAdminNumber(overview.providers.configCount)} 个，其中停用 ${formatAdminNumber(overview.providers.disabledConfigCount)} 个、自检失败 ${formatAdminNumber(overview.providers.failingTestCount)} 个；模型 ${formatAdminNumber(overview.providers.modelCount)} 个，其中停用 ${formatAdminNumber(overview.providers.disabledModelCount)} 个。`}
        meta={
          <div className="flex gap-4 text-xs text-muted-foreground">
            {Object.entries(overview.providers.modelsByModality).map(([modality, count]) => (
              <span key={modality}>{label(MODALITY_LABELS, modality)} {formatAdminNumber(count)}</span>
            ))}
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="admin-providers">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">工作区</th>
                <th className="px-3 py-2">渠道</th>
                <th className="px-3 py-2">启用</th>
                <th className="px-3 py-2 text-right">模型</th>
                <th className="px-3 py-2">最近自检</th>
                <th className="px-3 py-2">更新时间</th>
              </tr>
            </thead>
            <tbody>
              {overview.providers.items.length === 0 ? (
                <EmptyRow columns={6} text="尚未配置第三方渠道。" />
              ) : overview.providers.items.map(provider => (
                <tr key={provider.id} className="border-t border-border">
                  <td className="px-3 py-2">{provider.workspaceName}</td>
                  <td className="px-3 py-2">{provider.displayName}</td>
                  <td className="px-3 py-2">{provider.enabled ? "是" : "否"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatAdminNumber(provider.modelCount)}</td>
                  <td className="px-3 py-2">
                    {label(PROVIDER_TEST_LABELS, provider.lastTestStatus)}
                    {provider.lastTestErrorCode
                      ? <span className="ml-2 font-mono text-xs text-destructive">{provider.lastTestErrorCode}</span>
                      : null}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{formatAdminTimestamp(provider.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard
        title="技能"
        description={`技能包 ${formatAdminNumber(overview.skills.total)} 个；工作区安装 ${formatAdminNumber(overview.skills.installs)} 次，其中启用 ${formatAdminNumber(overview.skills.enabledInstalls)} 次。`}
        meta={
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {Object.entries(overview.skills.byCategory).map(([category, count]) => (
              <span key={category}>{category} {formatAdminNumber(count)}</span>
            ))}
          </div>
        }
      >
        {overview.skills.truncated ? (
          <p className="text-xs text-amber-600">安装统计已达扫描上限，数字可能偏小。</p>
        ) : null}
      </SectionCard>
    </div>
  );
}
