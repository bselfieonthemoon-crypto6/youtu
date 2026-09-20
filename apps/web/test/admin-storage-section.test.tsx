// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AdminAssetLargeObjectsResponse,
  AdminAssetOrphanListResponse,
  AdminAssetOverviewResponse,
  AdminAssetQueueResponse,
} from "@loomic/shared";

import {
  AdminStorageSection,
  assetQueueKindLabel,
  formatBytes,
} from "../src/components/admin/admin-storage-section";

const { overviewMock, orphansMock, queueMock, largeMock, purgeMock, workspacesMock } = vi.hoisted(() => ({
  overviewMock: vi.fn(),
  orphansMock: vi.fn(),
  queueMock: vi.fn(),
  largeMock: vi.fn(),
  purgeMock: vi.fn(),
  workspacesMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  fetchAdminStorageOverview: overviewMock,
  fetchAdminAssetOrphans: orphansMock,
  fetchAdminAssetQueue: queueMock,
  fetchAdminAssetLargeObjects: largeMock,
  purgeAdminOrphanAsset: purgeMock,
  fetchAdminWorkspaces: workspacesMock,
}));

const ASSET = "55555555-5555-4555-8555-555555555555";
const OTHER = "66666666-6666-4666-8666-666666666666";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";

const overview: AdminAssetOverviewResponse = {
  totalObjects: 5735, totalBytes: 1_436_990_476, pendingCount: 4, gcEligibleCount: 3, gcClaimedCount: 0,
  buckets: [
    { bucket: "workspace-assets", scope: "workspace", objects: 5731, bytes: 1_436_990_204,
      pendingCount: 0, gcEligibleCount: 3, claimedCount: 0 },
    { bucket: "project-assets", scope: "workspace", objects: 4, bytes: 272,
      pendingCount: 4, gcEligibleCount: 0, claimedCount: 0 },
  ],
  scopes: [{ scope: "workspace", objects: 5735, bytes: 1_436_990_476 }],
  workspaces: [{ workspaceId: WORKSPACE, workspaceName: "765966283 Workspace", objects: 5695, bytes: 1_409_498_984 }],
};

const orphanRow = {
  id: ASSET, bucket: "workspace-assets", objectPath: "w/generated/a.png",
  workspaceId: WORKSPACE, workspaceName: "765966283 Workspace", scope: "workspace",
  mimeType: "image/png", byteSize: 8_227_588, createdAt: "2026-09-12T05:03:02.995279+00:00",
  referenceCount: 0, confirmedOrphan: true, ageDays: 8,
  deletionPendingAt: null, gcEligibleAt: null, gcClaimedAt: null,
};

const orphans: AdminAssetOrphanListResponse = {
  total: 1307, pageConfirmed: true,
  objects: [orphanRow, { ...orphanRow, id: OTHER, objectPath: "w/generated/b.png",
    referenceCount: 0, confirmedOrphan: false, byteSize: 1024 }],
};

const queue: AdminAssetQueueResponse = {
  kind: "pending_delete", total: 4,
  objects: [{ ...orphanRow, id: OTHER, objectPath: "w/generated/queued.png",
    deletionPendingAt: "2026-09-07T10:49:58.88+00:00" }],
};

const large: AdminAssetLargeObjectsResponse = { objects: [orphanRow] };

async function renderReady() {
  render(<AdminStorageSection accessToken="token" />);
  await screen.findByTestId("admin-storage-orphans");
}

