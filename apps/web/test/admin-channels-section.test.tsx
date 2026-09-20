// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AdminChannelDetailResponse,
  AdminChannelFailureRatesResponse,
  AdminChannelListResponse,
  AdminChannelView,
} from "@loomic/shared";

import {
  AdminChannelsSection,
  formatChannelCoverage,
  formatFailureRate,
  providerAuditActionLabel,
  providerTestStatusLabel,
} from "../src/components/admin/admin-channels-section";

const { listMock, detailMock, ratesMock, workspacesMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  detailMock: vi.fn(),
  ratesMock: vi.fn(),
  workspacesMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  fetchAdminChannels: listMock,
  fetchAdminChannelDetail: detailMock,
  fetchAdminChannelFailureRates: ratesMock,
  fetchAdminWorkspaces: workspacesMock,
}));

const CONFIG = "66666666-6666-4666-8666-666666666666";
const OTHER_CONFIG = "77777777-7777-4777-8777-777777777777";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";

const channelRow: AdminChannelView = {
  id: CONFIG, workspaceId: WORKSPACE, workspaceName: "765966283 Workspace", displayName: "BASE",
  adapter: "openai_compatible", baseUrl: "https://api.apiyi.com/v1", enabled: true, revision: 18,
  apiKeyLastFour: "97Dd", modelCount: 5, enabledModelCount: 4, modalities: ["image", "text"],
  createdAt: "2026-09-03T05:19:19.030989+00:00", updatedAt: "2026-09-16T07:35:28.003898+00:00",
  lastTestedAt: "2026-09-16T07:35:27.133+00:00", lastTestStatus: "succeeded", lastTestErrorCode: null,
  windowDays: 30, jobs: 350, failures: 42, failureRate: 0.12,
  lastFailureAt: "2026-09-19T11:46:24.855691+00:00",
  topErrorCodes: [{ errorCode: "provider_rejected", count: 9, lastSeenAt: "2026-09-19T11:34:47.411808+00:00" }],
};

const failingRow: AdminChannelView = { ...channelRow, id: OTHER_CONFIG, displayName: "备用渠道", enabled: false,
  lastTestStatus: "failed", lastTestErrorCode: "http_401", lastTestedAt: null,
  modelCount: 0, enabledModelCount: 0, modalities: [], jobs: 0, failures: 0, failureRate: null,
  workspaceName: "设计团队", baseUrl: "https://backup.example.com/v1", topErrorCodes: [] };

const list: AdminChannelListResponse = {
  total: 2, windowDays: 30, totalJobs: 358, totalFailures: 49, channels: [channelRow, failingRow],
};

const rates: AdminChannelFailureRatesResponse = {
  windowDays: 30, totalJobs: 1449, totalFailures: 553, overallFailureRate: 0.3816,
  providerJobs: 358, providerFailures: 49, providerFailureRate: 0.1369, channelCount: 3,
  errorCodes: [
    { errorCode: "design_preview_stale", failures: 504, failed: 0, deadLetter: 504,
      share: 0.9114, channelCount: 0, lastSeenAt: "2026-09-17T17:16:53.527457+00:00" },
    { errorCode: "provider_rejected", failures: 9, failed: 0, deadLetter: 9,
      share: 0.0163, channelCount: 1, lastSeenAt: "2026-09-19T11:34:47.411808+00:00" },
  ],
};

