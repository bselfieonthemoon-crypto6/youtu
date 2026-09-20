// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminWorkspaceBillingResponse } from "@loomic/shared";

import {
  AdminBillingSection,
  billingPlanLabel,
  billingTransactionLabel,
  formatBillingTimestamp,
  planSummary,
} from "../src/components/admin/admin-billing-section";

const { fetchWorkspacesMock, fetchBillingMock, setPlanMock, adjustMock } = vi.hoisted(() => ({
  fetchWorkspacesMock: vi.fn(),
  fetchBillingMock: vi.fn(),
  setPlanMock: vi.fn(),
  adjustMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  fetchAdminWorkspaces: fetchWorkspacesMock,
  fetchAdminWorkspaceBilling: fetchBillingMock,
  adminSetWorkspacePlan: setPlanMock,
  adminAdjustWorkspaceCredits: adjustMock,
}));

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function billing(overrides: Partial<AdminWorkspaceBillingResponse> = {}): AdminWorkspaceBillingResponse {
  return {
    workspace: { id: WORKSPACE, name: "设计团队", type: "team", createdAt: "2026-09-01T00:00:00.000Z" },
    plan: "pro",
    balance: 940,
    subscription: {
      billingPeriod: "monthly", currentPeriodStart: "2026-09-01T00:00:00.000Z",
      currentPeriodEnd: "2026-10-01T00:00:00.000Z", canceledAt: null, hasExternalSubscription: true,
    },
    last30d: { deductedCredits: 21, refundedCredits: 7 },
    recentTransactions: [{
      id: "t1", transactionType: "generation_deduct", amount: -7, balanceAfter: 933, jobId: null,
      description: "第 3 页配图", actorEmail: "member@example.com", createdAt: "2026-09-20T04:00:00.000Z",
    }],
    mismatchedJobs: [],
    ...overrides,
  };
}

