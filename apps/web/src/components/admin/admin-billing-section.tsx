"use client";

import type { AdminWorkspaceBillingResponse, AdminWorkspaceDirectoryEntry } from "@loomic/shared";
import { PLAN_CONFIGS, subscriptionPlanSchema } from "@loomic/shared";
import { useCallback, useEffect, useState } from "react";

import {
  adminAdjustWorkspaceCredits,
  adminSetWorkspacePlan,
  fetchAdminWorkspaceBilling,
  fetchAdminWorkspaces,
} from "../../lib/server-api";

/**
 * Plan and credit management for one workspace, with the reconciliation view that
 * makes the numbers checkable.
 *
 * Both writes require a stated reason and an explicit confirmation, and the panel
 * shows what the operator is about to change: the plan they picked and the credits
 * it grants, or the exact delta. The reconciliation list (jobs whose recorded cost
 * disagrees with the ledger) is what turns "余额对不对" into something readable.
 */

const PLAN_ORDER = subscriptionPlanSchema.options;

const PLAN_LABELS: Record<string, string> = {
  free: "免费", starter: "入门", pro: "专业", ultra: "旗舰", business: "企业",
};
const TRANSACTION_LABELS: Record<string, string> = {
  subscription_grant: "订阅发放", daily_grant: "每日发放", purchase: "购买", generation_deduct: "生成扣费",
  generation_refund: "生成退款", admin_adjustment: "后台调整", bonus: "奖励",
};

export const billingPlanLabel = (plan: string) => PLAN_LABELS[plan] ?? plan;
export const billingTransactionLabel = (type: string) => TRANSACTION_LABELS[type] ?? type;

export function formatBillingNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

export function formatBillingTimestamp(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(parsed);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")} ${read("hour")}:${read("minute")}`;
}

/** What a plan grants, so the operator sees the effect before confirming. */
export function planSummary(plan: string): string {
  const config = PLAN_CONFIGS[plan as keyof typeof PLAN_CONFIGS];
  if (!config) return "";
  return `每月 ${formatBillingNumber(config.monthlyCredits)} 额度 · 并发 ${config.maxConcurrentJobs} · 最高 ${config.maxResolution}`;
}

