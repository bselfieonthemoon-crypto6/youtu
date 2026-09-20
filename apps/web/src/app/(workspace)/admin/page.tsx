"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { DesignResourceAdminSection } from "@/components/settings/design-resource-admin-section";
import { ProviderSettingsSection } from "@/components/settings/provider-settings-section";
import { DefaultModelSection } from "@/components/admin/default-model-section";
import { WorkspaceMembersSection } from "@/components/settings/workspace-members-section";
import { AdminOverviewSection } from "@/components/admin/admin-overview-section";
import { AdminAccessSection } from "@/components/admin/admin-access-section";
import { AdminAuditSection } from "@/components/admin/admin-audit-section";
import { AdminUsersSection } from "@/components/admin/admin-users-section";
import { AdminBillingSection } from "@/components/admin/admin-billing-section";
import { AdminSkillsSection } from "@/components/admin/admin-skills-section";
import { AdminJobsSection } from "@/components/admin/admin-jobs-section";
import { AdminChannelsSection } from "@/components/admin/admin-channels-section";
import { AdminHomeContentSection } from "@/components/admin/admin-home-content-section";
import { AdminStorageSection } from "@/components/admin/admin-storage-section";
import { useAuth } from "@/lib/auth-context";
import { fetchAdminAccess, fetchViewer } from "@/lib/server-api";

type AdminTab = "overview" | "access" | "directory" | "billing" | "skills" | "jobs" | "channels" | "content" | "storage" | "users" | "providers" | "resources";

export default function AdminPage() {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const [tab, setTab] = useState<AdminTab>("users");
  const [role, setRole] = useState<"owner" | "admin" | "member" | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  // Platform administration is a separate role from workspace administration:
  // the overview tab is offered only when the server says this user is an active
  // platform admin. It is presentation only — the data route re-checks.
  const [platformAdmin, setPlatformAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadAccess = useCallback(async () => {
    if (!accessToken) {
      setLoading(false);
      setLoadError("无法获取登录凭据，请重新登录后再试。");
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const viewer = await fetchViewer(accessToken);
      setRole(viewer.membership.role);
      setWorkspaceId(viewer.membership.workspaceId);
    } catch (error) {
      setRole(null);
      setWorkspaceId(null);
      setLoadError(
        error instanceof Error
          ? error.message
          : "加载管理权限失败，请稍后重试。",
      );
      return;
    } finally {
      setLoading(false);
    }
    // A failed probe only hides the tab; it must never block the workspace
    // administration this page already had.
    try {
      setPlatformAdmin((await fetchAdminAccess(accessToken)).platformAdmin);
    } catch {
      setPlatformAdmin(false);
    }
  }, [accessToken]);

  useEffect(() => void loadAccess(), [loadAccess]);

  if (loading)
    return (
      <div className="p-8 text-sm text-muted-foreground">正在加载管理后台…</div>
    );
  if (loadError) {
    return (
      <div className="mx-auto max-w-lg p-8">
        <h1 className="text-xl font-semibold">管理后台加载失败</h1>
        <p className="mt-2 text-sm text-destructive">{loadError}</p>
        <button
          type="button"
          onClick={() => void loadAccess()}
          className="mt-5 inline-flex rounded-md bg-foreground px-4 py-2 text-sm text-background"
        >
          重试
        </button>
      </div>
    );
  }
  if (role !== "owner" && role !== "admin") {
    return (
      <div className="mx-auto max-w-lg p-8">
        <h1 className="text-xl font-semibold">无权访问管理后台</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          只有工作区所有者或管理员可以进入。
        </p>
        <Link
          href="/home"
          className="mt-5 inline-flex rounded-md bg-foreground px-4 py-2 text-sm text-background"
        >
          返回首页
        </Link>
      </div>
    );
  }

  const authenticatedToken = accessToken ?? "";
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 md:p-8">
      <div className="mb-7">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          {platformAdmin ? "Platform & workspace administration" : "Workspace administration"}
        </p>
        <h1 className="mt-1 text-2xl font-semibold">管理后台</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          管理本工作区的成员、模型渠道与默认模型，以及设计资源。
          {platformAdmin
            ? "作为平台管理员，这里还能查看与处理平台级的总览、任务、渠道健康、首页内容、存储与权限审计等页面。"
            : ""}
        </p>
      </div>
      <div className="mb-7 inline-flex rounded-lg bg-muted p-1">
        {(
          [
            ...(platformAdmin ? ([["overview", "平台总览"], ["jobs", "任务"], ["channels", "渠道与模型"], ["content", "首页内容"], ["storage", "存储"], ["access", "权限与审计"], ["directory", "用户目录"], ["billing", "套餐与额度"], ["skills", "技能与图片"]] as const) : []),
            ["users", "本工作区成员"],
            ["providers", "第三方模型供应商"],
            ["resources", "设计资源"],
          ] as ReadonlyArray<readonly [AdminTab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`rounded-md px-4 py-2 text-sm ${tab === id ? "bg-card font-medium shadow-sm" : "text-muted-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className={tab === "users" || tab === "resources" || tab === "providers" ? "max-w-3xl" : "w-full"}>
        {tab === "overview" && platformAdmin ? (
          <AdminOverviewSection accessToken={authenticatedToken} />
        ) : tab === "access" && platformAdmin ? (
          <div className="space-y-5">
            <AdminAccessSection accessToken={authenticatedToken} />
            <AdminAuditSection accessToken={authenticatedToken} />
          </div>
        ) : tab === "directory" && platformAdmin ? (
          <AdminUsersSection accessToken={authenticatedToken} />
        ) : tab === "billing" && platformAdmin ? (
          <AdminBillingSection accessToken={authenticatedToken} />
        ) : tab === "skills" && platformAdmin ? (
          <AdminSkillsSection accessToken={authenticatedToken} />
        ) : tab === "jobs" && platformAdmin ? (
          <AdminJobsSection accessToken={authenticatedToken} />
        ) : tab === "channels" && platformAdmin ? (
          <AdminChannelsSection accessToken={authenticatedToken} />
        ) : tab === "content" && platformAdmin ? (
          <AdminHomeContentSection accessToken={authenticatedToken} />
        ) : tab === "storage" && platformAdmin ? (
          <AdminStorageSection accessToken={authenticatedToken} />
        ) : tab === "users" ? (
          <WorkspaceMembersSection
            accessToken={authenticatedToken}
            viewerRole={role}
          />
        ) : tab === "providers" ? (
          <div className="space-y-5">
            {/* The default model is drawn from these channels, so it is configured
                next to them - and only here, never in a user's own settings. */}
            <DefaultModelSection accessToken={authenticatedToken} />
            <ProviderSettingsSection accessToken={authenticatedToken} />
          </div>
        ) : (
          <DesignResourceAdminSection
            accessToken={authenticatedToken}
            workspaceId={workspaceId ?? ""}
            directoryImportEnabled={
              process.env.NEXT_PUBLIC_LOOMIC_DESIGN_IMPORT_DIRECTORY_ENABLED ===
              "true"
            }
          />
        )}
      </div>
    </div>
  );
}
