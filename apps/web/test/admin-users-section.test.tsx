// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminUsersSection, directoryRoleLabel, formatUserTimestamp } from "../src/components/admin/admin-users-section";

const { fetchUsersMock, fetchWorkspacesMock, addMemberMock, setRoleMock, removeMemberMock } = vi.hoisted(() => ({
  fetchUsersMock: vi.fn(),
  fetchWorkspacesMock: vi.fn(),
  addMemberMock: vi.fn(),
  setRoleMock: vi.fn(),
  removeMemberMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  fetchAdminUsers: fetchUsersMock,
  fetchAdminWorkspaces: fetchWorkspacesMock,
  adminAddWorkspaceMember: addMemberMock,
  adminSetWorkspaceMemberRole: setRoleMock,
  adminRemoveWorkspaceMember: removeMemberMock,
}));

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const userEntry = {
  userId: USER,
  email: "member@example.com",
  displayName: "成员",
  createdAt: "2026-09-01T02:00:00.000Z",
  isPlatformAdmin: false,
  lastActiveAt: "2026-09-20T04:00:00.000Z",
  runs30d: 4,
  jobs30d: 3,
  creditsSpent30d: 21,
  workspaces: [{ id: WORKSPACE, name: "设计团队", type: "team" as const, role: "member" as const }],
};

const ownerEntry = {
  ...userEntry,
  userId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  email: "owner@example.com",
  // Distinct activity values so the table assertions are unambiguous.
  lastActiveAt: null,
  jobs30d: 1,
  runs30d: 1,
  creditsSpent30d: 0,
  workspaces: [{ id: WORKSPACE, name: "设计团队", type: "team" as const, role: "owner" as const }],
};

function workspaces() {
  return [
    { id: WORKSPACE, name: "设计团队", type: "team" as const, createdAt: "2026-09-01T00:00:00.000Z", memberCount: 3 },
    { id: OTHER_WORKSPACE, name: "另一个工作区", type: "personal" as const, createdAt: "2026-09-02T00:00:00.000Z", memberCount: 1 },
  ];
}