export function AdminBillingSection({ accessToken }: { accessToken: string }) {
  const [workspaces, setWorkspaces] = useState<AdminWorkspaceDirectoryEntry[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [billing, setBilling] = useState<AdminWorkspaceBillingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [planDraft, setPlanDraft] = useState("free");
  const [grantDraft, setGrantDraft] = useState("0");
  const [planReason, setPlanReason] = useState("");
  const [confirmingPlan, setConfirmingPlan] = useState(false);

  const [deltaDraft, setDeltaDraft] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [confirmingAdjust, setConfirmingAdjust] = useState(false);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await fetchAdminWorkspaces(accessToken, { limit: 100 });
        if (cancelled) return;
        setWorkspaces(result.workspaces);
        setWorkspaceId(current => current || result.workspaces[0]?.id || "");
      } catch {
        if (!cancelled) setWorkspaces([]);
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken]);

  const load = useCallback(async () => {
    if (!accessToken || !workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchAdminWorkspaceBilling(accessToken, workspaceId);
      setBilling(result);
      setPlanDraft(result.plan);
      setGrantDraft("0");
      setPlanReason("");
      setConfirmingPlan(false);
      setDeltaDraft("");
      setAdjustReason("");
      setConfirmingAdjust(false);
    } catch (caught) {
      setBilling(null);
      setError(caught instanceof Error ? caught.message : "套餐与额度加载失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, [accessToken, workspaceId]);

  useEffect(() => void load(), [load]);

  const selected = workspaces.find(item => item.id === workspaceId) ?? null;
  const grantValue = Number(grantDraft);
  const grantValid = Number.isInteger(grantValue) && grantValue >= 0 && grantValue <= 1_000_000;
  const deltaValue = Number(deltaDraft);
  const deltaValid = Number.isInteger(deltaValue) && deltaValue !== 0 && Math.abs(deltaValue) <= 1_000_000;

  async function handleSetPlan() {
    if (!billing) return;
    setFeedback(null);
    setBusy(true);
    try {
      await adminSetWorkspacePlan(accessToken, billing.workspace.id, {
        plan: planDraft, grantCredits: grantValue, reason: planReason.trim(),
      });
      setFeedback(`已把 ${billing.workspace.name} 的套餐改为${billingPlanLabel(planDraft)}${grantValue > 0 ? `，并发放 ${formatBillingNumber(grantValue)} 额度` : ""}，操作已记入审计。`);
      await load();
    } catch (caught) {
      setFeedback(caught instanceof Error ? caught.message : "修改套餐失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function handleAdjust() {
    if (!billing) return;
    setFeedback(null);
    setBusy(true);
    try {
      await adminAdjustWorkspaceCredits(accessToken, billing.workspace.id, {
        delta: deltaValue, reason: adjustReason.trim(),
      });
      setFeedback(`已${deltaValue > 0 ? "增加" : "扣减"} ${formatBillingNumber(Math.abs(deltaValue))} 额度，操作已记入审计。`);
      await load();
    } catch (caught) {
      setFeedback(caught instanceof Error ? caught.message : "调整额度失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5" data-testid="admin-billing">
      <section className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">套餐与额度</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              平台管理员可以调整工作区套餐与额度余额。改动会写进同一本额度流水，并记录原因与审计；
              这里不改变生图的计费规则，只调整账户本身。
            </p>
          </div>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            工作区
            <select value={workspaceId} onChange={event => { setWorkspaceId(event.target.value); setFeedback(null); }}
              aria-label="选择工作区"
              className="w-72 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground">
              {workspaces.length === 0 ? <option value="">（没有可用工作区）</option> : null}
              {workspaces.map(workspace => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}（{workspace.memberCount} 人）
                </option>
              ))}
            </select>
          </label>
        </div>
        {feedback ? <p className="mt-3 text-sm text-muted-foreground" data-testid="admin-billing-feedback">{feedback}</p> : null}
      </section>

      {loading ? (
        <p className="text-sm text-muted-foreground">正在加载套餐与额度…</p>
      ) : error ? (
        <div>
          <p className="text-sm text-destructive">{error}</p>
          <button type="button" onClick={() => void load()}
            className="mt-4 inline-flex rounded-md border border-border px-3 py-1.5 text-sm">重试</button>
        </div>
      ) : billing ? (
        <>
          <section className="rounded-lg border border-border bg-card p-5">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-md bg-muted/60 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">当前套餐</div>
                <div className="mt-0.5 text-lg font-semibold">{billingPlanLabel(billing.plan)}</div>
                <div className="text-[11px] text-muted-foreground">{planSummary(billing.plan)}</div>
              </div>
              <div className="rounded-md bg-muted/60 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">额度余额</div>
                <div className="mt-0.5 text-lg font-semibold tabular-nums">{formatBillingNumber(billing.balance)}</div>
              </div>
              <div className="rounded-md bg-muted/60 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">近30天扣费</div>
                <div className="mt-0.5 text-lg font-semibold tabular-nums">{formatBillingNumber(billing.last30d.deductedCredits)}</div>
                <div className="text-[11px] text-muted-foreground">退款 {formatBillingNumber(billing.last30d.refundedCredits)}</div>
              </div>
              <div className="rounded-md bg-muted/60 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">订阅来源</div>
                <div className="mt-0.5 text-sm font-medium">
                  {billing.subscription.hasExternalSubscription ? "外部支付渠道" : "平台内设置"}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {billing.subscription.billingPeriod ?? "无计费周期"}
                  {billing.subscription.canceledAt ? " · 已取消" : ""}
                </div>
              </div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              订阅周期：{formatBillingTimestamp(billing.subscription.currentPeriodStart)} → {formatBillingTimestamp(billing.subscription.currentPeriodEnd)}
              {billing.subscription.canceledAt ? `（已于 ${formatBillingTimestamp(billing.subscription.canceledAt)} 取消）` : ""}
            </p>

            <div className="mt-5 grid gap-4 border-t border-border pt-4 lg:grid-cols-2">
              <div>
                <h3 className="text-sm font-medium">修改套餐</h3>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    套餐
                    <select value={planDraft} aria-label="选择套餐"
                      onChange={event => { setPlanDraft(event.target.value); setConfirmingPlan(false); }}
                      className="w-32 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground">
                      {PLAN_ORDER.map(plan => (
                        <option key={plan} value={plan}>{billingPlanLabel(plan)}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    同时发放额度
                    <input value={grantDraft} onChange={event => { setGrantDraft(event.target.value); setConfirmingPlan(false); }}
                      inputMode="numeric" aria-label="同时发放额度"
                      className="w-28 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    原因
                    <input value={planReason} onChange={event => { setPlanReason(event.target.value); setConfirmingPlan(false); }}
                      aria-label="修改套餐原因" placeholder="例如：商务补偿"
                      className="w-48 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
                  </label>
                  {confirmingPlan ? (
                    <div className="flex gap-2">
                      <button type="button" disabled={busy}
                        onClick={() => void handleSetPlan()}
                        className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-50">
                        确认执行
                      </button>
                      <button type="button" onClick={() => setConfirmingPlan(false)}
                        className="rounded-md border border-border px-3 py-1.5 text-sm">取消</button>
                    </div>
                  ) : (
                    <button type="button"
                      disabled={!grantValid || planReason.trim().length < 2}
                      onClick={() => setConfirmingPlan(true)}
                      className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50">
                      修改套餐
                    </button>
                  )}
                </div>
                {confirmingPlan ? (
                  <p className="mt-2 text-xs text-muted-foreground" data-testid="admin-billing-plan-confirm">
                    确认把套餐改为{billingPlanLabel(planDraft)}
                    {grantValue > 0 ? `，并发放 ${formatBillingNumber(grantValue)} 额度` : "，不发放额度"}？
                    {planDraft !== billing.plan ? `（当前为${billingPlanLabel(billing.plan)}）` : ""}
                  </p>
                ) : null}
                {!grantValid ? <p className="mt-2 text-xs text-destructive">发放额度必须是 0..1000000 的整数。</p> : null}
              </div>

              <div>
                <h3 className="text-sm font-medium">增减额度</h3>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    增减（正数增加，负数扣减）
                    <input value={deltaDraft} onChange={event => { setDeltaDraft(event.target.value); setConfirmingAdjust(false); }}
                      inputMode="numeric" aria-label="额度增减数值" placeholder="例如：500 或 -200"
                      className="w-40 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    原因
                    <input value={adjustReason} onChange={event => { setAdjustReason(event.target.value); setConfirmingAdjust(false); }}
                      aria-label="调整额度原因" placeholder="例如：失败任务补偿"
                      className="w-48 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
                  </label>
                  {confirmingAdjust ? (
                    <div className="flex gap-2">
                      <button type="button" disabled={busy}
                        onClick={() => void handleAdjust()}
                        className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-50">
                        确认执行
                      </button>
                      <button type="button" onClick={() => setConfirmingAdjust(false)}
                        className="rounded-md border border-border px-3 py-1.5 text-sm">取消</button>
                    </div>
                  ) : (
                    <button type="button"
                      disabled={!deltaValid || adjustReason.trim().length < 2}
                      onClick={() => setConfirmingAdjust(true)}
                      className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50">
                      调整额度
                    </button>
                  )}
                </div>
                {confirmingAdjust ? (
                  <p className="mt-2 text-xs text-muted-foreground" data-testid="admin-billing-adjust-confirm">
                    确认{deltaValue > 0 ? "增加" : "扣减"} {formatBillingNumber(Math.abs(deltaValue))} 额度？
                    余额将从 {formatBillingNumber(billing.balance)} 变为 {formatBillingNumber(billing.balance + deltaValue)}。
                  </p>
                ) : null}
                {!deltaValid ? <p className="mt-2 text-xs text-destructive">额度增减必须是非零整数（±1000000 以内）。</p> : null}
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-base font-semibold">最近额度流水</h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm" data-testid="admin-billing-transactions">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">时间</th>
                    <th className="px-3 py-2">类型</th>
                    <th className="px-3 py-2 text-right">额度</th>
                    <th className="px-3 py-2 text-right">余额</th>
                    <th className="px-3 py-2">说明</th>
                    <th className="px-3 py-2">关联账号/任务</th>
                  </tr>
                </thead>
                <tbody>
                  {billing.recentTransactions.length === 0 ? (
                    <tr><td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground">
                      该工作区还没有额度流水。
                    </td></tr>
                  ) : billing.recentTransactions.map(transaction => (
                    <tr key={transaction.id} className="border-t border-border">
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{formatBillingTimestamp(transaction.createdAt)}</td>
                      <td className="px-3 py-2">{billingTransactionLabel(transaction.transactionType)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${transaction.amount < 0 ? "text-destructive" : ""}`}>
                        {transaction.amount > 0 ? `+${formatBillingNumber(transaction.amount)}` : formatBillingNumber(transaction.amount)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatBillingNumber(transaction.balanceAfter)}</td>
                      <td className="px-3 py-2 max-w-sm break-words text-xs text-muted-foreground">{transaction.description ?? "—"}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {transaction.actorEmail ?? "—"}
                        {transaction.jobId ? <div className="font-mono">{transaction.jobId}</div> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-base font-semibold">对账：任务成本与流水不一致</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              `credits_cost` 与额度流水实际扣费不一致的任务（最近 20 条）。为空表示当前对得上。
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm" data-testid="admin-billing-mismatches">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">时间</th>
                    <th className="px-3 py-2">任务</th>
                    <th className="px-3 py-2">状态</th>
                    <th className="px-3 py-2 text-right">记录成本</th>
                    <th className="px-3 py-2 text-right">流水扣费</th>
                    <th className="px-3 py-2 text-right">流水退款</th>
                  </tr>
                </thead>
                <tbody>
                  {billing.mismatchedJobs.length === 0 ? (
                    <tr><td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground">
                      没有发现不一致的任务。
                    </td></tr>
                  ) : billing.mismatchedJobs.map(job => (
                    <tr key={job.jobId} className="border-t border-border">
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{formatBillingTimestamp(job.createdAt)}</td>
                      <td className="px-3 py-2 font-mono text-xs">{job.jobId}</td>
                      <td className="px-3 py-2">{job.status}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatBillingNumber(job.recordedCreditsCost)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatBillingNumber(job.ledgerCharged)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatBillingNumber(job.ledgerRefunded)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}

      {selected && !billing && !loading && !error ? (
        <p className="text-sm text-muted-foreground">选择工作区后查看套餐与额度。</p>
      ) : null}
    </div>
  );
}
