// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminJobDetailResponse, AdminJobListResponse } from "@loomic/shared";

import {
  AdminJobsSection,
  adminJobActionLabel,
  adminJobStatusLabel,
  adminJobTypeLabel,
  formatJobAge,
  formatJobTimestamp,
} from "../src/components/admin/admin-jobs-section";

const { listMock, detailMock, workspacesMock, cancelMock, acknowledgeMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  detailMock: vi.fn(),
  workspacesMock: vi.fn(),
  cancelMock: vi.fn(),
  acknowledgeMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  fetchAdminJobs: listMock,
  fetchAdminJobDetail: detailMock,
  fetchAdminWorkspaces: workspacesMock,
  cancelAdminJob: cancelMock,
  acknowledgeAdminJob: acknowledgeMock,
}));

const JOB = "33333333-3333-4333-8333-333333333333";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";

const jobRow = {
  id: JOB, status: "dead_letter", jobType: "image_generation", queueName: "image_generation_jobs",
  workspaceId: WORKSPACE, workspaceName: "设计团队", createdBy: "user-1", createdByEmail: "member@example.com",
  title: "咖啡店开业海报", model: "workspace:model", createdAt: "2026-09-20T04:00:00.000Z",
  startedAt: "2026-09-20T04:00:05.000Z", completedAt: null, attemptCount: 3, maxAttempts: 3,
  errorCode: "provider_rate_limited", errorMessage: "429 上游负载已饱和", creditsCost: 0,
  stuck: false, ageSeconds: 3600, acknowledgedAt: null, acknowledgedByEmail: null, acknowledgeReason: null,
};

const stuckRow = { ...jobRow, id: "44444444-4444-4444-8444-444444444444", status: "queued", errorCode: null,
  errorMessage: null, attemptCount: 0, startedAt: null, stuck: true, ageSeconds: 5400, createdByEmail: "other@example.com" };

const list: AdminJobListResponse = { total: 2, jobs: [jobRow, stuckRow] };

const detail: AdminJobDetailResponse = {
  job: {
    id: JOB, status: "dead_letter", jobType: "image_generation", queueName: "image_generation_jobs",
    workspaceId: WORKSPACE, workspaceName: "设计团队", createdBy: "user-1", createdByEmail: "member@example.com",
    createdAt: "2026-09-20T04:00:00.000Z", startedAt: "2026-09-20T04:00:05.000Z", completedAt: null,
    attemptCount: 3, maxAttempts: 3, errorCode: "provider_rate_limited", errorMessage: "429 上游负载已饱和",
    creditsCost: 0, acknowledgedAt: null, acknowledgedByEmail: null, acknowledgeReason: null,
    sessionId: "session-1", sessionTitle: "开业海报", canvasId: "canvas-1", failedAt: "2026-09-20T04:01:00.000Z",
    canceledAt: null, creditsTransactionId: null, payloadPreview: "{\"prompt\":\"咖啡\"}", resultPreview: null,
  },
  transactions: [{ id: "t1", transactionType: "generation_deduct", amount: -7, balanceAfter: 933,
    description: "生成扣费", createdAt: "2026-09-20T04:00:06.000Z" }],
  audit: [{ action: "job.failure.acknowledge", reason: "已知悉", actorEmail: "admin@example.com",
    actorUserId: "admin-1", createdAt: "2026-09-20T05:00:00.000Z" }],
};

