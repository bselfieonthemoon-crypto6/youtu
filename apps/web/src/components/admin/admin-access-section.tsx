"use client";

import type { AdminPlatformAdminView } from "@loomic/shared";
import { useCallback, useEffect, useState } from "react";

import {
  fetchAdminPlatformAdmins,
  grantAdminPlatformAdmin,
  revokeAdminPlatformAdmin,
} from "../../lib/server-api";

/**
 * Platform admin access management.
 *
 * Two things are deliberate here. Access changes need a stated reason, because an
 * unexplained grant/revoke is not reviewable later, and the confirmation is inline
 * rather than a modal: the row itself turns into "reason + confirm", which keeps
 * the reason attached to the account it applies to. The server is still the
 * control — it re-checks the actor and refuses to remove the last admin.
 */
export function AdminAccessSection({ accessToken }: { accessToken: string }) {
  const [admins, setAdmins] = useState<AdminPlatformAdminView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [grantReason, setGrantReason] = useState("");
  const [granting, setGranting] = useState(false);
  const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken) {
      setLoading(false);
      setError("无法获取登录凭据，请重新登录后再试。");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setAdmins((await fetchAdminPlatformAdmins(accessToken)).admins);
    } catch (caught) {
      setAdmins([]);
      setError(caught instanceof Error ? caught.message : "平台管理员列表加载失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => void load(), [load]);

  async function handleGrant(event: React.FormEvent) {
    event.preventDefault();
    setFeedback(null);
    setGranting(true);
    try {
      const admin = await grantAdminPlatformAdmin(accessToken, { email: email.trim(), reason: grantReason.trim() });
      setAdmins(current => [...current.filter(item => item.userId !== admin.userId), admin]);
      setEmail("");
      setGrantReason("");
      setFeedback(`已授予 ${admin.email ?? admin.userId} 平台管理员权限，操作已记入审计。`);
    } catch (caught) {
      setFeedback(caught instanceof Error ? caught.message : "授权失败，请稍后重试。");
    } finally {
      setGranting(false);
    }
  }

  async function handleRevoke(admin: AdminPlatformAdminView) {
    setFeedback(null);
    setRevoking(true);
    try {
      await revokeAdminPlatformAdmin(accessToken, admin.userId, revokeReason.trim());
      setAdmins(current => current.filter(item => item.userId !== admin.userId));
      setPendingRevokeId(null);
      setRevokeReason("");
      setFeedback(`已撤销 ${admin.email ?? admin.userId} 的平台管理员权限，操作已记入审计。`);
    } catch (caught) {
      setFeedback(caught instanceof Error ? caught.message : "撤销失败，请稍后重试。");
    } finally {
      setRevoking(false);
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">正在加载平台管理员…</p>;
  if (error) {
    return (
      <div>
        <p className="text-sm text-destructive">{error}</p>
        <button type="button" onClick={() => void load()}
          className="mt-4 inline-flex rounded-md border border-border px-3 py-1.5 text-sm">重试</button>
      </div>
    );
  }

  const canGrant = email.trim().length > 0 && grantReason.trim().length >= 2 && !granting;

  return (
    <div className="space-y-5" data-testid="admin-access">
      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-base font-semibold">平台管理员</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          平台管理员可以查看全站总览、管理用户与套餐、维护技能与图片。授权与撤销都需要填写原因并写入审计；
          系统拒绝撤销最后一个平台管理员。
        </p>
        {feedback ? <p className="mt-3 text-sm text-muted-foreground" data-testid="admin-access-feedback">{feedback}</p> : null}

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm" data-testid="admin-admins">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">账号</th>
                <th className="px-3 py-2">显示名</th>
                <th className="px-3 py-2">授权时间</th>
                <th className="px-3 py-2 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {admins.length === 0 ? (
                <tr><td colSpan={4} className="px-3 py-6 text-center text-sm text-muted-foreground">暂无平台管理员。</td></tr>
              ) : admins.map(admin => (
                <tr key={admin.userId} className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    {admin.email ?? admin.userId}
                    {admin.isCurrentUser ? <span className="ml-2 text-xs text-muted-foreground">（你）</span> : null}
                  </td>
                  <td className="px-3 py-2">{admin.displayName ?? "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {admin.grantedAt ? new Date(admin.grantedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {pendingRevokeId === admin.userId ? (
                      <div className="flex flex-col items-end gap-2">
                        <input
                          value={revokeReason}
                          onChange={event => setRevokeReason(event.target.value)}
                          placeholder="撤销原因（至少 2 个字符）"
                          aria-label={`撤销 ${admin.email ?? admin.userId} 的原因`}
                          className="w-64 rounded-md border border-border bg-background px-2 py-1 text-sm"
                        />
                        <div className="flex gap-2">
                          <button type="button" disabled={revoking || revokeReason.trim().length < 2}
                            onClick={() => void handleRevoke(admin)}
                            className="rounded-md bg-destructive px-3 py-1 text-xs text-white disabled:opacity-50">
                            确认撤销
                          </button>
                          <button type="button" onClick={() => { setPendingRevokeId(null); setRevokeReason(""); }}
                            className="rounded-md border border-border px-3 py-1 text-xs">取消</button>
                        </div>
                      </div>
                    ) : (
                      <button type="button"
                        onClick={() => { setPendingRevokeId(admin.userId); setRevokeReason(""); setFeedback(null); }}
                        className="rounded-md border border-border px-3 py-1 text-xs">撤销</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <form onSubmit={handleGrant} className="mt-5 flex flex-wrap items-end gap-2 border-t border-border pt-4">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            账号邮箱
            <input value={email} onChange={event => setEmail(event.target.value)} type="email" required
              placeholder="user@example.com" aria-label="要授权的账号邮箱"
              className="w-60 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            授权原因
            <input value={grantReason} onChange={event => setGrantReason(event.target.value)} required minLength={2}
              placeholder="例如：运营负责人" aria-label="授权原因"
              className="w-64 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
          </label>
          <button type="submit" disabled={!canGrant}
            className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-50">
            授予平台管理员
          </button>
        </form>
      </section>
    </div>
  );
}
