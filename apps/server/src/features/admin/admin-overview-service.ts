import {
  subscriptionPlanSchema,
  type AdminOverviewJobFailure,
  type AdminOverviewProvider,
  type AdminOverviewResponse,
  type AdminOverviewTransaction,
} from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { isActivePlatformAdmin } from "./platform-admin.js";

/**
 * Read-only platform overview for the operations console.
 *
 * Three rules shape every number here:
 *   1. Authorization is checked before any query, against the same
 *      `isActivePlatformAdmin` definition the routes use.
 *   2. Anything cheap to count exactly IS counted exactly, with a head count —
 *      job status, job type, workspace type, skill category. An approximate
 *      number in an ops console is worse than no number.
 *   3. Anything that needs every row (balance sum, plan histogram, model and
 *      install tallies) is read with a bounded, deterministically ordered page
 *      scan, and the section reports `truncated: true` when the cap was hit
 *      rather than returning a silently short total.
 *
 * The page size stays below PostgREST's common 1000-row response cap: a page
 * that comes back shorter than requested is how the scan knows it finished, so a
 * page size at the cap would end the scan early and under-count.
 */

export const ADMIN_OVERVIEW_WORKSPACE_LIMIT = 50;
export const ADMIN_OVERVIEW_LIST_LIMIT = 20;
/** Page size and cap of the bounded scans, exported so tests can hit the cap exactly. */
export const ADMIN_OVERVIEW_SCAN_PAGE_SIZE = 500;
export const ADMIN_OVERVIEW_SCAN_MAX_PAGES = 20;
const SCAN_PAGE_SIZE = ADMIN_OVERVIEW_SCAN_PAGE_SIZE;
const SCAN_MAX_PAGES = ADMIN_OVERVIEW_SCAN_MAX_PAGES;
const ERROR_MESSAGE_MAX = 300;

const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "canceled", "dead_letter"] as const;
const FAILED_JOB_STATUSES = ["failed", "dead_letter"] as const;
const JOB_TYPES = [
  "image_generation",
  "video_generation",
  "code_execution",
  "design_preview",
  "design_export",
  "design_resource_import",
] as const;
const WORKSPACE_TYPES = ["personal", "team"] as const;
const SKILL_CATEGORIES = ["design", "generation", "code", "data", "writing", "custom"] as const;

export type AdminOverviewErrorCode = "platform_admin_required" | "admin_overview_failed";

export class AdminOverviewError extends Error {
  constructor(
    readonly code: AdminOverviewErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "AdminOverviewError";
  }
}

export type AdminOverviewService = {
  isPlatformAdmin(userId: string): Promise<boolean>;
  overview(): Promise<AdminOverviewResponse>;
};

type LooseResult<T> = { data: T[] | null; error: unknown; count?: number | null };

function failed(): never {
  throw new AdminOverviewError("admin_overview_failed", "Failed to build the platform overview.", 500);
}

/** An exact row count, independent of any page cap. */
async function headCount(query: PromiseLike<{ count?: number | null; error?: unknown }>): Promise<number> {
  const { count, error } = await query;
  if (error) failed();
  return count ?? 0;
}