describe("admin storage section", () => {
  beforeEach(() => {
    overviewMock.mockReset().mockResolvedValue(overview);
    orphansMock.mockReset().mockResolvedValue(orphans);
    queueMock.mockReset().mockResolvedValue(queue);
    largeMock.mockReset().mockResolvedValue(large);
    purgeMock.mockReset().mockResolvedValue({ bucket: "workspace-assets", objectPath: "w/generated/a.png" });
    workspacesMock.mockReset().mockResolvedValue({ workspaces: [
      { id: WORKSPACE, name: "765966283 Workspace", type: "personal",
        createdAt: "2026-09-01T00:00:00.000Z", memberCount: 1 },
    ] });
  });
  afterEach(() => cleanup());

  it("shows occupancy, per-bucket totals and the heaviest workspaces", async () => {
    await renderReady();
    const panel = screen.getByTestId("admin-storage-overview");
    expect(within(panel).getByTestId("admin-storage-bytes")).toHaveTextContent("1.3 GB");
    expect(within(panel).getByText("5735")).toBeInTheDocument();

    const buckets = screen.getByTestId("admin-storage-buckets");
    expect(within(buckets).getByText("workspace-assets")).toBeInTheDocument();
    expect(within(buckets).getByText("4/0")).toBeInTheDocument();
    expect(within(screen.getByTestId("admin-storage-workspaces")).getByText("765966283 Workspace")).toBeInTheDocument();
  });

  it("marks the candidates the authoritative check rejects and locks their purge button", async () => {
    await renderReady();
    const table = screen.getByTestId("admin-storage-orphans");
    expect(within(table).getByText("确认无引用")).toBeInTheDocument();
    expect(within(table).getByTestId("admin-storage-referenced")).toHaveTextContent("仍被引用");

    const buttons = within(table).getAllByRole("button", { name: "清理" });
    expect(buttons[0]).toBeEnabled();
    expect(buttons[1]).toBeDisabled();
    expect(screen.getByText(/共 1307 条候选（当前页 2 条已逐条复核）/)).toBeInTheDocument();
  });

  it("filters on submit and reloads the queue when its kind changes", async () => {
    await renderReady();
    await userEvent.selectOptions(screen.getByLabelText("存储桶"), "workspace-assets");
    await userEvent.selectOptions(screen.getByLabelText("存储工作区"), WORKSPACE);
    await userEvent.type(screen.getByLabelText("最小字节"), "1048576");
    await userEvent.click(screen.getByRole("button", { name: "查询" }));

    await waitFor(() => expect(orphansMock).toHaveBeenLastCalledWith("token",
      { bucket: "workspace-assets", workspaceId: WORKSPACE, minBytes: 1048576, limit: 50 }));

    await userEvent.selectOptions(screen.getByLabelText("队列类型"), "gc_eligible");
    await waitFor(() => expect(queueMock).toHaveBeenLastCalledWith("token", "gc_eligible", { limit: 50 }));
    const queueTable = screen.getByTestId("admin-storage-queue");
    expect(within(queueTable).getByText("workspace-assets/w/generated/queued.png")).toBeInTheDocument();
  });

  it("purges only after an inline reason and confirmation", async () => {
    await renderReady();
    const table = screen.getByTestId("admin-storage-orphans");
    await userEvent.click(within(table).getAllByRole("button", { name: "清理" })[0]!);

    const confirm = screen.getByTestId("admin-storage-confirm");
    expect(confirm).toHaveTextContent("workspace-assets");
    const button = within(confirm).getByRole("button", { name: "确认清理" });
    expect(button).toBeDisabled();
    await userEvent.type(within(confirm).getByLabelText("清理原因"), "确认没有引用");
    await userEvent.click(button);

    expect(purgeMock).toHaveBeenCalledWith("token", ASSET, "确认没有引用");
    expect(await screen.findByTestId("admin-storage-feedback")).toHaveTextContent("已清理 7.8 MB");
  });

  it("shows the server's explanation when a purge is refused", async () => {
    purgeMock.mockRejectedValue(new Error("该素材仍被引用，不能清理。"));
    await renderReady();
    const table = screen.getByTestId("admin-storage-orphans");
    await userEvent.click(within(table).getAllByRole("button", { name: "清理" })[0]!);
    await userEvent.type(screen.getByLabelText("清理原因"), "确认没有引用");
    await userEvent.click(screen.getByRole("button", { name: "确认清理" }));

    expect(await screen.findByTestId("admin-storage-error")).toHaveTextContent("该素材仍被引用");
    // The confirmation stays open so the operator can read why and cancel.
    expect(screen.getByTestId("admin-storage-confirm")).toBeInTheDocument();
  });

  it("reports a load failure and reloads after a retry", async () => {
    orphansMock.mockRejectedValueOnce(new Error("存储服务暂时不可用")).mockResolvedValue(orphans);
    render(<AdminStorageSection accessToken="token" />);

    expect(await screen.findByTestId("admin-storage-error")).toHaveTextContent("存储服务暂时不可用");
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByTestId("admin-storage-orphans")).toBeInTheDocument();
  });

  it("formats byte sizes and queue kinds", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(8_227_588)).toBe("7.8 MB");
    expect(formatBytes(1_436_990_476)).toBe("1.3 GB");
    expect(formatBytes(-1)).toBe("—");
    expect(assetQueueKindLabel("gc_claimed")).toBe("已领取");
    expect(assetQueueKindLabel("other")).toBe("other");
  });
});