describe("admin billing section", () => {
  /** The panel only renders after the workspaces load picks a workspace. */
  async function renderReady() {
    render(<AdminBillingSection accessToken="token" />);
    await screen.findByRole("button", { name: "修改套餐" });
  }

  beforeEach(() => {
    fetchWorkspacesMock.mockReset().mockResolvedValue({ workspaces: [
      { id: WORKSPACE, name: "设计团队", type: "team", createdAt: "2026-09-01T00:00:00.000Z", memberCount: 3 },
      { id: OTHER, name: "另一个工作区", type: "personal", createdAt: "2026-09-02T00:00:00.000Z", memberCount: 1 },
    ] });
    fetchBillingMock.mockReset().mockResolvedValue(billing());
    setPlanMock.mockReset();
    adjustMock.mockReset();
  });
  afterEach(() => cleanup());

  it("shows the plan, balance, subscription window and 30-day totals", async () => {
    render(<AdminBillingSection accessToken="token" />);
    const section = await screen.findByTestId("admin-billing");
    await waitFor(() => expect(fetchBillingMock).toHaveBeenCalledWith("token", WORKSPACE));
    await screen.findByRole("button", { name: "修改套餐" });
    expect(within(section).getByText(/每月 .* 额度 · 并发/)).toBeInTheDocument();
    expect(within(section).getByText("940")).toBeInTheDocument();
    expect(within(section).getByText("外部支付渠道")).toBeInTheDocument();
    expect(within(section).getByText(/订阅周期：2026-09-01 08:00 → 2026-10-01 08:00/)).toBeInTheDocument();
    expect(within(section).getByText("生成扣费")).toBeInTheDocument();
  });

  it("loads the billing view again when another workspace is chosen", async () => {
    await renderReady();
    await userEvent.selectOptions(screen.getByLabelText("选择工作区"), OTHER);
    await waitFor(() => expect(fetchBillingMock).toHaveBeenLastCalledWith("token", OTHER));
  });

  it("requires a reason and an explicit confirmation before changing the plan", async () => {
    setPlanMock.mockResolvedValue(undefined);
    await renderReady();

    const start = screen.getByRole("button", { name: "修改套餐" });
    expect(start).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("选择套餐"), "ultra");
    await userEvent.clear(screen.getByLabelText("同时发放额度"));
    await userEvent.type(screen.getByLabelText("同时发放额度"), "500");
    await userEvent.type(screen.getByLabelText("修改套餐原因"), "商务补偿");
    expect(start).toBeEnabled();
    await userEvent.click(start);

    const confirmText = await screen.findByTestId("admin-billing-plan-confirm");
    expect(confirmText).toHaveTextContent("确认把套餐改为旗舰，并发放 500 额度？（当前为专业）");
    expect(setPlanMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "确认执行" }));
    expect(setPlanMock).toHaveBeenCalledWith("token", WORKSPACE, { plan: "ultra", grantCredits: 500, reason: "商务补偿" });
    expect(await screen.findByTestId("admin-billing-feedback")).toHaveTextContent("已把 设计团队 的套餐改为旗舰");
  });

  it("can cancel a pending plan change without calling the server", async () => {
    await renderReady();
    await userEvent.selectOptions(screen.getByLabelText("选择套餐"), "business");
    await userEvent.type(screen.getByLabelText("修改套餐原因"), "内部测试");
    await userEvent.click(screen.getByRole("button", { name: "修改套餐" }));
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(setPlanMock).not.toHaveBeenCalled();
  });

  it("shows the resulting balance before confirming a credit adjustment", async () => {
    adjustMock.mockResolvedValue(undefined);
    await renderReady();

    const start = screen.getByRole("button", { name: "调整额度" });
    expect(start).toBeDisabled();
    await userEvent.type(screen.getByLabelText("额度增减数值"), "-200");
    await userEvent.type(screen.getByLabelText("调整额度原因"), "失败任务补偿");
    await userEvent.click(start);

    expect(await screen.findByTestId("admin-billing-adjust-confirm"))
      .toHaveTextContent(/确认扣减 200 额度？\s*余额将从 940 变为 740。/);
    await userEvent.click(screen.getByRole("button", { name: "确认执行" }));
    expect(adjustMock).toHaveBeenCalledWith("token", WORKSPACE, { delta: -200, reason: "失败任务补偿" });
    expect(await screen.findByTestId("admin-billing-feedback")).toHaveTextContent("已扣减 200 额度");
  });

  it("refuses a zero or non-numeric adjustment locally", async () => {
    await renderReady();
    await userEvent.type(screen.getByLabelText("额度增减数值"), "0");
    await userEvent.type(screen.getByLabelText("调整额度原因"), "无效");
    expect(screen.getByRole("button", { name: "调整额度" })).toBeDisabled();
    expect(screen.getByText("额度增减必须是非零整数（±1000000 以内）。")).toBeInTheDocument();
  });

  it("surfaces an insufficient-balance refusal and keeps the panel usable", async () => {
    adjustMock.mockRejectedValue(new Error("该工作区余额不足，扣减后不能为负数。"));
    await renderReady();
    await userEvent.type(screen.getByLabelText("额度增减数值"), "-5000");
    await userEvent.type(screen.getByLabelText("调整额度原因"), "扣减");
    await userEvent.click(screen.getByRole("button", { name: "调整额度" }));
    await userEvent.click(screen.getByRole("button", { name: "确认执行" }));
    expect(await screen.findByTestId("admin-billing-feedback")).toHaveTextContent("余额不足");
    expect(screen.getByTestId("admin-billing-transactions")).toBeInTheDocument();
  });

  it("lists the reconciliation mismatches and states an empty one explicitly", async () => {
    fetchBillingMock.mockResolvedValue(billing({ mismatchedJobs: [{
      jobId: "33333333-3333-4333-8333-333333333333", status: "succeeded", jobType: "image_generation",
      recordedCreditsCost: 7, ledgerCharged: 5, ledgerRefunded: 0, createdAt: "2026-09-20T04:00:00.000Z",
    }] }));
    render(<AdminBillingSection accessToken="token" />);
    const table = await screen.findByTestId("admin-billing-mismatches");
    expect(within(table).getByText("33333333-3333-4333-8333-333333333333")).toBeInTheDocument();
    expect(within(table).getByText("7")).toBeInTheDocument();
    expect(within(table).getByText("5")).toBeInTheDocument();
    cleanup();

    fetchBillingMock.mockResolvedValue(billing());
    render(<AdminBillingSection accessToken="token" />);
    expect(await screen.findByText("没有发现不一致的任务。")).toBeInTheDocument();
  });

  it("reports a load failure and retries", async () => {
    fetchBillingMock.mockRejectedValueOnce(new Error("套餐与额度加载失败，请稍后重试。"))
      .mockResolvedValueOnce(billing());
    render(<AdminBillingSection accessToken="token" />);
    expect(await screen.findByText("套餐与额度加载失败，请稍后重试。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByTestId("admin-billing-transactions")).toBeInTheDocument();
  });

  it("states an empty ledger and labels plans, transactions and timestamps", async () => {
    fetchBillingMock.mockResolvedValue(billing({ recentTransactions: [] }));
    render(<AdminBillingSection accessToken="token" />);
    expect(await screen.findByText("该工作区还没有额度流水。")).toBeInTheDocument();
    cleanup();

    expect(billingPlanLabel("business")).toBe("企业");
    expect(billingPlanLabel("future_plan")).toBe("future_plan");
    expect(billingTransactionLabel("admin_adjustment")).toBe("后台调整");
    expect(billingTransactionLabel("unknown_type")).toBe("unknown_type");
    expect(formatBillingTimestamp("2026-09-20T04:00:00.000Z")).toBe("2026-09-20 12:00");
    expect(formatBillingTimestamp(null)).toBe("—");
    expect(planSummary("pro")).toContain("每月");
  });
});