/** Bounded, deterministically ordered page scan; `truncated` when it hit the cap. */
async function scanAll<T>(
  page: (from: number, to: number) => PromiseLike<LooseResult<T>>,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let index = 0; index < SCAN_MAX_PAGES; index += 1) {
    const from = index * SCAN_PAGE_SIZE;
    const { data, error } = await page(from, from + SCAN_PAGE_SIZE - 1);
    if (error) failed();
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < SCAN_PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

function histogram(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function truncatedMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > ERROR_MESSAGE_MAX ? `${trimmed.slice(0, ERROR_MESSAGE_MAX)}…` : trimmed;
}

export function createAdminOverviewService(options: {
  getAdminClient: () => AdminSupabaseClient;
  now?: () => Date;
}): AdminOverviewService {
  const admin = () => options.getAdminClient();
  const now = options.now ?? (() => new Date());

  async function isPlatformAdmin(userId: string): Promise<boolean> {
    try {
      return await isActivePlatformAdmin(admin(), userId);
    } catch {
      failed();
    }
  }

  async function workspaceNames(ids: readonly string[]): Promise<Map<string, string>> {
    const distinct = [...new Set(ids)];
    if (!distinct.length) return new Map();
    const { data, error } = await admin().from("workspaces").select("id,name").in("id", distinct);
    if (error) failed();
    return new Map((data ?? []).map(row => [row.id, row.name]));
  }

  async function overview(): Promise<AdminOverviewResponse> {
    try {
      return await buildOverview();
    } catch (error) {
      // One guarantee for callers: this service either returns a complete
      // overview or throws AdminOverviewError. A synchronous driver failure (a
      // missing table, a closed pool) must not escape as a raw error.
      if (error instanceof AdminOverviewError) throw error;
      failed();
    }
  }

  async function buildOverview(): Promise<AdminOverviewResponse> {
    const generatedAt = now().toISOString();
    const since30d = new Date(Date.parse(generatedAt) - 30 * 24 * 60 * 60 * 1000).toISOString();

    const workspaceList = admin().from("workspaces")
      .select("id,name,type,created_at", { count: "exact" })
      .order("created_at", { ascending: true })
      .limit(ADMIN_OVERVIEW_WORKSPACE_LIMIT);

    const [
      workspaceResult,
      workspaceTypeCounts,
      jobStatusCounts,
      jobTypeCounts,
      failureRows,
      providerList,
      providerCounts,
      skillTotal,
      skillCategoryCounts,
    ] = await Promise.all([
      workspaceList,
      Promise.all(WORKSPACE_TYPES.map(type =>
        headCount(admin().from("workspaces").select("id", { count: "exact", head: true }).eq("type", type)))),
      Promise.all(JOB_STATUSES.map(status =>
        headCount(admin().from("background_jobs").select("id", { count: "exact", head: true }).eq("status", status)))),
      Promise.all(JOB_TYPES.map(jobType =>
        headCount(admin().from("background_jobs").select("id", { count: "exact", head: true }).eq("job_type", jobType)))),
      admin().from("background_jobs")
        .select("id,workspace_id,job_type,status,error_code,error_message,attempt_count,created_at,completed_at")
        .in("status", [...FAILED_JOB_STATUSES])
        .order("created_at", { ascending: false })
        .limit(ADMIN_OVERVIEW_LIST_LIMIT),
      admin().from("workspace_provider_configs")
        .select("id,workspace_id,display_name,enabled,last_test_status,last_test_error_code,updated_at", { count: "exact" })
        .order("updated_at", { ascending: false })
        .limit(ADMIN_OVERVIEW_WORKSPACE_LIMIT),
      Promise.all([
        headCount(admin().from("workspace_provider_configs").select("id", { count: "exact", head: true }).eq("enabled", false)),
        headCount(admin().from("workspace_provider_configs").select("id", { count: "exact", head: true }).eq("last_test_status", "failed")),
      ]),
      headCount(admin().from("skills").select("id", { count: "exact", head: true })),
      Promise.all(SKILL_CATEGORIES.map(category =>
        headCount(admin().from("skills").select("id", { count: "exact", head: true }).eq("category", category)))),
    ]);
    if (workspaceResult.error || failureRows.error || providerList.error) failed();

    const listedWorkspaces = workspaceResult.data ?? [];
    const listedIds = listedWorkspaces.map(row => row.id);

    const [memberRows, balanceRows, subscriptionRows, creditScan, planScan, installScan, modelScan, transactionRows, transactionTypeCounts] =
      await Promise.all([
        listedIds.length
          ? admin().from("workspace_members").select("workspace_id,role").in("workspace_id", listedIds)
          : Promise.resolve({ data: [] as { workspace_id: string; role: string }[], error: null }),
        listedIds.length
          ? admin().from("credit_balances").select("workspace_id,balance").in("workspace_id", listedIds)
          : Promise.resolve({ data: [] as { workspace_id: string; balance: number }[], error: null }),
        listedIds.length
          ? admin().from("subscriptions").select("workspace_id,plan").in("workspace_id", listedIds)
          : Promise.resolve({ data: [] as { workspace_id: string; plan: string }[], error: null }),
        scanAll<{ workspace_id: string; balance: number }>((from, to) =>
          admin().from("credit_balances").select("workspace_id,balance").order("workspace_id", { ascending: true }).range(from, to)),
        scanAll<{ plan: string }>((from, to) =>
          admin().from("subscriptions").select("plan").order("workspace_id", { ascending: true }).range(from, to)),
        scanAll<{ enabled: boolean }>((from, to) =>
          admin().from("workspace_skills").select("enabled").order("workspace_id", { ascending: true }).range(from, to)),
        scanAll<{ provider_config_id: string; modality: string; enabled: boolean }>((from, to) =>
          admin().from("workspace_provider_models").select("provider_config_id,modality,enabled").order("id", { ascending: true }).range(from, to)),
        admin().from("credit_transactions")
          .select("id,workspace_id,transaction_type,amount,balance_after,job_id,created_at")
          .order("created_at", { ascending: false })
          .limit(ADMIN_OVERVIEW_LIST_LIMIT),
        Promise.all([
          headCount(admin().from("credit_transactions").select("id", { count: "exact", head: true })
            .eq("transaction_type", "generation_deduct").gte("created_at", since30d)),
          headCount(admin().from("credit_transactions").select("id", { count: "exact", head: true })
            .eq("transaction_type", "generation_refund").gte("created_at", since30d)),
        ]),
      ]);
    if (memberRows.error || balanceRows.error || subscriptionRows.error || transactionRows.error) failed();

    const memberCounts = histogram((memberRows.data ?? []).map(row => row.workspace_id));
    const balances = new Map((balanceRows.data ?? []).map(row => [row.workspace_id, Number(row.balance) || 0]));
    const plans = new Map((subscriptionRows.data ?? []).map(row => [row.workspace_id, row.plan]));
    const jobsByStatus: Record<string, number> = {};
    JOB_STATUSES.forEach((status, index) => { jobsByStatus[status] = jobStatusCounts[index] ?? 0; });
    const jobsByType: Record<string, number> = {};
    JOB_TYPES.forEach((jobType, index) => { jobsByType[jobType] = jobTypeCounts[index] ?? 0; });
    const modelsByModality = histogram(modelScan.rows.map(row => row.modality));
    const modelsPerConfig = histogram(modelScan.rows.map(row => row.provider_config_id));

    const failureNames = await workspaceNames((failureRows.data ?? []).map(row => row.workspace_id));
    const transactionWorkspaceIds = (transactionRows.data ?? []).map(row => row.workspace_id);
    const missingTransactionNames = transactionWorkspaceIds.filter(id => !failureNames.has(id));
    const transactionNames = await workspaceNames(missingTransactionNames);
    // A platform-scoped channel (workspace_id IS NULL) belongs to the whole
    // install, so it must not be sent to the workspace-name lookup: an empty id
    // in an `in` filter makes PostgREST reject the whole query.
    const providerNames = await workspaceNames(
      (providerList.data ?? [])
        .map(row => row.workspace_id)
        .filter((id): id is string => typeof id === "string"),
    );

    const recentFailures: AdminOverviewJobFailure[] = (failureRows.data ?? []).map(row => ({
      id: row.id,
      workspaceId: row.workspace_id,
      workspaceName: failureNames.get(row.workspace_id) ?? "未知工作区",
      jobType: row.job_type,
      status: row.status,
      errorCode: row.error_code ?? null,
      errorMessage: truncatedMessage(row.error_message),
      attemptCount: Number(row.attempt_count) || 0,
      createdAt: row.created_at,
      completedAt: row.completed_at ?? null,
    }));

    const recentTransactions: AdminOverviewTransaction[] = (transactionRows.data ?? []).map(row => ({
      id: row.id,
      workspaceId: row.workspace_id,
      workspaceName: transactionNames.get(row.workspace_id) ?? failureNames.get(row.workspace_id) ?? "未知工作区",
      transactionType: row.transaction_type,
      amount: Number(row.amount) || 0,
      balanceAfter: Number(row.balance_after) || 0,
      jobId: row.job_id ?? null,
      createdAt: row.created_at,
    }));

    const providerItems: AdminOverviewProvider[] = (providerList.data ?? []).map(row => ({
      id: row.id,
      workspaceId: row.workspace_id,
      workspaceName: typeof row.workspace_id === "string"
        ? providerNames.get(row.workspace_id) ?? "未知工作区"
        : "平台默认（所有工作区）",
      displayName: row.display_name,
      enabled: row.enabled === true,
      modelCount: modelsPerConfig[row.id] ?? 0,
      lastTestStatus: row.last_test_status,
      lastTestErrorCode: row.last_test_error_code ?? null,
      updatedAt: row.updated_at,
    }));

    const planHistogram: Record<string, number> = {};
    for (const row of planScan.rows) {
      const parsed = subscriptionPlanSchema.safeParse(row.plan);
      const plan = parsed.success ? parsed.data : "free";
      planHistogram[plan] = (planHistogram[plan] ?? 0) + 1;
    }
    // `subscriptions` is UNIQUE(workspace_id), so the histogram covers one row per
    // subscribed workspace. A workspace that never subscribed has no row at all
    // and is on the free plan; counting only the rows would make the histogram
    // sum to less than the workspace count. Only meaningful for a complete scan.
    const workspacesTotal = workspaceResult.count ?? listedWorkspaces.length;
    if (!planScan.truncated) {
      const withoutRow = Math.max(0, workspacesTotal - planScan.rows.length);
      if (withoutRow) planHistogram.free = (planHistogram.free ?? 0) + withoutRow;
    }

    return {
      generatedAt,
      workspaces: {
        total: workspacesTotal,
        byType: Object.fromEntries(WORKSPACE_TYPES.map((type, index) => [type, workspaceTypeCounts[index] ?? 0])),
        items: listedWorkspaces.map(row => ({
          id: row.id,
          name: row.name,
          type: row.type,
          createdAt: row.created_at,
          memberCount: memberCounts[row.id] ?? 0,
          balance: balances.get(row.id) ?? 0,
          plan: plans.get(row.id) ?? "free",
        })),
      },
      jobs: {
        total: Object.values(jobsByStatus).reduce((sum, value) => sum + value, 0),
        active: (jobsByStatus.queued ?? 0) + (jobsByStatus.running ?? 0),
        byStatus: jobsByStatus,
        byType: jobsByType,
        recentFailures,
      },
      credits: {
        totalBalance: creditScan.rows.reduce((sum, row) => sum + (Number(row.balance) || 0), 0),
        byPlan: planHistogram,
        deductionsLast30d: transactionTypeCounts[0] ?? 0,
        refundsLast30d: transactionTypeCounts[1] ?? 0,
        recentTransactions,
        truncated: creditScan.truncated || planScan.truncated,
      },
      providers: {
        configCount: providerList.count ?? providerItems.length,
        disabledConfigCount: providerCounts[0] ?? 0,
        failingTestCount: providerCounts[1] ?? 0,
        modelCount: modelScan.rows.length,
        disabledModelCount: modelScan.rows.filter(row => row.enabled !== true).length,
        modelsByModality,
        items: providerItems,
        truncated: modelScan.truncated,
      },
      skills: {
        total: skillTotal,
        byCategory: Object.fromEntries(SKILL_CATEGORIES.map((category, index) => [category, skillCategoryCounts[index] ?? 0])),
        installs: installScan.rows.length,
        enabledInstalls: installScan.rows.filter(row => row.enabled === true).length,
        truncated: installScan.truncated,
      },
    };
  }

  return { isPlatformAdmin, overview };
}