const detail: AdminChannelDetailResponse = {
  channel: {
    id: CONFIG, workspaceId: WORKSPACE, workspaceName: "765966283 Workspace", displayName: "BASE",
    adapter: "openai_compatible", baseUrl: "https://api.apiyi.com/v1", enabled: true, revision: 18,
    apiKeyLastFour: "97Dd", modelCount: 5, enabledModelCount: 4, modalities: ["image", "text"],
    createdAt: "2026-09-03T05:19:19.030989+00:00", updatedAt: "2026-09-16T07:35:28.003898+00:00",
    lastTestedAt: "2026-09-16T07:35:27.133+00:00", lastTestStatus: "succeeded", lastTestErrorCode: null,
    windowDays: 30, jobs: 350, failures: 42, failureRate: 0.12,
    lastFailureAt: "2026-09-19T11:46:24.855691+00:00",
    createdByEmail: "owner@example.com", updatedByEmail: "owner@example.com",
  },
  history: [
    { action: "test_succeeded", actorUserId: "user-1", actorEmail: "owner@example.com",
      errorCode: null, createdAt: "2026-09-16T07:35:28.019065+00:00" },
    { action: "test_failed", actorUserId: "user-1", actorEmail: "owner@example.com",
      errorCode: "provider_redirect_not_allowed", createdAt: "2026-09-10T05:38:39.559974+00:00" },
  ],
  errorCodes: [{ errorCode: "provider_rejected", failures: 9, failed: 0, deadLetter: 9,
    lastSeenAt: "2026-09-19T11:34:47.411808+00:00" }],
  failures: [{ jobId: "job-1", jobType: "image_generation", status: "dead_letter",
    errorCode: "provider_rejected", createdAt: "2026-09-19T11:34:47.411808+00:00",
    finishedAt: "2026-09-19T11:37:06.394226+00:00" }],
};

/** The section renders its shell first; wait for a real row before asserting. */
async function renderReady() {
  render(<AdminChannelsSection accessToken="token" />);
  await screen.findByTestId("admin-channel-table");
}

