import { describe, expect, it, vi } from "vitest";

import {
  ADMIN_OVERVIEW_LIST_LIMIT,
  ADMIN_OVERVIEW_SCAN_MAX_PAGES,
  ADMIN_OVERVIEW_SCAN_PAGE_SIZE,
  ADMIN_OVERVIEW_WORKSPACE_LIMIT,
  AdminOverviewError,
  createAdminOverviewService,
} from "./admin-overview-service.js";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

const iso = (minutesAgo: number) => new Date(Date.UTC(2026, 8, 20, 12, 0, 0) - minutesAgo * 60_000).toISOString();

/**
 * Minimal PostgREST-shaped fake: it records the filters a query used, then
 * answers from an in-memory table with the same `{ data, error, count }` shape
 * the service consumes. Head counts report the filtered length, `range` slices
 * like a page, and `maybeSingle` returns first-or-null, so the service's
 * aggregation and paging logic are exercised rather than stubbed.
 */
function fakeAdmin(tables: Tables) {
  const queries: Array<{ table: string; filters: Array<[string, unknown]>; head: boolean }> = [];
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let inFilter: [string, readonly unknown[]] | null = null;
    let gteFilter: [string, unknown] | null = null;
    let limit: number | null = null;
    let range: [number, number] | null = null;
    let head = false;
    let counting = false;

    const rowsNow = () => {
      let rows = [...(tables[table] ?? [])];
      for (const [column, value] of filters) {
        rows = value === null
          ? rows.filter(row => row[column] === null || row[column] === undefined)
          : rows.filter(row => row[column] === value);
      }
      if (inFilter) rows = rows.filter(row => (inFilter![1] as readonly unknown[]).includes(row[inFilter![0]]));
      if (gteFilter) rows = rows.filter(row => String(row[gteFilter![0]]) >= String(gteFilter![1]));
      return rows;
    };
    const finish = () => {
      const rows = rowsNow();
      queries.push({ table, filters, head });
      const page = range ? rows.slice(range[0], range[1] + 1) : limit === null ? rows : rows.slice(0, limit);
      return { data: counting && head ? null : page, error: null, count: counting ? rows.length : null };
    };
    const builder: any = {
      select(_columns: string, opts?: { count?: string; head?: boolean }) {
        counting = opts?.count === "exact";
        head = opts?.head === true;
        return builder;
      },
      eq(column: string, value: unknown) { filters.push([column, value]); return builder; },
      is(column: string, value: unknown) { filters.push([column, value]); return builder; },
      in(column: string, values: readonly unknown[]) { inFilter = [column, values]; return builder; },
      gte(column: string, value: unknown) { gteFilter = [column, value]; return builder; },
      order() { return builder; },
      limit(value: number) { limit = value; return builder; },
      range(first: number, last: number) { range = [first, last]; return builder; },
      maybeSingle: async () => {
        const rows = rowsNow();
        queries.push({ table, filters, head });
        return { data: rows[0] ?? null, error: null };
      },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(finish()).then(resolve),
    };
    return builder;
  };
  return { client: { from } as never, queries };
}

const workspace = (index: number, type: "personal" | "team" = "personal"): Row => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  name: `workspace-${index}`,
  type,
  owner_user_id: "11111111-1111-4111-8111-111111111111",
  created_at: iso(index),
  updated_at: iso(index),
});

