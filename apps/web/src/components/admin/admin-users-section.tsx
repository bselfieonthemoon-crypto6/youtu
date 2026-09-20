"use client";

import type { AdminAssignableRole, AdminUserDirectoryEntry, AdminWorkspaceDirectoryEntry } from "@loomic/shared";
import { useCallback, useEffect, useState } from "react";

import {
  adminAddWorkspaceMember,
  adminRemoveWorkspaceMember,
  adminSetWorkspaceMemberRole,
  fetchAdminUsers,
  fetchAdminWorkspaces,
} from "../../lib/server-api";

/**
 * Platform-level user directory with cross-workspace membership management.
 *
 * The directory answers "who is on this install, what are they doing, and where
 * are they a member". Membership changes are the only writes, they always need a
 * reason, and removal uses the same inline "reason + confirm" pattern as platform
 * admin access: the reason stays attached to the row it applies to. The server
 * re-checks platform-admin rights and refuses to touch a workspace owner.
 */

const PAGE_SIZE = 25;

const ROLE_LABELS: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员" };
const TYPE_LABELS: Record<string, string> = { personal: "个人", team: "团队" };

export function formatUserTimestamp(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(parsed);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")} ${read("hour")}:${read("minute")}`;
}

export const directoryRoleLabel = (role: string) => ROLE_LABELS[role] ?? role;
export const directoryTypeLabel = (type: string) => TYPE_LABELS[type] ?? type;