describe("admin channels section", () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue(list);
    detailMock.mockReset().mockResolvedValue(detail);
    ratesMock.mockReset().mockResolvedValue(rates);
    workspacesMock.mockReset().mockResolvedValue({ workspaces: [
      { id: WORKSPACE, name: "765966283 Workspace", type: "personal",
        createdAt: "2026-09-01T00:00:00.000Z", memberCount: 1 },
    ] });
  });
  afterEach(() => cleanup());

  it("lists channels with their last self-test result, models and failure rate", async () => {
    await renderReady();
    const table = screen.getByTestId("admin-channel-table");
    expect(within(table).getByText("BASE")).toBeInTheDocument();
    expect(within(table).getByText("已启用")).toBeInTheDocument();
    expect(within(table).getByText("已停用")).toBeInTheDocument();
    expect(within(table).getByText("4/5")).toBeInTheDocument();
    expect(within(table).getByText("12.0%")).toBeInTheDocument();
    const testCells = within(table).getAllByTestId("admin-channel-test-status");
    expect(testCells[0]).toHaveTextContent("自检成功");
    expect(testCells[1]).toHaveTextContent("自检失败");
    // The channel that was never tested and has no jobs shows a dash, not a 0% rate.
    expect(testCells[1]).toHaveTextContent("http_401");
    expect(within(table).getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getByText(/共 2 个渠道/)).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith("token", { days: 30, limit: 100 });
  });

  it("reports both failure rates and marks the codes no channel saw", async () => {
    await renderReady();
    const panel = screen.getByTestId("admin-channel-rates");
    expect(within(panel).getByTestId("admin-channel-provider-rate")).toHaveTextContent("13.7%");
    expect(within(panel).getByText("38.2%")).toBeInTheDocument();
    expect(within(panel).getByText("无渠道记录的失败").parentElement).toHaveTextContent("504");

    const table = screen.getByTestId("admin-channel-rate-table");
    const staleRow = within(table).getByText("design_preview_stale").closest("tr")!;
    expect(within(staleRow).getByText("无渠道记录")).toBeInTheDocument();
    const rejectedRow = within(table).getByText("provider_rejected").closest("tr")!;
    expect(within(rejectedRow).getByText("1 个渠道")).toBeInTheDocument();
  });

  it("applies filters on submit rather than on every change", async () => {
    await renderReady();
    expect(listMock).toHaveBeenCalledTimes(1);

    await userEvent.selectOptions(screen.getByLabelText("渠道工作区"), WORKSPACE);
    await userEvent.selectOptions(screen.getByLabelText("渠道启用状态"), "false");
    await userEvent.selectOptions(screen.getByLabelText("渠道自检状态"), "failed");
    await userEvent.selectOptions(screen.getByLabelText("渠道统计窗口"), "7");
    await userEvent.type(screen.getByLabelText("渠道关键词"), " backup ");
    expect(listMock).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "查询" }));
    await waitFor(() => expect(listMock).toHaveBeenLastCalledWith("token", {
      workspaceId: WORKSPACE, query: "backup", enabled: false, testStatus: "failed", days: 7, limit: 100,
    }));
    // The window drives the rate panel too, so both calls move together.
    expect(ratesMock).toHaveBeenLastCalledWith("token", { days: 7, limit: 20 });
  });

  it("opens a channel with its self-test history, error breakdown and newest failures", async () => {
    await renderReady();
    const table = screen.getByTestId("admin-channel-table");
    await userEvent.click(within(table).getAllByRole("button", { name: "详情" })[0]!);

    const panel = await screen.findByTestId("admin-channel-detail");
    expect(detailMock).toHaveBeenCalledWith("token", CONFIG, { days: 30, historyLimit: 20, jobLimit: 10 });
    expect(within(panel).getByText(/渠道 BASE/)).toBeInTheDocument();
    const history = within(panel).getByTestId("admin-channel-history");
    expect(history).toHaveTextContent("自检成功");
    expect(history).toHaveTextContent("自检失败");
    expect(history).toHaveTextContent("provider_redirect_not_allowed");
    expect(within(panel).getByTestId("admin-channel-errors")).toHaveTextContent("provider_rejected");
    expect(within(panel).getByTestId("admin-channel-failures")).toHaveTextContent("image_generation");
    expect(within(panel).getByText("****97Dd")).toBeInTheDocument();
  });

  it("shows the empty states instead of pretending a channel has data", async () => {
    detailMock.mockResolvedValue({ ...detail,
      history: [], errorCodes: [], failures: [] });
    await renderReady();
    const table = screen.getByTestId("admin-channel-table");
    await userEvent.click(within(table).getAllByRole("button", { name: "详情" })[0]!);

    const panel = await screen.findByTestId("admin-channel-detail");
    expect(within(panel).getByText("该渠道还没有任何记录。")).toBeInTheDocument();
    expect(within(panel).getByText("该窗口内这个渠道没有失败。")).toBeInTheDocument();
    expect(within(panel).getByText("没有可归属到该渠道的失败任务。")).toBeInTheDocument();
  });

  it("reports a directory failure and reloads after a retry", async () => {
    listMock.mockRejectedValue(new Error("渠道列表暂时不可用"));
    ratesMock.mockResolvedValue(rates);
    render(<AdminChannelsSection accessToken="token" />);

    expect(await screen.findByText("渠道列表暂时不可用")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-channel-rates")).not.toBeInTheDocument();

    listMock.mockResolvedValue(list);
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByTestId("admin-channel-table")).toBeInTheDocument();
    expect(screen.getByTestId("admin-channel-rates")).toBeInTheDocument();
  });

  it("keeps the table readable when only a detail fetch fails", async () => {
    detailMock.mockRejectedValue(new Error("该渠道配置不存在。"));
    await renderReady();
    const table = screen.getByTestId("admin-channel-table");
    await userEvent.click(within(table).getAllByRole("button", { name: "详情" })[0]!);

    expect(await screen.findByTestId("admin-channel-detail-error")).toHaveTextContent("该渠道配置不存在。");
    expect(screen.getByTestId("admin-channel-table")).toBeInTheDocument();
    expect(screen.getByTestId("admin-channel-rates")).toBeInTheDocument();
  });

  it("labels the raw provider audit actions and formats rates and coverage", () => {
    expect(providerAuditActionLabel("key_rotated")).toBe("轮换密钥");
    expect(providerAuditActionLabel("test_failed")).toBe("自检失败");
    expect(providerAuditActionLabel("something_new")).toBe("something_new");
    expect(providerTestStatusLabel("never")).toBe("未自检");
    expect(providerTestStatusLabel("weird")).toBe("weird");
    expect(formatFailureRate(0.1369)).toBe("13.7%");
    expect(formatFailureRate(0)).toBe("0.0%");
    expect(formatFailureRate(null)).toBe("—");
    expect(formatChannelCoverage(0)).toBe("无渠道记录");
    expect(formatChannelCoverage(2)).toBe("2 个渠道");
  });
});