function baseTables(): Tables {
  return {
    platform_admins: [{ user_id: "admin", is_active: true, revoked_at: null }],
    workspaces: [workspace(1), workspace(2, "team"), workspace(3)],
    workspace_members: [
      { workspace_id: workspace(1).id, role: "owner" },
      { workspace_id: workspace(1).id, role: "member" },
      { workspace_id: workspace(2).id, role: "owner" },
    ],
    credit_balances: [
      { workspace_id: workspace(1).id, balance: 100 },
      { workspace_id: workspace(2).id, balance: 40 },
      { workspace_id: workspace(3).id, balance: 5 },
    ],
    subscriptions: [
      { workspace_id: workspace(1).id, plan: "pro" },
      { workspace_id: workspace(2).id, plan: "not-a-plan" },
    ],
    background_jobs: [
      { id: "job-1", workspace_id: workspace(1).id, job_type: "image_generation", status: "succeeded",
        error_code: null, error_message: null, attempt_count: 1, created_at: iso(10), completed_at: iso(9) },
      { id: "job-2", workspace_id: workspace(2).id, job_type: "image_generation", status: "dead_letter",
        error_code: "provider_rate_limited", error_message: "429 上游负载已饱和".repeat(40), attempt_count: 3,
        created_at: iso(8), completed_at: null },
      { id: "job-3", workspace_id: "99999999-9999-4999-8999-999999999999", job_type: "video_generation",
        status: "failed", error_code: "http_401", error_message: "Invalid token", attempt_count: 1,
        created_at: iso(7), completed_at: iso(7) },
      { id: "job-4", workspace_id: workspace(1).id, job_type: "video_generation", status: "running",
        error_code: null, error_message: null, attempt_count: 0, created_at: iso(6), completed_at: null },
      { id: "job-5", workspace_id: workspace(1).id, job_type: "image_generation", status: "queued",
        error_code: null, error_message: null, attempt_count: 0, created_at: iso(5), completed_at: null },
    ],
    workspace_provider_configs: [
      { id: "cfg-1", workspace_id: workspace(1).id, display_name: "渠道 A", enabled: true,
        last_test_status: "succeeded", last_test_error_code: null, updated_at: iso(3) },
      { id: "cfg-2", workspace_id: workspace(2).id, display_name: "渠道 B", enabled: false,
        last_test_status: "failed", last_test_error_code: "http_401", updated_at: iso(2) },
      // The platform-wide default channel has no owning workspace.
      { id: "cfg-platform", workspace_id: null, display_name: "平台默认", enabled: true,
        last_test_status: "succeeded", last_test_error_code: null, updated_at: iso(4) },
    ],
    workspace_provider_models: [
      { id: "m1", provider_config_id: "cfg-1", modality: "image", enabled: true },
      { id: "m2", provider_config_id: "cfg-1", modality: "text", enabled: true },
      { id: "m3", provider_config_id: "cfg-2", modality: "image", enabled: false },
      { id: "m4", provider_config_id: "cfg-platform", modality: "video", enabled: true },
    ],
    skills: [
      { id: "s1", category: "design" },
      { id: "s2", category: "design" },
      { id: "s3", category: "custom" },
    ],
    workspace_skills: [
      { workspace_id: workspace(1).id, enabled: true },
      { workspace_id: workspace(1).id, enabled: false },
      { workspace_id: workspace(2).id, enabled: true },
    ],
    credit_transactions: [
      { id: "t1", workspace_id: workspace(1).id, transaction_type: "generation_deduct", amount: -7,
        balance_after: 93, job_id: "job-1", created_at: iso(10) },
      { id: "t2", workspace_id: "99999999-9999-4999-8999-999999999999", transaction_type: "generation_refund",
        amount: 7, balance_after: 40, job_id: null, created_at: iso(4) },
    ],
  };
}

function service(tables: Tables) {
  const fake = fakeAdmin(tables);
  const created = createAdminOverviewService({
    getAdminClient: () => fake.client,
    now: () => new Date(Date.UTC(2026, 8, 20, 12, 0, 0)),
  });
  return { ...created, fake };
}