export function AdminUsersSection({ accessToken }: { accessToken: string }) {
  const [users, setUsers] = useState<AdminUserDirectoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<AdminWorkspaceDirectoryEntry[]>([]);
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const [addWorkspaceId, setAddWorkspaceId] = useState("");
  const [addRole, setAddRole] = useState<AdminAssignableRole>("member");
  const [addReason, setAddReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [removeReason, setRemoveReason] = useState("");
  const [pendingRoleId, setPendingRoleId] = useState<string | null>(null);
  const [roleDraft, setRoleDraft] = useState<AdminAssignableRole>("member");
  const [roleReason, setRoleReason] = useState("");

  const load = useCallback(async () => {
    if (!accessToken) {
      setLoading(false);
      setError("无法获取登录凭据，请重新登录后再试。");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await fetchAdminUsers(accessToken, {
        ...(submittedQuery ? { query: submittedQuery } : {}),
        limit: PAGE_SIZE,
      });
      setUsers(result.users);
      setTotal(result.total);
      setSelectedId(current => (current && result.users.some(user => user.userId === current)
        ? current
        : result.users[0]?.userId ?? null));
    } catch (caught) {
      setUsers([]);
      setTotal(0);
      setError(caught instanceof Error ? caught.message : "用户目录加载失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, [accessToken, submittedQuery]);

  useEffect(() => void load(), [load]);

  // The workspace picker is a separate bounded search; it only needs to load when
  // the section is visible.
  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await fetchAdminWorkspaces(accessToken, {
          ...(workspaceQuery ? { query: workspaceQuery } : {}), limit: 50,
        });
        if (!cancelled) setWorkspaces(result.workspaces);
      } catch {
        if (!cancelled) setWorkspaces([]);
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken, workspaceQuery]);

  const selected = users.find(user => user.userId === selectedId) ?? null;

  function replaceMemberships(userId: string, next: AdminUserDirectoryEntry["workspaces"]) {
    setUsers(current => current.map(user => user.userId === userId ? { ...user, workspaces: next } : user));
  }

  async function handleAdd(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || !addWorkspaceId) return;
    setFeedback(null);
    setBusy(true);
    try {
      await adminAddWorkspaceMember(accessToken, addWorkspaceId, {
        userId: selected.userId, role: addRole, reason: addReason.trim(),
      });
      const workspace = workspaces.find(item => item.id === addWorkspaceId);
      if (workspace) {
        replaceMemberships(selected.userId, [...selected.workspaces,
          { id: workspace.id, name: workspace.name, type: workspace.type, role: addRole }]);
      }
      setFeedback(`已把 ${selected.email ?? selected.userId} 加入 ${workspace?.name ?? addWorkspaceId}（${directoryRoleLabel(addRole)}），操作已记入审计。`);
      setAddReason("");
    } catch (caught) {
      setFeedback(caught instanceof Error ? caught.message : "加入工作区失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function handleRoleChange(userId: string, workspaceId: string, role: AdminAssignableRole, reason: string) {
    setFeedback(null);
    setBusy(true);
    try {
      await adminSetWorkspaceMemberRole(accessToken, workspaceId, userId, { role, reason: reason.trim() });
      const target = users.find(user => user.userId === userId);
      if (target) {
        replaceMemberships(userId, target.workspaces.map(item => item.id === workspaceId ? { ...item, role } : item));
      }
      setPendingRoleId(null);
      setRoleReason("");
      setFeedback(`已把角色改为${directoryRoleLabel(role)}，操作已记入审计。`);
    } catch (caught) {
      setFeedback(caught instanceof Error ? caught.message : "修改角色失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(userId: string, workspaceId: string, reason: string) {
    setFeedback(null);
    setBusy(true);
    try {
      await adminRemoveWorkspaceMember(accessToken, workspaceId, userId, reason.trim());
      const target = users.find(user => user.userId === userId);
      if (target) replaceMemberships(userId, target.workspaces.filter(item => item.id !== workspaceId));
      setPendingRemoveId(null);
      setRemoveReason("");
      setFeedback("已移出该工作区，操作已记入审计。");
    } catch (caught) {
      setFeedback(caught instanceof Error ? caught.message : "移出工作区失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5" data-testid="admin-users">
      <section className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">用户目录</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              按邮箱或昵称搜索账号，查看其所属工作区与近 30 天活跃度；成员增删改都需要填写原因并写入审计。
              工作区所有者的成员身份不能在后台修改。
            </p>
          </div>
          <form className="flex items-end gap-2"
            onSubmit={event => { event.preventDefault(); setSubmittedQuery(query.trim()); }}>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              搜索
              <input value={query} onChange={event => setQuery(event.target.value)} aria-label="搜索邮箱或昵称"
                placeholder="邮箱 / 昵称"
                className="w-56 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
            </label>
            <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-sm">查询</button>
          </form>
        </div>
        {feedback ? <p className="mt-3 text-sm text-muted-foreground" data-testid="admin-users-feedback">{feedback}</p> : null}
      </section>

      {loading ? (
        <p className="text-sm text-muted-foreground">正在加载用户目录…</p>
      ) : error ? (
        <div>
          <p className="text-sm text-destructive">{error}</p>
          <button type="button" onClick={() => void load()}
            className="mt-4 inline-flex rounded-md border border-border px-3 py-1.5 text-sm">重试</button>
        </div>
      ) : (
        <section className="rounded-lg border border-border bg-card p-5">
          <p className="text-xs text-muted-foreground">共 {total} 个账号，当前显示前 {users.length} 个。</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm" data-testid="admin-user-table">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">账号</th>
                  <th className="px-3 py-2">工作区</th>
                  <th className="px-3 py-2 text-right">近30天任务</th>
                  <th className="px-3 py-2 text-right">近30天额度</th>
                  <th className="px-3 py-2">最后活跃</th>
                  <th className="px-3 py-2">平台管理员</th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 ? (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    没有匹配的账号。
                  </td></tr>
                ) : users.map(user => (
                  <tr key={user.userId}
                    className={`border-t border-border align-top ${user.userId === selectedId ? "bg-muted/50" : ""}`}>
                    <td className="px-3 py-2">
                      <button type="button" onClick={() => { setSelectedId(user.userId); setFeedback(null); }}
                        className="text-left underline-offset-2 hover:underline">
                        {user.email ?? user.userId}
                      </button>
                      <div className="text-xs text-muted-foreground">{user.displayName ?? "未命名"}</div>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {user.workspaces.length === 0 ? "—" : user.workspaces.map(item => (
                        <div key={item.id}>{item.name}（{directoryRoleLabel(item.role)}）</div>
                      ))}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{user.jobs30d}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{user.creditsSpent30d}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{formatUserTimestamp(user.lastActiveAt)}</td>
                    <td className="px-3 py-2">{user.isPlatformAdmin ? "是" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {selected ? (
        <section className="rounded-lg border border-border bg-card p-5" data-testid="admin-user-detail">
          <h2 className="text-base font-semibold">成员管理：{selected.email ?? selected.userId}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            注册时间 {formatUserTimestamp(selected.createdAt)}；近 30 天 {selected.jobs30d} 个任务、
            {selected.runs30d} 次运行、消耗 {selected.creditsSpent30d} 额度。
          </p>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm" data-testid="admin-user-memberships">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">工作区</th>
                  <th className="px-3 py-2">类型</th>
                  <th className="px-3 py-2">角色</th>
                  <th className="px-3 py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {selected.workspaces.length === 0 ? (
                  <tr><td colSpan={4} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    该账号还没有加入任何工作区。
                  </td></tr>
                ) : selected.workspaces.map(membership => {
                  const isOwner = membership.role === "owner";
                  const confirmingRemove = pendingRemoveId === membership.id;
                  const confirmingRole = pendingRoleId === membership.id;
                  return (
                    <tr key={membership.id} className="border-t border-border align-top">
                      <td className="px-3 py-2">{membership.name}</td>
                      <td className="px-3 py-2">{directoryTypeLabel(membership.type)}</td>
                      <td className="px-3 py-2">
                        {isOwner ? (
                          <span className="text-muted-foreground">所有者（后台不可改）</span>
                        ) : confirmingRole ? (
                          <div className="flex flex-col gap-2">
                            <select value={roleDraft} aria-label={`${membership.name} 的新角色`}
                              onChange={event => setRoleDraft(event.target.value as AdminAssignableRole)}
                              className="w-32 rounded-md border border-border bg-background px-2 py-1 text-sm">
                              <option value="member">成员</option>
                              <option value="admin">管理员</option>
                            </select>
                            <input value={roleReason} onChange={event => setRoleReason(event.target.value)}
                              placeholder="修改原因（至少 2 个字符）" aria-label={`${membership.name} 的角色修改原因`}
                              className="w-64 rounded-md border border-border bg-background px-2 py-1 text-sm" />
                            <div className="flex gap-2">
                              <button type="button" disabled={busy || roleReason.trim().length < 2}
                                onClick={() => void handleRoleChange(selected.userId, membership.id, roleDraft, roleReason)}
                                className="rounded-md bg-foreground px-3 py-1 text-xs text-background disabled:opacity-50">
                                确认修改
                              </button>
                              <button type="button" onClick={() => { setPendingRoleId(null); setRoleReason(""); }}
                                className="rounded-md border border-border px-3 py-1 text-xs">取消</button>
                            </div>
                          </div>
                        ) : (
                          directoryRoleLabel(membership.role)
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {isOwner ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : confirmingRemove ? (
                          <div className="flex flex-col items-end gap-2">
                            <input value={removeReason} onChange={event => setRemoveReason(event.target.value)}
                              placeholder="移出原因（至少 2 个字符）" aria-label={`移出 ${membership.name} 的原因`}
                              className="w-64 rounded-md border border-border bg-background px-2 py-1 text-sm" />
                            <div className="flex gap-2">
                              <button type="button" disabled={busy || removeReason.trim().length < 2}
                                onClick={() => void handleRemove(selected.userId, membership.id, removeReason)}
                                className="rounded-md bg-destructive px-3 py-1 text-xs text-white disabled:opacity-50">
                                确认移出
                              </button>
                              <button type="button" onClick={() => { setPendingRemoveId(null); setRemoveReason(""); }}
                                className="rounded-md border border-border px-3 py-1 text-xs">取消</button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex justify-end gap-2">
                            <button type="button"
                              onClick={() => { setPendingRoleId(membership.id); setRoleDraft(membership.role === "admin" ? "member" : "admin"); setRoleReason(""); setFeedback(null); }}
                              className="rounded-md border border-border px-3 py-1 text-xs">改角色</button>
                            <button type="button"
                              onClick={() => { setPendingRemoveId(membership.id); setRemoveReason(""); setFeedback(null); }}
                              className="rounded-md border border-border px-3 py-1 text-xs">移出</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <form onSubmit={handleAdd} className="mt-5 flex flex-wrap items-end gap-2 border-t border-border pt-4">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              工作区搜索
              <input value={workspaceQuery} onChange={event => setWorkspaceQuery(event.target.value)}
                aria-label="工作区搜索" placeholder="工作区名称"
                className="w-44 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              加入工作区
              <select value={addWorkspaceId} onChange={event => setAddWorkspaceId(event.target.value)}
                aria-label="选择工作区"
                className="w-60 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground">
                <option value="">请选择</option>
                {workspaces
                  .filter(workspace => !selected.workspaces.some(item => item.id === workspace.id))
                  .map(workspace => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}（{workspace.memberCount} 人）
                    </option>
                  ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              角色
              <select value={addRole} onChange={event => setAddRole(event.target.value as AdminAssignableRole)}
                aria-label="新成员角色"
                className="w-28 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground">
                <option value="member">成员</option>
                <option value="admin">管理员</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              原因
              <input value={addReason} onChange={event => setAddReason(event.target.value)} required minLength={2}
                aria-label="加入工作区原因" placeholder="例如：项目协作"
                className="w-52 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
            </label>
            <button type="submit" disabled={busy || !addWorkspaceId || addReason.trim().length < 2}
              className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-50">
              加入工作区
            </button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
