// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AdminPage from "../src/app/(workspace)/admin/page";

const { fetchViewerMock, fetchAdminAccessMock } = vi.hoisted(() => ({
  fetchViewerMock: vi.fn(),
  fetchAdminAccessMock: vi.fn(),
}));

vi.mock("../src/lib/auth-context", () => ({
  useAuth: () => ({ session: { access_token: "token" } }),
}));
vi.mock("../src/lib/server-api", () => ({
  fetchViewer: fetchViewerMock,
  fetchAdminAccess: fetchAdminAccessMock,
}));
vi.mock("../src/components/settings/workspace-members-section", () => ({
  WorkspaceMembersSection: () => <div>成员面板</div>,
}));
vi.mock("../src/components/settings/provider-settings-section", () => ({
  ProviderSettingsSection: () => <div>供应商面板</div>,
}));
vi.mock("../src/components/admin/admin-overview-section", () => ({
  AdminOverviewSection: ({ accessToken }: { accessToken: string }) => (
    <div>平台总览面板:{accessToken}</div>
  ),
}));
vi.mock("../src/components/admin/admin-access-section", () => ({
  AdminAccessSection: ({ accessToken }: { accessToken: string }) => (
    <div>权限面板:{accessToken}</div>
  ),
}));
vi.mock("../src/components/admin/admin-audit-section", () => ({
  AdminAuditSection: ({ accessToken }: { accessToken: string }) => (
    <div>审计面板:{accessToken}</div>
  ),
}));
vi.mock("../src/components/admin/admin-users-section", () => ({
  AdminUsersSection: ({ accessToken }: { accessToken: string }) => (
    <div>用户目录面板:{accessToken}</div>
  ),
}));
vi.mock("../src/components/admin/admin-billing-section", () => ({
  AdminBillingSection: ({ accessToken }: { accessToken: string }) => (
    <div>套餐面板:{accessToken}</div>
  ),
}));
vi.mock("../src/components/admin/admin-skills-section", () => ({
  AdminSkillsSection: ({ accessToken }: { accessToken: string }) => (
    <div>技能面板:{accessToken}</div>
  ),
}));
vi.mock("../src/components/admin/admin-jobs-section", () => ({
  AdminJobsSection: ({ accessToken }: { accessToken: string }) => (
    <div>任务面板:{accessToken}</div>
  ),
}));
vi.mock("../src/components/admin/admin-channels-section", () => ({
  AdminChannelsSection: ({ accessToken }: { accessToken: string }) => (
    <div>渠道面板:{accessToken}</div>
  ),
}));
vi.mock("../src/components/admin/admin-home-content-section", () => ({
  AdminHomeContentSection: ({ accessToken }: { accessToken: string }) => (
    <div>首页内容面板:{accessToken}</div>
  ),
}));

function viewer(role: "owner" | "admin" | "member") {
  return { membership: { role, workspaceId: "workspace-1" } };
}

describe("admin page", () => {
  beforeEach(() => {
    fetchViewerMock.mockReset();
    fetchAdminAccessMock.mockReset().mockResolvedValue({ platformAdmin: false });
  });
  afterEach(() => cleanup());

  it("blocks ordinary workspace members", async () => {
    fetchViewerMock.mockResolvedValue(viewer("member"));
    render(<AdminPage />);
    expect(
      await screen.findByRole("heading", { name: "无权访问管理后台" }),
    ).toBeInTheDocument();
  });

  it("shows both management areas to owners", async () => {
    fetchViewerMock.mockResolvedValue(viewer("owner"));
    render(<AdminPage />);
    expect(await screen.findByText("成员面板")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "第三方模型供应商" }),
    );
    expect(screen.getByText("供应商面板")).toBeInTheDocument();
  });

  it("shows the viewer error and retries instead of reporting missing permission", async () => {
    fetchViewerMock
      .mockRejectedValueOnce(new Error("无法连接到权限服务"))
      .mockResolvedValueOnce(viewer("owner"));

    render(<AdminPage />);

    expect(
      await screen.findByRole("heading", { name: "管理后台加载失败" }),
    ).toBeInTheDocument();
    expect(screen.getByText("无法连接到权限服务")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "无权访问管理后台" }),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("成员面板")).toBeInTheDocument();
    expect(fetchViewerMock).toHaveBeenCalledTimes(2);
  });

  it("offers the platform overview only to a platform admin", async () => {
    fetchViewerMock.mockResolvedValue(viewer("owner"));
    fetchAdminAccessMock.mockResolvedValue({ platformAdmin: false });
    render(<AdminPage />);

    expect(await screen.findByText("成员面板")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "平台总览" })).not.toBeInTheDocument();
    expect(fetchAdminAccessMock).toHaveBeenCalledWith("token");
  });

  it("opens the read-only overview tab for a platform admin and passes the token", async () => {
    fetchViewerMock.mockResolvedValue(viewer("owner"));
    fetchAdminAccessMock.mockResolvedValue({ platformAdmin: true });
    render(<AdminPage />);

    const tab = await screen.findByRole("button", { name: "平台总览" });
    await userEvent.click(tab);
    expect(screen.getByText("平台总览面板:token")).toBeInTheDocument();
    // Workspace administration is still reachable from the same page.
    await userEvent.click(screen.getByRole("button", { name: "本工作区成员" }));
    expect(screen.getByText("成员面板")).toBeInTheDocument();
  });

  it("offers the platform-admin and audit tab only to a platform admin", async () => {
    fetchViewerMock.mockResolvedValue(viewer("owner"));
    fetchAdminAccessMock.mockResolvedValue({ platformAdmin: true });
    render(<AdminPage />);

    await userEvent.click(await screen.findByRole("button", { name: "权限与审计" }));
    expect(screen.getByText("权限面板:token")).toBeInTheDocument();
    expect(screen.getByText("审计面板:token")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "用户目录" }));
    expect(screen.getByText("用户目录面板:token")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "套餐与额度" }));
    expect(screen.getByText("套餐面板:token")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "技能与图片" }));
    expect(screen.getByText("技能面板:token")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "任务" }));
    expect(screen.getByText("任务面板:token")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "渠道与模型" }));
    expect(screen.getByText("渠道面板:token")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "首页内容" }));
    expect(screen.getByText("首页内容面板:token")).toBeInTheDocument();

    cleanup();
    fetchAdminAccessMock.mockResolvedValue({ platformAdmin: false });
    render(<AdminPage />);
    expect(await screen.findByText("成员面板")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "权限与审计" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "用户目录" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "套餐与额度" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "技能与图片" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "任务" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "渠道与模型" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "首页内容" })).not.toBeInTheDocument();
  });

  it("keeps workspace administration working when the platform probe fails", async () => {
    fetchViewerMock.mockResolvedValue(viewer("owner"));
    fetchAdminAccessMock.mockRejectedValue(new Error("probe down"));
    render(<AdminPage />);

    expect(await screen.findByText("成员面板")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "平台总览" })).not.toBeInTheDocument();
  });
});