describe("admin overview service", () => {
  it("only treats an active, non-revoked platform admin as authorized", async () => {
    const tables = baseTables();
    const { isPlatformAdmin, fake } = service(tables);
    await expect(isPlatformAdmin("admin")).resolves.toBe(true);
    await expect(isPlatformAdmin("someone-else")).resolves.toBe(false);
    const lookup = fake.queries.find(query => query.table === "platform_admins")!;
    expect(lookup.filters).toEqual([["user_id", "admin"], ["is_active", true], ["revoked_at", null]]);

    const inactive = baseTables();
    inactive.platform_admins = [{ user_id: "admin", is_active: false, revoked_at: null }];
    await expect(service(inactive).isPlatformAdmin("admin")).resolves.toBe(false);
  });

  it("counts jobs and workspaces exactly, and derives active work from statuses", async () => {
    const { overview } = service(baseTables());
    const result = await overview();
    expect(result.workspaces.total).toBe(3);
    expect(result.workspaces.byType).toEqual({ personal: 2, team: 1 });
    expect(result.jobs.total).toBe(5);
    expect(result.jobs.byStatus).toMatchObject({ queued: 1, running: 1, succeeded: 1, failed: 1, dead_letter: 1, canceled: 0 });
    expect(result.jobs.active).toBe(2);
    expect(result.jobs.byType).toMatchObject({ image_generation: 3, video_generation: 2 });
  });

  it("joins workspace facts onto each listed workspace and defaults a missing plan", async () => {
    const { overview } = service(baseTables());
    const result = await overview();
    expect(result.workspaces.items).toHaveLength(3);
    expect(result.workspaces.items[0]).toMatchObject({ name: "workspace-1", memberCount: 2, balance: 100, plan: "pro" });
    // A workspace with no subscription row is on the free plan, not undefined.
    expect(result.workspaces.items.find(item => item.name === "workspace-3")).toMatchObject({ plan: "free", balance: 5 });
  });

  it("reports recent failures with a resolved workspace name and a bounded error message", async () => {
    const { overview } = service(baseTables());
    const result = await overview();
    expect(result.jobs.recentFailures).toHaveLength(2);
    const dead = result.jobs.recentFailures.find(job => job.id === "job-2")!;
    expect(dead.workspaceName).toBe("workspace-2");
    expect(dead.errorCode).toBe("provider_rate_limited");
    expect(dead.errorMessage!.length).toBeLessThanOrEqual(301);
    expect(dead.errorMessage!.endsWith("…")).toBe(true);
    // A job whose workspace cannot be resolved says so instead of showing a uuid.
    const orphan = result.jobs.recentFailures.find(job => job.id === "job-3")!;
    expect(orphan.workspaceName).toBe("未知工作区");
    expect(orphan.errorMessage).toBe("Invalid token");
  });

  it("bounds the failure and transaction lists", async () => {
    const tables = baseTables();
    tables.background_jobs = Array.from({ length: 40 }, (_, index) => ({
      id: `job-${index}`, workspace_id: workspace(1).id, job_type: "image_generation", status: "dead_letter",
      error_code: "provider_rejected", error_message: "no channel", attempt_count: 1, created_at: iso(index), completed_at: null,
    }));
    tables.credit_transactions = Array.from({ length: 40 }, (_, index) => ({
      id: `t-${index}`, workspace_id: workspace(1).id, transaction_type: "generation_deduct", amount: -1,
      balance_after: 1, job_id: null, created_at: iso(index),
    }));
    const result = await service(tables).overview();
    expect(result.jobs.recentFailures).toHaveLength(ADMIN_OVERVIEW_LIST_LIMIT);
    expect(result.credits.recentTransactions).toHaveLength(ADMIN_OVERVIEW_LIST_LIMIT);
  });

  it("sums balances across pages and histograms plans, falling back to free", async () => {
    const tables = baseTables();
    const { overview } = service(tables);
    const result = await overview();
    expect(result.credits.totalBalance).toBe(145);
    expect(result.credits.byPlan).toEqual({ pro: 1, free: 2 });
    expect(result.credits.truncated).toBe(false);
    expect(result.credits.recentTransactions[0]).toMatchObject({ workspaceName: "workspace-1", amount: -7, balanceAfter: 93 });
    // A transaction whose workspace is not in the listed window still resolves.
    expect(result.credits.recentTransactions[1]).toMatchObject({ workspaceName: "未知工作区" });
  });

  it("reports truncated instead of a silently short total when a scan hits its cap", async () => {
    const tables = baseTables();
    const cap = ADMIN_OVERVIEW_SCAN_PAGE_SIZE * ADMIN_OVERVIEW_SCAN_MAX_PAGES;
    tables.credit_balances = Array.from({ length: cap }, (_, index) => ({
      workspace_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      balance: 1,
    }));
    const result = await service(tables).overview();
    expect(result.credits.truncated).toBe(true);
    expect(result.credits.totalBalance).toBe(cap);
  });

  it("bounds the workspace and provider lists", async () => {
    const tables = baseTables();
    tables.workspaces = Array.from({ length: ADMIN_OVERVIEW_WORKSPACE_LIMIT + 10 },
      (_, index) => workspace(index + 1));
    tables.workspace_provider_configs = Array.from({ length: ADMIN_OVERVIEW_WORKSPACE_LIMIT + 10 }, (_, index) => ({
      id: `cfg-${index}`, workspace_id: workspace(1).id, display_name: `渠道 ${index}`, enabled: true,
      last_test_status: "never", last_test_error_code: null, updated_at: iso(index),
    }));
    const result = await service(tables).overview();
    expect(result.workspaces.items).toHaveLength(ADMIN_OVERVIEW_WORKSPACE_LIMIT);
    expect(result.providers.items).toHaveLength(ADMIN_OVERVIEW_WORKSPACE_LIMIT);
    expect(result.workspaces.total).toBe(ADMIN_OVERVIEW_WORKSPACE_LIMIT + 10);
    expect(result.providers.configCount).toBe(ADMIN_OVERVIEW_WORKSPACE_LIMIT + 10);
  });

  it("summarizes provider and skill catalogs without counting rows twice", async () => {
    const result = await service(baseTables()).overview();
    expect(result.providers).toMatchObject({
      configCount: 3, disabledConfigCount: 1, failingTestCount: 1,
      modelCount: 4, disabledModelCount: 1, modelsByModality: { image: 2, text: 1, video: 1 }, truncated: false,
    });
    expect(result.providers.items.find(item => item.id === "cfg-1")).toMatchObject({ workspaceName: "workspace-1", modelCount: 2 });
    expect(result.providers.items.find(item => item.id === "cfg-2")).toMatchObject({ modelCount: 1, enabled: false, lastTestErrorCode: "http_401" });
    // The platform channel carries no workspace id and is labelled, not "unknown".
    expect(result.providers.items.find(item => item.id === "cfg-platform")).toMatchObject({
      workspaceId: null, workspaceName: "平台默认（所有工作区）", modelCount: 1, enabled: true,
    });
    expect(result.skills).toEqual({ total: 3, byCategory: { design: 2, generation: 0, code: 0, data: 0, writing: 0, custom: 1 },
      installs: 3, enabledInstalls: 2, truncated: false });
  });

  it("fails closed with a 500-shaped error instead of returning partial data", async () => {
    const broken = createAdminOverviewService({
      getAdminClient: () => ({ from: () => { throw new Error("no database"); } }) as never,
    });
    await expect(broken.overview()).rejects.toBeInstanceOf(AdminOverviewError);
    await expect(broken.overview()).rejects.toMatchObject({ code: "admin_overview_failed", statusCode: 500 });
    await expect(broken.isPlatformAdmin("admin")).rejects.toMatchObject({ code: "admin_overview_failed" });
  });

  it("reports a query error rather than an empty overview", async () => {
    const tables = baseTables();
    const client = {
      from: (table: string) => {
        const builder: any = {
          select: () => builder, eq: () => builder, is: () => builder, in: () => builder,
          gte: () => builder, order: () => builder, limit: () => builder, range: () => builder,
          maybeSingle: async () => ({ data: { user_id: "admin" }, error: null }),
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(
            table === "workspaces" ? { data: null, error: { message: "boom" }, count: null } : { data: [], error: null, count: 0 },
          ).then(resolve),
        };
        return builder;
      },
    };
    const created = createAdminOverviewService({ getAdminClient: () => client as never });
    await expect(created.overview()).rejects.toMatchObject({ code: "admin_overview_failed", statusCode: 500 });
    void tables;
    void vi;
  });
});
