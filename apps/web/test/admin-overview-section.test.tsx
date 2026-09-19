// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminOverviewResponse } from "@loomic/shared";

import {
  AdminOverviewSection,
  formatAdminNumber,
  formatAdminTimestamp,
} from "../src/components/admin/admin-overview-section";

const { fetchAdminOverviewMock } = vi.hoisted(() => ({ fetchAdminOverviewMock: vi.fn() }));

vi.mock("../src/lib/server-api", () => ({ fetchAdminOverview: fetchAdminOverviewMock }));

function overview(overrides: Partial<AdminOverviewResponse> = {}): AdminOverviewResponse {
  return {
    generatedAt: "2026-09-20T04:00:00.000Z",
    workspaces: {
      total: 37,
      byType: { personal: 30, team: 7 },
      items: [
        { id: "w1", name: "设计团队", type: "team", createdAt: "2026-09-01T02:00:00.000Z",
          memberCount: 3, balance: 940, plan: "pro" },
        { id: "w2", name: "个人空间", type: "personal", createdAt: "2026-09-02T02:00:00.000Z",
          memberCount: 1, balance: 0, plan: "free" },
      ],
    },
    jobs: {
      total: 1443,
      active: 2,
      byStatus: { queued: 1, running: 1, succeeded: 1400, failed: 10, canceled: 2, dead_letter: 29 },
      byType: { image_generation: 1400, video_generation: 43 },
      recentFailures: [
        { id: "job-1", workspaceId: "w1", workspaceName: "设计团队", jobType: "image_generation",
          status: "dead_letter", errorCode: "provider_rate_limited", errorMessage: "429 上游负载已饱和",
          attemptCount: 3, createdAt: "2026-09-19T10:00:00.000Z", completedAt: null },
        { id: "job-2", workspaceId: "w9", workspaceName: "未知工作区", jobType: "video_generation",
          status: "failed", errorCode: null, errorMessage: null, attemptCount: 0,
          createdAt: "2026-09-19T09:00:00.000Z", completedAt: "2026-09-19T09:01:00.000Z" },
      ],
    },
    credits: {
      totalBalance: 1250,
      byPlan: { pro: 1, free: 2 },
      deductionsLast30d: 88,
      refundsLast30d: 3,
      recentTransactions: [
        { id: "t1", workspaceId: "w1", workspaceName: "设计团队", transactionType: "generation_deduct",
          amount: -7, balanceAfter: 933, jobId: "job-1", createdAt: "2026-09-19T10:00:00.000Z" },
        { id: "t2", workspaceId: "w1", workspaceName: "设计团队", transactionType: "generation_refund",
          amount: 7, balanceAfter: 940, jobId: null, createdAt: "2026-09-19T10:05:00.000Z" },
      ],
      truncated: false,
    },
    providers: {
      configCount: 5, disabledConfigCount: 1, failingTestCount: 1,
      modelCount: 17, disabledModelCount: 2, modelsByModality: { image: 9, text: 6, video: 2 },
      items: [
        { id: "cfg-1", workspaceId: "w1", workspaceName: "设计团队", displayName: "渠道 A", enabled: true,
          modelCount: 4, lastTestStatus: "succeeded", lastTestErrorCode: null, updatedAt: "2026-09-19T08:00:00.000Z" },
        { id: "cfg-2", workspaceId: "w2", workspaceName: "个人空间", displayName: "渠道 B", enabled: false,
          modelCount: 1, lastTestStatus: "failed", lastTestErrorCode: "http_401", updatedAt: "2026-09-19T07:00:00.000Z" },
      ],
      truncated: false,
    },
    skills: { total: 16, byCategory: { design: 13, generation: 1, code: 0, data: 0, writing: 1, custom: 1 },
      installs: 341, enabledInstalls: 300, truncated: false },
    ...overrides,
  };
}

