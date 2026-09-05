// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AdminPage from "../src/app/(workspace)/admin/page";

const { fetchViewerMock } = vi.hoisted(() => ({ fetchViewerMock: vi.fn() }));

vi.mock("../src/lib/auth-context", () => ({
  useAuth: () => ({ session: { access_token: "token" } }),
}));
vi.mock("../src/lib/server-api", () => ({ fetchViewer: fetchViewerMock }));
vi.mock("../src/components/settings/workspace-members-section", () => ({
  WorkspaceMembersSection: () => <div>成员面板</div>,
}));
vi.mock("../src/components/settings/provider-settings-section", () => ({
  ProviderSettingsSection: () => <div>供应商面板</div>,
}));

function viewer(role: "owner" | "admin" | "member") {
  return { membership: { role, workspaceId: "workspace-1" } };
}

describe("admin page", () => {
  beforeEach(() => fetchViewerMock.mockReset());
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
});