describe("admin users section", () => {
  beforeEach(() => {
    fetchUsersMock.mockReset().mockResolvedValue({ total: 2, users: [userEntry, ownerEntry] });
    fetchWorkspacesMock.mockReset().mockResolvedValue({ workspaces: workspaces() });
    addMemberMock.mockReset();
    setRoleMock.mockReset();
    removeMemberMock.mockReset();
  });
  afterEach(() => cleanup());

  it("lists accounts with their workspaces, activity and last-active time", async () => {
    render(<AdminUsersSection accessToken="token" />);
    const table = await screen.findByTestId("admin-user-table");
    expect(within(table).getByText("member@example.com")).toBeInTheDocument();
    expect(within(table).getAllByText(/设计团队（成员）/).length).toBeGreaterThan(0);
    expect(within(table).getByText("21")).toBeInTheDocument();
    expect(within(table).getByText("2026-09-20 12:00")).toBeInTheDocument();
    expect(screen.getByText("共 2 个账号，当前显示前 2 个。")).toBeInTheDocument();
  });

  it("searches on submit rather than on every keystroke", async () => {
    render(<AdminUsersSection accessToken="token" />);
    await screen.findByTestId("admin-user-table");
    expect(fetchUsersMock).toHaveBeenLastCalledWith("token", { limit: 25 });

    await userEvent.type(screen.getByLabelText("搜索邮箱或昵称"), "member@example.com");
    expect(fetchUsersMock).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "查询" }));
    await waitFor(() => expect(fetchUsersMock).toHaveBeenLastCalledWith("token",
      { query: "member@example.com", limit: 25 }));
  });

  it("shows the member detail with activity and refuses to touch an owner", async () => {
    render(<AdminUsersSection accessToken="token" />);
    await screen.findByTestId("admin-user-table");
    // The first account is selected by default.
    const detail = screen.getByTestId("admin-user-detail");
    expect(within(detail).getByText(/成员管理：member@example.com/)).toBeInTheDocument();
    expect(within(detail).getByText(/近 30 天 3 个任务、/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "owner@example.com" }));
    const ownerDetail = screen.getByTestId("admin-user-detail");
    const row = within(ownerDetail).getByText("所有者（后台不可改）").closest("tr")!;
    expect(within(row).queryByRole("button", { name: "移出" })).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "改角色" })).not.toBeInTheDocument();
  });

  it("adds the selected account to a workspace with a mandatory reason", async () => {
    addMemberMock.mockResolvedValue(undefined);
    render(<AdminUsersSection accessToken="token" />);
    const detail = await screen.findByTestId("admin-user-detail");
    await waitFor(() => expect(fetchWorkspacesMock).toHaveBeenCalled());

    const submit = within(detail).getByRole("button", { name: "加入工作区" });
    expect(submit).toBeDisabled();

    await userEvent.selectOptions(within(detail).getByLabelText("选择工作区"), OTHER_WORKSPACE);
    await userEvent.selectOptions(within(detail).getByLabelText("新成员角色"), "admin");
    await userEvent.type(within(detail).getByLabelText("加入工作区原因"), "项目协作");
    expect(submit).toBeEnabled();
    await userEvent.click(submit);

    expect(addMemberMock).toHaveBeenCalledWith("token", OTHER_WORKSPACE,
      { userId: USER, role: "admin", reason: "项目协作" });
    expect(await screen.findByTestId("admin-users-feedback")).toHaveTextContent("已把 member@example.com 加入 另一个工作区（管理员）");
    // The workspace already occupied by the account is not offered again.
    expect(within(detail).queryByRole("option", { name: /设计团队/ })).not.toBeInTheDocument();
  });

  it("surfaces a membership refusal instead of pretending it worked", async () => {
    addMemberMock.mockRejectedValue(new Error("该用户已经是这个工作区的成员。"));
    render(<AdminUsersSection accessToken="token" />);
    const detail = await screen.findByTestId("admin-user-detail");
    await userEvent.selectOptions(within(detail).getByLabelText("选择工作区"), OTHER_WORKSPACE);
    await userEvent.type(within(detail).getByLabelText("加入工作区原因"), "重复加入");
    await userEvent.click(within(detail).getByRole("button", { name: "加入工作区" }));
    expect(await screen.findByTestId("admin-users-feedback")).toHaveTextContent("该用户已经是这个工作区的成员。");
  });

  it("requires an inline reason before changing a role", async () => {
    setRoleMock.mockResolvedValue(undefined);
    render(<AdminUsersSection accessToken="token" />);
    const detail = await screen.findByTestId("admin-user-detail");
    await userEvent.click(within(detail).getByRole("button", { name: "改角色" }));
    const confirm = within(detail).getByRole("button", { name: "确认修改" });
    expect(confirm).toBeDisabled();
    await userEvent.selectOptions(within(detail).getByLabelText("设计团队 的新角色"), "admin");
    await userEvent.type(within(detail).getByLabelText("设计团队 的角色修改原因"), "升为管理员");
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);

    expect(setRoleMock).toHaveBeenCalledWith("token", WORKSPACE, USER, { role: "admin", reason: "升为管理员" });
    expect(await screen.findByTestId("admin-users-feedback")).toHaveTextContent("已把角色改为管理员");
    await waitFor(() => expect(within(screen.getByTestId("admin-user-memberships")).getByText("管理员")).toBeInTheDocument());
  });

  it("asks for a reason before removing and keeps the row when the server refuses", async () => {
    removeMemberMock.mockRejectedValueOnce(new Error("工作区所有者的成员身份不能在后台修改或移除。"));
    render(<AdminUsersSection accessToken="token" />);
    const detail = await screen.findByTestId("admin-user-detail");
    await userEvent.click(within(detail).getByRole("button", { name: "移出" }));
    const confirm = within(detail).getByRole("button", { name: "确认移出" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(detail).getByLabelText("移出 设计团队 的原因"), "离职");
    await userEvent.click(confirm);

    expect(removeMemberMock).toHaveBeenCalledWith("token", WORKSPACE, USER, "离职");
    expect(await screen.findByTestId("admin-users-feedback")).toHaveTextContent("工作区所有者的成员身份不能在后台修改或移除。");
    expect(within(screen.getByTestId("admin-user-memberships")).getByText("设计团队")).toBeInTheDocument();
  });

  it("removes a membership after a successful confirmed call", async () => {
    removeMemberMock.mockResolvedValue(undefined);
    render(<AdminUsersSection accessToken="token" />);
    const detail = await screen.findByTestId("admin-user-detail");
    await userEvent.click(within(detail).getByRole("button", { name: "移出" }));
    await userEvent.type(within(detail).getByLabelText("移出 设计团队 的原因"), "项目结束");
    await userEvent.click(within(detail).getByRole("button", { name: "确认移出" }));

    expect(await screen.findByTestId("admin-users-feedback")).toHaveTextContent("已移出该工作区");
    expect(within(screen.getByTestId("admin-user-memberships")).getByText("该账号还没有加入任何工作区。")).toBeInTheDocument();
  });

  it("can cancel a pending role change or removal without calling the server", async () => {
    render(<AdminUsersSection accessToken="token" />);
    const detail = await screen.findByTestId("admin-user-detail");
    await userEvent.click(within(detail).getByRole("button", { name: "改角色" }));
    await userEvent.click(within(detail).getByRole("button", { name: "取消" }));
    await userEvent.click(within(detail).getByRole("button", { name: "移出" }));
    await userEvent.click(within(detail).getByRole("button", { name: "取消" }));
    expect(setRoleMock).not.toHaveBeenCalled();
    expect(removeMemberMock).not.toHaveBeenCalled();
  });

  it("reports a load failure and retries", async () => {
    fetchUsersMock.mockRejectedValueOnce(new Error("用户目录加载失败，请稍后重试。"))
      .mockResolvedValueOnce({ total: 1, users: [userEntry] });
    render(<AdminUsersSection accessToken="token" />);
    expect(await screen.findByText("用户目录加载失败，请稍后重试。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByTestId("admin-user-table")).toBeInTheDocument();
  });

  it("states an empty result and labels roles and timestamps deterministically", async () => {
    fetchUsersMock.mockResolvedValue({ total: 0, users: [] });
    render(<AdminUsersSection accessToken="token" />);
    expect(await screen.findByText("没有匹配的账号。")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-user-detail")).not.toBeInTheDocument();

    expect(directoryRoleLabel("owner")).toBe("所有者");
    expect(directoryRoleLabel("admin")).toBe("管理员");
    expect(directoryRoleLabel("member")).toBe("成员");
    expect(directoryRoleLabel("future_role")).toBe("future_role");
    expect(formatUserTimestamp("2026-09-20T04:00:00.000Z")).toBe("2026-09-20 12:00");
    expect(formatUserTimestamp(null)).toBe("—");
    expect(formatUserTimestamp("nonsense")).toBe("—");
  });
});
