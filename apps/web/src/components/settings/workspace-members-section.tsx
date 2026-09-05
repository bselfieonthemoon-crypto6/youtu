"use client";

import type { ManageableWorkspaceRole, WorkspaceMemberAdminView } from "@loomic/shared";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  addWorkspaceMember,
  fetchWorkspaceMembers,
  removeWorkspaceMember,
  updateWorkspaceMember,
} from "../../lib/server-api";

export function WorkspaceMembersSection({
  accessToken,
  viewerRole,
}: {
  accessToken: string;
  viewerRole: "owner" | "admin";
}) {
  const [members, setMembers] = useState<WorkspaceMemberAdminView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ManageableWorkspaceRole>("member");
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMembers((await fetchWorkspaceMembers(accessToken)).members);
    } catch (caught) {
      setError(memberErrorMessage(caught, "用户列表加载失败，请稍后重试。"));
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => void load(), [load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return members;
    return members.filter((member) =>
      `${member.displayName} ${member.email} ${roleLabel(member.role)}`.toLowerCase().includes(needle),
    );
  }, [members, query]);

  async function handleAdd(event: React.FormEvent) {
    event.preventDefault();
    setFeedback(null);
    setAdding(true);
    try {
      const response = await addWorkspaceMember(accessToken, { email: email.trim(), role });
      setMembers((current) => [...current, response.member]);
      setEmail("");
      setRole("member");
      setFeedback("用户已加入当前工作区。");
    } catch (caught) {
      setFeedback(memberErrorMessage(caught, "添加失败，请检查邮箱后重试。"));
    } finally {
      setAdding(false);
    }
  }

  async function handleRoleChange(member: WorkspaceMemberAdminView, nextRole: ManageableWorkspaceRole) {
    setBusyId(member.userId);
    setFeedback(null);
    try {
      const response = await updateWorkspaceMember(accessToken, member.userId, { role: nextRole });
      setMembers((current) => current.map((item) => item.userId === member.userId ? response.member : item));
    } catch (caught) {
      setFeedback(memberErrorMessage(caught, "角色更新失败。"));
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemove(member: WorkspaceMemberAdminView) {
    if (!window.confirm(`确定将“${member.displayName}”移出工作区吗？`)) return;
    setBusyId(member.userId);
    setFeedback(null);
    try {
      await removeWorkspaceMember(accessToken, member.userId);
      setMembers((current) => current.filter((item) => item.userId !== member.userId));
    } catch (caught) {
      setFeedback(memberErrorMessage(caught, "移除失败，请稍后重试。"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section aria-labelledby="workspace-members-heading">
      <div className="mb-5">
        <h2 id="workspace-members-heading" className="text-lg font-semibold">用户管理</h2>
        <p className="mt-1 text-sm text-muted-foreground">管理当前工作区成员和权限。仅支持添加已经注册 Loomic 的用户。</p>
      </div>

      <form onSubmit={handleAdd} className="mb-5 grid gap-2 rounded-xl border border-border bg-card p-4 sm:grid-cols-[1fr_120px_auto]">
        <input aria-label="用户邮箱" required type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="用户邮箱" className={inputClass} />
        <select aria-label="新用户角色" value={role} disabled={viewerRole !== "owner"} onChange={(event) => setRole(event.target.value as ManageableWorkspaceRole)} className={inputClass}>
          <option value="member">成员</option>
          <option value="admin">管理员</option>
        </select>
        <button type="submit" disabled={adding} className="h-9 rounded-md bg-foreground px-4 text-xs font-medium text-background disabled:opacity-50">{adding ? "添加中…" : "添加用户"}</button>
      </form>

      <div className="mb-3 flex items-center justify-between gap-3">
        <input aria-label="搜索用户" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索姓名或邮箱" className={`${inputClass} max-w-xs`} />
        <span className="text-xs text-muted-foreground">共 {members.length} 人</span>
      </div>

      {feedback && <p role="status" className="mb-3 text-sm text-muted-foreground">{feedback}</p>}
      {loading ? (
        <MemberState text="正在加载用户…" />
      ) : error ? (
        <MemberState text={error} action="重试" onAction={() => void load()} />
      ) : filtered.length === 0 ? (
        <MemberState text={query ? "没有匹配的用户。" : "当前工作区暂无用户。"} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          {filtered.map((member) => {
            const immutable = member.role === "owner";
            const canChangeRole = viewerRole === "owner" && !immutable && !member.isCurrentUser;
            const canRemove = !immutable && !member.isCurrentUser && (viewerRole === "owner" || member.role === "member");
            return (
              <div key={member.userId} className="flex flex-col gap-3 border-b border-border p-4 last:border-b-0 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold">{member.displayName.slice(0, 1).toUpperCase()}</div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{member.displayName}{member.isCurrentUser ? "（你）" : ""}</p>
                    <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {immutable ? (
                    <span className="rounded-full bg-muted px-3 py-1 text-xs">所有者</span>
                  ) : (
                    <select aria-label={`${member.displayName}的角色`} value={member.role} disabled={!canChangeRole || busyId === member.userId} onChange={(event) => void handleRoleChange(member, event.target.value as ManageableWorkspaceRole)} className="h-8 rounded-md border border-input bg-transparent px-2 text-xs disabled:opacity-60">
                      <option value="member">成员</option><option value="admin">管理员</option>
                    </select>
                  )}
                  {canRemove && <button type="button" disabled={busyId === member.userId} onClick={() => void handleRemove(member)} className="h-8 rounded-md border border-border px-2.5 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50">移除</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function MemberState({ text, action, onAction }: { text: string; action?: string; onAction?: () => void }) {
  return <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground"><p>{text}</p>{action && onAction && <button type="button" onClick={onAction} className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs text-foreground">{action}</button>}</div>;
}

function roleLabel(role: WorkspaceMemberAdminView["role"]) {
  if (role === "owner") return "所有者";
  if (role === "admin") return "管理员";
  return "成员";
}

function memberErrorMessage(error: unknown, fallback: string) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (code === "member_not_found") return "没有找到该邮箱对应的已注册用户。";
  if (code === "member_already_exists") return "该用户已经在当前工作区中。";
  if (code === "member_owner_immutable") return "工作区所有者不能被修改或移除。";
  if (code === "member_forbidden") return "你没有权限执行此操作。";
  return fallback;
}

const inputClass = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus:ring-1 focus:ring-ring";
