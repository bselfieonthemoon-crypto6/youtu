// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminAccessSection } from "../src/components/admin/admin-access-section";
import { AdminAuditSection, auditActionLabel, formatAuditTimestamp } from "../src/components/admin/admin-audit-section";

const { fetchAdminsMock, grantMock, revokeMock, fetchAuditMock } = vi.hoisted(() => ({
  fetchAdminsMock: vi.fn(),
  grantMock: vi.fn(),
  revokeMock: vi.fn(),
  fetchAuditMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  fetchAdminPlatformAdmins: fetchAdminsMock,
  grantAdminPlatformAdmin: grantMock,
  revokeAdminPlatformAdmin: revokeMock,
  fetchAdminAudit: fetchAuditMock,
}));

const me = { userId: "u-1", email: "me@example.com", displayName: "我", grantedAt: "2026-09-20T00:00:00.000Z",
  grantedBy: null, isCurrentUser: true };
const other = { userId: "u-2", email: "other@example.com", displayName: null, grantedAt: "2026-09-20T01:00:00.000Z",
  grantedBy: "u-1", isCurrentUser: false };

describe("admin access section", () => {
  beforeEach(() => {
    fetchAdminsMock.mockReset().mockResolvedValue({ admins: [me, other] });
    grantMock.mockReset();
    revokeMock.mockReset();
    fetchAuditMock.mockReset().mockResolvedValue({ events: [] });
  });
  afterEach(() => cleanup());

  it("lists admins and marks the current user", async () => {
    render(<AdminAccessSection accessToken="token" />);
    const table = await screen.findByTestId("admin-admins");
    expect(within(table).getByText("me@example.com")).toBeInTheDocument();
    expect(within(table).getByText("（你）")).toBeInTheDocument();
    expect(within(table).getByText("other@example.com")).toBeInTheDocument();
    expect(fetchAdminsMock).toHaveBeenCalledWith("token");
  });

  it("requires a reason before a grant can be submitted and shows the audit note", async () => {
    const admin = { ...other, userId: "u-3", email: "new@example.com" };
    grantMock.mockResolvedValue(admin);
    render(<AdminAccessSection accessToken="token" />);
    await screen.findByTestId("admin-admins");

    const submit = screen.getByRole("button", { name: "授予平台管理员" });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByLabelText("要授权的账号邮箱"), "new@example.com");
    await userEvent.type(screen.getByLabelText("授权原因"), "运");
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("授权原因"), "营负责人");
    expect(submit).toBeEnabled();

    await userEvent.click(submit);
    expect(grantMock).toHaveBeenCalledWith("token", { email: "new@example.com", reason: "运营负责人" });
    expect(await screen.findByTestId("admin-access-feedback")).toHaveTextContent("已授予 new@example.com 平台管理员权限，操作已记入审计。");
    expect(within(screen.getByTestId("admin-admins")).getByText("new@example.com")).toBeInTheDocument();
  });

  it("surfaces a server refusal instead of pretending it worked", async () => {
    grantMock.mockRejectedValue(new Error("该邮箱没有对应的账号。"));
    render(<AdminAccessSection accessToken="token" />);
    await screen.findByTestId("admin-admins");
    await userEvent.type(screen.getByLabelText("要授权的账号邮箱"), "ghost@example.com");
    await userEvent.type(screen.getByLabelText("授权原因"), "任命");
    await userEvent.click(screen.getByRole("button", { name: "授予平台管理员" }));
    expect(await screen.findByTestId("admin-access-feedback")).toHaveTextContent("该邮箱没有对应的账号。");
  });

  it("requires an explicit inline confirmation with a reason before revoking", async () => {
    revokeMock.mockResolvedValue(other);
    render(<AdminAccessSection accessToken="token" />);
    const table = await screen.findByTestId("admin-admins");
    const row = within(table).getByText("other@example.com").closest("tr")!;

    await userEvent.click(within(row).getByRole("button", { name: "撤销" }));
    expect(revokeMock).not.toHaveBeenCalled();

    const confirm = within(row).getByRole("button", { name: "确认撤销" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(row).getByLabelText("撤销 other@example.com 的原因"), "离职");
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);

    expect(revokeMock).toHaveBeenCalledWith("token", "u-2", "离职");
    await waitFor(() => expect(within(screen.getByTestId("admin-admins")).queryByText("other@example.com")).not.toBeInTheDocument());
    expect(screen.getByTestId("admin-access-feedback")).toHaveTextContent("已撤销 other@example.com");
  });

  it("keeps the last-admin refusal visible and the row intact", async () => {
    revokeMock.mockRejectedValue(new Error("不能撤销最后一个平台管理员：撤销后将没有人能进入管理后台。"));
    render(<AdminAccessSection accessToken="token" />);
    const table = await screen.findByTestId("admin-admins");
    const row = within(table).getByText("me@example.com").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "撤销" }));
    await userEvent.type(within(row).getByLabelText("撤销 me@example.com 的原因"), "交接");
    await userEvent.click(within(row).getByRole("button", { name: "确认撤销" }));

    expect(await screen.findByTestId("admin-access-feedback")).toHaveTextContent("不能撤销最后一个平台管理员");
    expect(within(screen.getByTestId("admin-admins")).getByText("me@example.com")).toBeInTheDocument();
  });

  it("can cancel a pending revoke without calling the server", async () => {
    render(<AdminAccessSection accessToken="token" />);
    const table = await screen.findByTestId("admin-admins");
    const row = within(table).getByText("other@example.com").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "撤销" }));
    await userEvent.click(within(row).getByRole("button", { name: "取消" }));
    expect(within(row).getByRole("button", { name: "撤销" })).toBeInTheDocument();
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it("reports a load failure and retries", async () => {
    fetchAdminsMock.mockRejectedValueOnce(new Error("平台管理员列表加载失败，请稍后重试。"))
      .mockResolvedValueOnce({ admins: [me] });
    render(<AdminAccessSection accessToken="token" />);
    expect(await screen.findByText("平台管理员列表加载失败，请稍后重试。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByTestId("admin-admins")).toBeInTheDocument();
  });
});