describe("admin overview section", () => {
  beforeEach(() => fetchAdminOverviewMock.mockReset().mockResolvedValue(overview()));
  afterEach(() => cleanup());

  it("renders the snapshot, workspace rows and headline totals", async () => {
    render(<AdminOverviewSection accessToken="token" />);
    expect(await screen.findByTestId("admin-overview")).toBeInTheDocument();
    expect(fetchAdminOverviewMock).toHaveBeenCalledWith("token");
    expect(screen.getByText(/数据快照：2026-09-20 12:00/)).toBeInTheDocument();

    const table = screen.getByTestId("admin-workspaces");
    expect(within(table).getByText("设计团队")).toBeInTheDocument();
    expect(within(table).getByText("专业")).toBeInTheDocument();
    expect(within(table).getByText("免费")).toBeInTheDocument();
    expect(within(table).getByText("940")).toBeInTheDocument();
    // Totals show the whole install, not just the listed window.
    expect(screen.getByText("1,443")).toBeInTheDocument();
  });

  it("lists recent failures with their code and upstream text", async () => {
    render(<AdminOverviewSection accessToken="token" />);
    const table = await screen.findByTestId("admin-failures");
    expect(within(table).getByText("设计团队")).toBeInTheDocument();
    expect(within(table).getByText("死信")).toBeInTheDocument();
    expect(within(table).getByText("provider_rate_limited")).toBeInTheDocument();
    expect(within(table).getByText("429 上游负载已饱和")).toBeInTheDocument();
    // A job whose workspace could not be resolved, and a job with no code, are
    // both stated rather than left blank.
    expect(within(table).getByText("未知工作区")).toBeInTheDocument();
    expect(within(table).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows transaction signs, refunds and the job link column", async () => {
    render(<AdminOverviewSection accessToken="token" />);
    const table = await screen.findByTestId("admin-transactions");
    expect(within(table).getByText("生成扣费")).toBeInTheDocument();
    expect(within(table).getByText("-7")).toBeInTheDocument();
    expect(within(table).getByText("+7")).toBeInTheDocument();
    expect(within(table).getByText("job-1")).toBeInTheDocument();
    expect(screen.getByText(/近 30 天扣费 88 笔、退款 3 笔/)).toBeInTheDocument();
  });

  it("surfaces channel health including a disabled config and its test error", async () => {
    render(<AdminOverviewSection accessToken="token" />);
    const table = await screen.findByTestId("admin-providers");
    expect(within(table).getByText("渠道 B")).toBeInTheDocument();
    expect(within(table).getByText("http_401")).toBeInTheDocument();
    expect(screen.getByText(/停用 1 个、自检失败 1 个/)).toBeInTheDocument();
    expect(screen.getByText(/技能包 16 个/)).toBeInTheDocument();
  });

  it("says a scan was truncated instead of letting a short total look complete", async () => {
    fetchAdminOverviewMock.mockResolvedValue(overview({
      credits: { ...overview().credits, truncated: true },
    }));
    render(<AdminOverviewSection accessToken="token" />);
    expect(await screen.findByText(/部分统计已达扫描上限/)).toBeInTheDocument();
    expect(screen.getByText(/余额或套餐统计已达扫描上限/)).toBeInTheDocument();
  });

  it("states empty sections explicitly", async () => {
    const empty = overview();
    fetchAdminOverviewMock.mockResolvedValue({
      ...empty,
      workspaces: { ...empty.workspaces, items: [] },
      jobs: { ...empty.jobs, recentFailures: [] },
      providers: { ...empty.providers, items: [] },
    });
    render(<AdminOverviewSection accessToken="token" />);
    expect(await screen.findByText("暂无工作区。")).toBeInTheDocument();
    expect(screen.getByText("最近没有失败任务。")).toBeInTheDocument();
    expect(screen.getByText("尚未配置第三方渠道。")).toBeInTheDocument();
  });

  it("reports a load failure and retries", async () => {
    fetchAdminOverviewMock
      .mockRejectedValueOnce(new Error("平台总览加载失败，请稍后重试。"))
      .mockResolvedValueOnce(overview());
    render(<AdminOverviewSection accessToken="token" />);

    expect(await screen.findByText("平台总览加载失败，请稍后重试。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByTestId("admin-overview")).toBeInTheDocument();
    expect(fetchAdminOverviewMock).toHaveBeenCalledTimes(2);
  });

  it("formats numbers and timestamps in Beijing time, with a dash for missing values", () => {
    expect(formatAdminNumber(1443)).toBe("1,443");
    expect(formatAdminTimestamp("2026-09-20T04:00:00.000Z")).toBe("2026-09-20 12:00");
    expect(formatAdminTimestamp(null)).toBe("—");
    expect(formatAdminTimestamp("not-a-date")).toBe("—");
  });
});