describe("admin jobs section", () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue(list);
    detailMock.mockReset().mockResolvedValue(detail);
    workspacesMock.mockReset().mockResolvedValue({ workspaces: [
      { id: WORKSPACE, name: "设计团队", type: "team", createdAt: "2026-09-01T00:00:00.000Z", memberCount: 3 },
    ] });
    cancelMock.mockReset();
    acknowledgeMock.mockReset();
  });
  afterEach(() => cleanup());

  it("lists jobs with their error code, attempts and stuck state", async () => {
    render(<AdminJobsSection accessToken="token" />);
    const table = await screen.findByTestId("admin-job-table");
    expect(within(table).getByText("死信")).toBeInTheDocument();
    expect(within(table).getByText("provider_rate_limited")).toBeInTheDocument();
    expect(within(table).getByText("3/3")).toBeInTheDocument();
    expect(within(table).getByTestId("admin-job-stuck")).toHaveTextContent("卡住 1.5 小时");
    expect(screen.getByText("共 2 条匹配，当前显示前 2 条。")).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith("token", { sinceHours: 24, limit: 50 });
  });

  it("applies filters on submit rather than on every change", async () => {
    render(<AdminJobsSection accessToken="token" />);
    await screen.findByTestId("admin-job-table");
    await userEvent.selectOptions(screen.getByLabelText("任务状态"), "dead_letter");
    expect(listMock).toHaveBeenCalledTimes(1);

    await userEvent.selectOptions(screen.getByLabelText("任务类型"), "image_generation");
    await userEvent.selectOptions(screen.getByLabelText("任务工作区"), WORKSPACE);
    await userEvent.type(screen.getByLabelText("错误码"), "provider_rate_limited");
    await userEvent.selectOptions(screen.getByLabelText("时间范围"), "168");
    await userEvent.click(screen.getByRole("button", { name: "查询" }));
    await waitFor(() => expect(listMock).toHaveBeenLastCalledWith("token", {
      status: "dead_letter", jobType: "image_generation", workspaceId: WORKSPACE,
      errorCode: "provider_rate_limited", sinceHours: 168, limit: 50,
    }));
  });

  it("opens a job with its attempts, upstream error, ledger and admin history", async () => {
    render(<AdminJobsSection accessToken="token" />);
    const table = await screen.findByTestId("admin-job-table");
    await userEvent.click(within(table).getAllByRole("button", { name: "详情" })[0]!);

    const panel = await screen.findByTestId("admin-job-detail");
    expect(detailMock).toHaveBeenCalledWith("token", JOB);
    expect(within(panel).getByText("开业海报")).toBeInTheDocument();
    expect(within(panel).getByTestId("admin-job-error")).toHaveTextContent("429 上游负载已饱和");
    expect(within(panel).getByText(/generation_deduct/)).toBeInTheDocument();
    expect(within(panel).getByTestId("admin-job-audit")).toHaveTextContent("标记已处置");
    expect(within(panel).getByText(/\{\"prompt\":\"咖啡\"\}/)).toBeInTheDocument();
  });

  it("shows the derived acknowledgement state of a reviewed failure", async () => {
    // The detail function returns the acknowledgement, not just the list, so the
    // panel must read it from the job row it already has.
    detailMock.mockResolvedValue({ ...detail,
      job: { ...detail.job, acknowledgedAt: "2026-09-20T05:00:00.000Z",
        acknowledgedByEmail: "admin@example.com", acknowledgeReason: "上游已恢复，已复核" } });
    render(<AdminJobsSection accessToken="token" />);
    const table = await screen.findByTestId("admin-job-table");
    await userEvent.click(within(table).getAllByRole("button", { name: "详情" })[0]!);

    const panel = await screen.findByTestId("admin-job-detail");
    expect(within(panel).getByText(/^已处置 · /)).toBeInTheDocument();
    expect(within(panel).getByText("处置").parentElement).toHaveTextContent("已处置 ·");
  });

  it("cancels a queued job only after an inline reason and confirmation", async () => {
    cancelMock.mockResolvedValue(undefined);
    // The queued job's own detail must say "queued", otherwise the panel offers no
    // cancel action at all (a terminal job is acknowledged, not cancelled).
    detailMock.mockImplementation(async (_token: string, jobId: string) => (
      jobId === stuckRow.id ? { ...detail, job: { ...detail.job, id: stuckRow.id, status: "queued" } } : detail));
    render(<AdminJobsSection accessToken="token" />);
    const table = await screen.findByTestId("admin-job-table");
    await userEvent.click(within(table).getAllByRole("button", { name: "详情" })[1]!);
    const panel = await screen.findByTestId("admin-job-detail");
    await waitFor(() => expect(within(panel).getByRole("button", { name: "取消任务" })).toBeInTheDocument());

    await userEvent.click(within(panel).getByRole("button", { name: "取消任务" }));
    expect(cancelMock).not.toHaveBeenCalled();
    const confirm = within(panel).getByRole("button", { name: "确认取消" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(panel).getByLabelText("取消任务原因"), "上游长期无响应");
    await userEvent.click(confirm);

    expect(cancelMock).toHaveBeenCalledWith("token", stuckRow.id, "上游长期无响应");
    expect(await screen.findByTestId("admin-jobs-feedback")).toHaveTextContent("已取消该任务");
  });

  it("marks a terminal failure as handled with a reason", async () => {
    acknowledgeMock.mockResolvedValue(undefined);
    render(<AdminJobsSection accessToken="token" />);
    const table = await screen.findByTestId("admin-job-table");
    await userEvent.click(within(table).getAllByRole("button", { name: "详情" })[0]!);
    const panel = await screen.findByTestId("admin-job-detail");

    await userEvent.click(within(panel).getByRole("button", { name: "标记已处置" }));
    const confirm = within(panel).getByRole("button", { name: "确认标记" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(panel).getByLabelText("处置说明"), "已知悉，等待上游恢复");
    await userEvent.click(confirm);

    expect(acknowledgeMock).toHaveBeenCalledWith("token", JOB, "已知悉，等待上游恢复");
    expect(await screen.findByTestId("admin-jobs-feedback")).toHaveTextContent("已标记为人工处置");
  });

  it("keeps the panel usable and shows the server's refusal", async () => {
    acknowledgeMock.mockRejectedValue(new Error("只有已结束的任务可以标记为已处置。"));
    render(<AdminJobsSection accessToken="token" />);
    const table = await screen.findByTestId("admin-job-table");
    await userEvent.click(within(table).getAllByRole("button", { name: "详情" })[0]!);
    const panel = await screen.findByTestId("admin-job-detail");
    await userEvent.click(within(panel).getByRole("button", { name: "标记已处置" }));
    await userEvent.type(within(panel).getByLabelText("处置说明"), "尝试标记");
    await userEvent.click(within(panel).getByRole("button", { name: "确认标记" }));
    expect(await screen.findByTestId("admin-jobs-feedback")).toHaveTextContent("只有已结束的任务可以标记为已处置。");
    expect(screen.getByTestId("admin-job-detail")).toBeInTheDocument();
  });

  it("can abandon a pending action without calling the server", async () => {
    render(<AdminJobsSection accessToken="token" />);
    const table = await screen.findByTestId("admin-job-table");
    await userEvent.click(within(table).getAllByRole("button", { name: "详情" })[0]!);
    const panel = await screen.findByTestId("admin-job-detail");
    await userEvent.click(within(panel).getByRole("button", { name: "标记已处置" }));
    await userEvent.click(within(panel).getByRole("button", { name: "放弃" }));
    expect(acknowledgeMock).not.toHaveBeenCalled();
    expect(within(panel).getByRole("button", { name: "标记已处置" })).toBeInTheDocument();
  });

  it("states an empty result and a failed load explicitly", async () => {
    listMock.mockResolvedValue({ total: 0, jobs: [] });
    render(<AdminJobsSection accessToken="token" />);
    expect(await screen.findByText(/没有匹配的任务/)).toBeInTheDocument();
    cleanup();

    listMock.mockRejectedValueOnce(new Error("任务列表加载失败，请稍后重试。")).mockResolvedValueOnce(list);
    render(<AdminJobsSection accessToken="token" />);
    expect(await screen.findByText("任务列表加载失败，请稍后重试。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByTestId("admin-job-table")).toBeInTheDocument();
  });

  it("labels statuses, types and ages deterministically", () => {
    expect(adminJobStatusLabel("dead_letter")).toBe("死信");
    expect(adminJobStatusLabel("queued")).toBe("排队");
    expect(adminJobStatusLabel("future")).toBe("future");
    expect(adminJobTypeLabel("image_generation")).toBe("图片生成");
    expect(adminJobTypeLabel("future")).toBe("future");
    expect(adminJobActionLabel("job.cancel")).toBe("取消任务");
    expect(adminJobActionLabel("unknown.action")).toBe("unknown.action");
    expect(formatJobAge(30)).toBe("30 秒");
    expect(formatJobAge(5400)).toBe("1.5 小时");
    expect(formatJobAge(172800)).toBe("2.0 天");
    expect(formatJobTimestamp("2026-09-20T04:00:00.000Z")).toBe("2026-09-20 12:00:00");
    expect(formatJobTimestamp(null)).toBe("—");
  });
});