describe("admin audit section", () => {
  beforeEach(() => {
    fetchAuditMock.mockReset();
  });
  afterEach(() => cleanup());

  const event = {
    id: "e1", actorUserId: "u-1", actorEmail: "me@example.com", action: "platform_admin.grant",
    targetKind: "user", targetId: "u-2", workspaceId: "w-1", workspaceName: "设计团队", reason: "任命",
    createdAt: "2026-09-20T04:00:00.000Z",
  };

  it("renders action, target, actor and reason", async () => {
    fetchAuditMock.mockResolvedValue({ events: [event] });
    render(<AdminAuditSection accessToken="token" />);
    const section = await screen.findByTestId("admin-audit");
    expect(within(section).getByText("授予平台管理员")).toBeInTheDocument();
    expect(within(section).getByText("用户")).toBeInTheDocument();
    expect(within(section).getByText("u-2")).toBeInTheDocument();
    expect(within(section).getByText("设计团队")).toBeInTheDocument();
    expect(within(section).getByText("me@example.com")).toBeInTheDocument();
    expect(within(section).getByText("任命")).toBeInTheDocument();
    expect(within(section).getByText("2026-09-20 12:00:00")).toBeInTheDocument();
    expect(fetchAuditMock).toHaveBeenCalledWith("token", { limit: 50 });
  });

  it("states an empty log and falls back for a system actor or unknown action", async () => {
    fetchAuditMock.mockResolvedValueOnce({ events: [] });
    render(<AdminAuditSection accessToken="token" />);
    expect(await screen.findByText("还没有任何管理操作记录。")).toBeInTheDocument();
    cleanup();

    fetchAuditMock.mockResolvedValue({ events: [{ ...event, id: "e2", actorUserId: null, actorEmail: null,
      action: "some.future.action", targetKind: "widget", targetId: "x", workspaceName: null, reason: null }] });
    render(<AdminAuditSection accessToken="token" />);
    const section = await screen.findByTestId("admin-audit");
    expect(within(section).getByText("some.future.action")).toBeInTheDocument();
    expect(within(section).getByText("widget")).toBeInTheDocument();
    expect(within(section).getByText("系统")).toBeInTheDocument();
    expect(within(section).getByText("—")).toBeInTheDocument();
  });

  it("labels known actions and timestamps deterministically", () => {
    expect(auditActionLabel("platform_admin.revoke")).toBe("撤销平台管理员");
    expect(auditActionLabel("unknown.action")).toBe("unknown.action");
    expect(formatAuditTimestamp("2026-09-20T04:00:00.000Z")).toBe("2026-09-20 12:00:00");
    expect(formatAuditTimestamp("not-a-date")).toBe("—");
  });

  it("reports a load failure and retries", async () => {
    fetchAuditMock.mockRejectedValueOnce(new Error("审计记录加载失败，请稍后重试。"))
      .mockResolvedValueOnce({ events: [event] });
    render(<AdminAuditSection accessToken="token" />);
    expect(await screen.findByText("审计记录加载失败，请稍后重试。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByTestId("admin-audit")).toBeInTheDocument();
  });
});
