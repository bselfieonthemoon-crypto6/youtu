"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

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
import { useViewerAccess } from "@/hooks/use-viewer-access";
import { useAuth } from "@/lib/auth-context";

type AdminTab = "overview" | "access" | "directory" | "billing" | "skills" | "jobs" | "channels" | "content" | "storage" | "users" | "providers" | "resources";

/** Tabs that only an active platform admin may open. */
const PLATFORM_TABS: ReadonlyArray<readonly [AdminTab, string]> = [
  ["overview", "平台总览"],
  ["jobs", "任务"],
  ["channels", "渠道健康"],
  ["content", "首页内容"],
  ["storage", "存储"],
  ["access", "权限与审计"],
  ["directory", "用户目录"],
  ["billing", "套餐与额度"],
  ["skills", "技能与图片"],
];

/** Tabs a workspace owner/admin legitimately owns. */
const WORKSPACE_TABS: ReadonlyArray<readonly [AdminTab, string]> = [
  ["users", "本工作区成员"],
  ["providers", "模型与渠道"],
  ["resources", "设计资源"],
];

export default function AdminPage() {
  const { session } = useAuth();
  const access = useViewerAccess();
  const [tab, setTab] = useState<AdminTab>("users");

  // A platform admin who is only a workspace member may use the platform tabs but not
  // the workspace ones: the workspace routes still require owner/admin server-side.
  const workspaceRole =
    access.role === "owner" || access.role === "admin" ? access.role : null;

  const tabs = useMemo<ReadonlyArray<readonly [AdminTab, string]>>(
    () => [
      ...(access.platformAdmin ? PLATFORM_TABS : []),
      ...(workspaceRole ? WORKSPACE_TABS : []),
    ],
    [access.platformAdmin, workspaceRole],
  );

  // A tab picked under one identity must not survive into another: an account switch
  // used to leave `tab` pointing at a platform tab that the new identity may not open,
  // which then fell through to the wrong section. The default stays the workspace
  // members tab for a workspace administrator; a platform admin without a workspace
  // role has no workspace tabs, so they land on their first platform tab instead.
  const fallbackTab: AdminTab = workspaceRole
    ? "users"
    : (tabs[0]?.[0] ?? "users");
  const effectiveTab = tabs.some(([id]) => id === tab) ? tab : fallbackTab;

  if (access.loading) {
    return (
      <div className="p-8 text-sm text-muted-foreground">正在加载管理后台…</div>
    );
  }

  if (access.loadError) {
    return (
      <div className="mx-auto max-w-lg p-8">
        <h1 className="text-xl font-semibold">管理后台加载失败</h1>
        <p className="mt-2 text-sm text-destructive">{access.loadError}</p>
        <button
          type="button"
          onClick={access.refresh}
          className="mt-5 inline-flex rounded-md bg-foreground px-4 py-2 text-sm text-background"
        >
          重试
        </button>
      </div>
    );
  }

  // The shell is only for an identity the server confirmed can administer something.
  // A workspace member - an ordinary user - gets this instead of a console.
  if (!access.canSeeAdministration) {
    return (
      <div className="mx-auto max-w-lg p-8">
        <h1 className="text-xl font-semibold">无权访问管理后台</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          只有工作区所有者或管理员，以及平台管理员可以进入。当前账号没有管理权限。
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

  const accessToken = session?.access_token ?? "";
  const platformAdmin = access.platformAdmin;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 md:p-8">
      <div className="mb-7">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          {platformAdmin ? "Platform & workspace administration" : "Workspace administration"}
        </p>
        <h1 className="mt-1 text-2xl font-semibold">
          {platformAdmin ? "管理后台" : "工作区管理"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {workspaceRole
            ? "管理本工作区的成员、模型渠道与默认模型，以及设计资源。"
            : null}
          {platformAdmin
            ? "作为平台管理员，这里还能查看与处理平台级的总览、任务、渠道健康、首页内容、存储与权限审计等页面。"
            : "平台级的管理页面只对平台管理员开放。"}
        </p>
      </div>
      <div className="mb-7 inline-flex rounded-lg bg-muted p-1">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`rounded-md px-4 py-2 text-sm ${effectiveTab === id ? "bg-card font-medium shadow-sm" : "text-muted-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className={effectiveTab === "users" || effectiveTab === "resources" || effectiveTab === "providers" ? "max-w-3xl" : "w-full"}>
        {effectiveTab === "overview" && platformAdmin ? (
          <AdminOverviewSection accessToken={accessToken} />
        ) : effectiveTab === "access" && platformAdmin ? (
          <div className="space-y-5">
            <AdminAccessSection accessToken={accessToken} />
            <AdminAuditSection accessToken={accessToken} />
          </div>
        ) : effectiveTab === "directory" && platformAdmin ? (
          <AdminUsersSection accessToken={accessToken} />
        ) : effectiveTab === "billing" && platformAdmin ? (
          <AdminBillingSection accessToken={accessToken} />
        ) : effectiveTab === "skills" && platformAdmin ? (
          <AdminSkillsSection accessToken={accessToken} />
        ) : effectiveTab === "jobs" && platformAdmin ? (
          <AdminJobsSection accessToken={accessToken} />
        ) : effectiveTab === "channels" && platformAdmin ? (
          <AdminChannelsSection accessToken={accessToken} />
        ) : effectiveTab === "content" && platformAdmin ? (
          <AdminHomeContentSection accessToken={accessToken} />
        ) : effectiveTab === "storage" && platformAdmin ? (
          <AdminStorageSection accessToken={accessToken} />
        ) : effectiveTab === "users" && workspaceRole ? (
          <WorkspaceMembersSection
            accessToken={accessToken}
            viewerRole={workspaceRole}
          />
        ) : effectiveTab === "providers" && workspaceRole ? (
          <div className="space-y-5">
            {/* The default model is drawn from these channels, so it is configured
                next to them - and only here, never in a user's own settings. */}
            <DefaultModelSection accessToken={accessToken} />
            <ProviderSettingsSection accessToken={accessToken} />
          </div>
        ) : effectiveTab === "resources" && workspaceRole ? (
          <DesignResourceAdminSection
            accessToken={accessToken}
            workspaceId={access.workspaceId ?? ""}
            directoryImportEnabled={
              process.env.NEXT_PUBLIC_LOOMIC_DESIGN_IMPORT_DIRECTORY_ENABLED ===
              "true"
            }
          />
        ) : null}
      </div>
    </div>
  );
}
